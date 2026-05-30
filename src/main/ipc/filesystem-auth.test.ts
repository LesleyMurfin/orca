import type * as NodePath from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isDescendantOrEqual', () => {
  afterEach(() => {
    vi.doUnmock('path')
    vi.doUnmock('../repo-worktrees')
    vi.resetModules()
  })

  it('accepts Windows descendants when drive and root casing differ', async () => {
    vi.resetModules()
    vi.doMock('../repo-worktrees', () => ({
      isRepoRoot: vi.fn(),
      listRepoWorktrees: vi.fn()
    }))
    vi.doMock('path', async () => {
      const path = await vi.importActual<typeof NodePath>('node:path')
      return {
        ...path.win32,
        default: path.win32
      }
    })

    const { isDescendantOrEqual } = await import('./filesystem-auth')

    expect(isDescendantOrEqual(String.raw`c:\repo\src\app.ts`, String.raw`C:\Repo`)).toBe(true)
    expect(isDescendantOrEqual(String.raw`D:\repo\src\app.ts`, String.raw`C:\Repo`)).toBe(false)
  })
})
