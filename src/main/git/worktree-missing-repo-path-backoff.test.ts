// PRB-0003: `git worktree list` must stop re-spawning against a confirmed-missing repo path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import {
  _resetWorktreeMissingPathBackoffForTests,
  _resetWorktreeScanCacheForTests,
  addWorktree,
  listWorktreeGraph,
  listWorktrees
} from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

// Why: a fresh Error per rejection — a shared instance would let one settled
// rejection be reused across calls and hide ordering bugs.
const enoent = (): Error => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })

const worktreeListOutput = (path: string): string =>
  `worktree ${path}\nHEAD abc123\nbranch refs/heads/main\n`

// Why: assert on `worktree list` spawns specifically, not total mock calls —
// PRB-0003 is a hot loop of *that* spawn, and capability discovery or config
// reads would otherwise make the counts read as unrelated noise.
function worktreeListSpawns(): number {
  return gitExecFileAsyncMock.mock.calls.filter((call) => {
    const args = call[0] as string[]
    return args[0] === 'worktree' && args[1] === 'list'
  }).length
}

describe('listWorktrees missing-repo-path backoff', () => {
  // Why: a stale workspace path re-enumerated on every status poll used to
  // re-spawn `git worktree list` with a missing cwd, each failing `spawn git
  // ENOENT`. Once the directory is confirmed missing we must back off instead
  // of hot-looping. node:fs/promises is intentionally NOT mocked so stat()
  // genuinely ENOENTs on these non-existent paths.
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetWorktreeScanCacheForTests()
    _resetWorktreeMissingPathBackoffForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    gitExecFileAsyncMock.mockReset()
    _resetWorktreeScanCacheForTests()
    _resetWorktreeMissingPathBackoffForTests()
  })

  it('spawns git only once across sequential lists of a confirmed-missing path', async () => {
    // Sequential (awaited) calls defeat the in-flight-scan dedupe — each scan
    // settles and is removed before the next starts — so this exercises the
    // backoff memo itself, not the dedupe. Without the fix each call spawns.
    const missingPath = `/does-not-exist-backoff-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(enoent())

    await expect(listWorktrees(missingPath)).resolves.toEqual([])
    await expect(listWorktrees(missingPath)).resolves.toEqual([])
    await expect(listWorktrees(missingPath)).resolves.toEqual([])

    expect(worktreeListSpawns()).toBe(1)
  })

  it('backs off signal-path callers too (they bypass the in-flight dedupe)', async () => {
    // Signal callers route straight to the unshared scan, so if the memo were
    // consulted only via the dedupe they would still hot-loop. Assert the memo
    // suppresses them as well.
    const missingPath = `/does-not-exist-backoff-signal-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(enoent())

    await expect(
      listWorktrees(missingPath, { signal: new AbortController().signal })
    ).resolves.toEqual([])
    await expect(
      listWorktrees(missingPath, { signal: new AbortController().signal })
    ).resolves.toEqual([])

    expect(worktreeListSpawns()).toBe(1)
  })

  it('probes again only after the backoff window elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const missingPath = `/does-not-exist-backoff-window-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(enoent())

    await expect(listWorktrees(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // Within the window: no fresh spawn.
    await expect(listWorktrees(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // Past the window: the memo expires and a fresh probe is allowed.
    vi.setSystemTime(30_000)
    await expect(listWorktrees(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(2)
  })

  it('does NOT back off on a non-ENOENT git failure (transient error still re-probes)', async () => {
    // The fix must only memoize a *confirmed missing directory*. A transient
    // failure (locked index, IO error) must not suppress the next real scan,
    // or a live repo would be hidden for the whole window.
    const path = `/repo-transient-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(new Error('fatal: unable to read tree'))

    await expect(listWorktrees(path)).resolves.toEqual([])
    await expect(listWorktrees(path)).resolves.toEqual([])

    expect(worktreeListSpawns()).toBe(2)
  })

  it("does NOT back off on a 'not a git repository' failure", async () => {
    // The path exists but isn't a repo — never a missing-path condition, so it
    // must keep re-probing (the dir could become a repo).
    const path = `/not-a-repo-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(new Error('fatal: not a git repository'))

    await expect(listWorktrees(path)).resolves.toEqual([])
    await expect(listWorktrees(path)).resolves.toEqual([])

    expect(worktreeListSpawns()).toBe(2)
  })

  it('keys the backoff by wslDistro (different distros at one path do not share a mark)', async () => {
    const missingPath = `/does-not-exist-backoff-distro-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(enoent())

    // Distro A confirms missing and is marked.
    await expect(listWorktrees(missingPath, { wslDistro: 'Ubuntu' })).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // Distro A stays backed off; distro B is a distinct key and still probes.
    await expect(listWorktrees(missingPath, { wslDistro: 'Ubuntu' })).resolves.toEqual([])
    await expect(listWorktrees(missingPath, { wslDistro: 'Debian' })).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(2)
  })

  it('a completed worktree mutation clears the mark within the window', async () => {
    // Isolates the mutation-driven clear from timer expiry: the clock never
    // advances, so a recreated path is only re-listed because addWorktree
    // dropped the mark. Without that clear the list short-circuits to [].
    const repoPath = `/does-not-exist-backoff-mutation-${Math.random()}`
    let pathExists = false
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return pathExists
          ? Promise.resolve({ stdout: worktreeListOutput(repoPath) })
          : Promise.reject(enoent())
      }
      return Promise.resolve({ stdout: '' })
    })

    await expect(listWorktrees(repoPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // A successful mutation against the same repo proves the path exists again.
    pathExists = true
    await addWorktree(repoPath, `${repoPath}-wt`, 'feature/x', 'feature/x', false, false, {
      checkoutExistingBranch: true
    })

    // The mark is gone, so the very next list spawns (no clock advance).
    const recovered = await listWorktrees(repoPath)
    expect(recovered[0]?.path).toBe(repoPath)
    expect(worktreeListSpawns()).toBe(2)
  })
})

describe('listWorktreeGraph missing-repo-path backoff', () => {
  // The graph path carries the same guard as listWorktrees; cover it directly.
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetWorktreeScanCacheForTests()
    _resetWorktreeMissingPathBackoffForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    gitExecFileAsyncMock.mockReset()
    _resetWorktreeScanCacheForTests()
    _resetWorktreeMissingPathBackoffForTests()
  })

  it('marks on confirmed-missing, short-circuits within window, re-probes after it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const missingPath = `/does-not-exist-graph-backoff-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(enoent())

    await expect(listWorktreeGraph(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // Within the window the graph path also short-circuits without spawning.
    await expect(listWorktreeGraph(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // Past the window it probes again.
    vi.setSystemTime(30_000)
    await expect(listWorktreeGraph(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(2)
  })

  it('shares one backoff mark between listWorktrees and listWorktreeGraph', async () => {
    const missingPath = `/does-not-exist-shared-backoff-${Math.random()}`
    gitExecFileAsyncMock.mockRejectedValue(enoent())

    // listWorktrees confirms missing and marks the shared memo...
    await expect(listWorktrees(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)

    // ...so listWorktreeGraph for the same key short-circuits without spawning.
    await expect(listWorktreeGraph(missingPath)).resolves.toEqual([])
    expect(worktreeListSpawns()).toBe(1)
  })
})
