import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

export type RemoteRuntimeTerminalHandleResolution =
  | { kind: 'ready'; handle: string }
  | { kind: 'pending' }
  | { kind: 'gone' }

export type RemoteRuntimeTerminalRecoveryParticipant = {
  id: string
  worktreeId: string | null
  resolveHandle: (
    snapshot: RuntimeMobileSessionTabsResult | null
  ) => RemoteRuntimeTerminalHandleResolution
  rebind: (args: { handle: string; generation: number; signal: AbortSignal }) => Promise<void>
  onGone: () => void
  onFatal: (error: { code: string; message: string }) => void
}

export type RemoteRuntimeTerminalRecoveryLease = {
  generation: number
  cancel: () => void
}

export type RemoteRuntimeTerminalRecoveryDependencies = {
  subscribeSessionTabs: (args: {
    environmentId: string
    worktreeId: string
    onSnapshot: (snapshot: RuntimeMobileSessionTabsResult) => void
    onError: (error: { code: string; message: string }) => void
    onClose: () => void
  }) => Promise<{ unsubscribe: () => void }>
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (timer: unknown) => void
  onIdle?: () => void
}
