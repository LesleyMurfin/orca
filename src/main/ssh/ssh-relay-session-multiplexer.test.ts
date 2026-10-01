import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  buildRelaySecondConnectCommand,
  createRelaySessionMultiplexer
} from './ssh-relay-session-multiplexer'
import type { SshConnection } from './ssh-connection'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { waitForSentinelMock } = vi.hoisted(() => ({
  waitForSentinelMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  waitForSentinel: waitForSentinelMock
}))

function mockTransport(): MultiplexerTransport {
  return {
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn()
  }
}

function mockConn(execImpl?: SshConnection['exec']): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double only implements exec used by the factory.
  return { exec: execImpl ?? vi.fn() } as SshConnection
}

describe('buildRelaySecondConnectCommand', () => {
  it('builds a POSIX cd + node relay.js --connect command', () => {
    const cmd = buildRelaySecondConnectCommand({
      remoteRelayDir: '/home/u/.orca-remote/relay-v',
      nodePath: '/usr/bin/node',
      sockPath: '/tmp/relay.sock',
      credentialFile: '/tmp/cred',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })
    expect(cmd).toContain("cd '/home/u/.orca-remote/relay-v'")
    expect(cmd).toContain("'/usr/bin/node' relay.js --connect")
    expect(cmd).toContain("--sock-path '/tmp/relay.sock'")
    expect(cmd).toContain("--credential-file '/tmp/cred'")
  })

  it('builds a PowerShell connect command for Windows hosts', () => {
    const cmd = buildRelaySecondConnectCommand({
      remoteRelayDir: 'C:\\Users\\a\\.orca-remote\\r',
      nodePath: 'C:\\node\\node.exe',
      sockPath: '\\\\.\\pipe\\orca',
      credentialFile: 'C:\\cred',
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
    expect(cmd.toLowerCase()).toContain('powershell')
    expect(cmd).toContain('-EncodedCommand')
    const encoded = cmd.split('-EncodedCommand ').pop()?.trim() ?? ''
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(decoded).toContain('relay.js')
    expect(decoded).toContain('--connect')
    expect(decoded).toContain('--sock-path')
  })
})

describe('createRelaySessionMultiplexer', () => {
  beforeEach(() => {
    waitForSentinelMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('uses a single transport when sock/dir/node/credential are missing', async () => {
    const transport = mockTransport()
    const conn = mockConn()
    const mux = await createRelaySessionMultiplexer(conn, { transport })
    expect(conn.exec).not.toHaveBeenCalled()
    expect(mux.getTransportCount()).toBe(1)
    expect(mux.isDisposed()).toBe(false)
    mux.dispose()
  })

  it('opens a second connect and builds a multi-channel mux when endpoints are complete', async () => {
    const transport = mockTransport()
    const background = mockTransport()
    waitForSentinelMock.mockResolvedValue(background)
    const exec = vi.fn().mockResolvedValue({ on: vi.fn(), stderr: { on: vi.fn() } })
    const conn = mockConn(exec)

    const mux = await createRelaySessionMultiplexer(conn, {
      transport,
      remoteRelayDir: '/relay',
      nodePath: '/bin/node',
      sockPath: '/tmp/s.sock',
      credentialFile: '/tmp/c',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    // Primary + up to 9 additional priority workers (10 lanes total)
    expect(exec.mock.calls.length).toBe(9)
    expect(String(exec.mock.calls[0]![0])).toContain('relay.js --connect')
    expect(waitForSentinelMock).toHaveBeenCalledTimes(9)
    expect(mux.getTransportCount()).toBe(10)
    expect(mux.isDisposed()).toBe(false)
    // Priority proof: keystrokes and bulk must not share a pipe when N=10
    mux.notify('pty.data', { id: 'p', data: 'k' })
    void mux.request('fs.listFiles', { path: '/' }).catch(() => {})
    mux.dispose()
  })

  it('opens additional connects until MaxSessions stops the loop', async () => {
    const transport = mockTransport()
    waitForSentinelMock.mockResolvedValue(mockTransport())
    let opens = 0
    const exec = vi.fn().mockImplementation(async () => {
      opens += 1
      if (opens > 3) {
        throw Object.assign(new Error('Channel open failure: open failed'), { reason: 2 })
      }
      return { on: vi.fn(), stderr: { on: vi.fn() } }
    })
    const conn = mockConn(exec)
    const mux = await createRelaySessionMultiplexer(conn, {
      transport,
      remoteRelayDir: '/relay',
      nodePath: '/bin/node',
      sockPath: '/tmp/s.sock',
      credentialFile: '/tmp/c',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      targetTransportCount: 10
    })
    // primary + 3 successful extras = 4 transports
    expect(opens).toBe(4)
    expect(mux.getTransportCount()).toBe(4)
    expect(mux.isDisposed()).toBe(false)
    mux.dispose()
  })

  it('falls back to single transport when second channel hits MaxSessions', async () => {
    const transport = mockTransport()
    const err = Object.assign(new Error('Channel open failure: open failed'), { reason: 2 })
    const exec = vi.fn().mockRejectedValue(err)
    const conn = mockConn(exec)

    const mux = await createRelaySessionMultiplexer(conn, {
      transport,
      remoteRelayDir: '/relay',
      nodePath: '/bin/node',
      sockPath: '/tmp/s.sock',
      credentialFile: '/tmp/c',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(waitForSentinelMock).not.toHaveBeenCalled()
    expect(mux.isDisposed()).toBe(false)
    void mux.request('pty.spawn').catch(() => {})
    mux.dispose()
  })

  it('falls back to single transport when waitForSentinel fails', async () => {
    const transport = mockTransport()
    waitForSentinelMock.mockRejectedValue(new Error('sentinel timeout'))
    const exec = vi.fn().mockResolvedValue({ on: vi.fn(), stderr: { on: vi.fn() } })
    const conn = mockConn(exec)

    const mux = await createRelaySessionMultiplexer(conn, {
      transport,
      remoteRelayDir: '/relay',
      nodePath: '/bin/node',
      sockPath: '/tmp/s.sock',
      credentialFile: '/tmp/c',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(mux.isDisposed()).toBe(false)
    mux.dispose()
  })

  it('rethrows when the abort signal is already aborted after a failed second connect', async () => {
    const transport = mockTransport()
    const controller = new AbortController()
    const exec = vi.fn().mockImplementation(async () => {
      controller.abort()
      throw new Error('aborted mid-open')
    })
    const conn = mockConn(exec)

    await expect(
      createRelaySessionMultiplexer(
        conn,
        {
          transport,
          remoteRelayDir: '/relay',
          nodePath: '/bin/node',
          sockPath: '/tmp/s.sock',
          credentialFile: '/tmp/c',
          hostPlatform: getRemoteHostPlatform('linux-x64')
        },
        controller.signal
      )
    ).rejects.toThrow()
  })
})
