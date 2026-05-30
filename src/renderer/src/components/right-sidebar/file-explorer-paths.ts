import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { splitPathSegments } from './path-tree'

export function normalizeAbsolutePath(path: string): string {
  const isUncPath = /^[\\/]{2}[^\\/]/.test(path)
  const normalizedPath = path.replace(/[\\/]+/g, '/')
  const pathWithUncRoot =
    isUncPath && !normalizedPath.startsWith('//') ? `/${normalizedPath}` : normalizedPath

  if (pathWithUncRoot === '/') {
    return pathWithUncRoot
  }

  if (/^[A-Za-z]:\/$/.test(pathWithUncRoot)) {
    return pathWithUncRoot
  }

  return pathWithUncRoot.replace(/\/+$/, '')
}

function isCaseInsensitiveAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(path) || path.startsWith('//')
}

function getPathComparisonKey(path: string): string {
  // Why: Windows drive and UNC paths are case-insensitive; POSIX paths are not.
  return isCaseInsensitiveAbsolutePath(path) ? path.toLowerCase() : path
}

export function isPathEqualOrDescendant(candidatePath: string, targetPath: string): boolean {
  const normalizedCandidate = normalizeAbsolutePath(candidatePath)
  const normalizedTarget = normalizeAbsolutePath(targetPath)
  const candidateKey = getPathComparisonKey(normalizedCandidate)
  const targetKey = getPathComparisonKey(normalizedTarget)
  const targetPrefix = targetKey.endsWith('/') ? targetKey : `${targetKey}/`

  return (
    candidateKey === targetKey || (targetKey.length > 0 && candidateKey.startsWith(targetPrefix))
  )
}

export function getRevealAncestorDirs(worktreePath: string, filePath: string): string[] | null {
  const relativePath = getRelativePathInsideRoot(filePath, worktreePath)
  if (relativePath === null) {
    return null
  }

  const segments = splitPathSegments(relativePath)
  const ancestorDirs: string[] = []
  let currentPath = worktreePath

  for (const segment of segments.slice(0, -1)) {
    currentPath = joinPath(currentPath, segment)
    ancestorDirs.push(currentPath)
  }

  return ancestorDirs
}
