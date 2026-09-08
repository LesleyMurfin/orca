import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDurableDaemonScopeCommand,
  daemonScopeUnitName,
  detectOwnCgroupScopeUnit,
  isDurableDaemonScopeSupported
} from './daemon-cgroup-scope'

describe('daemonScopeUnitName', () => {
  it('prefixes the launch nonce so the unit is traceable back to a launch', () => {
    expect(daemonScopeUnitName('c0ffee12-3456-7890-abcd-ef0123456789')).toBe(
      'orca-daemon-c0ffee12-3456-7890-abcd-ef0123456789'
    )
  })

  it('sanitizes characters systemd unit names reject', () => {
    expect(daemonScopeUnitName('weird nonce/with:stuff')).toBe('orca-daemon-weird-nonce-with:stuff')
  })
})

describe('isDurableDaemonScopeSupported', () => {
  it('is false on non-Linux platforms regardless of environment', () => {
    expect(isDurableDaemonScopeSupported({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'darwin')).toBe(
      false
    )
    expect(isDurableDaemonScopeSupported({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'win32')).toBe(
      false
    )
  })

  it('never throws when XDG_RUNTIME_DIR is absent and the conventional path cannot resolve', () => {
    expect(() => isDurableDaemonScopeSupported({}, 'linux')).not.toThrow()
    expect(typeof isDurableDaemonScopeSupported({}, 'linux')).toBe('boolean')
  })

  it('is false pointed at a runtime dir with no reachable user bus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xdg-runtime-'))
    try {
      // No `bus` socket written under this fake runtime dir — the probe must fail closed.
      expect(isDurableDaemonScopeSupported({ XDG_RUNTIME_DIR: dir }, 'linux')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildDurableDaemonScopeCommand', () => {
  it('wraps the daemon command in systemd-run --user --scope with a collected unit', () => {
    const result = buildDurableDaemonScopeCommand(
      '/usr/bin/node',
      ['/opt/orca/daemon-entry.js', '--socket', '/tmp/x.sock'],
      'nonce-1',
      { PATH: '/usr/bin' }
    )
    expect(result.command).toBe('systemd-run')
    expect(result.args).toEqual([
      '--user',
      '--scope',
      '--unit=orca-daemon-nonce-1',
      '--collect',
      '--quiet',
      '--',
      '/usr/bin/node',
      '/opt/orca/daemon-entry.js',
      '--socket',
      '/tmp/x.sock'
    ])
  })

  it('preserves an explicit XDG_RUNTIME_DIR from the caller env', () => {
    const result = buildDurableDaemonScopeCommand('/usr/bin/node', [], 'n', {
      PATH: '/bin',
      XDG_RUNTIME_DIR: '/run/user/9999'
    })
    expect(result.env.XDG_RUNTIME_DIR).toBe('/run/user/9999')
  })

  it('computes the conventional /run/user/<uid> runtime dir when the caller env omits it', () => {
    const result = buildDurableDaemonScopeCommand('/usr/bin/node', [], 'n', { PATH: '/bin' })
    expect(result.env.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid?.() ?? ''}`)
  })
})

describe('detectOwnCgroupScopeUnit', () => {
  const tempFiles: string[] = []

  afterEach(() => {
    while (tempFiles.length > 0) {
      const path = tempFiles.pop()
      if (path) {
        rmSync(path, { force: true })
      }
    }
  })

  function writeCgroupFixture(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cgroup-scope-'))
    const path = join(dir, 'cgroup')
    writeFileSync(path, contents)
    tempFiles.push(path)
    return path
  }

  it('is null on non-Linux platforms without reading any file', () => {
    expect(detectOwnCgroupScopeUnit('darwin', '/nonexistent')).toBeNull()
    expect(detectOwnCgroupScopeUnit('win32', '/nonexistent')).toBeNull()
  })

  it('is null when the cgroup file cannot be read', () => {
    expect(detectOwnCgroupScopeUnit('linux', '/definitely/absent/cgroup')).toBeNull()
  })

  it('parses a v2 unified-hierarchy line naming an orca-daemon scope', () => {
    const path = writeCgroupFixture('0::/user.slice/user-1000.slice/orca-daemon-abc123.scope\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBe('orca-daemon-abc123.scope')
  })

  it('parses a v1 systemd-controller line naming an orca-daemon scope', () => {
    const path = writeCgroupFixture(
      '1:name=systemd:/user.slice/user-1000.slice/orca-daemon-def456.scope\n'
    )
    expect(detectOwnCgroupScopeUnit('linux', path)).toBe('orca-daemon-def456.scope')
  })

  it('returns null for a plain service-unit cgroup — the un-isolated case this fix targets', () => {
    const path = writeCgroupFixture('0::/system.slice/orca-serve@factory.service\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBeNull()
  })

  it('returns null for a scope unit that is not an orca-daemon one', () => {
    const path = writeCgroupFixture('0::/user.slice/user-1000.slice/some-other-app.scope\n')
    expect(detectOwnCgroupScopeUnit('linux', path)).toBeNull()
  })
})
