import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ENVIRONMENT_CONFIG_METHODS } from './environment-config'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

// Why: these keys are the confirmed host-binding / command-exec-adjacent /
// proxy-redirect surface from the design (§4.1). Each MUST be rejected by the
// zod `.strict()` allow-schema so the RPC boundary never reaches the runtime.
const DANGEROUS_KEYS: Record<string, unknown> = {
  openInApplications: [{ label: 'x', command: 'rm -rf /' }],
  agentCmdOverrides: { claude: 'malicious --exec' },
  terminalWindowsShell: 'cmd.exe',
  terminalWindowsWslDistro: 'Ubuntu',
  terminalWindowsPowerShellImplementation: 'pwsh.exe',
  localAccountWslDistro: 'Ubuntu',
  localAgentWslDistro: 'Ubuntu',
  localAccountRuntime: 'wsl',
  localAgentRuntime: 'wsl',
  httpProxyUrl: 'http://attacker.example',
  httpProxyBypassRules: '<local>',
  floatingTerminalTrustedCwds: ['/etc'],
  floatingTerminalCwd: '/etc',
  // Auth/credential surface — a session cookie must never be remotely writable.
  opencodeSessionCookie: 'stolen-session-cookie',
  // Destructive-guard bypass — flipping this off silences the delete-worktree
  // confirmation that guards `git worktree remove` + `rm -rf`.
  skipDeleteWorktreeConfirm: true,
  // Agent-command injection — default args/env are appended to the spawned
  // agent CLI, so both are as exec-adjacent as agentCmdOverrides.
  agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
  agentDefaultEnv: { claude: { LD_PRELOAD: '/tmp/evil.so' } }
}

describe('environment config RPC methods', () => {
  it('returns the runtime portable settings for getAll', async () => {
    const settings = {
      terminalCursorStyle: 'underline',
      terminalGpuAcceleration: 'auto',
      terminalFontSize: 13
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getPortableSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ENVIRONMENT_CONFIG_METHODS })

    const response = await dispatcher.dispatch(makeRequest('environment.config.getAll'))

    expect(runtime.getPortableSettings).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({ ok: true, result: { settings } })
  })

  it('accepts a representative portable key and persists it via the runtime', async () => {
    const updated = { terminalCursorStyle: 'block' }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updatePortableSettings: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ENVIRONMENT_CONFIG_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('environment.config.setMany', { terminalCursorStyle: 'block' })
    )

    expect(runtime.updatePortableSettings).toHaveBeenCalledWith({ terminalCursorStyle: 'block' })
    expect(response).toMatchObject({ ok: true, result: { settings: updated } })
  })

  it.each(Object.entries(DANGEROUS_KEYS))(
    'rejects the host-binding / exec-adjacent key %s at the RPC boundary',
    async (key, value) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        updatePortableSettings: vi.fn()
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: ENVIRONMENT_CONFIG_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('environment.config.setMany', { [key]: value })
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(runtime.updatePortableSettings).not.toHaveBeenCalled()
    }
  )

  it('rejects a dangerous key even when mixed with an allowlisted key', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updatePortableSettings: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ENVIRONMENT_CONFIG_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('environment.config.setMany', {
        terminalCursorStyle: 'block',
        openInApplications: [{ label: 'x', command: 'rm -rf /' }]
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updatePortableSettings).not.toHaveBeenCalled()
  })

  it('accepts the canonical compactWorktreeCards key', async () => {
    const updated = { compactWorktreeCards: true }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updatePortableSettings: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ENVIRONMENT_CONFIG_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('environment.config.setMany', { compactWorktreeCards: true })
    )

    expect(runtime.updatePortableSettings).toHaveBeenCalledWith({ compactWorktreeCards: true })
    expect(response).toMatchObject({ ok: true, result: { settings: updated } })
  })

  it('rejects the deprecated experimentalCompactWorktreeCards key', async () => {
    // Why: current main renamed this to `compactWorktreeCards` and Store.load()
    // resets the legacy key to undefined each load, so allowlisting it would be a
    // silent no-op. Lock it out of the `.strict()` boundary so the dead key can
    // never silently reappear in the allowlist.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updatePortableSettings: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ENVIRONMENT_CONFIG_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('environment.config.setMany', { experimentalCompactWorktreeCards: true })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updatePortableSettings).not.toHaveBeenCalled()
  })
})
