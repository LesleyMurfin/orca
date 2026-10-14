import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'

const repo: Repo = {
  id: 'workspace-query',
  path: '/tmp/workspace-query',
  displayName: 'Workspace query',
  addedAt: 1,
  badgeColor: 'blue'
}
const resolved: ResolvedWorktree = {
  ...store.getWorktreeMeta(TEST_WORKTREE_ID),
  id: TEST_WORKTREE_ID,
  repoId: 'repo-1',
  path: '/tmp/worktree-a',
  branch: 'main',
  displayName: 'Workspace',
  linkedIssue: null,
  comment: '',
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  git: {
    path: '/tmp/worktree-a',
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}
const snapshot: ResolvedWorktreeSnapshot = {
  worktrees: [resolved],
  platformByRepoId: new Map()
}

describe('workspace query prototype dispatch', () => {
  it('preserves callable arity and native async methods', () => {
    class Probe extends OrcaRuntimeService {
      read() {
        return {
          arities: [
            this.resolveWorktreeSelector.length,
            this.resolveRepoSelector.length,
            this.buildResolvedWorktreeFromId.length,
            this.listKnownResolvedWorktreesForExplicitTarget.length,
            this.resolveExplicitWorktreeIdScoped.length,
            this.listRepoWorktreesForListing.length,
            this.invalidateWorktreeScanCacheForRepo.length
          ],
          kinds: [
            this.resolveWorktreeSelector,
            this.resolveRepoSelector,
            this.listResolvedWorktrees,
            this.listResolvedWorktreeSnapshot,
            this.selectReposBySelector
          ].map((fn) => fn.constructor.name)
        }
      }
    }
    expect(new Probe(store).read()).toEqual({
      arities: [1, 1, 1, 2, 2, 2, 1],
      kinds: ['AsyncFunction', 'AsyncFunction', 'AsyncFunction', 'AsyncFunction', 'Function']
    })
  })

  it('re-enters the runtime repo selector', async () => {
    const seen: unknown[][] = []
    class Probe extends OrcaRuntimeService {
      protected override selectReposBySelector(selector: string): Repo[] {
        seen.push([this, selector])
        return [repo]
      }
      run() {
        return this.resolveRepoSelector('id:workspace-query')
      }
    }
    const runtime = new Probe(store)
    await expect(runtime.run()).resolves.toBe(repo)
    expect(seen).toEqual([[runtime, 'id:workspace-query']])
  })

  it('re-enters the runtime snapshot from async listing', async () => {
    const seen: OrcaRuntimeService[] = []
    class Probe extends OrcaRuntimeService {
      protected override async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
        seen.push(this)
        return snapshot
      }
      run() {
        return this.listResolvedWorktrees()
      }
    }
    const runtime = new Probe(store)
    await expect(runtime.run()).resolves.toEqual([resolved])
    expect(seen).toEqual([runtime])
  })

  it('calls the runtime scoped resolver with the original single argument', async () => {
    const seen: { receiver: OrcaRuntimeService; args: unknown[] }[] = []
    class Probe extends OrcaRuntimeService {
      protected override hasFreshResolvedWorktreeCache(): boolean {
        return false
      }
      protected override async resolveExplicitWorktreeIdScoped(
        _worktreeId: string,
        _hostId?: ExecutionHostId
      ): Promise<ResolvedWorktree> {
        seen.push({ receiver: this, args: Array.from(arguments) })
        return resolved
      }
      run() {
        return this.resolveWorktreeSelector(`id:${TEST_WORKTREE_ID}`)
      }
    }
    const runtime = new Probe(store)
    await expect(runtime.run()).resolves.toBe(resolved)
    expect(seen).toEqual([{ receiver: runtime, args: [TEST_WORKTREE_ID] }])
  })

  it('allocates the five canonical cells before the real cache constructor seam', () => {
    const phases: boolean[][] = []
    class Probe extends OrcaRuntimeService {
      protected override get canonicalFetchKeyCache() {
        phases.push(
          [
            'resolvedWorktrees',
            'worktreeScanGenerations',
            'worktreeScanCache',
            'worktreeScanInFlight',
            'worktreeAdminFingerprintProbes'
          ].map((key) => Object.getOwnPropertyDescriptor(this, key) !== undefined)
        )
        return super.canonicalFetchKeyCache
      }
    }
    new Probe(store)
    expect(phases).toEqual([[true, true, true, true, true]])
  })

  it('keeps early construction refusals as Promises', async () => {
    const phases: { repo: Promise<Repo>; rows: Promise<ResolvedWorktree[]> }[] = []
    class Probe extends OrcaRuntimeService {
      protected override get canonicalFetchKeyCache() {
        phases.push({
          repo: this.resolveRepoSelector('id:absent'),
          rows: this.listResolvedWorktrees()
        })
        return super.canonicalFetchKeyCache
      }
    }
    new Probe(null)
    expect(phases).toHaveLength(1)
    for (const phase of phases) {
      expect(phase.repo).toBeInstanceOf(Promise)
      expect(phase.rows).toBeInstanceOf(Promise)
      await expect(phase.repo).rejects.toThrow('repo_not_found')
      await expect(phase.rows).resolves.toEqual([])
    }
  })

  it('keeps disconnected SSH stored rows with a failed scan verdict', async () => {
    class Probe extends OrcaRuntimeService {
      run(remote: Repo) {
        return this.listRepoWorktreesForResolutionUncached(remote, undefined)
      }
    }
    const remote: Repo = { ...repo, executionHostId: 'ssh:workspace-query' }
    const id = `${repo.id}::/remote/stored-worktree`
    const meta = {
      ...store.getWorktreeMeta(TEST_WORKTREE_ID),
      hostId: remote.executionHostId,
      customName: 'Stored',
      comment: '',
      issueNumber: null,
      issueUrl: null,
      issueTitle: null,
      mergeStatus: null
    }
    const runtime = new Probe({
      ...store,
      getRepos: () => [remote],
      getAllWorktreeMeta: () => ({ [id]: meta }),
      getWorktreeMeta: () => meta
    })
    const result = await runtime.run(remote)
    expect(result.ok).toBe(false)
    expect(result.worktrees.map((row) => row.path)).toEqual(['/remote/stored-worktree'])
  })
})
