import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { Store } from '../persistence'
import { clearActiveRuntimeEnvironmentFocusIfMatches } from '../runtime-environment-focus-self-heal'
import {
  closeRemoteRuntimeRequestConnection,
  retryRemoteRuntimeSharedControlConnectionsNow
} from './runtime-environment-request-connections'
import {
  callRuntimeEnvironment,
  clearSharedControlSupport,
  getRuntimeEnvironmentStatus,
  resetSharedControlSupport,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'

const RUNTIME_ENVIRONMENT_HANDLER_CHANNELS = [
  'runtimeEnvironments:list',
  'runtimeEnvironments:addFromPairingCode',
  'runtimeEnvironments:resolve',
  'runtimeEnvironments:remove',
  'runtimeEnvironments:disconnect',
  'runtimeEnvironments:getStatus',
  'runtimeEnvironments:retryConnectionsNow',
  'runtimeEnvironments:call',
  'runtimeEnvironments:subscribe',
  'runtimeEnvironments:unsubscribe'
] as const

type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  environmentId: string
  ownerWebContentsId: number
  removeDestroyedListener: () => void
}

type RuntimeEnvironmentSubscriptionStartResult =
  | { ok: true; subscriptionId: string; requestId: string }
  | {
      ok: false
      error: { code: string; message: string }
    }

const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()

function serializeRuntimeEnvironmentSubscriptionError(error: unknown): {
  code: string
  message: string
} {
  return {
    code: error instanceof RemoteRuntimeClientError ? error.code : 'runtime_error',
    message: error instanceof Error ? error.message : String(error)
  }
}

function getUserDataPath(): string {
  return app.getPath('userData')
}

function closeSubscriptionsForEnvironment(environmentId: string): void {
  // Why: removing a saved runtime invalidates its streaming WebSockets too;
  // otherwise terminal/browser subscriptions stay alive until renderer teardown.
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    subscription.close()
  }
}

function listPublicRuntimeEnvironments(): PublicKnownRuntimeEnvironment[] {
  // Why: `source` is persisted on the env record, so read it directly instead of
  // joining the VM store — a corrupt VM store must not break listing all envs.
  return listEnvironments(getUserDataPath()).map(redactRuntimeEnvironment)
}

export function registerRuntimeEnvironmentHandlers(store: Store): void {
  // Why: keep direct re-registration safe even though register-core-handlers
  // normally guards this path; otherwise the binary send listener can stack.
  resetSharedControlSupport()
  for (const channel of RUNTIME_ENVIRONMENT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('runtimeEnvironments:subscriptionBinary')

  ipcMain.handle('runtimeEnvironments:list', (): PublicKnownRuntimeEnvironment[] =>
    listPublicRuntimeEnvironments()
  )
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    (
      _event,
      args: { name: string; pairingCode: string }
    ): { environment: PublicKnownRuntimeEnvironment } => ({
      environment: redactRuntimeEnvironment(addEnvironmentFromPairingCode(getUserDataPath(), args))
    })
  )
  ipcMain.handle(
    'runtimeEnvironments:resolve',
    (_event, args: { selector: string }): PublicKnownRuntimeEnvironment =>
      redactRuntimeEnvironment(resolveEnvironment(getUserDataPath(), args.selector))
  )
  ipcMain.handle(
    'runtimeEnvironments:remove',
    (_event, args: { selector: string }): { removed: PublicKnownRuntimeEnvironment } => {
      const removed = removeEnvironment(getUserDataPath(), args.selector)
      closeRemoteRuntimeRequestConnection(removed.id)
      clearSharedControlSupport(removed.id)
      if (args.selector !== removed.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
        clearSharedControlSupport(args.selector)
      }
      clearActiveRuntimeEnvironmentFocusIfMatches(store, removed.id)
      closeSubscriptionsForEnvironment(removed.id)
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    (_event, args: { selector: string }): { disconnected: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      // Why: disconnect is intentionally non-destructive; it drops live
      // transport state while keeping the paired server available for later.
      closeRemoteRuntimeRequestConnection(environment.id)
      clearSharedControlSupport(environment.id)
      if (args.selector !== environment.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
        clearSharedControlSupport(args.selector)
      }
      closeSubscriptionsForEnvironment(environment.id)
      return { disconnected: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      return getRuntimeEnvironmentStatus(getUserDataPath(), args.selector, args.timeoutMs)
    }
  )
  ipcMain.handle('runtimeEnvironments:retryConnectionsNow', () => {
    retryRemoteRuntimeSharedControlConnectionsNow()
  })
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: { selector: string; method: string; params?: unknown; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      return callRuntimeEnvironment(
        getUserDataPath(),
        args.selector,
        args.method,
        args.params,
        args.timeoutMs
      )
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:subscribe',
    async (
      event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
      }
    ): Promise<RuntimeEnvironmentSubscriptionStartResult> => {
      const subscriptionId =
        typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
          ? args.subscriptionId
          : randomUUID()
      let subscription: RemoteRuntimeSubscription | null = null
      let removeDestroyedListener = (): void => {}
      try {
        if (remoteRuntimeSubscriptions.has(subscriptionId)) {
          throw new Error('Runtime environment subscription id already exists')
        }
        const environment = resolveEnvironment(getUserDataPath(), args.selector)
        const sender = event.sender
        const ownerWebContentsId = sender.id
        let senderDestroyed = sender.isDestroyed()
        let subscriptionClosed = false
        let destroyedListenerAttached = false
        const closeSubscription = (): void => {
          senderDestroyed = true
          const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
          remoteRuntimeSubscriptions.delete(subscriptionId)
          if (retained) {
            retained.close()
            return
          }
          removeDestroyedListener()
          subscription?.close()
        }
        removeDestroyedListener = (): void => {
          if (!destroyedListenerAttached) {
            return
          }
          destroyedListenerAttached = false
          sender.removeListener('destroyed', closeSubscription)
        }
        sender.once('destroyed', closeSubscription)
        destroyedListenerAttached = true
        subscription = await subscribeRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          {
            onEvent: (payload) => {
              if (!sender.isDestroyed()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload
                })
              }
            },
            onClose: () => {
              // Why: a close can beat the async handle continuation. Tombstone it
              // independently so the late handle is release-only, never retained.
              subscriptionClosed = true
              removeDestroyedListener()
              remoteRuntimeSubscriptions.delete(subscriptionId)
            }
          }
        )
        if (subscriptionClosed || senderDestroyed || sender.isDestroyed()) {
          removeDestroyedListener()
          subscription.close()
          return { ok: true, subscriptionId, requestId: subscription.requestId }
        }
        remoteRuntimeSubscriptions.set(subscriptionId, {
          requestId: subscription.requestId,
          environmentId: environment.id,
          ownerWebContentsId,
          removeDestroyedListener,
          sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
          close: () => {
            removeDestroyedListener()
            subscription?.close()
          }
        })
        return { ok: true, subscriptionId, requestId: subscription.requestId }
      } catch (error) {
        removeDestroyedListener()
        subscription?.close()
        return {
          ok: false,
          error: serializeRuntimeEnvironmentSubscriptionError(error)
        }
      }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:unsubscribe',
    (event, args: { subscriptionId: string }): { unsubscribed: boolean } => {
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (!subscription || subscription.ownerWebContentsId !== event.sender.id) {
        return { unsubscribed: false }
      }
      remoteRuntimeSubscriptions.delete(args.subscriptionId)
      subscription.close()
      return { unsubscribed: true }
    }
  )
  ipcMain.on(
    'runtimeEnvironments:subscriptionBinary',
    (event, args: { subscriptionId?: unknown; bytes?: unknown }) => {
      if (typeof args.subscriptionId !== 'string') {
        return
      }
      const bytes = toBinaryPayload(args.bytes)
      if (!bytes) {
        return
      }
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (subscription?.ownerWebContentsId === event.sender.id) {
        subscription.sendBinary(bytes)
      }
    }
  )
}

function toBinaryPayload(value: unknown): Uint8Array<ArrayBufferLike> | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
