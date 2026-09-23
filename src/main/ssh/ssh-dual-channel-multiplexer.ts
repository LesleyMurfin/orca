import {
  MessageType,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './relay-protocol'
import {
  createSshDisposalError,
  type MultiplexerDisposeReason,
  type NotificationHandler,
  type MethodNotificationHandler,
  type RequestHandler,
  type SshMultiplexerRequestOptions
} from './ssh-channel-multiplexer'
import {
  SingleChannelState,
  DualChannelRegistry,
  type DualChannelTransports,
  type ChannelKind
} from './ssh-dual-channel-state'

export type { DualChannelTransports }

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  beforeResolve?: (result: unknown) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
  channel: ChannelKind
}

const REQUEST_TIMEOUT_MS = 30_000

function selectChannel(method: string): ChannelKind {
  return method.startsWith('pty.') ? 'interactive' : 'background'
}

export class SshDualChannelMultiplexer {
  private readonly channels: { interactive: SingleChannelState; background: SingleChannelState }
  private readonly registry = new DualChannelRegistry()
  private nextRequestId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private disposed = false
  private disposeReason: MultiplexerDisposeReason | null = null

  constructor(transports: DualChannelTransports) {
    const onFrame = (f: DecodedFrame, ch: ChannelKind): void => {
      this.handleFrame(f, ch)
    }
    this.channels = {
      interactive: new SingleChannelState('interactive', transports.interactive, onFrame),
      background: new SingleChannelState('background', transports.background, onFrame)
    }
    transports.interactive.onClose(() => {
      this.dispose('connection_lost')
    })
    transports.background.onClose(() => {
      this.dispose('connection_lost')
    })
  }

  isDisposed(): boolean {
    return this.disposed
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: SshMultiplexerRequestOptions
  ): Promise<unknown> {
    if (this.disposed) {
      throw createSshDisposalError(this.disposeReason ?? 'shutdown')
    }
    if (options?.signal?.aborted) {
      const err = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
      err.name = 'AbortError'
      throw err
    }

    const id = this.nextRequestId++
    const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
    const channelKind = selectChannel(method)
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    promise.catch(() => {})

    let timer: ReturnType<typeof setTimeout>
    const cleanup = (): void => {
      clearTimeout(timer)
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort)
      }
    }
    const onAbort = (): void => {
      const pending = this.pendingRequests.get(id)
      if (!pending) {
        return
      }
      pending.cleanup()
      this.pendingRequests.delete(id)
      this.notify('rpc.cancel', { id })
      const err = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
      err.name = 'AbortError'
      pending.reject(err)
    }

    timer = setTimeout(() => {
      const pending = this.pendingRequests.get(id)
      if (pending) {
        pending.cleanup()
        this.notify('rpc.cancel', { id })
      }
      this.pendingRequests.delete(id)
      reject(
        Object.assign(new Error(`Request "${method}" timed out after ${timeoutMs}ms`), {
          code: 'SSH_MUX_REQUEST_TIMEOUT'
        })
      )
    }, timeoutMs)

    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    this.pendingRequests.set(id, {
      resolve,
      reject,
      beforeResolve: options?.beforeResolve,
      timer,
      cleanup,
      channel: channelKind
    })

    this.channels[channelKind].sendJsonRpc({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    })
    return promise
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }
    this.channels[selectChannel(method)].sendJsonRpc({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    })
  }

  onNotification(handler: NotificationHandler): () => void {
    if (this.disposed) {
      return () => {}
    }
    return this.registry.addNotification(handler)
  }

  onNotificationByMethod(method: string, handler: MethodNotificationHandler): () => void {
    if (this.disposed) {
      return () => {}
    }
    return this.registry.addMethodNotification(method, handler)
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    return this.registry.addRequest(method, handler)
  }

  onDispose(handler: (reason: MultiplexerDisposeReason) => void): () => void {
    if (this.disposed) {
      try {
        handler(this.disposeReason ?? 'shutdown')
      } catch {
        /* empty */
      }
      return () => {}
    }
    return this.registry.addDispose(handler)
  }

  dispose(reason: MultiplexerDisposeReason = 'shutdown'): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.disposeReason = reason
    const err = createSshDisposalError(reason)

    for (const [id, pending] of this.pendingRequests) {
      pending.cleanup()
      pending.reject(err)
      this.pendingRequests.delete(id)
    }

    this.registry.clear()
    this.channels.interactive.dispose()
    this.channels.background.dispose()
    this.registry.dispatchDispose(reason)
  }

  private handleFrame(frame: DecodedFrame, channel: ChannelKind): void {
    if (this.disposed) {
      return
    }
    const ch = this.channels[channel]
    ch.highestReceivedSeq = Math.max(ch.highestReceivedSeq, frame.id)
    if (frame.type !== MessageType.Regular) {
      return
    }
    try {
      const msg = parseJsonRpcMessage(frame.payload)
      if ('id' in msg && ('result' in msg || 'error' in msg)) {
        this.handleResponse(msg as JsonRpcResponse, channel)
      } else if ('id' in msg && 'method' in msg) {
        void this.handleIncomingRequest(msg as JsonRpcRequest, channel)
      } else if ('method' in msg && !('id' in msg)) {
        this.registry.dispatchNotification(msg.method, msg.params ?? {})
      }
    } catch {
      /* ignore invalid frames */
    }
  }

  private handleResponse(msg: JsonRpcResponse, channel: ChannelKind): void {
    const pending = this.pendingRequests.get(msg.id)
    if (!pending || pending.channel !== channel) {
      return
    }
    pending.cleanup()
    this.pendingRequests.delete(msg.id)

    if (msg.error) {
      const err = new Error(msg.error.message)
      Object.defineProperty(err, 'code', { value: msg.error.code })
      Object.defineProperty(err, 'data', { value: msg.error.data })
      pending.reject(err)
    } else {
      try {
        pending.beforeResolve?.(msg.result)
        pending.resolve(msg.result)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private async handleIncomingRequest(msg: JsonRpcRequest, channel: ChannelKind): Promise<void> {
    const handler = this.registry.requestHandlers.get(msg.method)
    const ch = this.channels[channel]
    if (!handler) {
      ch.sendJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` }
      })
      return
    }
    try {
      const result = await handler(msg.params ?? {})
      ch.sendJsonRpc({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
    } catch (err) {
      ch.sendJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: (err as { code?: number }).code ?? -32000,
          message: err instanceof Error ? err.message : String(err)
        }
      })
    }
  }
}
