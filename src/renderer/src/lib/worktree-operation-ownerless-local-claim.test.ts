import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'

/**
 * Boundaries of the one branch that turns absent owner fields into positive LOCAL identity.
 * Claiming a row that actually lives on a runtime or SSH host would spawn a terminal — or delete a
 * workspace — on the wrong machine, so every shape carrying host evidence must be proven to leave
 * before that branch is reached, and runtime ingestion must be proven to always stamp.
 */
const WORKTREE_ID = 'repo-1::/srv/worktree'
const HYDRATED_MULTI_RUNTIME = {
  runtimeEnvironmentCatalogHydrated: true,
  runtimeEnvironments: [{ id: 'hub-a' } as never, { id: 'hub-b' } as never]
}
const LOCAL_CLAIM = {
  kind: 'resolved',
  route: { executionHostId: 'local', runtimeEnvironmentId: null }
}

function worktree(hostId?: Worktree['hostId'], runtimeOwnerEnvironmentId?: string): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/srv/worktree',
    hostId,
    runtimeOwnerEnvironmentId
  } as Worktree
}

describe('the ownerless-row local claim never swallows a hosted row', () => {
  it('claims the ownerless row itself — the state this branch exists for', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree()] }
        },
        WORKTREE_ID
      )
    ).toEqual(LOCAL_CLAIM)
  })

  it('leaves a runtime-stamped row on its runtime', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree('runtime:hub-b')] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'runtime:hub-b', runtimeEnvironmentId: 'hub-b' }
    })
  })

  it('leaves a row carrying only a runtime owner id on that runtime', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree(undefined, 'hub-b')] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: null, runtimeEnvironmentId: 'hub-b' }
    })
  })

  it('leaves an ssh-stamped row on its ssh host', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree('ssh:box')] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'ssh:box', runtimeEnvironmentId: null }
    })
  })

  it('leaves an ownerless row whose repo names a runtime on that runtime', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1', executionHostId: 'runtime:hub-b' } as never],
          worktreesByRepo: { 'repo-1': [worktree()] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'runtime:hub-b', runtimeEnvironmentId: 'hub-b' }
    })
  })

  // Why: this repo carries no executionHostId at all, only a connectionId — the host comes out of
  // getRepoExecutionHostId's ssh fallback, so "no host field on the repo" must not read as local.
  it('leaves an ownerless row whose repo carries only an ssh connection on that ssh host', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1', connectionId: 'box' } as never],
          worktreesByRepo: { 'repo-1': [worktree()] }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'ssh:box', runtimeEnvironmentId: null }
    })
  })

  it('leaves a runtime-stamped detected row on its runtime', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1' } as never],
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree('runtime:hub-b')] } as never
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'runtime:hub-b', runtimeEnvironmentId: 'hub-b' }
    })
  })

  it('keeps the runtime owner when a second projection of the same id is ownerless', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree()] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree('runtime:hub-b')] } as never
          }
        },
        WORKTREE_ID
      )
    ).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'runtime:hub-b', runtimeEnvironmentId: 'hub-b' }
    })
  })

  it('refuses the claim while the runtime catalog has not hydrated', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          runtimeEnvironments: HYDRATED_MULTI_RUNTIME.runtimeEnvironments,
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree()] }
        },
        WORKTREE_ID
      )
    ).not.toEqual(LOCAL_CLAIM)
  })

  it('refuses the claim while a removed runtime could have owned the row', () => {
    expect(
      resolveWorktreeOperationRouteResult(
        {
          ...HYDRATED_MULTI_RUNTIME,
          removedRuntimeEnvironmentIds: new Set(['hub-gone']),
          repos: [{ id: 'repo-1' } as never],
          worktreesByRepo: { 'repo-1': [worktree()] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })
})

/**
 * The claim above is only safe because a runtime-owned row can never REACH the store ownerless:
 * both ingestion boundaries stamp it. Without these, a hostless row on a paired client could be a
 * runtime's workspace and the claim would route it to the wrong machine.
 */
describe('runtime ingestion always stamps the rows the local claim would otherwise see', () => {
  it('stamps a fetched runtime worktree with its host and runtime owner', () => {
    expect(withRepoHostOwnership(worktree(), 'runtime:hub-b')).toMatchObject({
      hostId: 'runtime:hub-b',
      runtimeOwnerEnvironmentId: 'hub-b'
    })
  })

  it('stamps a fetched runtime repo with its runtime host even when the host reports none', () => {
    expect(
      repoWithFetchedOwner({ id: 'repo-1', executionHostId: null } as Repo, {
        kind: 'environment',
        environmentId: 'hub-b'
      } as never).executionHostId
    ).toBe('runtime:hub-b')
  })
})
