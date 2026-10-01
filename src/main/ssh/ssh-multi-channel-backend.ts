import {
  MessageType,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './relay-protocol'
import {
  createSshDisposalError,
  SSH_MUX_REQUEST_TIMEOUT_CODE,
  type MultiplexerDisposeReason,
  type NotificationHandler,
  type MethodNotificationHandler,
  type RequestHandler,
  type SshMultiplexerRequestOptions,
  type MultiplexerWriteSettlement,
  type MultiplexerTransport
} from './ssh-channel-multiplexer'
import {
  SingleChannelState,
  DualChannelRegistry,
  DualChannelRequestTracker,
  selectTransportIndex,
  createCancelNotification,
  createAbortError,
  createTimeoutError,
  applyResponseSettlement,
  dispatchIncomingRequest
} from './ssh-dual-channel-state'

/**
 * Internal backend for 1..N physical transports.
 * Public API is only SshChannelMultiplexer — never construct this from session code.
 */
export class MultiChannelMuxBackend {
  private readonly channels: SingleChannelState[]
  private readonly registry = new DualChannelRegistry()
  private readonly pending = new DualChannelRequestTracker()
  private nextRequestId = 1
  private disposed = false
  private disposeReason: MultiplexerDisposeReason | null = null

  constructor(transports: MultiplexerTransport[]) {
    if (transports.length < 1) {
      throw new Error('MultiChannelMuxBackend requires at least one transport')
    }
    const onFrame = (f: DecodedFrame, index: number): void => {
      this.handleFrame(f, index)
    }
    this.channels = transports.map((transport, index) => {
      const kind = index === 0 ? 'interactive' : 'background'
      return new SingleChannelState(kind, transport, (frame, _kind) => onFrame(frame, index))
    })
    for (const transport of transports) {
      transport.onClose(() => this.dispose('connection_lost'))
    }
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
      throw createAbortError(method)
    }

    const id = this.nextRequestId++
    const timeoutMs = options?.timeoutMs ?? 30_000
    const channelIndex = selectTransportIndex(method, this.channels.length)
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    promise.catch(() => {})

    let timer: NodeJS.Timeout
    const cleanup = (): void => {
      clearTimeout(timer)
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort)
      }
    }
    const onAbort = (): void => {
      const req = this.pending.get(id)
      if (!req) {
        return
      }
      req.cleanup()
      this.pending.delete(id)
      if (!this.disposed) {
        this.channels[req.channelIndex]?.sendJsonRpc(createCancelNotification(id))
      }
      req.reject(createAbortError(method))
    }

    timer = setTimeout(() => {
      const req = this.pending.get(id)
      if (req) {
        req.cleanup()
        if (!this.disposed) {
          this.channels[req.channelIndex]?.sendJsonRpc(createCancelNotification(id))
        }
      }
      this.pending.delete(id)
      reject(createTimeoutError(method, timeoutMs, SSH_MUX_REQUEST_TIMEOUT_CODE))
    }, timeoutMs)

    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    this.pending.set(id, {
      resolve,
      reject,
      beforeResolve: options?.beforeResolve,
      timer,
      cleanup,
      channelIndex
    })

    try {
      this.channels[channelIndex]!.sendJsonRpc({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {})
      })
    } catch (writeErr) {
      cleanup()
      this.pending.delete(id)
      throw writeErr
    }
    return promise
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }
    let channelIndex = selectTransportIndex(method, this.channels.length)
    if (method === 'rpc.cancel' && typeof params?.id === 'number') {
      const pendingIndex = this.pending.getChannelIndex(params.id)
      if (pendingIndex !== undefined) {
        channelIndex = pendingIndex
      }
    }
    this.channels[channelIndex]!.sendJsonRpc({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    })
  }

  notifyWithSettlement(
    method: string,
    params: Record<string, unknown> | undefined,
    onSettled: (result: MultiplexerWriteSettlement) => void
  ): void {
    if (this.disposed) {
      onSettled({
        outcome: 'refused',
        reason: 'transport_disposed',
        error: createSshDisposalError(this.disposeReason ?? 'shutdown')
      })
      return
    }
    const channelIndex = selectTransportIndex(method, this.channels.length)
    this.channels[channelIndex]!.sendJsonRpc(
      {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {})
      },
      (res) => {
        if (res.ok) {
          onSettled({ outcome: 'accepted' })
        } else {
          onSettled({
            outcome: 'unverifiable',
            reason: 'transport_settlement_lost',
            bytesHandedToTransport: true,
            error: res.error
          })
        }
      }
    )
  }

  probeLiveness(timeoutMs: number): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false)
    }
    const { promise, resolve } = Promise.withResolvers<boolean>()
    let timer: NodeJS.Timeout
    const remove = this.registry.addLivenessWaiter({
      succeed: () => {
        clearTimeout(timer)
        resolve(true)
      },
      fail: () => {
        clearTimeout(timer)
        resolve(false)
      }
    })
    timer = setTimeout(() => {
      remove()
      resolve(false)
    }, timeoutMs)
    this.channels[0]!.sendKeepAlive()
    return promise
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
    if (this.disposed) {
      return () => {}
    }
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
    this.pending.rejectAll(createSshDisposalError(reason))
    this.registry.failLiveness()
    this.registry.clear()
    for (const ch of this.channels) {
      ch.dispose()
    }
    this.registry.dispatchDispose(reason)
  }

  private handleFrame(frame: DecodedFrame, channelIndex: number): void {
    if (this.disposed) {
      return
    }
    this.registry.resolveLiveness()
    const ch = this.channels[channelIndex]
    if (!ch) {
      return
    }
    ch.highestReceivedSeq = Math.max(ch.highestReceivedSeq, frame.id)
    if (frame.type !== MessageType.Regular) {
      return
    }
    try {
      const msg = parseJsonRpcMessage(frame.payload)
      if ('id' in msg && ('result' in msg || 'error' in msg)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Property checks verify JsonRpcResponse shape.
        this.handleResponse(msg as JsonRpcResponse, channelIndex)
      } else if ('id' in msg && 'method' in msg) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Property checks verify JsonRpcRequest shape.
        void dispatchIncomingRequest(msg as JsonRpcRequest, ch, this.registry, () => this.disposed)
      } else if ('method' in msg && !('id' in msg)) {
        this.registry.dispatchNotification(msg.method, msg.params ?? {})
      }
    } catch {
      /* ignore invalid frames */
    }
  }

  private handleResponse(msg: JsonRpcResponse, channelIndex: number): void {
    const pending = this.pending.get(msg.id)
    if (!pending || pending.channelIndex !== channelIndex) {
      return
    }
    pending.cleanup()
    this.pending.delete(msg.id)
    applyResponseSettlement(msg, pending)
  }
}
