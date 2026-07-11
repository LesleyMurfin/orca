import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disconnectSavedRuntimeEnvironment,
  invalidateRuntimeEnvironmentRecovery,
  removeSavedRuntimeEnvironment
} from './runtime-environment-connection-lifecycle'

const { cancelRecoveries } = vi.hoisted(() => ({ cancelRecoveries: vi.fn() }))

vi.mock('./remote-runtime-terminal-recovery-coordinator', () => ({
  cancelRemoteRuntimeTerminalRecoveriesForEnvironment: cancelRecoveries
}))

describe('runtime environment connection lifecycle', () => {
  const disconnect = vi.fn()
  const remove = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { disconnect, remove } } })
  })

  it('cancels terminal recovery after an explicit disconnect succeeds', async () => {
    disconnect.mockResolvedValue({ disconnected: { id: 'canonical-env' } })

    await expect(disconnectSavedRuntimeEnvironment('environment-alias')).resolves.toEqual({
      disconnected: { id: 'canonical-env' }
    })

    expect(cancelRecoveries).toHaveBeenCalledWith('canonical-env')
  })

  it('cancels terminal recovery after an explicit removal succeeds', async () => {
    remove.mockResolvedValue({ removed: { id: 'canonical-env' } })

    await expect(removeSavedRuntimeEnvironment('environment-alias')).resolves.toEqual({
      removed: { id: 'canonical-env' }
    })

    expect(cancelRecoveries).toHaveBeenCalledWith('canonical-env')
  })

  it('keeps recovery active when the explicit teardown request fails', async () => {
    disconnect.mockRejectedValue(new Error('disconnect failed'))

    await expect(disconnectSavedRuntimeEnvironment('env-1')).rejects.toThrow('disconnect failed')
    expect(cancelRecoveries).not.toHaveBeenCalled()
  })

  it('invalidates recovery when another lifecycle action already closed the transport', () => {
    invalidateRuntimeEnvironmentRecovery('env-1')
    expect(cancelRecoveries).toHaveBeenCalledWith('env-1')
  })
})
