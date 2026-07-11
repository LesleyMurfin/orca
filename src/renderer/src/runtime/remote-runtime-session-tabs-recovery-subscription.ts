import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RemoteRuntimeTerminalRecoveryDependencies } from './remote-runtime-terminal-recovery-types'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

type StructuredError = { code: string; message: string }
type RecoveryCallbacks = {
  onSnapshot: (snapshot: RuntimeMobileSessionTabsResult) => void
  onError: (error: StructuredError) => void
  onClose: () => void
  onStartReady: () => void
  onStartError: (error: StructuredError) => void
}

export class RemoteRuntimeSessionTabsRecoverySubscription {
  snapshot: RuntimeMobileSessionTabsResult | null = null
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

function isSessionTabsClientTab(value: unknown): boolean {
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
  if (tab.type !== 'terminal') {
    return tab.type === 'markdown' || tab.type === 'file' || tab.type === 'browser'
  }
  if (typeof tab.parentTabId !== 'string' || typeof tab.leafId !== 'string') {
    return false
  }
  // Terminal status and handle form a wire union; partial pairs must not look pending.
  return (
    (tab.status === 'pending-handle' && tab.terminal === null) ||
    (tab.status === 'ready' && typeof tab.terminal === 'string' && tab.terminal.length > 0)
  )
}

function isSessionTabsSnapshot(value: unknown): value is RuntimeMobileSessionTabsResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  const activeType = snapshot.activeTabType
  return (
    typeof snapshot.worktree === 'string' &&
    typeof snapshot.publicationEpoch === 'string' &&
    typeof snapshot.snapshotVersion === 'number' &&
    (typeof snapshot.activeGroupId === 'string' || snapshot.activeGroupId === null) &&
    (typeof snapshot.activeTabId === 'string' || snapshot.activeTabId === null) &&
    (activeType === null ||
      activeType === 'terminal' ||
      activeType === 'markdown' ||
      activeType === 'file' ||
      activeType === 'browser') &&
    Array.isArray(snapshot.tabs) &&
    snapshot.tabs.every(isSessionTabsClientTab)
  )
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
  if ((type === 'snapshot' || type === 'updated') && isSessionTabsSnapshot(snapshot)) {
    callbacks.onSnapshot(snapshot)
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
