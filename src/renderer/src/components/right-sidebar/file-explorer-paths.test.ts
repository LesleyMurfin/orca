import { describe, expect, it } from 'vitest'
import {
  getRevealAncestorDirs,
  isPathEqualOrDescendant,
  normalizeAbsolutePath
} from './file-explorer-paths'

describe('file explorer paths', () => {
  it('preserves Windows UNC roots while normalizing separators', () => {
    expect(normalizeAbsolutePath('\\\\Server\\Share\\Repo\\')).toBe('//Server/Share/Repo')
  })

  it('matches Windows drive paths case-insensitively', () => {
    expect(isPathEqualOrDescendant('C:\\Repo\\src\\app.ts', 'c:\\repo')).toBe(true)
  })

  it('matches Windows UNC paths case-insensitively', () => {
    expect(
      isPathEqualOrDescendant('\\\\Server\\Share\\Repo\\src\\app.ts', '\\\\server\\share\\repo')
    ).toBe(true)
  })

  it('keeps POSIX paths case-sensitive', () => {
    expect(isPathEqualOrDescendant('/Repo/src/app.ts', '/repo')).toBe(false)
  })

  it('builds reveal ancestors for Windows paths even when casing differs', () => {
    expect(getRevealAncestorDirs('C:\\Repo', 'c:\\repo\\src\\app.ts')).toEqual(['C:\\Repo\\src'])
  })
})
