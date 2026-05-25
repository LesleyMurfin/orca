import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type * as NodeOs from 'node:os'
import { join } from 'path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import {
  getCodexSessionDirectories,
  getCodexSessionsDirectory,
  listCodexSessionFiles
} from './scanner'

const originalCodexHome = process.env.CODEX_HOME
let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  delete process.env.CODEX_HOME
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-usage-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-usage-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('getCodexSessionsDirectory', () => {
  it('defaults to Orca-managed Codex runtime sessions', () => {
    expect(getCodexSessionsDirectory()).toBe(
      join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    )
  })

  it('ignores an ambient CODEX_HOME override', () => {
    process.env.CODEX_HOME = '/tmp/explicit-codex-home'

    expect(getCodexSessionsDirectory()).toBe(
      join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    )
  })
})

describe('listCodexSessionFiles', () => {
  it('scans both Orca-managed and system Codex session homes', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const runtimeSessionPath = join(runtimeSessionsDir, 'runtime.jsonl')
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    writeFileSync(runtimeSessionPath, '{}\n', 'utf-8')
    writeFileSync(systemSessionPath, '{}\n', 'utf-8')

    expect(getCodexSessionDirectories()).toEqual([runtimeSessionsDir, systemSessionsDir])
    expect(await listCodexSessionFiles()).toEqual([runtimeSessionPath, systemSessionPath].sort())
  })
})
