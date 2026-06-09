import { execFile, execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile,
  hardenSecurePath,
  writeSecureFile
} from './secure-file'

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn()
}))

describe('hardenSecurePath', () => {
  const originalSystemRoot = process.env.SystemRoot
  const originalWindir = process.env.WINDIR
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    process.env.SystemRoot = 'C:\\Windows'
    delete process.env.WINDIR
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    vi.mocked(execFileSync).mockReset()
    vi.mocked(execFile).mockReset()
    // whoami.exe is still called synchronously to obtain the user SID
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === 'C:\\Windows\\System32\\whoami.exe') {
        return '"USER","S-1-5-21-1000"'
      }
      return ''
    })
    // PowerShell is now called asynchronously; simulate immediate success
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        callback(null, '', '')
      }
      return {} as ReturnType<typeof execFile>
    })
  })

  afterEach(() => {
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
    if (originalWindir === undefined) {
      delete process.env.WINDIR
    } else {
      process.env.WINDIR = originalWindir
    }
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites Windows ACLs through the system PowerShell path', () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })

    // whoami.exe called synchronously to obtain SID
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'C:\\Windows\\System32\\whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
    // PowerShell called asynchronously
    const [powershellFile, powershellArgs, powershellOptions] = vi.mocked(execFile).mock.calls[0]!
    expect(powershellFile).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    expect(powershellArgs).toEqual(
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        'C:\\Users\\me\\.orca\\secret.json',
        'S-1-5-21-1000',
        '0'
      ])
    )
    const script = (powershellArgs as string[])[5]!
    expect(script).toContain('SetAccessRuleProtection($true, $false)')
    expect(script).toContain('RemoveAccessRuleSpecific')
    expect(script).toContain('Unexpected ACL entry')
    expect(powershellOptions).toEqual(
      expect.objectContaining({ windowsHide: true, timeout: 5000 })
    )
  })

  it('adds inheritable rules when hardening a Windows directory', () => {
    hardenSecurePath('C:\\Users\\me\\.orca', { isDirectory: true, platform: 'win32' })

    const powershellArgs = vi.mocked(execFile).mock.calls[0]![1] as string[]
    expect(powershellArgs.at(-1)).toBe('1')
    expect(powershellArgs[5]).toContain('ContainerInherit')
    expect(powershellArgs[5]).toContain('ObjectInherit')
  })

  it('keeps Windows hardening best-effort when ACL rewriting fails', () => {
    // Simulate async PowerShell failure — the callback receives an error
    vi.mocked(execFile).mockImplementationOnce((_file, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        callback(new Error('access denied'), '', '')
      }
      return {} as ReturnType<typeof execFile>
    })

    expect(() =>
      hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
        isDirectory: false,
        platform: 'win32'
      })
    ).not.toThrow()
  })

  it('caches successful existing-file hardening within a process', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    // dir hardened once (path-cached), file hardened once (metadata-cached) — 2 total
    expect(getPowerShellCalls()).toHaveLength(2)
    expect(getPowerShellCalls().map(getPowerShellTarget)).toEqual([userDataPath, targetPath])
  })

  it('re-hardens an existing file when its metadata changes after caching', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    await waitForFileTimestampTick()
    writeFileSync(targetPath, '{"changed":true}')
    hardenExistingSecureFile(targetPath)

    // call 1: dir + file. call 2: dir skipped (path-cached), file re-hardened (new mtime)
    expect(getPowerShellCalls()).toHaveLength(3)
    expect(getPowerShellCalls().map(getPowerShellTarget)).toEqual([
      userDataPath,
      targetPath,
      targetPath
    ])
  })

  it('keeps post-rename target hardening on every write while caching the directory', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'first')
    writeSecureFile(targetPath, 'second')

    const powershellTargets = getPowerShellCalls().map(getPowerShellTarget)
    // write 1: dir(1) + tmpFile(1) + targetFile(1) = 3
    // write 2: dir skipped + tmpFile(1) + targetFile(1) = 2
    // total = 5; dir appears once, targetPath appears twice (tmpFile paths vary)
    expect(powershellTargets).toHaveLength(5)
    expect(powershellTargets.filter((entry) => entry === userDataPath)).toHaveLength(1)
    expect(powershellTargets.filter((entry) => entry === targetPath)).toHaveLength(2)
  })

  // Regression test: #4901 — env-store reads at ~2×/s caused a PowerShell storm because the
  // parent directory mtime churned (every secure write updates it), so the mtime-keyed cache
  // never matched. Directories must be path-cached for the process lifetime.
  it('does not re-harden the parent directory when its mtime changes between reads', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    // Simulate the env-store read loop: hardenExistingSecureFile called many times while
    // another part of Orca writes to the same directory (changing its mtime).
    hardenExistingSecureFile(targetPath)
    await waitForFileTimestampTick()
    // Simulate a write to another file in the same dir (changes dir mtime)
    writeFileSync(join(userDataPath, 'other.json'), '{}')
    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    // The parent directory must be hardened exactly ONCE despite its mtime changing
    const dirCalls = getPowerShellCalls().filter(
      (call) => getPowerShellTarget(call) === userDataPath
    )
    expect(dirCalls).toHaveLength(1)
  })

  it('does not re-harden an unchanged file on repeated reads', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    const fileCalls = getPowerShellCalls().filter(
      (call) => getPowerShellTarget(call) === targetPath
    )
    expect(fileCalls).toHaveLength(1)
  })

  it('applies the ACL asynchronously without blocking (async execFile, not execFileSync)', () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })

    // PowerShell must be launched via execFile (async), never via execFileSync
    const syncPowershellCalls = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file]) =>
        String(file).endsWith('WindowsPowerShell\\v1.0\\powershell.exe')
      )
    expect(syncPowershellCalls).toHaveLength(0)
    expect(getPowerShellCalls()).toHaveLength(1)
  })
})

function getPowerShellCalls(): unknown[][] {
  return vi
    .mocked(execFile)
    .mock.calls.filter(([file]) => String(file).endsWith('WindowsPowerShell\\v1.0\\powershell.exe'))
}

function getPowerShellTarget(call: unknown[]): string {
  return (call[1] as string[])[6]!
}

async function waitForFileTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
