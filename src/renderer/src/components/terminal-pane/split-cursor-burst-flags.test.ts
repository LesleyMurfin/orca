/**
 * Unit tests for the pure split-cursor-burst flag decision. This is the SAME
 * logic `writePtyOutputToXterm` runs in production (pty-connection.ts), extracted
 * so a future edit that re-narrows protection to native-Windows-only is caught
 * here instead of silently passing CI.
 */
import { describe, expect, it } from 'vitest'
import {
  computeSplitCursorBurstFlags,
  type SplitCursorBurstState
} from './split-cursor-burst-flags'

const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'

function freshState(): SplitCursorBurstState {
  return { synchronizedForegroundOutputActive: false, bareCursorHideForegroundActive: false }
}

describe('computeSplitCursorBurstFlags', () => {
  it('engages the hold when a chunk ends on a dangling bare ?25l', () => {
    const flags = computeSplitCursorBurstFlags(`${CURSOR_HIDE}REDRAW`, {
      protectSplitCursorBursts: true,
      foreground: true,
      state: freshState()
    })
    expect(flags.bareCursorHideEnding).toBe(true)
    expect(flags.bareCursorHideShow).toBe(false)
  })

  it('releases (coalesces) when the matching ?25h arrives after a held hide', () => {
    const flags = computeSplitCursorBurstFlags(CURSOR_SHOW, {
      protectSplitCursorBursts: true,
      foreground: true,
      // Prior chunk ended on a dangling hide, so the hold is active.
      state: { synchronizedForegroundOutputActive: false, bareCursorHideForegroundActive: true }
    })
    expect(flags.bareCursorHideShow).toBe(true)
    expect(flags.bareCursorHideEnding).toBe(false)
  })

  it('applies no protection when the transport opts out (local non-Windows)', () => {
    const flags = computeSplitCursorBurstFlags(`${CURSOR_HIDE}REDRAW`, {
      protectSplitCursorBursts: false,
      foreground: true,
      state: freshState()
    })
    expect(flags.bareCursorHideEnding).toBe(false)
    expect(flags.bareCursorHideShow).toBe(false)
    expect(flags.synchronizedForegroundOutput).toBe(false)
    expect(flags.cursorRestoreNeedsRowInvalidation).toBe(false)
  })

  it('applies no protection on a background (non-foreground) chunk', () => {
    const flags = computeSplitCursorBurstFlags(`${CURSOR_HIDE}REDRAW`, {
      protectSplitCursorBursts: true,
      foreground: false,
      state: freshState()
    })
    expect(flags.bareCursorHideEnding).toBe(false)
  })

  it('gate-narrowing regression guard: protection stays ON for a protected remote-runtime chunk', () => {
    // A future edit that re-narrows the gate to native-Windows-only would flip
    // this off for a remote-runtime PTY (which sets protectSplitCursorBursts via
    // shouldProtectSplitCursorBursts) — this asserts the bare-cursor hold engages.
    const flags = computeSplitCursorBurstFlags(`${CURSOR_HIDE}REDRAW`, {
      protectSplitCursorBursts: true,
      foreground: true,
      state: freshState()
    })
    expect(flags.bareCursorHideEnding).toBe(true)
  })

  it('does not engage the bare-cursor hold while a DEC-2026 synchronized hold is active', () => {
    // Why: the two protection paths must not contend — the bare path is gated on
    // !synchronizedForegroundOutput.
    const flags = computeSplitCursorBurstFlags(`\x1b[?2026h${CURSOR_HIDE}`, {
      protectSplitCursorBursts: true,
      foreground: true,
      state: freshState()
    })
    expect(flags.synchronizedForegroundOutput).toBe(true)
    expect(flags.bareCursorHideEnding).toBe(false)
  })

  it('flags a cursor restore (hide -> reposition -> show) for row invalidation', () => {
    const flags = computeSplitCursorBurstFlags(`${CURSOR_HIDE}\x1b[5;1HX${CURSOR_SHOW}`, {
      protectSplitCursorBursts: true,
      foreground: true,
      state: freshState()
    })
    expect(flags.cursorRestoreNeedsRowInvalidation).toBe(true)
  })
})
