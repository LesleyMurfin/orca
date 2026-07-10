/**
 * Client view decoupling: the active tab (per worktree) and the active worktree
 * are projected/gated per device so two paired clients no longer "swallow" each
 * other's selection.
 *
 * AXIS 1 — active tab is a per-device projection. When a device switches its
 * active tab, the acting device's slot follows its choice AND every other
 * subscribed peer is pinned to the pre-switch shared active tab, so a slotless
 * peer is not dragged onto the shared snapshot this switch mutates. A device
 * that has never been subscribed during a peer switch still hydrates from the
 * shared snapshot (reattach). Slots are pruned on tab close and device
 * disconnect.
 * AXIS 2 — active worktree activations carrying an origin clientId are delivered
 * only to that self subscriber, while origin-less (CLI/creation) activations
 * still broadcast to every subscriber.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  setActiveTabForDevice(worktreeId: string, clientId: string, tabId: string): void
  clearDeviceSlotsForTab(worktreeId: string, tabId: string): void
  activateMobileSessionTabForRemoteClient(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    activeTab: RuntimeMobileSessionSnapshotTab,
    clientId?: string
  ): void
  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void
  notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: unknown,
    startup?: unknown,
    defaultTabs?: unknown,
    originClientId?: string
  ): void
}

function terminalTab(id: string, isActive: boolean): RuntimeMobileSessionSnapshotTab {
  return {
    type: 'terminal',
    id,
    parentTabId: `parent-${id}`,
    leafId: `leaf-${id}`,
    title: id,
    isActive
  }
}

function markdownTab(id: string, isActive: boolean): RuntimeMobileSessionMarkdownTab {
  return {
    type: 'markdown',
    id,
    title: id,
    filePath: `/repo/${id}.md`,
    relativePath: `${id}.md`,
    language: 'markdown',
    mode: 'markdown-preview',
    isDirty: false,
    isActive,
    sourceFileId: `src-${id}`,
    sourceFilePath: `/repo/${id}.md`,
    sourceRelativePath: `${id}.md`,
    documentVersion: 'v1'
  }
}

function seedSnapshot(
  runtime: OrcaRuntimeService,
  tabs: RuntimeMobileSessionSnapshotTab[] = [
    terminalTab('tab-1', true),
    terminalTab('tab-2', false)
  ],
  activeTabId = 'tab-1'
): RuntimeMobileSessionTabsSnapshot {
  const active = tabs.find((tab) => tab.id === activeTabId)
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId,
    activeTabType: active?.type ?? null,
    tabs
  }
  ;(runtime as unknown as RuntimeInternals).mobileSessionTabsByWorktree.set(
    snapshot.worktree,
    snapshot
  )
  return snapshot
}

describe('client view decoupling — active tab projection', () => {
  it('does not swallow a slotless peer when a device switches tabs (real mutator)', () => {
    // Drives the true activation mutator, which ALSO rewrites the shared
    // snapshot.activeTabId — the production side effect that a naive slotless
    // fallback would leak. The peer must stay on its own tab regardless.
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(runtime)

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    const resultsB: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')
    runtime.onMobileSessionTabsChanged((result) => resultsB.push(result), 'device-B')

    // Both devices start slotless and see the shared active tab.
    internals.emitMobileSessionTabsSnapshot(snapshot)
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-1')
    expect(resultsB.at(-1)?.activeTabId).toBe('tab-1')

    // Device A switches to tab-2 through the real mutator.
    const tab2 = snapshot.tabs.find((tab) => tab.id === 'tab-2')!
    internals.activateMobileSessionTabForRemoteClient('wt-1', snapshot, tab2, 'device-A')

    // The shared snapshot now says tab-2 (side effect present in state)...
    expect(internals.mobileSessionTabsByWorktree.get('wt-1')?.activeTabId).toBe('tab-2')
    // ...A follows its own selection...
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-2')
    expect(resultsA.at(-1)?.tabs.find((tab) => tab.id === 'tab-2')?.isActive).toBe(true)
    // ...but B is pinned to the pre-switch tab and is NOT swallowed.
    expect(resultsB.at(-1)?.activeTabId).toBe('tab-1')
    expect(resultsB.at(-1)?.tabs.find((tab) => tab.id === 'tab-1')?.isActive).toBe(true)
    expect(resultsB.at(-1)?.tabs.find((tab) => tab.id === 'tab-2')?.isActive).toBe(false)
  })

  it('does not swallow a peer through the public activateMobileSessionTab path', async () => {
    // End-to-end: real public entrypoint (markdown tab avoids terminal
    // materialization), notifyClients:false + acting clientId.
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(
      runtime,
      [markdownTab('doc-1', true), markdownTab('doc-2', false)],
      'doc-1'
    )

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    const resultsB: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')
    runtime.onMobileSessionTabsChanged((result) => resultsB.push(result), 'device-B')
    internals.emitMobileSessionTabsSnapshot(snapshot)

    await runtime.activateMobileSessionTab('id:wt-1', 'doc-2', undefined, {
      notifyClients: false,
      clientId: 'device-A'
    })

    expect(resultsA.at(-1)?.activeTabId).toBe('doc-2')
    expect(resultsB.at(-1)?.activeTabId).toBe('doc-1')
  })

  it('hydrates a late-joining device from the shared snapshot after a peer switch', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(runtime)

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')

    // A switches while it is the only subscriber; shared snapshot -> tab-2.
    const tab2 = snapshot.tabs.find((tab) => tab.id === 'tab-2')!
    const mutated = internals.mobileSessionTabsByWorktree.get('wt-1')!
    internals.activateMobileSessionTabForRemoteClient('wt-1', mutated, tab2, 'device-A')

    // Device B attaches afterwards with no slot: it hydrates to the current
    // shared active tab (tab-2) rather than a stale one.
    const resultsB: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsB.push(result), 'device-B')
    internals.emitMobileSessionTabsSnapshot(internals.mobileSessionTabsByWorktree.get('wt-1')!)
    expect(resultsB.at(-1)?.activeTabId).toBe('tab-2')
  })

  it('applies a device active-tab override to markdown tab isActive flags', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(
      runtime,
      [markdownTab('doc-1', true), markdownTab('doc-2', false)],
      'doc-1'
    )

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')

    internals.setActiveTabForDevice('wt-1', 'device-A', 'doc-2')
    internals.emitMobileSessionTabsSnapshot(snapshot)

    const latest = resultsA.at(-1)
    expect(latest?.activeTabId).toBe('doc-2')
    expect(latest?.tabs.find((tab) => tab.id === 'doc-2')?.isActive).toBe(true)
    expect(latest?.tabs.find((tab) => tab.id === 'doc-1')?.isActive).toBe(false)
  })

  it('falls back to the shared active tab when a device slot points at a missing tab', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(runtime)

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')

    // Slot references a tab no longer present (e.g. closed elsewhere).
    internals.setActiveTabForDevice('wt-1', 'device-A', 'tab-gone')
    internals.emitMobileSessionTabsSnapshot(snapshot)

    expect(resultsA.at(-1)?.activeTabId).toBe('tab-1')
  })

  it('deletes a device slot when its tab closes so a reused id cannot resurrect it', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(runtime)

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')

    internals.setActiveTabForDevice('wt-1', 'device-A', 'tab-2')
    internals.emitMobileSessionTabsSnapshot(snapshot)
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-2')

    // Close tab-2. The slot must be dropped, not merely masked: tab-2 still
    // exists in the snapshot, so a surviving slot would keep projecting it.
    internals.clearDeviceSlotsForTab('wt-1', 'tab-2')
    internals.emitMobileSessionTabsSnapshot(snapshot)
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-1')
  })

  it('clears a device active-tab slot when the device disconnects', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(runtime)

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')

    internals.setActiveTabForDevice('wt-1', 'device-A', 'tab-2')
    internals.emitMobileSessionTabsSnapshot(snapshot)
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-2')

    runtime.onClientDisconnected('device-A')
    internals.emitMobileSessionTabsSnapshot(snapshot)
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-1')
  })
})

describe('client view decoupling — active worktree origin gating', () => {
  it('delivers an origin-gated activation only to the acting device', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals

    const eventsA: RuntimeClientEvent[] = []
    const eventsB: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => eventsA.push(event), 'device-A')
    runtime.onClientEvent((event) => eventsB.push(event), 'device-B')

    internals.notifyActivateWorktree('repo-1', 'wt-9', undefined, undefined, undefined, 'device-A')

    expect(eventsA).toHaveLength(1)
    expect(eventsA[0]).toMatchObject({ type: 'activateWorktree', worktreeId: 'wt-9' })
    // The acting device token gates delivery but must not ship on the wire.
    expect(eventsA[0]).not.toHaveProperty('originClientId')
    expect(eventsB).toHaveLength(0)
  })

  it('broadcasts origin-less activations (CLI/creation) to every subscriber', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals

    const eventsA: RuntimeClientEvent[] = []
    const eventsB: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => eventsA.push(event), 'device-A')
    runtime.onClientEvent((event) => eventsB.push(event), 'device-B')

    internals.notifyActivateWorktree('repo-1', 'wt-9')

    expect(eventsA).toHaveLength(1)
    expect(eventsB).toHaveLength(1)
  })

  it('keeps broadcasting non-activation events regardless of subscriber clientId', () => {
    const runtime = new OrcaRuntimeService()

    const eventsA: RuntimeClientEvent[] = []
    const eventsB: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => eventsA.push(event), 'device-A')
    runtime.onClientEvent((event) => eventsB.push(event), 'device-B')

    runtime.notifySshStateChanged('ssh-target-1', 'connected' as never)

    expect(eventsA).toHaveLength(1)
    expect(eventsB).toHaveLength(1)
  })
})
