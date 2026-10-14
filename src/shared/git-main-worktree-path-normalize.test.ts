import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from './worktree/types'
import {
  normalizeMainWorktreePaths,
  type GitWorktreePathEquality
} from './git-main-worktree-path-normalize'

const posixEqual: GitWorktreePathEquality = (left, right) => left === right

const windowsEqual: GitWorktreePathEquality = (left, right) =>
  left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase()

function row(
  path: string,
  fields: Partial<Pick<GitWorktreeInfo, 'branch' | 'head' | 'isBare' | 'isMainWorktree'>> = {}
): GitWorktreeInfo {
  return {
    path,
    branch: fields.branch ?? 'refs/heads/main',
    head: fields.head ?? 'abc123',
    isBare: fields.isBare ?? false,
    isMainWorktree: fields.isMainWorktree ?? false
  }
}

describe('normalizeMainWorktreePaths', () => {
  it('returns unchanged when there is no main entry', () => {
    const worktrees = [row('/repo/feature')]
    expect(
      normalizeMainWorktreePaths({
        worktrees,
        mainIndex: -1,
        repoPath: '/repo',
        arePathsEqual: posixEqual
      })
    ).toBe(worktrees)
  })

  it('leaves a normal main path equal to repoPath unchanged without location', () => {
    const main = row('/repo', { isMainWorktree: true })
    const worktrees = [main, row('/repo-feature')]

    expect(
      normalizeMainWorktreePaths({
        worktrees,
        mainIndex: 0,
        repoPath: '/repo',
        arePathsEqual: posixEqual
      })
    ).toBe(worktrees)
  })

  it('rewrites separate-git-dir main path onto topLevel when git-dir is the common dir', () => {
    const main = row('/repo/.git', {
      branch: 'refs/heads/main',
      head: 'abc123',
      isBare: false,
      isMainWorktree: true
    })

    expect(
      normalizeMainWorktreePaths({
        worktrees: [main],
        mainIndex: 0,
        repoPath: '/repo/checkout',
        location: {
          topLevel: '/repo/checkout',
          commonDir: '/repo/.git',
          gitDir: '/repo/.git'
        },
        arePathsEqual: posixEqual
      })
    ).toEqual([
      {
        path: '/repo/checkout',
        branch: 'refs/heads/main',
        head: 'abc123',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('rewrites Windows-style separate-git-dir paths with case-insensitive equality', () => {
    const main = row('C:\\Repo\\.git', { isMainWorktree: true })

    expect(
      normalizeMainWorktreePaths({
        worktrees: [main],
        mainIndex: 0,
        repoPath: 'c:/repo/checkout',
        location: {
          topLevel: 'c:/repo/checkout',
          commonDir: 'c:/repo/.git',
          gitDir: 'c:/repo/.git'
        },
        arePathsEqual: windowsEqual
      })
    ).toEqual([
      {
        path: 'c:/repo/checkout',
        branch: 'refs/heads/main',
        head: 'abc123',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('does not rewrite when main path is not the git-common-dir', () => {
    const main = row('/repo', { isMainWorktree: true })
    const worktrees = [main]

    expect(
      normalizeMainWorktreePaths({
        worktrees,
        mainIndex: 0,
        repoPath: '/repo/linked',
        location: {
          topLevel: '/repo/linked',
          commonDir: '/repo/.git',
          gitDir: '/repo/.git'
        },
        arePathsEqual: posixEqual
      })
    ).toBe(worktrees)
  })

  it('does not rewrite when git-dir differs from common-dir (linked bare/separate-git-dir)', () => {
    // Bare main + linked checkout: path==commonDir, but git-dir is the worktree private dir.
    // #23631 keeps the bare main row; no path rewrite and no primary steal onto the linked folder.
    const bare = row('/project/.bare', {
      branch: '',
      head: 'deadbeef',
      isBare: true,
      isMainWorktree: true
    })
    const checkout = row('/project/main', {
      branch: 'refs/heads/main',
      head: 'abc123',
      isBare: false
    })
    const worktrees = [bare, checkout]

    expect(
      normalizeMainWorktreePaths({
        worktrees,
        mainIndex: 0,
        repoPath: '/project/main',
        location: {
          topLevel: '/project/main',
          commonDir: '/project/.bare',
          gitDir: '/project/.bare/worktrees/main'
        },
        arePathsEqual: posixEqual
      })
    ).toBe(worktrees)
  })

  it('returns unchanged when location is missing', () => {
    const main = row('/repo/.git', { isMainWorktree: true })
    const worktrees = [main]

    expect(
      normalizeMainWorktreePaths({
        worktrees,
        mainIndex: 0,
        repoPath: '/repo/checkout',
        arePathsEqual: posixEqual
      })
    ).toBe(worktrees)
  })
})
