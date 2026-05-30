import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeRemoveOverlay } from './overlay-mirror'

const tempRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('safeRemoveOverlay', () => {
  it('removes valid overlay children whose names start with dot-dot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-overlay-root-'))
    tempRoots.push(root)
    const overlayDir = join(root, '..session-overlay')
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'marker.txt'), 'overlay')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    safeRemoveOverlay(overlayDir, root)

    expect(existsSync(overlayDir)).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
