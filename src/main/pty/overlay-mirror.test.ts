import type * as NodePath from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('safeRemoveOverlay', () => {
  afterEach(() => {
    vi.doUnmock('fs')
    vi.doUnmock('path')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('refuses Windows overlay targets on a different drive than the root', async () => {
    const lstatSyncMock = vi.fn(() => ({
      isSymbolicLink: () => false,
      isDirectory: () => false
    }))
    const unlinkSyncMock = vi.fn()
    vi.doMock('fs', () => ({
      cpSync: vi.fn(),
      linkSync: vi.fn(),
      lstatSync: lstatSyncMock,
      readdirSync: vi.fn(),
      rmdirSync: vi.fn(),
      symlinkSync: vi.fn(),
      unlinkSync: unlinkSyncMock
    }))
    vi.doMock('path', async () => {
      const path = await vi.importActual<typeof NodePath>('node:path')
      return {
        ...path.win32,
        default: path.win32
      }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { safeRemoveOverlay } = await import('./overlay-mirror')
    safeRemoveOverlay(String.raw`D:\users\me\config`, String.raw`C:\orca\overlays`)

    expect(warnSpy).toHaveBeenCalledWith(
      '[overlay-mirror] refusing to remove overlay outside root: target=D:\\users\\me\\config root=C:\\orca\\overlays'
    )
    expect(lstatSyncMock).not.toHaveBeenCalled()
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })
})
