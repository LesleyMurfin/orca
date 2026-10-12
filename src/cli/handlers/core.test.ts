import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

// The claude-teams handler spawns `claude` via node:child_process; mock it so we
// can inspect the child env without launching a real process.
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// Keep the socket runtime client out of the import graph; only the error type
// and serveOrcaApp binding are referenced by the module under test.
vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  serveOrcaApp: vi.fn()
}))

import { CORE_HANDLERS } from './core'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

type SpawnEnv = Record<string, string | undefined>

// Minimal child stub: the handler only awaits `exit`, so resolve it on the next
// microtask to complete the spawned-process promise deterministically.
function mockClaudeChild(): { once: (event: string, cb: (...args: unknown[]) => void) => unknown } {
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'exit') {
        queueMicrotask(() => cb(0, null))
      }
      return child
    }
  }
  return child
}

describe('orca claude-teams CLI handler', () => {
  const isWindows = process.platform === 'win32'
  let previousRunAsNode: string | undefined
  let previousPaneKey: string | undefined
  let previousExitCode: typeof process.exitCode

  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  function runClaudeTeams(): Promise<void> {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs: []
    }
    return CORE_HANDLERS['claude-teams'](ctx)
  }

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => mockClaudeChild())
    callMock.mockReset()
    callMock.mockResolvedValue({
      result: {
        launch: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PATH: '/shim:/usr/bin' } }
      }
    })
    previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    previousPaneKey = process.env.ORCA_PANE_KEY
    previousExitCode = process.exitCode
    // The `orca` launcher runs Orca's Electron binary as Node, so the CLI process
    // itself carries ELECTRON_RUN_AS_NODE=1. Reproduce that inherited flag here.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
  })

  afterEach(() => {
    if (previousRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode
    }
    if (previousPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = previousPaneKey
    }
    process.exitCode = previousExitCode
  })

  // Guarded to non-Windows: the handler early-returns unsupported_platform on
  // win32, so the leak path never runs there.
  it.skipIf(isWindows)(
    'does not leak ELECTRON_RUN_AS_NODE into the spawned claude child',
    async () => {
      await runClaudeTeams()

      expect(spawnMock).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object))
      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
      expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()

      // The prepareLaunch request env is built from the same helper, so it must
      // be sanitized too.
      const prepareLaunchEnv = (callMock.mock.calls[0][1] as { env: SpawnEnv }).env
      expect(prepareLaunchEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  )

  it.skipIf(isWindows)(
    'still forwards non-Electron parent env and prepareLaunch env to claude',
    async () => {
      const previousMarker = process.env.ORCA_TEST_MARKER
      process.env.ORCA_TEST_MARKER = 'keep-me'
      try {
        await runClaudeTeams()
      } finally {
        if (previousMarker === undefined) {
          delete process.env.ORCA_TEST_MARKER
        } else {
          process.env.ORCA_TEST_MARKER = previousMarker
        }
      }

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
      expect(spawnEnv.ORCA_TEST_MARKER).toBe('keep-me')
      expect(spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
      expect(spawnEnv.PATH).toBe('/shim:/usr/bin')
    }
  )

  it.skipIf(isWindows)('removes managed auth variables before spawning Claude', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited'
    callMock.mockResolvedValueOnce({
      result: {
        launch: {
          env: {
            CLAUDE_CONFIG_DIR: '/managed/claude',
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
          },
          envToDelete: ['ANTHROPIC_API_KEY']
        }
      }
    })
    try {
      await runClaudeTeams()
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }

    const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
    expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe('/managed/claude')
  })

  it.skipIf(isWindows)('preserves API-key auth when no managed deletion is requested', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-system'
    try {
      await runClaudeTeams()
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey
      }
    }

    const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('sk-ant-system')
  })
})

describe('orca serve --generate-service', () => {
  const client = { call: async () => ({}) } as unknown as RuntimeClient
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  async function generate(flags: Map<string, string | boolean>): Promise<string> {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await CORE_HANDLERS.serve({
        flags,
        client,
        cwd: '/tmp/repo',
        json: false,
        rawArgs: []
      })
    } finally {
      console.log = originalLog
    }
    return lines.join('\n')
  }

  it('emits a loadable systemd unit with KillMode=mixed on linux', async () => {
    setPlatform('linux')
    const unit = await generate(
      new Map<string, string | boolean>([
        ['generate-service', true],
        ['port', '6768'],
        ['pairing-address', '127.0.0.1']
      ])
    )
    expect(unit).toContain('[Service]')
    expect(unit).toContain('Type=simple')
    expect(unit).toContain('KillMode=mixed')
    expect(unit).toContain('KillSignal=SIGTERM')
    expect(unit).toContain('RestartPreventExitStatus=3 78')
    expect(unit).toContain(
      'ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address 127.0.0.1'
    )
    expect(unit).toContain('User=orca')
    expect(unit).toContain('WantedBy=multi-user.target')
  })

  it('emits a user systemd unit without User=/Group= when --user is set on linux', async () => {
    setPlatform('linux')
    const unit = await generate(
      new Map<string, string | boolean>([
        ['generate-service', true],
        ['user', true],
        ['port', '6768']
      ])
    )
    expect(unit).toContain('KillMode=mixed')
    expect(unit).toContain('Description=Orca runtime server (user)')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toMatch(/^User=/m)
    expect(unit).not.toMatch(/^Group=/m)
  })

  it('emits a launchd plist with RunAtLoad and KeepAlive on darwin', async () => {
    setPlatform('darwin')
    const plist = await generate(
      new Map<string, string | boolean>([
        ['generate-service', true],
        ['port', '6768'],
        ['pairing-address', '127.0.0.1']
      ])
    )
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('<string>ai.orca.serve</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<true/>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).toContain('<string>--port</string>')
    expect(plist).toContain('<string>6768</string>')
    expect(plist).toContain('<string>--pairing-address</string>')
    expect(plist).toContain('<string>127.0.0.1</string>')
    expect(plist).toContain('<key>UserName</key>')
    expect(plist).toContain('<string>orca</string>')
  })

  it('emits a Windows Scheduled Task XML on win32', async () => {
    setPlatform('win32')
    const task = await generate(
      new Map<string, string | boolean>([
        ['generate-service', true],
        ['port', '6768'],
        ['pairing-address', '127.0.0.1']
      ])
    )
    expect(task).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    expect(task).toContain('http://schemas.microsoft.com/windows/2004/02/mit/task')
    expect(task).toContain('<BootTrigger>')
    expect(task).toContain('<UserId>S-1-5-18</UserId>')
    expect(task).toContain('<Command>')
    expect(task).toContain('<Arguments>serve --port 6768 --pairing-address 127.0.0.1</Arguments>')
    expect(task).toContain('<Interval>PT1M</Interval>')
  })
})
