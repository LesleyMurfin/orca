import type { GitWorktreeInfo } from './worktree/types'

export type GitMainWorktreePathLocation = {
  topLevel: string
  commonDir: string
  gitDir: string
}

export type GitWorktreePathEquality = (leftPath: string, rightPath: string) => boolean

export type NormalizeMainWorktreePathArgs = {
  worktrees: GitWorktreeInfo[]
  mainIndex: number
  repoPath: string
  location?: GitMainWorktreePathLocation | null
  arePathsEqual: GitWorktreePathEquality
}

/**
 * Pure main-entry path normalization for separate-git-dir listings.
 *
 * Mirrors desktop/relay list readers: rewrite the porcelain main path onto the
 * real working toplevel only when rev-parse says the main entry is the common
 * git dir and that git-dir is the common dir (not a linked worktree private dir).
 * See #23631 — a linked worktree of bare/separate-git-dir must not steal or
 * duplicate the main row path.
 */
export function normalizeMainWorktreePaths({
  worktrees,
  mainIndex,
  repoPath,
  location,
  arePathsEqual
}: NormalizeMainWorktreePathArgs): GitWorktreeInfo[] {
  const mainWorktree = mainIndex >= 0 ? worktrees[mainIndex] : undefined
  if (!mainWorktree) {
    return worktrees
  }

  if (arePathsEqual(mainWorktree.path, repoPath)) {
    return worktrees
  }

  if (!location) {
    return worktrees
  }

  // Why: only separate-git-dir/submodule mains report path == git-common-dir.
  if (!arePathsEqual(mainWorktree.path, location.commonDir)) {
    return worktrees
  }

  // Why: linked worktree of bare/separate-git-dir passes path==commonDir via the bare/main
  // git dir, but its own git-dir is not the common dir; rewriting would stamp main onto that
  // folder and duplicate the path (#23631).
  if (!arePathsEqual(location.gitDir, location.commonDir)) {
    return worktrees
  }

  const normalized = [...worktrees]
  normalized[mainIndex] = { ...mainWorktree, path: location.topLevel }
  return normalized
}
