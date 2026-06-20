# DRAFT PR — fix(terminal): apply split-cursor-burst protection to remote-runtime PTYs

> Draft for Lesley's review. Branch `ai/remote-cursor-fix` → `stablyai/orca:main`. **Not opened yet** — gated on the live visual check + final correctness re-review.

**Title:** `fix(terminal): apply split-cursor-burst protection to remote-runtime PTYs`

## Problem
The text cursor disappears while typing in repainting TUIs (claude, vim, htop) in **serve-hosted (remote-runtime)** terminals. Local terminals are unaffected. (See issue: cursor-disappears-in-remote-terminals.)

## Root cause
The serve-side 5 ms output batcher (`TERMINAL_OUTPUT_FLUSH_MS`) can split a TUI's `ESC[?25l … ESC[?25h` repaint burst across separate Output frames. The renderer's cursor-restore protection added for native-Windows ConPTY (#4669/#4907) is gated to `isNativeWindowsConpty` and is never applied to remote-runtime PTYs, which split the burst identically. Local PTYs deliver the burst atomically, so they don't hit it.

## Fix
Renderer-only (`src/renderer/src/components/terminal-pane/`, `src/renderer/src/lib/pane-manager/`):
- Extract the protection gate into a pure, unit-testable predicate `shouldProtectSplitCursorBursts()` and **broaden it to remote-runtime PTYs**. Native-Windows ConPTY behaviour is unchanged (it still matches).
- Add a **persistent hold-until-show**: a dangling `ESC[?25l` holds foreground output, and an intermediate cursor-free redraw frame **extends** the hold (instead of releasing it) until the matching `ESC[?25h` arrives or a safety timeout fires — fixing the ≥3-frame split case.
- Rename the now transport-neutral flag `nativeWindowsCursorRestore` → `cursorRestoreNeedsRowInvalidation`.

No serve-side, main-process, or native-module changes — so it does not collide with the in-flight output-batcher/ACK work (`terminal.ts` / multiplexer).

## Tests
- `split-cursor-burst-protection.test.ts` — the gate fires for remote-runtime and native-Windows ConPTY, and stays OFF for local non-Windows.
- `pane-terminal-output-scheduler.test.ts` — new 3-frame split test (extends the hold across a cursor-free redraw frame); RED before the hold-persistence change, GREEN after.
- `remote-runtime-cursor-burst.test.ts` — integration over the real batcher + codec + scheduler (unpatched vs patched contrast).

## Risk / compatibility
- Native-Windows ConPTY path is untouched (same gate value for it).
- Local non-Windows PTYs are excluded (protection stays off where it isn't needed).
- Known limitation (documented in source): a 5 ms flush that bisects the 6-byte `ESC[?25l` itself is not specifically handled (ambiguous tail; xterm reassembles for display).

## Validation status
- Unit/integration: passing.
- **Live visual check on a patched client over a remote serve PTY: pending** (final empirical gate before merge).
