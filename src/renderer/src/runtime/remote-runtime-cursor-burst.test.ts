/**
 * Mechanism-level repro for the remote-runtime invisible-cursor bug (v1.4.88).
 *
 * WHY this exists: in the remote serve topology a repainting TUI (claude/vim)
 * hides the cursor with a bare `\e[?25l` and shows it again with `\e[?25h` a
 * moment later. The serve output batcher coalesces on a 5ms timer, so under
 * fast input the flush can land BETWEEN the hide and the show — emitting them in
 * two separate binary frames. The client multiplexer forwards one frame at a
 * time with no cross-frame buffering, so the renderer paints the gap with the
 * cursor hidden. The native-Windows path already protects against this split;
 * remote-runtime PTYs were never included in that gate.
 *
 * This test wires the REAL transport modules end-to-end and asserts the cursor
 * is not left hidden after both frames are processed.
 *
 * --- REAL vs FAKED (RULE #1: no silent over-mocking) ---
 * REAL:
 *  - The serve output batcher `createTerminalOutputBatcher`, driven through the
 *    REAL RPC path (`TERMINAL_METHODS` + `RpcDispatcher.dispatchStreaming` with
 *    `terminalBinaryStream` capability), exactly as it runs in production. Fake
 *    timers make the 5ms flush land between the hide and show, producing two
 *    real binary `Output` frames.
 *  - The real terminal-stream wire codec: `encodeTerminalStreamFrame` /
 *    `encodeTerminalStreamText` on the serve side; `decodeTerminalStreamFrame` /
 *    `decodeTerminalStreamText` on the client side.
 *  - The real renderer write scheduler `writeTerminalOutput`
 *    (pane-terminal-output-scheduler.ts) and its foreground hold / coalesce /
 *    strip-transient-cursor-show state machine, against a faithful xterm sink
 *    that records the exact byte stream written (same fake-terminal shape the
 *    scheduler's own tests use).
 * FAKED / REPLICATED (and why):
 *  - The client multiplexer's Output-case forwarding. The real
 *    `RemoteRuntimeTerminalMultiplexer` class is not exported and only receives
 *    frames via `window.api.runtimeEnvironments.subscribe` (Electron preload),
 *    so it is not headlessly constructible without deep Electron mocks. We
 *    replicate its Output case verbatim (decode frame -> decode text -> call
 *    onData once per frame, NO cross-frame buffering — multiplexer
 *    handleBinary, lines 330-336) so the no-buffering behavior under test is the
 *    real one.
 * REAL (was replicated, now wired to production):
 *  - The gate flag-decision from `writePtyOutputToXterm`. It is now the exported
 *    pure `computeSplitCursorBurstFlags` (split-cursor-burst-flags.ts), so this
 *    test drives the SAME logic the renderer runs. `protectSplitCursorBursts`
 *    selects the repo state under test (false = pre-fix, remote-runtime PTYs
 *    outside the gate; true = the fix that adds them). The captured claude/vim/htop
 *    byte streams contain ZERO DEC-2026 markers (only bare `?25l`/`?25h`), so the
 *    bare path is the one that decides the bug — see CAPTURE-FINDINGS.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { computeSplitCursorBurstFlags } from '../components/terminal-pane/split-cursor-burst-flags'
import { RpcDispatcher } from '../../../main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../../main/runtime/rpc/methods/terminal'
import type { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import type { RpcRequest } from '../../../main/runtime/rpc/core'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'

// Why: the scheduler imports @/lib/e2e-config at module load; the alias is not
// resolved in this test context, so stub it like the scheduler's own tests do.
vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

/**
 * Drive the REAL serve batcher through the REAL RPC streaming path and collect
 * the binary frames it emits. `emit` lets the caller push PTY output, then
 * advance fake timers to control where the 5ms flush boundary falls.
 */
async function startServeBatcherStream(): Promise<{
  emit: (data: string) => void
  binaryFrames: Uint8Array<ArrayBufferLike>[]
  flushTimers: () => Promise<void>
  stop: () => Promise<void>
}> {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const cleanups = new Map<string, () => void>()
  const dataListenerRef: { current?: (data: string) => void } = {}
  const runtime = stubRuntime({
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 80, rows: 24 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
      dataListenerRef.current = listener
      return vi.fn()
    }),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      const cleanup = cleanups.get(id)
      cleanups.delete(id)
      cleanup?.()
    }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
    updateMobileViewport: vi.fn().mockResolvedValue(false)
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.subscribe', {
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      capabilities: { terminalBinaryStream: 1 }
    }),
    (msg) => messages.push(msg),
    {
      connectionId: 'conn-1',
      sendBinary: (bytes) => binaryFrames.push(bytes)
    }
  )

  await vi.waitFor(() =>
    expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
  )
  const emitData = dataListenerRef.current
  if (!emitData) {
    throw new Error('serve batcher data listener was never registered')
  }

  return {
    emit: emitData,
    binaryFrames,
    flushTimers: () => vi.runOnlyPendingTimersAsync(),
    stop: async () => {
      runtime.cleanupSubscription?.('terminal-1:desktop-1')
      await dispatchPromise
    }
  }
}

/**
 * Replicates the client multiplexer Output case (handleBinary lines 330-336):
 * decode each binary frame and deliver its text to onData ONCE per frame, with
 * NO cross-frame buffering. This is the no-buffering behavior the bug depends on.
 */
function deliverFramesAsMultiplexerWould(
  frames: Uint8Array<ArrayBufferLike>[],
  onData: (data: string) => void
): void {
  for (const bytes of frames) {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame || frame.opcode !== TerminalStreamOpcode.Output) {
      continue
    }
    onData(decodeTerminalStreamText(frame.payload))
  }
}

/**
 * Drives the REAL production flag-decision (`computeSplitCursorBurstFlags`) for a
 * REMOTE-RUNTIME foreground chunk and maps its outputs onto the scheduler write
 * opts exactly as `writePtyOutputToXterm` (pty-connection.ts) does. This is the
 * same logic the renderer runs — no replica.
 * `bareCursorSplitFixWired` selects the repo state under test via the production
 * `protectSplitCursorBursts` gate:
 *  - false = pre-fix v1.4.88: remote-runtime PTYs sit OUTSIDE the protect gate,
 *            so a bare dangling hide never holds -> frame A is shown cursor-hidden.
 *  - true  = the fix that adds remote-runtime PTYs to the gate: the hide holds
 *            until the matching show.
 * Advances the caller-owned `state` the same way the production caller does.
 */
function computeRemoteProtectionFlags(
  data: string,
  state: { synchronizedForegroundOutputActive: boolean; bareCursorHideForegroundActive: boolean },
  bareCursorSplitFixWired: boolean
): {
  forceForegroundRefresh: boolean
  followupForegroundRefresh: boolean
  stripTransientCursorShows: boolean
  coalesceForeground: boolean
  holdForeground: boolean
  holdForegroundUntilCursorShow: boolean
} {
  const flags = computeSplitCursorBurstFlags(data, {
    protectSplitCursorBursts: bareCursorSplitFixWired,
    foreground: true,
    state: {
      synchronizedForegroundOutputActive: state.synchronizedForegroundOutputActive,
      bareCursorHideForegroundActive: state.bareCursorHideForegroundActive
    }
  })

  // Advance the caller-owned state exactly as writePtyOutputToXterm does.
  state.synchronizedForegroundOutputActive = flags.nextSynchronizedForegroundOutputActive
  state.bareCursorHideForegroundActive = flags.bareCursorHideEnding

  // Map the pure flags onto scheduler opts, mirroring the production caller.
  return {
    forceForegroundRefresh:
      flags.synchronizedForegroundOutput || flags.cursorRestoreNeedsRowInvalidation,
    followupForegroundRefresh: flags.cursorRestoreNeedsRowInvalidation,
    stripTransientCursorShows: bareCursorSplitFixWired,
    coalesceForeground:
      (flags.synchronizedForegroundOutput && flags.synchronizedOutputEnded) ||
      flags.bareCursorHideShow,
    holdForeground:
      (flags.synchronizedForegroundOutput && flags.nextSynchronizedForegroundOutputActive) ||
      flags.bareCursorHideEnding,
    holdForegroundUntilCursorShow: flags.bareCursorHideEnding
  }
}

/**
 * Faithful xterm sink. Tracks the exact byte stream written AND captures the
 * cursor-visibility state AFTER EACH WRITE — every `terminal.write` is a chunk
 * xterm parses and shows on the next frame, so the cursor state left by a write
 * is a state the user can actually see. A write that leaves the cursor hidden,
 * followed by a SEPARATE later write that restores it, is the visible flicker:
 * the cursor vanished and only reappeared a frame later. (The scheduler's hold
 * coalesces the two into one write, so the hidden state is never displayed.)
 */
function createFakeXterm(): {
  written: string[]
  cursorHiddenAfterEachWrite: boolean[]
  buffer: { active: { cursorY: number; baseY: number; viewportY: number } }
  rows: number
  refresh: ReturnType<typeof vi.fn>
  _core: { refresh: ReturnType<typeof vi.fn> }
  write: (data: string, callback?: () => void) => void
} {
  const written: string[] = []
  const cursorHiddenAfterEachWrite: boolean[] = []
  const cursorHiddenNow = (): boolean => {
    const all = written.join('')
    const lastHide = all.lastIndexOf(CURSOR_HIDE)
    const lastShow = all.lastIndexOf(CURSOR_SHOW)
    return lastHide !== -1 && lastHide > lastShow
  }
  return {
    written,
    cursorHiddenAfterEachWrite,
    buffer: { active: { cursorY: 0, baseY: 0, viewportY: 0 } },
    rows: 24,
    refresh: vi.fn(),
    _core: { refresh: vi.fn() },
    write: (data: string, callback?: () => void) => {
      written.push(data)
      cursorHiddenAfterEachWrite.push(cursorHiddenNow())
      callback?.()
    }
  }
}

/**
 * True iff the cursor was left hidden by some write and only restored by a LATER
 * separate write — i.e. the hidden state was displayed for at least one frame.
 * (If the final write also leaves it hidden it still counts; either way the user
 * saw the cursor disappear.)
 */
function paintedWhileCursorHidden(cursorHiddenAfterEachWrite: boolean[]): boolean {
  return cursorHiddenAfterEachWrite.some((hidden) => hidden)
}

/**
 * Derive the cursor's final resting visibility from the exact bytes xterm
 * received. The cursor is hidden iff the last cursor toggle written was a hide.
 */
function cursorEndsHidden(written: string[]): boolean {
  const all = written.join('')
  const lastHide = all.lastIndexOf(CURSOR_HIDE)
  const lastShow = all.lastIndexOf(CURSOR_SHOW)
  return lastHide !== -1 && lastHide > lastShow
}

describe('remote-runtime cursor burst (mechanism-level repro)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadScheduler() {
    vi.resetModules()
    return import('../lib/pane-manager/pane-terminal-output-scheduler')
  }

  /**
   * Run the full pipeline: serve batcher -> binary frames -> multiplexer
   * forward -> renderer scheduler -> fake xterm. `bareCursorSplitFixWired` selects
   * the unpatched (false) vs fixed (true) protection decision. `singleFrame`
   * lets the positive control deliver the whole burst atomically.
   */
  async function runPipeline(opts: {
    bareCursorSplitFixWired: boolean
    singleFrame: boolean
  }): Promise<{ written: string[]; cursorHiddenAfterEachWrite: boolean[]; frameCount: number }> {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createFakeXterm()
    const protectionState = {
      synchronizedForegroundOutputActive: false,
      bareCursorHideForegroundActive: false
    }

    const stream = await startServeBatcherStream()

    if (opts.singleFrame) {
      // Positive control: hide+redraw+show arrive together, one flush.
      stream.emit(`${CURSOR_HIDE}REDRAW${CURSOR_SHOW}`)
      await stream.flushTimers()
    } else {
      // Bug repro: the 5ms flush lands between the hide and the show, so the
      // batcher emits two separate Output frames (frame A ends cursor-hidden).
      stream.emit(`${CURSOR_HIDE}REDRAW`)
      await stream.flushTimers()
      stream.emit(CURSOR_SHOW)
      await stream.flushTimers()
    }

    deliverFramesAsMultiplexerWould(stream.binaryFrames, (data) => {
      const flags = computeRemoteProtectionFlags(data, protectionState, opts.bareCursorSplitFixWired)
      writeTerminalOutput(terminal, data, {
        foreground: true,
        latencySensitive: true,
        ...flags
      })
    })

    // Drain every pending scheduler timer (hold-safety / coalesce release) so
    // any held chunk is flushed to xterm before we inspect cursor state.
    await vi.runAllTimersAsync()

    const frameCount = stream.binaryFrames.filter((bytes) => {
      const frame = decodeTerminalStreamFrame(bytes)
      return frame?.opcode === TerminalStreamOpcode.Output
    }).length

    await stream.stop()
    return {
      written: terminal.written,
      cursorHiddenAfterEachWrite: terminal.cursorHiddenAfterEachWrite,
      frameCount
    }
  }

  it('positive control: a single-frame burst is never painted with the cursor hidden (no false green)', async () => {
    const { written, cursorHiddenAfterEachWrite, frameCount } = await runPipeline({
      bareCursorSplitFixWired: false,
      singleFrame: true
    })
    // The whole burst rode one frame, so the transport never split it.
    expect(frameCount).toBe(1)
    // The cursor is shown by the end, and no write ever left it hidden — proving
    // the harness does not report a phantom flicker when there is none.
    expect(written.join('')).toContain(CURSOR_SHOW)
    expect(cursorEndsHidden(written)).toBe(false)
    expect(paintedWhileCursorHidden(cursorHiddenAfterEachWrite)).toBe(false)
  })

  it('repro: a split bare ?25l/?25h burst over remote-runtime paints the cursor hidden (UNPATCHED)', async () => {
    const { cursorHiddenAfterEachWrite, frameCount } = await runPipeline({
      bareCursorSplitFixWired: false,
      singleFrame: false
    })
    // The serve batcher really split the burst into two separate Output frames.
    expect(frameCount).toBe(2)
    // With the bare-cursor cross-frame hold NOT wired, the hide-ending frame is
    // written on its own before the show arrives — the user sees the cursor
    // vanish for a frame. THIS is the bug. On unpatched v1.4.88 this is true.
    expect(paintedWhileCursorHidden(cursorHiddenAfterEachWrite)).toBe(true)
  })

  it('fix: wiring the dangling-?25l cross-frame hold never paints the cursor hidden (PATCHED)', async () => {
    const { written, cursorHiddenAfterEachWrite, frameCount } = await runPipeline({
      bareCursorSplitFixWired: true,
      singleFrame: false
    })
    // The transport still splits the burst...
    expect(frameCount).toBe(2)
    // ...but the dangling-hide hold defers the hide-ending frame until the
    // matching show arrives, so no write ever leaves the cursor hidden, and the
    // cursor is visible at rest.
    expect(paintedWhileCursorHidden(cursorHiddenAfterEachWrite)).toBe(false)
    expect(cursorEndsHidden(written)).toBe(false)
  })
})
