import {
  FrameDecoder,
  encodeJsonRpcFrame,
  type DecodedFrame,
  type JsonRpcMessage
} from './relay-protocol'
import type {
  MultiplexerTransport,
  NotificationHandler,
  MethodNotificationHandler,
  RequestHandler,
  MultiplexerDisposeReason
} from './ssh-channel-multiplexer'

export type DualChannelTransports = {
  interactive: MultiplexerTransport
  background: MultiplexerTransport
}

export type ChannelKind = 'interactive' | 'background'

export class SingleChannelState {
  nextOutgoingSeq = 1
  highestReceivedSeq = 0
  readonly decoder: FrameDecoder

  constructor(
    readonly kind: ChannelKind,
    readonly transport: MultiplexerTransport,
    onFrame: (frame: DecodedFrame, ch: ChannelKind) => void
  ) {
    this.decoder = new FrameDecoder((f) => onFrame(f, this.kind))
    transport.onData((data: Buffer) => this.decoder.feed(data))
  }

  sendJsonRpc(msg: JsonRpcMessage): void {
    const frame = encodeJsonRpcFrame(msg, this.nextOutgoingSeq++, this.highestReceivedSeq)
    this.transport.write(frame)
  }

  dispose(): void {
    this.decoder.reset()
    this.transport.close?.()
  }
}

export class DualChannelRegistry {
  readonly notificationHandlers: NotificationHandler[] = []
  readonly methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
  readonly requestHandlers = new Map<string, RequestHandler>()
  readonly disposeHandlers: ((reason: MultiplexerDisposeReason) => void)[] = []

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
    for (const handler of this.disposeHandlers) {
      try {
        handler(reason)
      } catch {
        /* empty */
      }
    }
    this.disposeHandlers.length = 0
  }

  clear(): void {
    this.notificationHandlers.length = 0
    this.methodNotificationHandlers.clear()
  }
}
