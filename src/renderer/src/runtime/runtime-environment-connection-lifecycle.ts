import { cancelRemoteRuntimeTerminalRecoveriesForEnvironment } from './remote-runtime-terminal-recovery-coordinator'

export function invalidateRuntimeEnvironmentRecovery(environmentId: string): void {
  cancelRemoteRuntimeTerminalRecoveriesForEnvironment(environmentId)
}

export async function disconnectSavedRuntimeEnvironment(selector: string) {
  const result = await window.api.runtimeEnvironments.disconnect({ selector })
  // The transport close can arrive after the IPC result; invalidate its binding generation first.
  invalidateRuntimeEnvironmentRecovery(result.disconnected.id)
  return result
}

export async function removeSavedRuntimeEnvironment(selector: string) {
  const result = await window.api.runtimeEnvironments.remove({ selector })
  invalidateRuntimeEnvironmentRecovery(result.removed.id)
  return result
}
