import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import type { WebSessionTabsSyncState } from './state'
import { NULL_PTY_PLACEHOLDER_TTL_MS, shouldReplaceTerminalTab } from './terminal-surfaces'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'local-tab-uuid-1',
    ptyId: null,
    worktreeId: 'env-1::worktree-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: 'env-1::worktree-1',
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

describe('shouldReplaceTerminalTab TTL bound (#21340)', () => {
  const envId = 'env-1'
  const emptyPtyIds = new Set<string>()
  const emptyMirroredIds = new Set<string>()
  const emptyProvisional = new Set<string>()

  it('retains a freshly created tab with ptyId: null within the 30s grace period', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: null,
      createdAt: now - 15_000 // 15s old (< 30s TTL)
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(false)
  })

  it('evicts a tab with ptyId: null exceeding the 30s grace period', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: null,
      createdAt: now - 31_000 // 31s old (> 30s TTL)
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(true)
  })

  it('retains a tab on the exact boundary (now - createdAt === 30_000)', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: null,
      createdAt: now - NULL_PTY_PLACEHOLDER_TTL_MS // exactly 30_000ms old
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(false)
  })

  it('retains an active tab with non-null ptyId even if older than 30s', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: `remote:${envId}@@pty-live-1`,
      createdAt: now - 60_000 // 60s old (> 30s TTL)
    })

    // Remote snapshot does not contain this PTY yet or it is an active local tab
    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(false)
  })

  it('retains a legacy tab without createdAt or with non-number createdAt and ptyId: null', () => {
    const now = 100_000
    const legacyWithoutCreatedAt = makeTab({
      id: 'local-tab-legacy-1',
      ptyId: null
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deleting required property to simulate legacy deserialization missing createdAt
    delete (legacyWithoutCreatedAt as Record<string, unknown>).createdAt

    const legacyRawRecord: Record<string, unknown> = {
      id: 'local-tab-legacy-2',
      ptyId: null,
      worktreeId: 'env-1::worktree-1',
      title: 'Terminal 1',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: '2026-09-28T00:00:00.000Z'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Simulating untyped legacy payload with non-numeric createdAt passed to tab reconciler
    const legacyWithNonNumberCreatedAt = legacyRawRecord as unknown as TerminalTab

    expect(
      shouldReplaceTerminalTab(
        legacyWithoutCreatedAt,
        envId,
        emptyPtyIds,
        emptyMirroredIds,
        emptyProvisional,
        now
      )
    ).toBe(false)

    expect(
      shouldReplaceTerminalTab(
        legacyWithNonNumberCreatedAt,
        envId,
        emptyPtyIds,
        emptyMirroredIds,
        emptyProvisional,
        now
      )
    ).toBe(false)
  })

  it('filters out an expired null-PTY tab from retainedTerminalTabs in prepareWebSessionTabsSnapshotBase reconciler', () => {
    const worktreeId = 'env-1::worktree-1'
    const now = 100_000

    const freshNullPtyTab = makeTab({
      id: 'tab-fresh-null-pty',
      ptyId: null,
      worktreeId,
      createdAt: now - 10_000
    })

    const expiredNullPtyTab = makeTab({
      id: 'tab-expired-null-pty',
      ptyId: null,
      worktreeId,
      createdAt: now - 35_000
    })

    const activePtyTab = makeTab({
      id: 'tab-active-pty',
      ptyId: `remote:${envId}@@pty-surviving`,
      worktreeId,
      createdAt: now - 60_000
    })

    const state = makeState({
      activeWorktreeId: worktreeId,
      tabsByWorktree: {
        [worktreeId]: [freshNullPtyTab, expiredNullPtyTab, activePtyTab]
      }
    })

    const rawSnapshot: RuntimeMobileSessionTabsResult = {
      worktree: worktreeId,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: null,
      activeTabType: null,
      tabGroups: [],
      tabs: []
    }

    const base = prepareWebSessionTabsSnapshotBase(
      state,
      rawSnapshot,
      envId,
      worktreeId,
      now,
      undefined,
      undefined
    )

    expect(base.retainedTerminalTabs.map((t) => t.id)).toEqual([
      freshNullPtyTab.id,
      activePtyTab.id
    ])
    expect(base.removedTerminalIds.has(expiredNullPtyTab.id)).toBe(true)
    expect(base.retainedTerminalTabs.find((t) => t.id === expiredNullPtyTab.id)).toBeUndefined()
  })
})
