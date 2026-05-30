import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { isDescendantOrEqual, validateGitRelativeFilePath } from './filesystem-auth'

describe('filesystem-auth path containment', () => {
  it('allows descendants whose path segment starts with dotdot characters', () => {
    const root = resolve('/workspace/repo')
    const child = resolve('/workspace/repo/..fixtures/file.ts')

    expect(isDescendantOrEqual(child, root)).toBe(true)
  })

  it('allows git-relative files under dotdot-prefixed child directories', () => {
    expect(validateGitRelativeFilePath(resolve('/workspace/repo'), '..fixtures/file.ts')).toBe(
      '..fixtures/file.ts'
    )
  })

  it('still rejects parent-directory escapes', () => {
    const root = resolve('/workspace/repo')
    const outside = resolve('/workspace/repo/../other/file.ts')

    expect(isDescendantOrEqual(outside, root)).toBe(false)
    expect(() => validateGitRelativeFilePath(root, '../other/file.ts')).toThrow(
      'Access denied: git file path escapes the selected worktree'
    )
  })
})
