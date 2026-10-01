import {
  FrameDecoder,
  encodeJsonRpcFrame,
  encodeKeepAliveFrame,
  type DecodedFrame,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './relay-protocol'
import type {
  MultiplexerTransport,
  NotificationHandler,
  MethodNotificationHandler,
  RequestHandler,
  MultiplexerDisposeReason
} from './ssh-channel-multiplexer'
import type { MultiplexerTransportWriteResult } from './ssh-multiplexer-transport-writer'

export type DualChannelTransports = {
  interactive: MultiplexerTransport
  background: MultiplexerTransport
}

export type ChannelKind = 'interactive' | 'background'
export function selectChannel(method: string): ChannelKind {
  if (method === 'pty.history' || method === 'pty.replay' || method === 'pty.dumpScrollback') {
    return 'background'
  }
  return method.startsWith('pty.') ? 'interactive' : 'background'
}

export type LivenessWaiter = {
  succeed: () => void
  fail: () => void
}
export type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  beforeResolve?: (result: unknown) => void
  timer: NodeJS.Timeout
  cleanup: () => void
  channel: ChannelKind
}

export function createAbortError(method: string): Error {
  const err = new Error(`Request "${method}" was cancelled`)
  err.name = 'AbortError'
  return err
}

export function createTimeoutError(method: string, timeoutMs: number, code: string): Error {
  return Object.assign(new Error(`Request "${method}" timed out after ${timeoutMs}ms`), { code })
}

export class DualChannelRequestTracker {
  private readonly pending = new Map<number, PendingRequest>()

  get(id: number): PendingRequest | undefined {
    return this.pending.get(id)
  }

  set(id: number, req: PendingRequest): void {
    this.pending.set(id, req)
  }

  delete(id: number): boolean {
    return this.pending.delete(id)
  }

  rejectAll(error: Error): void {
    for (const [id, req] of this.pending) {
      req.cleanup()
      req.reject(error)
      this.pending.delete(id)
    }
  }

  getChannel(id: number): ChannelKind | undefined {
    return this.pending.get(id)?.channel
  }
}

export function createCancelNotification(id: number): JsonRpcNotification {
  return { jsonrpc: '2.0', method: 'rpc.cancel', params: { id } }
}

export class SingleChannelState {
  nextOutgoingSeq = 1
  highestReceivedSeq = 0
  readonly decoder: FrameDecoder
  private disposed = false

  constructor(
    readonly kind: ChannelKind,
    readonly transport: MultiplexerTransport,
    onFrame: (frame: DecodedFrame, ch: ChannelKind) => void
  ) {
    this.decoder = new FrameDecoder((f) => {
      if (!this.disposed) {
        onFrame(f, this.kind)
      }
    })
    transport.onData((data: Buffer) => {
      if (!this.disposed) {
        this.decoder.feed(data)
      }
    })
  }

  isDisposed(): boolean {
    return this.disposed
  }

  sendJsonRpc(
    msg: JsonRpcMessage,
    onSettled?: (result: MultiplexerTransportWriteResult) => void
  ): void {
    if (this.disposed) {
      onSettled?.({ ok: false, error: new Error('Channel disposed') })
      return
    }
    const frame = encodeJsonRpcFrame(msg, this.nextOutgoingSeq++, this.highestReceivedSeq)
    this.transport.write(frame, onSettled)
  }

  sendKeepAlive(): void {
    if (this.disposed) {
      return
    }
    const frame = encodeKeepAliveFrame(this.nextOutgoingSeq++, this.highestReceivedSeq)
    this.transport.write(frame)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.decoder.reset()
    this.transport.close?.()
  }
}

export class DualChannelRegistry {
  readonly notificationHandlers: NotificationHandler[] = []
  readonly methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
  readonly requestHandlers = new Map<string, RequestHandler>()
  readonly disposeHandlers: ((reason: MultiplexerDisposeReason) => void)[] = []
  readonly livenessWaiters: LivenessWaiter[] = []

  addLivenessWaiter(waiter: LivenessWaiter): () => void {
    this.livenessWaiters.push(waiter)
    return () => {
      const idx = this.livenessWaiters.indexOf(waiter)
      if (idx !== -1) {
        this.livenessWaiters.splice(idx, 1)
      }
    }
  }

  resolveLiveness(): void {
    const waiters = Array.from(this.livenessWaiters)
    this.livenessWaiters.length = 0
    for (const waiter of waiters) {
      waiter.succeed()
    }
  }

  failLiveness(): void {
    const waiters = Array.from(this.livenessWaiters)
    this.livenessWaiters.length = 0
    for (const waiter of waiters) {
      waiter.fail()
    }
  }

  addNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler)
    return () => {
      const idx = this.notificationHandlers.indexOf(handler)
      if (idx !== -1) {
        this.notificationHandlers.splice(idx, 1)
      }
    }
  }

  addMethodNotification(method: string, handler: MethodNotificationHandler): () => void {
    let set = this.methodNotificationHandlers.get(method)
    if (!set) {
      set = new Set()
      this.methodNotificationHandlers.set(method, set)
    }
    set.add(handler)
    return () => {
      const current = this.methodNotificationHandlers.get(method)
      if (current) {
        current.delete(handler)
        if (current.size === 0) {
          this.methodNotificationHandlers.delete(method)
        }
      }
    }
  }

  addRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler)
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method)
      }
    }
  }

  addDispose(handler: (reason: MultiplexerDisposeReason) => void): () => void {
    this.disposeHandlers.push(handler)
    return () => {
      const idx = this.disposeHandlers.indexOf(handler)
      if (idx !== -1) {
        this.disposeHandlers.splice(idx, 1)
      }
    }
  }

  dispatchNotification(method: string, params: Record<string, unknown>): void {
    for (const handler of Array.from(this.notificationHandlers)) {
      try {
        handler(method, params)
      } catch {
        /* empty */
      }
    }
    const methodSet = this.methodNotificationHandlers.get(method)
    if (methodSet) {
      for (const handler of Array.from(methodSet)) {
        try {
          handler(params)
        } catch {
          /* empty */
        }
      }
    }
  }

  dispatchDispose(reason: MultiplexerDisposeReason): void {
    const handlers = Array.from(this.disposeHandlers)
    this.disposeHandlers.length = 0
    for (const handler of handlers) {
      try {
        handler(reason)
      } catch {
        /* empty */
      }
    }
  }

  clear(): void {
    this.notificationHandlers.length = 0
    this.methodNotificationHandlers.clear()
    this.requestHandlers.clear()
  }
}

export function applyResponseSettlement(msg: JsonRpcResponse, pending: PendingRequest): void {
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

export async function dispatchIncomingRequest(
  msg: JsonRpcRequest,
  channel: SingleChannelState,
  registry: DualChannelRegistry,
  isDisposed: () => boolean
): Promise<void> {
  const handler = registry.requestHandlers.get(msg.method)
  if (!handler) {
    if (isDisposed()) {
      return
    }
    channel.sendJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    })
    return
  }
  try {
    const result = await handler(msg.params ?? {})
    if (isDisposed()) {
      return
    }
    channel.sendJsonRpc({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
  } catch (err) {
    if (isDisposed()) {
      return
    }
    channel.sendJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code:
          typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number'
            ? err.code
            : -32000,
        message: err instanceof Error ? err.message : String(err)
      }
    })
  }
}
