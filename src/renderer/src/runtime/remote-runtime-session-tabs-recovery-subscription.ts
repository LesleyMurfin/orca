import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../shared/runtime-types'
import type {
  RemoteRuntimeTerminalRecoveryDependencies,
  RemoteRuntimeTerminalRecoverySnapshot
} from './remote-runtime-terminal-recovery-types'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

type StructuredError = { code: string; message: string }
type RecoveryCallbacks = {
  onSnapshot: (snapshot: RemoteRuntimeTerminalRecoverySnapshot) => void
  onError: (error: StructuredError) => void
  onClose: () => void
  onStartReady: () => void
  onStartError: (error: StructuredError) => void
}

export class RemoteRuntimeSessionTabsRecoverySubscription {
  snapshot: RemoteRuntimeTerminalRecoverySnapshot | null = null
  startPending = false
  private handle: { unsubscribe: () => void } | null = null
  private disposed = false

  constructor(
    readonly worktreeId: string,
    readonly generation: number,
    private readonly environmentId: string,
    private readonly subscribe: RemoteRuntimeTerminalRecoveryDependencies['subscribeSessionTabs'],
    private readonly callbacks: RecoveryCallbacks
  ) {}

  start(): void {
    if (this.disposed || this.startPending || this.handle) {
      return
    }
    this.startPending = true
    let promise: Promise<{ unsubscribe: () => void }>
    try {
      promise = this.subscribe({
        environmentId: this.environmentId,
        worktreeId: this.worktreeId,
        onSnapshot: (snapshot) => {
          if (this.disposed) {
            return
          }
          this.snapshot = snapshot
          this.callbacks.onSnapshot(snapshot)
        },
        onError: (error) => {
          if (!this.disposed) {
            this.callbacks.onError(error)
          }
        },
        onClose: () => {
          if (this.disposed) {
            return
          }
          this.dispose()
          this.callbacks.onClose()
        }
      })
    } catch (error) {
      promise = Promise.reject(error)
    }
    void promise.then(
      (handle) => {
        this.startPending = false
        if (this.disposed) {
          releaseHandle(handle)
        } else {
          this.handle = handle
          this.callbacks.onStartReady()
        }
      },
      (error) => {
        this.startPending = false
        if (!this.disposed) {
          this.callbacks.onStartError(normalizeRecoveryError(error))
        }
      }
    )
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.handle) {
      releaseHandle(this.handle)
      this.handle = null
    }
  }
}

export function normalizeRecoveryError(error: unknown): StructuredError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return { code: error.code, message: error.message }
  }
  return { code: 'runtime_error', message: error instanceof Error ? error.message : String(error) }
}

function releaseHandle(handle: { unsubscribe: () => void }): void {
  try {
    handle.unsubscribe()
  } catch {
    // State is already tombstoned; release is best effort.
  }
}

function isSessionTabsTerminalClientTab(
  value: unknown
): value is RuntimeMobileSessionTerminalClientTab {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const tab = value as Record<string, unknown>
  if (
    typeof tab.id !== 'string' ||
    typeof tab.title !== 'string' ||
    typeof tab.isActive !== 'boolean'
  ) {
    return false
  }
  if (
    tab.type !== 'terminal' ||
    typeof tab.parentTabId !== 'string' ||
    typeof tab.leafId !== 'string'
  ) {
    return false
  }
  // Terminal status and handle form a wire union; partial pairs must not look pending.
  return (
    (tab.status === 'pending-handle' && tab.terminal === null) ||
    (tab.status === 'ready' && typeof tab.terminal === 'string' && tab.terminal.length > 0)
  )
}

function parseSessionTabsSnapshotForRecovery(
  value: unknown
): RemoteRuntimeTerminalRecoverySnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const snapshot = value as Record<string, unknown>
  if (!Array.isArray(snapshot.tabs)) {
    return null
  }
  const terminalTabs: RuntimeMobileSessionTerminalClientTab[] = []
  for (const value of snapshot.tabs) {
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const tab = value as Record<string, unknown>
    if (typeof tab.type !== 'string') {
      return null
    }
    if (tab.type === 'terminal') {
      if (!isSessionTabsTerminalClientTab(tab)) {
        return null
      }
      terminalTabs.push(tab)
    }
  }
  // Why: recovery only resolves terminal handles. Dropping newer non-terminal
  // surfaces keeps compatible runtime versions from blocking terminal repair.
  return { tabs: terminalTabs }
}

function adaptSessionTabsResponse(
  response: RuntimeRpcResponse<unknown>,
  callbacks: Pick<
    Parameters<RemoteRuntimeTerminalRecoveryDependencies['subscribeSessionTabs']>[0],
    'onSnapshot' | 'onError' | 'onClose'
  >
): void {
  if (response.ok === false) {
    callbacks.onError({ code: 'runtime_error', message: response.error.message })
    return
  }
  if (typeof response.result !== 'object' || response.result === null) {
    callbacks.onError(invalidSessionTabsResponse())
    return
  }
  const { type, ...snapshot } = response.result as Record<string, unknown>
  const parsedSnapshot = parseSessionTabsSnapshotForRecovery(snapshot)
  if ((type === 'snapshot' || type === 'updated') && parsedSnapshot) {
    callbacks.onSnapshot(parsedSnapshot)
  } else if (type === 'end') {
    callbacks.onClose()
  } else {
    callbacks.onError(invalidSessionTabsResponse())
  }
}

function invalidSessionTabsResponse(): StructuredError {
  return {
    code: 'invalid_runtime_response',
    message: 'Malformed session.tabs subscription response.'
  }
}

export async function subscribeRemoteRuntimeSessionTabsForRecovery(
  args: Parameters<RemoteRuntimeTerminalRecoveryDependencies['subscribeSessionTabs']>[0]
): Promise<{ unsubscribe: () => void }> {
  try {
    const handle = await window.api.runtimeEnvironments.subscribe(
      {
        selector: args.environmentId,
        method: 'session.tabs.subscribe',
        params: { worktree: toRuntimeWorktreeSelector(args.worktreeId) },
        timeoutMs: 15_000
      },
      {
        onResponse: (response) => adaptSessionTabsResponse(response, args),
        onError: args.onError,
        onClose: args.onClose
      }
    )
    return { unsubscribe: handle.unsubscribe }
  } catch (error) {
    throw normalizeRecoveryError(error)
  }
}
