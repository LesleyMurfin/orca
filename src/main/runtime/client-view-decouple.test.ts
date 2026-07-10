/**
 * Client view decoupling: the active tab (per worktree) and the active worktree
 * are projected/gated per device so two paired clients no longer "swallow" each
 * other's selection.
 *
 * AXIS 1 — active tab is a per-device projection: each mobile-session subscriber
 * sees its own active tab; a device with no slot falls back to the shared
 * snapshot (reattach hydration), and slots are pruned on device disconnect.
 * AXIS 2 — active worktree activations carrying an origin clientId are delivered
 * only to that self subscriber, while origin-less (CLI/creation) activations
 * still broadcast to every subscriber.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  setActiveTabForDevice(worktreeId: string, clientId: string, tabId: string): void
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

function terminalTab(id: string, isActive: boolean) {
  return {
    type: 'terminal' as const,
    id,
    parentTabId: `parent-${id}`,
    leafId: `leaf-${id}`,
    title: id,
    isActive
  }
}

function seedSnapshot(runtime: OrcaRuntimeService): RuntimeMobileSessionTabsSnapshot {
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabs: [terminalTab('tab-1', true), terminalTab('tab-2', false)]
  }
  ;(runtime as unknown as RuntimeInternals).mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
  return snapshot
}

describe('client view decoupling — active tab projection', () => {
  it('projects each device its own active tab and falls back to shared for slotless devices', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    const snapshot = seedSnapshot(runtime)

    const resultsA: RuntimeMobileSessionTabsResult[] = []
    const resultsB: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((result) => resultsA.push(result), 'device-A')
    runtime.onMobileSessionTabsChanged((result) => resultsB.push(result), 'device-B')

    // Before any device activates a tab, both see the shared active tab.
    internals.emitMobileSessionTabsSnapshot(snapshot)
    expect(resultsA.at(-1)?.activeTabId).toBe('tab-1')
    expect(resultsB.at(-1)?.activeTabId).toBe('tab-1')

    // Device A selects tab-2. Only A's projection follows; B keeps the shared tab.
    internals.setActiveTabForDevice('wt-1', 'device-A', 'tab-2')
    internals.emitMobileSessionTabsSnapshot(snapshot)

    const latestA = resultsA.at(-1)
    const latestB = resultsB.at(-1)
    expect(latestA?.activeTabId).toBe('tab-2')
    expect(latestA?.tabs.find((tab) => tab.id === 'tab-2')?.isActive).toBe(true)
    expect(latestA?.tabs.find((tab) => tab.id === 'tab-1')?.isActive).toBe(false)
    expect(latestB?.activeTabId).toBe('tab-1')
    expect(latestB?.tabs.find((tab) => tab.id === 'tab-1')?.isActive).toBe(true)
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
