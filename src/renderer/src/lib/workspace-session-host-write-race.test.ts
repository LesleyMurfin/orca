/**
 * GAP-03 Write Race Protection (revive_labs#962 / stablyai/orca#22038, PR #968 deferred scenario):
 * does the client's own wake-triggered session write (`persistWorkspaceSessionByHost`) undo a
 * server-side tab close it just correctly declined to adopt?
 *
 * `projects/orca-serve-tab-lifecycle/upstream/filing-drafts/GAP-03-offline-client-reconciliation.md`
 * §2 row 6 ("Step 4: Close & Teardown") describes the defect as: "Client write race overwrites
 * server-side tab close operations ... `patchWorkspaceSessionByHost` fires on client wake, racing
 * against server event streams." The proposed fix (§5.2) was a `hasPendingReconnectionHandshake`
 * write-gate on `persistWorkspaceSessionByHost` that defers any write until an authoritative
 * reconnect handshake settles.
 *
 * This suite answers, with test evidence, whether that gate is actually necessary given the
 * shipped fix's own mechanism: `adoptStrandedHostPartitionSession` never deletes a declined row —
 * it leaves it in the host partition slice, and `partitionRowsTheWriteWontReturn` parks every
 * row this read declined to adopt into `contestedHostWorkspaceSessions[hostId]`, which
 * `attachHostSessionShadow` re-attaches into the SAME host's write-side slice on the next write —
 * but ONLY if that host already has a slice in the write (i.e. something else this boot routes
 * there). Whether a wake-triggered write actually resurrects a declined tab therefore depends on
 * whether anything else makes `persistWorkspaceSessionByHost`/`patchWorkspaceSessionByHost` touch
 * that specific host partition at all in the same call.
 *
 * Verdict, resolved: write-race protection is provided by `shadowRowsTheHostHasNotAnswered`
 * (`workspace-session-host-shadow-testimony.ts`), which withholds parked rows from the write-side
 * shadow once the host has answered for that target (positive testimony via landed, non-conflicting
 * remote-workspace hydration). While the host has NOT answered, preserving parked rows remains the
 * only safe move — this file stands guard against re-introducing the reverted naive drop that
 * unconditionally dropped parked rows without positive host testimony and caused unrecoverable data
 * loss on Concurrent Active Edits.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  persistWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const REPO_ID = 'repo-remote'
const WORKTREE_ID = `${REPO_ID}::/remote/checkout`
const SIBLING_REPO_ID = `${REPO_ID}-2`
const SIBLING_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/sibling`

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

function partitionedApi(partitions: Partial<Record<string, WorkspaceSessionState>>) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession(),
    listHostIds: async () =>
      Object.keys(partitions).flatMap((hostId) => normalizeExecutionHostId(hostId) ?? [])
  }
}

function capturingApi() {
  const captured: Partial<Record<string, WorkspaceSessionState>> = {}
  return {
    captured,
    api: {
      get: async () => getDefaultWorkspaceSession(),
      patch: async () => {},
      setSync: () => {},
      set: async (payload: WorkspaceSessionState, hostId?: ExecutionHostId) => {
        captured[hostId ?? 'local'] = payload
      },
      flush: async () => {}
    }
  }
}

describe('GAP-03 Write Race Protection', () => {
  it('a wake-triggered write for a worktree with nothing else on the same host never even touches that host partition, so the declined tabs cannot round-trip back', async () => {
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
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
    }

    await persistWorkspaceSessionByHost(api as never, read.session, state)

    expect(captured[SSH_HOST_ID]).toBeUndefined()
  })

  it('still routes a declined row back into the host partition while the host has not answered for that target — preserving is the only safe move when nothing has superseded the parked verdict', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )
    // Read-time behavior is correct: WORKTREE_ID declined, SIBLING_WORKTREE_ID also parked (the
    // documented "Concurrent Active Edits" boundary — see workspace-session-host-offline-reconnect.test.ts).
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(read.session.tabsByWorktree[SIBLING_WORKTREE_ID]).toBeUndefined()

    // Now simulate the SAME host legitimately gaining a write target this boot: the user opens a
    // brand-new local tab that main's own routing places on this SSH host (e.g. a fresh worktree
    // the user just created there). This is enough to force a slice for SSH_HOST_ID to exist on
    // the very next wake-triggered write.
    const NEW_LOCAL_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/new-tab`
    const payloadWithFreshLocalActivity: WorkspaceSessionState = {
      ...read.session,
      tabsByWorktree: {
        ...read.session.tabsByWorktree,
        [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
      }
    }

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ],
        [SIBLING_REPO_ID]: [
          {
            id: NEW_LOCAL_WORKTREE_ID,
            repoId: SIBLING_REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
    }

    await persistWorkspaceSessionByHost(api as never, payloadWithFreshLocalActivity, state)

    // The write race, demonstrated: WORKTREE_ID's genuinely-closed tabs come back, even though the
    // read that produced this exact payload correctly declined them moments earlier.
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-2',
      'tab-3'
    ])
  })

  it('stops routing a declined row back into the host partition once the host has answered for that target', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(read.session.tabsByWorktree[SIBLING_WORKTREE_ID]).toBeUndefined()

    const NEW_LOCAL_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/new-tab`
    const payloadWithFreshLocalActivity: WorkspaceSessionState = {
      ...read.session,
      tabsByWorktree: {
        ...read.session.tabsByWorktree,
        [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
      }
    }

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ],
        [SIBLING_REPO_ID]: [
          {
            id: NEW_LOCAL_WORKTREE_ID,
            repoId: SIBLING_REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey,
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: { [TARGET_ID]: { phase: 'synced' } }
    }

    await persistWorkspaceSessionByHost(api as never, payloadWithFreshLocalActivity, state)

    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]).toBeUndefined()
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[SIBLING_WORKTREE_ID]).toBeUndefined()
    expect(
      captured[SSH_HOST_ID]?.tabsByWorktree?.[NEW_LOCAL_WORKTREE_ID]?.map((e) => e.id)
    ).toEqual(['tab-fresh'])
  })
})
