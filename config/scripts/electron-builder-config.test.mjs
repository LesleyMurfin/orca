import { createRequire } from 'node:module'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

describe('electron-builder config', () => {
  it('uses the multi-size icon source for Linux packages', () => {
    expect(electronBuilderConfig.linux.icon).toBe('resources/build/icon.icns')
  })

  it.skipIf(process.platform === 'win32')(
    'marks the packaged Unix CLI launcher executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-config-'))
      const resourcesDir = join(root, 'linux-unpacked', 'resources')
      const launcherPath = join(resourcesDir, 'bin', 'orca')
      await mkdir(join(resourcesDir, 'bin'), { recursive: true })
      await writeFile(launcherPath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o644 })

      await electronBuilderConfig.afterPack({
        appOutDir: join(root, 'linux-unpacked'),
        electronPlatformName: 'linux'
      })

      expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
    }
  )
})
