import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '../../runtime/remote-runtime-terminal-multiplexer'

type FitOverrideEvent = Parameters<
  NonNullable<RemoteRuntimeMultiplexedTerminalCallbacks['onFitOverrideChanged']>
>[0]
type DriverEvent = Parameters<
  NonNullable<RemoteRuntimeMultiplexedTerminalCallbacks['onDriverChanged']>
>[0]
type BindingStateCallbacks = {
  onFitOverrideChanged: (event: FitOverrideEvent) => void
  onDriverChanged: (driver: DriverEvent) => void
}

export function createRemoteRuntimePtyStagedBindingState(callbacks: BindingStateCallbacks): {
  stageFitOverride: (event: FitOverrideEvent) => void
  stageDriver: (driver: DriverEvent) => void
  flush: (isCurrent: () => boolean) => void
  clear: () => void
} {
  let fitOverride: FitOverrideEvent | null = null
  let driver: DriverEvent | null = null
  return {
    stageFitOverride: (event) => {
      fitOverride = event
    },
    stageDriver: (event) => {
      driver = event
    },
    flush: (isCurrent) => {
      const nextFitOverride = fitOverride
      const nextDriver = driver
      fitOverride = null
      driver = null
      if (nextFitOverride && isCurrent()) {
        invokeSafely(() => callbacks.onFitOverrideChanged(nextFitOverride))
      }
      if (nextDriver && isCurrent()) {
        invokeSafely(() => callbacks.onDriverChanged(nextDriver))
      }
    },
    clear: () => {
      fitOverride = null
      driver = null
    }
  }
}

function invokeSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // Consumer callbacks cannot roll back an activated binding transition.
  }
}
