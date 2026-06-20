# Issue (DRAFT — Bug B): Floating workspace terminal fails with `selector_not_found` (black pane) on a remote runtime

> **Status:** DRAFT for review — NOT yet filed upstream. Will be filed on `stablyai/orca` only after build + live test + Lesley's approval.

## Summary
Opening a terminal in the **floating workspace** while the desktop client is paired to a remote `orca serve` runtime produces a black pane and a `selector_not_found` error toast. It works correctly when not connected to a remote runtime.

## Environment
- Orca v1.4.88
- Windows desktop client paired to a headless `orca serve` on WSL Ubuntu (Linux host)
- Bridge-free serve topology

## Steps to reproduce
1. Pair the desktop client to a remote `orca serve`.
2. Open the floating workspace and create a terminal in it.

**Expected:** a working PTY (as it does locally).
**Actual:** black pane + `selector_not_found` toast.

## Root cause
Floating tabs bind to a synthetic worktree id `FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'` (`src/shared/constants.ts`). When serve-connected, the remote PTY transport's `connect()` calls `terminal.create` with selector `id:global-floating-terminal` (`remote-runtime-pty-transport.ts`). On the serve, `OrcaRuntimeService.resolveWorktreeSelector` cannot match that id against any real worktree and throws `selector_not_found` (`orca-runtime.ts`), which surfaces as the black pane + error toast. Locally the `createTab` fallback avoids the remote resolver, which is why it only reproduces over a remote runtime.

(Note: the create/activate wrappers swallow the error and return `false`; the *visible* failure comes from the PTY transport `connect()` path, whose callee is `resolveWorktreeSelector` — the fix targets exactly that callee.)

## Related
- #5695 / #5696 (MERGED) — added a `name:` branch to this same `resolveWorktreeSelector` (template for the fix).
