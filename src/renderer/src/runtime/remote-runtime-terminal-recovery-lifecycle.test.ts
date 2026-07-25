import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  beginRemoteRuntimeTerminalRecovery,
  cancelRemoteRuntimeTerminalRecoveriesForEnvironment,
  retryRemoteRuntimeTerminalRecoveriesNow,
  type RemoteRuntimeTerminalRecoveryParticipant
} from './remote-runtime-terminal-recovery-coordinator'

const OFFLINE = { code: 'remote_runtime_unavailable', message: 'offline' }

type BridgeCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onError: (error: { code: string; message: string }) => void
  onClose: () => void
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function pendingParticipant(
  id: string,
  onDispose?: () => void
): RemoteRuntimeTerminalRecoveryParticipant {
  return {
    id,
    worktreeId: `wt-${id}`,
    resolveHandle: vi.fn(() => ({ kind: 'pending' as const })),
    rebind: vi.fn().mockResolvedValue(undefined),
    onGone: vi.fn(),
    onFatal: vi.fn(),
    onDispose
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('remote runtime terminal recovery lifecycle', () => {
  it('disposes one environment generation without allowing late callbacks to reopen it', async () => {
    const callbacks: BridgeCallbacks[] = []
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(async (_args: unknown, next: BridgeCallbacks) => {
      callbacks.push(next)
      return { unsubscribe, sendBinary: vi.fn() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    const onDispose = vi.fn()
    beginRemoteRuntimeTerminalRecovery({
      environmentId: 'lifecycle-explicit-disconnect',
      participant: pendingParticipant('explicit-disconnect', onDispose)
    })
    await flush()

    cancelRemoteRuntimeTerminalRecoveriesForEnvironment('lifecycle-explicit-disconnect')
    callbacks[0]?.onClose()
    retryRemoteRuntimeTerminalRecoveriesNow()
    await flush()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('retries when the session tabs subscribe response is recoverably rejected', async () => {
    vi.useFakeTimers()
    const callbacks: BridgeCallbacks[] = []
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(async (_args: unknown, next: BridgeCallbacks) => {
      callbacks.push(next)
      return { unsubscribe, sendBinary: vi.fn() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    const lease = beginRemoteRuntimeTerminalRecovery({
      environmentId: 'lifecycle-recoverable-response',
      participant: pendingParticipant('recoverable-response')
    })
    await flush()

    callbacks[0]?.onResponse({ id: 'rpc-offline', ok: false, error: OFFLINE })
    await flush()
    await vi.advanceTimersByTimeAsync(250)
    await flush()

    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    lease.cancel()
  })
})
