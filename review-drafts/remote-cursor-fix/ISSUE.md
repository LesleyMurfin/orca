# DRAFT ISSUE — text cursor disappears while typing in remote (serve-hosted) terminals

> Draft for Lesley's review before filing upstream at `stablyai/orca`. Not yet filed.

**Title:** Text cursor disappears while typing in remote serve-hosted terminals (claude / vim / htop)

## Summary
In a thin-client → `orca serve` setup, the terminal text cursor intermittently disappears while typing in repainting TUI apps (claude, vim, htop) in a **serve-hosted (remote-runtime) terminal**. The same apps in a **local** terminal render the cursor correctly. The cursor reappears once output settles, so it reads as flicker/disappearance during fast input.

## Environment
- Orca **v1.4.88** (reproduces on the current line).
- Topology: headless `orca serve` (PTY host) + thin client (Windows desktop and web client). Remote-runtime PTYs (`remote:<env>@@…`).
- Reproduces on a non-Windows client too (it is **not** Windows-specific) — see root cause.

## Steps to reproduce
1. Connect a client to an `orca serve` runtime.
2. Open a **serve-hosted** terminal (remote-runtime PTY — not a local PTY).
3. Run `claude` (or `vim`, `htop`) and type continuously / trigger repaints.
4. Observe: the block text cursor disappears during typing and reappears when output settles.
5. Repeat in a **local** terminal → cursor stays visible (no repro).

## Root cause (code-traced)
TUI apps bracket repaints with `ESC[?25l` (hide cursor) … `ESC[?25h` (show cursor). The serve-side output batcher (`createTerminalOutputBatcher`, `src/main/runtime/rpc/methods/terminal.ts`, `TERMINAL_OUTPUT_FLUSH_MS = 5`) flushes on a 5 ms timer, so under fast typing the flush boundary can fall **between** the hide and the matching show, splitting the burst across separate Output frames. The client writes one frame per `terminal.write()` with no cross-frame buffering, so xterm paints a frame that ends cursor-hidden; the show arrives a frame later.

The renderer already has protection for exactly this split — but it was added for **native-Windows ConPTY** (#4669, #4907) and is **gated to `isNativeWindowsConpty`** (`pty-connection.ts`), so it is **never applied to remote-runtime PTYs**, which split the `?25l/?25h` burst identically. Local PTYs deliver the burst in a single write (atomic parse) → no repro.

## Evidence
- A byte-capture of `claude`/`vim`/`htop` output shows the apps emit **bare `ESC[?25l` / `ESC[?25h`** with **zero** DEC-2026 synchronized-output markers (`ESC[?2026h/l`) — so the existing DEC-2026-keyed handling does not cover them; a dangling-`?25l` hold is required.
- Isolation: identical app, identical client; cursor is correct on a local PTY and wrong on a remote PTY → the difference is the split transport, not the renderer, TUI, or any appearance setting.

## Proposed fix
Broaden the existing split-cursor-burst protection from native-Windows-ConPTY-only to **remote-runtime PTYs** (native-Windows behaviour unchanged), and make the hold persist across an intermediate cursor-free redraw frame (≥3-frame split). See the linked PR.

## Related
- #4669, #4907 (the native-Windows ConPTY cursor-restore protection this generalizes).
