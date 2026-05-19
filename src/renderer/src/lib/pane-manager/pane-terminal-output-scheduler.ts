/* oxlint-disable max-lines -- Why: queueing, parse callbacks, and discard
semantics share ACK state; keeping them together makes liveness easier to audit. */
import { e2eConfig } from '@/lib/e2e-config'

type TerminalOutputTarget = {
  write(data: string, callback?: () => void): void
}

type QueueEntry = {
  terminal: TerminalOutputTarget
  chunks: QueueChunk[]
}

type QueueChunk = {
  data: string
  onParsed?: (charCount: number) => void
}

type WriteQueueEntry = {
  data: string
  callback?: () => void
  callbackInvoked?: boolean
}

type TerminalWriteState = {
  queue: WriteQueueEntry[]
  writing: boolean
  current?: WriteQueueEntry
}

const BACKGROUND_FLUSH_DELAY_MS = 50
const BACKGROUND_DRAIN_INTERVAL_MS = 16
const BACKGROUND_CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_DRAIN = 2
const PARSE_SETTLE_TIMEOUT_MS = 250
const WRITE_CALLBACK_TIMEOUT_MS = 30_000

const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
const writesByTerminal = new Map<TerminalOutputTarget, TerminalWriteState>()
let drainTimer: ReturnType<typeof setTimeout> | null = null
const debugEnabled = e2eConfig.exposeStore

// Why no lossy queue cap: dropping raw terminal bytes can corrupt parser state
// (half an escape sequence, missed mode reset, wrong scrollback). A pathological
// background producer can still consume memory/CPU; preserving terminal
// correctness means that case needs adaptive/backpressure work, not truncation.

type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  drainWrites: number[]
}

type TerminalOutputSchedulerDebugApi = {
  reset: () => void
  snapshot: () => TerminalOutputSchedulerDebugSnapshot
}

const debugState: TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: 0,
  foregroundWriteCount: 0,
  backgroundWriteCount: 0,
  flushWriteCount: 0,
  scheduledDrainCount: 0,
  drainWrites: []
}

function resetDebugState(): void {
  debugState.backgroundEnqueueCount = 0
  debugState.foregroundWriteCount = 0
  debugState.backgroundWriteCount = 0
  debugState.flushWriteCount = 0
  debugState.scheduledDrainCount = 0
  debugState.drainWrites = []
}

function exposeDebugApi(): void {
  if (!debugEnabled || typeof window === 'undefined') {
    return
  }
  // Why: the e2e repro needs to prove background output used the shared drain,
  // but production must not accumulate diagnostic counters indefinitely.
  const target = window as unknown as {
    __terminalOutputSchedulerDebug?: TerminalOutputSchedulerDebugApi
  }
  target.__terminalOutputSchedulerDebug ??= {
    reset: resetDebugState,
    snapshot: () => ({
      ...debugState,
      drainWrites: [...debugState.drainWrites]
    })
  }
}

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null) {
    return
  }
  if (debugEnabled) {
    debugState.scheduledDrainCount++
  }
  drainTimer = setTimeout(drainQueuedOutput, delayMs)
}

function takeQueuedChunk(entry: QueueEntry, limit: number): { data: string; onParsed: () => void } {
  let remaining = limit
  let data = ''
  const parsedCallbacks: (() => void)[] = []

  while (remaining > 0 && entry.chunks.length > 0) {
    const chunk = entry.chunks[0]
    if (chunk.data.length <= remaining) {
      data += chunk.data
      remaining -= chunk.data.length
      const consumed = chunk.data.length
      if (chunk.onParsed && consumed > 0) {
        parsedCallbacks.push(() => chunk.onParsed?.(consumed))
      }
      entry.chunks.shift()
      continue
    }

    const consumed = remaining
    data += chunk.data.slice(0, remaining)
    entry.chunks[0] = { ...chunk, data: chunk.data.slice(remaining) }
    if (chunk.onParsed && consumed > 0) {
      parsedCallbacks.push(() => chunk.onParsed?.(consumed))
    }
    remaining = 0
  }

  return {
    data,
    onParsed: () => {
      for (const callback of parsedCallbacks) {
        callback()
      }
    }
  }
}

function getWriteState(terminal: TerminalOutputTarget): TerminalWriteState {
  let state = writesByTerminal.get(terminal)
  if (!state) {
    state = { queue: [], writing: false }
    writesByTerminal.set(terminal, state)
  }
  return state
}

function invokeWriteCallback(entry: WriteQueueEntry): void {
  if (entry.callbackInvoked) {
    return
  }
  entry.callbackInvoked = true
  entry.callback?.()
}

function invokeQueuedChunkCallbacks(entry: QueueEntry): void {
  for (const chunk of entry.chunks) {
    if (chunk.data.length > 0) {
      chunk.onParsed?.(chunk.data.length)
    }
  }
  entry.chunks.length = 0
}

function discardWriteState(state: TerminalWriteState): void {
  if (state.current) {
    invokeWriteCallback(state.current)
    state.current = undefined
  }
  for (const entry of state.queue) {
    invokeWriteCallback(entry)
  }
  state.queue.length = 0
  state.writing = false
}

function finishTerminalWrite(terminal: TerminalOutputTarget, state: TerminalWriteState): void {
  if (writesByTerminal.get(terminal) !== state) {
    return
  }
  state.current = undefined
  state.writing = false
  if (state.queue.length === 0) {
    writesByTerminal.delete(terminal)
    return
  }
  pumpTerminalWriteQueue(terminal, state)
}

function pumpTerminalWriteQueue(
  terminal: TerminalOutputTarget,
  state = writesByTerminal.get(terminal)
): void {
  if (!state || state.writing) {
    return
  }

  const next = state.queue.shift()
  if (!next) {
    writesByTerminal.delete(terminal)
    return
  }

  state.writing = true
  state.current = next
  let settled = false
  const finish = (): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    finishTerminalWrite(terminal, state)
  }
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    // Why: if xterm never calls back, these bytes have no future ACK path.
    // Treat them as abandoned so upstream PTYs cannot remain paused forever.
    try {
      invokeWriteCallback(next)
    } finally {
      finish()
    }
  }, WRITE_CALLBACK_TIMEOUT_MS)
  try {
    terminal.write(next.data, () => {
      try {
        invokeWriteCallback(next)
      } finally {
        finish()
      }
    })
  } catch {
    // Why: xterm throws when disposed and can throw its overflow guard if a
    // caller bypassed flow control earlier. Drop this terminal's pending writes
    // so one dead pane cannot poison the global scheduler.
    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
    discardWriteState(state)
    writesByTerminal.delete(terminal)
  }
}

export function enqueueTerminalWrite(
  terminal: TerminalOutputTarget,
  data: string,
  callback?: () => void
): void {
  const state = getWriteState(terminal)
  state.queue.push({ data, callback })
  pumpTerminalWriteQueue(terminal, state)
}

function writeQueuedChunk(entry: QueueEntry): boolean {
  const { data, onParsed } = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  if (!data) {
    return false
  }
  enqueueTerminalWrite(entry.terminal, data, onParsed)
  return true
}

function drainQueuedOutput(): void {
  drainTimer = null
  let writes = 0

  while (queuedByTerminal.size > 0 && writes < MAX_WRITES_PER_DRAIN) {
    const entry = queuedByTerminal.values().next().value
    if (!entry) {
      break
    }

    queuedByTerminal.delete(entry.terminal)
    if (writeQueuedChunk(entry)) {
      writes++
      if (debugEnabled) {
        debugState.backgroundWriteCount++
      }
    }
    if (entry.chunks.length > 0) {
      queuedByTerminal.set(entry.terminal, entry)
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
  }
  if (queuedByTerminal.size > 0) {
    scheduleDrain(BACKGROUND_DRAIN_INTERVAL_MS)
  }
}

export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options: { foreground: boolean; onParsed?: (charCount: number) => void }
): void {
  exposeDebugApi()
  if (!data) {
    return
  }

  if (options.foreground) {
    flushTerminalOutput(terminal)
    if (debugEnabled) {
      debugState.foregroundWriteCount++
    }
    enqueueTerminalWrite(terminal, data, () => options.onParsed?.(data.length))
    return
  }

  let entry = queuedByTerminal.get(terminal)
  if (!entry) {
    entry = { terminal, chunks: [] }
    queuedByTerminal.set(terminal, entry)
  }
  entry.chunks.push({ data, onParsed: options.onParsed })
  if (debugEnabled) {
    debugState.backgroundEnqueueCount++
  }
  // Why: non-focused panes can produce output continuously. Letting every
  // pane call xterm.write immediately schedules one xterm WriteBuffer timer
  // per pane, which starves the focused terminal on the shared renderer thread.
  scheduleDrain(BACKGROUND_FLUSH_DELAY_MS)
}

export function flushTerminalOutput(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  const entry = queuedByTerminal.get(terminal)
  if (!entry) {
    return
  }
  queuedByTerminal.delete(terminal)

  let data = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  while (data.data) {
    if (debugEnabled) {
      debugState.flushWriteCount++
    }
    enqueueTerminalWrite(terminal, data.data, data.onParsed)
    data = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  }
}

export function waitForTerminalOutputParsed(terminal: TerminalOutputTarget): Promise<void> {
  flushTerminalOutput(terminal)

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      resolve()
    }
    timer = setTimeout(finish, PARSE_SETTLE_TIMEOUT_MS)
    enqueueTerminalWrite(terminal, '', finish)
  })
}

export function discardTerminalOutput(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  const queuedEntry = queuedByTerminal.get(terminal)
  if (queuedEntry) {
    invokeQueuedChunkCallbacks(queuedEntry)
    queuedByTerminal.delete(terminal)
  }
  const writeState = writesByTerminal.get(terminal)
  if (writeState) {
    discardWriteState(writeState)
  }
  writesByTerminal.delete(terminal)
}

exposeDebugApi()
