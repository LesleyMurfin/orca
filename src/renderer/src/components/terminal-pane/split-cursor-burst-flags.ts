// Why: TUIs like claude/vim/htop hide the cursor with bare `?25l`/`?25h` and a
// split transport (native-Windows ConPTY, remote-runtime) can end a chunk on the
// unmatched hide, painting a cursor-hidden gap until the later `?25h`. This pure
// module decides the foreground hold / coalesce flags that close that gap; the
// caller owns the mutable session state and threads it through each call.

const CURSOR_SHOW_SEQUENCE = '\x1b[?25h'
const CURSOR_HIDE_SEQUENCE = '\x1b[?25l'

function containsSynchronizedOutputStart(data: string): boolean {
  return data.includes('\x1b[?2026h')
}

function containsSynchronizedOutputEnd(data: string): boolean {
  return data.includes('\x1b[?2026l')
}

function shouldSynchronizedOutputRemainActive(data: string, wasActive: boolean): boolean {
  const lastStartIndex = data.lastIndexOf('\x1b[?2026h')
  const lastEndIndex = data.lastIndexOf('\x1b[?2026l')
  if (lastStartIndex === -1 && lastEndIndex === -1) {
    return wasActive
  }
  return lastStartIndex > lastEndIndex
}

function containsCursorPositionSequence(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    let index = offset + 2
    while (index < data.length) {
      const char = data[index]
      if (char === 'G' || char === 'H' || char === 'f') {
        return true
      }
      if ((char < '0' || char > '9') && char !== ';') {
        break
      }
      index += 1
    }
    offset = data.indexOf('\x1b[', offset + 2)
  }
  return false
}

function containsCursorRestore(data: string): boolean {
  const hideIndex = data.indexOf(CURSOR_HIDE_SEQUENCE)
  const showIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE)
  return hideIndex !== -1 && showIndex > hideIndex && containsCursorPositionSequence(data)
}

// Why: TUIs like claude/vim/htop hide the cursor with a bare `?25l` and a split
// transport can end a chunk on the unmatched hide, painting a cursor-hidden gap
// until the later `?25h`. Known limitation: a chunk that splits inside the 6-byte
// `?25l` itself is not caught (xterm reassembles for display; rare write-ordering).
function endsWithDanglingCursorHide(data: string): boolean {
  const hideIndex = data.lastIndexOf(CURSOR_HIDE_SEQUENCE)
  if (hideIndex === -1) {
    return false
  }
  const showIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE)
  return hideIndex > showIndex
}

/**
 * Mutable session state the flag decision reads and advances across chunks. The
 * caller owns these fields; this module never mutates them — it returns the next
 * values in {@link SplitCursorBurstFlags}.
 */
export type SplitCursorBurstState = {
  synchronizedForegroundOutputActive: boolean
  bareCursorHideForegroundActive: boolean
}

export type SplitCursorBurstContext = {
  /** Whether this transport opts into split-cursor-burst protection at all. */
  protectSplitCursorBursts: boolean
  /** Whether this chunk is being written to the foreground (visible) pane. */
  foreground: boolean
  /** Current session state (not mutated; advanced via the returned next-state). */
  state: SplitCursorBurstState
}

export type SplitCursorBurstFlags = {
  synchronizedForegroundOutput: boolean
  cursorRestoreNeedsRowInvalidation: boolean
  synchronizedOutputEnded: boolean
  bareCursorHideShow: boolean
  bareCursorHideEnding: boolean
  /** Next value for {@link SplitCursorBurstState.synchronizedForegroundOutputActive}. */
  nextSynchronizedForegroundOutputActive: boolean
}

/**
 * Pure decision for the split-cursor-burst foreground hold/coalesce flags. Moved
 * verbatim out of `writePtyOutputToXterm` so the same logic the renderer runs is
 * the logic the tests exercise. The caller applies the returned flags to the
 * write and persists the next-state fields back onto its own session state.
 */
export function computeSplitCursorBurstFlags(
  data: string,
  ctx: SplitCursorBurstContext
): SplitCursorBurstFlags {
  const { protectSplitCursorBursts, foreground, state } = ctx
  const synchronizedOutputStarted =
    protectSplitCursorBursts && foreground && containsSynchronizedOutputStart(data)
  const synchronizedOutputEnded =
    protectSplitCursorBursts && foreground && containsSynchronizedOutputEnd(data)
  const synchronizedForegroundOutput =
    protectSplitCursorBursts &&
    foreground &&
    (state.synchronizedForegroundOutputActive ||
      synchronizedOutputStarted ||
      synchronizedOutputEnded)
  const nextSynchronizedForegroundOutputActive =
    protectSplitCursorBursts &&
    foreground &&
    shouldSynchronizedOutputRemainActive(data, state.synchronizedForegroundOutputActive)
  // Why: xterm's DOM renderer draws the cursor as row content, so a
  // cursor-only restore needs row invalidation even outside DEC 2026 — on
  // both native-Windows ConPTY and remote-runtime split transports.
  const cursorRestoreNeedsRowInvalidation =
    protectSplitCursorBursts && foreground && containsCursorRestore(data)
  // Why: hold a foreground chunk that ends on an unmatched bare `?25l`;
  // release once the matching `?25h` arrives. Skipped while the DEC-2026 hold
  // is already engaged so the two paths don't contend.
  const bareCursorSplitProtection = protectSplitCursorBursts && foreground
  const bareCursorHideEnding =
    bareCursorSplitProtection &&
    !synchronizedForegroundOutput &&
    endsWithDanglingCursorHide(data)
  const bareCursorHideShow =
    bareCursorSplitProtection &&
    state.bareCursorHideForegroundActive &&
    !bareCursorHideEnding &&
    data.includes(CURSOR_SHOW_SEQUENCE)

  return {
    synchronizedForegroundOutput,
    cursorRestoreNeedsRowInvalidation,
    synchronizedOutputEnded,
    bareCursorHideShow,
    bareCursorHideEnding,
    nextSynchronizedForegroundOutputActive
  }
}
