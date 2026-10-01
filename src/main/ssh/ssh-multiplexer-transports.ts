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

/**
 * Work-priority lanes, highest → lowest.
 * With N transports, lane rank i maps to transport min(i, N-1) so each pipe
 * carries a distinct priority class instead of dumping all background work
 * onto one socket.
 */
export const MUX_PRIORITY_LANES = [
  'interactive', // live keystrokes / resize — never share with bulk
  'control', // rpc.cancel, session grace/config
  'pty-lifecycle', // spawn / shutdown / attach / signal
  'session', // resolveHome, registerRoot
  'ports', // port detect / forwards
  'git-meta', // status, branch lists
  'git-bulk', // diff, log, response streams
  'fs-meta', // readDir, stat, light probes
  'fs-bulk', // listFiles, readFileStream, heavy walks
  'history' // pty.history / replay / scrollback dumps
] as const

export type MuxPriorityLane = (typeof MUX_PRIORITY_LANES)[number]

/** Preferred parallel relay connects: one pipe per priority lane. */
export const MUX_TARGET_TRANSPORT_COUNT = MUX_PRIORITY_LANES.length

/** Labels a SingleChannelState as interactive (index 0) vs worker. */
export type ChannelKind = 'interactive' | 'background'

export function selectMuxPriorityLane(method: string): MuxPriorityLane {
  if (
    method === 'pty.data' ||
    method === 'pty.resize' ||
    method === 'pty.ackData' ||
    method === 'pty.setDeliveryPaused' ||
    method === 'pty.input' ||
    method === 'pty.key' // harness / echo probes
  ) {
    return 'interactive'
  }
  if (
    method === 'rpc.cancel' ||
    method.startsWith('session.configure') ||
    method.includes('Grace')
  ) {
    return 'control'
  }
  if (
    method === 'pty.spawn' ||
    method === 'pty.shutdown' ||
    method === 'pty.attach' ||
    method === 'pty.kill' ||
    method === 'pty.signal'
  ) {
    return 'pty-lifecycle'
  }
  if (method === 'pty.history' || method === 'pty.replay' || method === 'pty.dumpScrollback') {
    return 'history'
  }
  if (method.startsWith('ports.')) {
    return 'ports'
  }
  if (method.startsWith('session.')) {
    return 'session'
  }
  if (
    method === 'git.diff' ||
    method === 'git.log' ||
    (method.startsWith('git.') &&
      (method.includes('Stream') || method.includes('diff') || method.includes('log')))
  ) {
    return 'git-bulk'
  }
  if (method.startsWith('git.')) {
    return 'git-meta'
  }
  if (
    method === 'fs.listFiles' ||
    method === 'fs.readFileStream' ||
    method.includes('Stream') ||
    method === 'fs.workspaceSpaceScan'
  ) {
    return 'fs-bulk'
  }
  if (method.startsWith('fs.')) {
    return 'fs-meta'
  }
  return 'fs-meta'
}

export function selectChannel(method: string): ChannelKind {
  return selectMuxPriorityLane(method) === 'interactive' ? 'interactive' : 'background'
}

/**
 * Map RPC method → transport index for 1..N physical pipes.
 * Each priority lane owns its own index when N is large enough (up to 10).
 */
export function selectTransportIndex(method: string, transportCount: number): number {
  if (transportCount <= 1) {
    return 0
  }
  const lane = selectMuxPriorityLane(method)
  const laneRank = MUX_PRIORITY_LANES.indexOf(lane)
  const rank = laneRank === -1 ? MUX_PRIORITY_LANES.length - 1 : laneRank
  if (rank === 0) {
    return 0
  }
  if (transportCount === 2) {
    return 1
  }
  return Math.min(rank, transportCount - 1)
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
