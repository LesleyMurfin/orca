import type { JsonRpcNotification } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-multiplexer-transport-writer'

export type DualChannelTransports = {
  interactive: MultiplexerTransport
  background: MultiplexerTransport
}

/** 1 transport, N transports, or named dual pair — normalized by SshChannelMultiplexer. */
export type SshMultiplexerTransports =
  | MultiplexerTransport
  | readonly MultiplexerTransport[]
  | DualChannelTransports

export type ChannelKind = 'interactive' | 'background'

export function selectChannel(method: string): ChannelKind {
  if (method === 'pty.history' || method === 'pty.replay' || method === 'pty.dumpScrollback') {
    return 'background'
  }
  return method.startsWith('pty.') ? 'interactive' : 'background'
}

/** Map RPC method → transport index for 1..N physical pipes. */
export function selectTransportIndex(method: string, transportCount: number): number {
  if (transportCount <= 1) {
    return 0
  }
  const lane = selectChannel(method)
  if (lane === 'interactive') {
    return 0
  }
  // count===2: background → 1; count>=3: bulk streams → last, other background → 1
  if (
    transportCount >= 3 &&
    (method.startsWith('fs.') || method.startsWith('git.') || method.includes('Stream'))
  ) {
    return transportCount - 1
  }
  return 1
}

export function isDualChannelTransports(value: unknown): value is DualChannelTransports {
  return (
    typeof value === 'object' &&
    value !== null &&
    'interactive' in value &&
    'background' in value &&
    !('write' in value)
  )
}

export function normalizeSshMultiplexerTransports(
  input: SshMultiplexerTransports
): MultiplexerTransport[] {
  if (Array.isArray(input)) {
    if (input.length < 1) {
      throw new Error('SshChannelMultiplexer requires at least one transport')
    }
    return [...input]
  }
  if (isDualChannelTransports(input)) {
    return [input.interactive, input.background]
  }
  if (typeof input === 'object' && input !== null && 'write' in input) {
    return [input]
  }
  throw new Error('SshChannelMultiplexer requires at least one transport')
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
  channelIndex: number
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

  getChannelIndex(id: number): number | undefined {
    return this.pending.get(id)?.channelIndex
  }
}

export function createCancelNotification(id: number): JsonRpcNotification {
  return { jsonrpc: '2.0', method: 'rpc.cancel', params: { id } }
}
