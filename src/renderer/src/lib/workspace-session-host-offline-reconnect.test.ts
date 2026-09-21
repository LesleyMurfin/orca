/**
 * GAP-03: offline paired clients retain stale tabs in their cached host partition and re-inject
 * them into the merged session on reconnect.
 *
 * `adoptStrandedHostPartitionSession` (src/shared/workspace-session-stranded-partition-adoption.ts)
 * treats a `base` worktree as "owned" — and therefore protected from adoption — only when it holds
 * a NON-EMPTY `tabsByWorktree` row (`workspacesTheBaseOwns`). When every tab for a worktree has
 * been closed server-side while a client was disconnected, the base's row for that worktree goes
 * to empty/absent, so it is no longer "owned". The stranded/cached host partition — the client's
 * stale on-disk mirror of a runtime/ssh host session from before it went offline — still carries
 * the closed tabs, and `adoptStrandedHostPartitionSession` unconditionally folds them back into the
 * merged session, re-injecting tabs the user (or another client) explicitly closed while this
 * client was away. That merged session is then the payload the next
 * `persistWorkspaceSessionByHost`/`patchWorkspaceSessionByHost` call round-trips back to the host
 * partition and broadcasts to every other connected client — the "ghost tab" resurrection reported
 * in revive_labs#962 and filed upstream as stablyai/orca#22038.
 *
 * Contrast with the sibling `workspace-session-ssh-partition-ownership.test.ts` suite: those tests
 * pin the #12721 protection (an empty PARTITION row is not proof of absence, and a base's own
 * unsaved draft must survive when the OTHER side is empty). This suite pins the opposite gap: an
 * empty BASE row is treated as "nothing to protect", so a stale but non-empty host row wins even
 * though it names tabs the base has no record of intentionally reopening.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const REPO_ID = 'repo-remote'
const WORKTREE_ID = `${REPO_ID}::/remote/checkout`

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** A session read whose partitions are exactly what persistence holds, plus its census. */
function partitionedApi(partitions: Partial<Record<string, WorkspaceSessionState>>) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession(),
    listHostIds: async () =>
      Object.keys(partitions).flatMap((hostId) => normalizeExecutionHostId(hostId) ?? [])
  }
}

describe('GAP-03: offline client reconnect must not resurrect server-closed tabs', () => {
  it('does not re-adopt a tab that was closed on the host while this client was offline', async () => {
    // The client's LOCAL read reflects current truth: the worktree's tabs were all closed while
    // this client was disconnected, so its `tabsByWorktree` row is now empty/absent.
    // The `ssh:<targetId>` partition is this client's STALE on-disk cache from before it went
    // offline: it still names the two now-closed tabs.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)]
          }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    // Expected: reconnect purges the stale cached tabs instead of reinjecting them into the
    // merged session (and, downstream, back into the host partition and every other client).
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })
})

describe('GAP-03 non-regression: #12721 offline-created local work must survive reconnect', () => {
  it('keeps a genuinely offline-created tab that was never synced to the host partition', async () => {
    // This client created a tab entirely offline — the host partition (mirroring the last state
    // synced from the server before disconnect) has nothing for this worktree at all, because the
    // tab never existed server-side. `hostHasNothingFor` / the empty-host-row rule from #12721 is
    // exactly what must keep protecting this: an empty host row is never adopted, so it cannot
    // out-rank the base's real, populated row.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-offline-draft', WORKTREE_ID)] }
        }),
        [SSH_HOST_ID]: session({})
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-offline-draft'
    ])
  })
})
