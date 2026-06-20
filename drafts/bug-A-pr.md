# PR (DRAFT — Bug A): fix: don't show local Windows shells for serve-runtime worktrees

> **Status:** DRAFT for review — NOT yet filed upstream. Will be filed on `stablyai/orca` only after build + live test + Lesley's approval.
> **Target branch (at filing):** `fix/serve-runtime-shell-menu` (split from the integration branch `ai/remote-terminal-wsl-floating-fix`).
> Fixes #<bug-A-issue-number>

## Summary
Suppresses the local Windows shell submenu when the active terminal runtime host is **not** Windows (e.g. a Linux `orca serve`). On such a host PowerShell/CMD/Git Bash are meaningless, and the plain **"New Terminal"** already opens the runtime's default shell (bash). This mirrors the existing SSH-PTY suppression and applies #5327's principle: *shell choices follow the execution host, not the client OS.*

## Change
`src/renderer/src/components/tab-bar/TabBar.tsx` — extend the existing suppression gate:

```ts
const runtimeHostIsNonWindows =
  Boolean(activeRuntimeEnvironmentId?.trim()) &&
  !windowsTerminalCapabilities.isLoading &&
  windowsTerminalCapabilities.hostPlatform !== 'win32'
const shouldShowWindowsShellMenu =
  (isWindows || windowsTerminalCapabilities.hostPlatform === 'win32') &&
  !worktreeHasRemoteConnection &&
  !runtimeHostIsNonWindows
```

**Suppression-only — no new transport, no PowerShell bridge.** No bash entry is bolted into the Windows-shell builder (which would route through `resolveWindowsShellLaunchTarget` and mangle `bash`); the existing plain "New Terminal" path already spawns the serve's default shell.

## Why keyed on probed `hostPlatform` (not "a runtime is active")
Keying on "an `activeRuntimeEnvironmentId` is set" would regress #5519's **local Windows-WSL project runtime**, which runs on a `win32` host and must keep its 4-shell menu. Gating on the probed `windowsTerminalCapabilities.hostPlatform !== 'win32'` preserves that menu and only suppresses on non-Windows hosts.

## Testing
- Co-located unit test `TabBar.windows-shell-launch.test.ts`: a serve runtime (`hostPlatform: 'linux'`) hides PowerShell/CMD/WSL rows and keeps plain "New Terminal"; existing win32-remote regression tests still pass. **8/8 green.**
- TODO before filing: live repro on a Win-client ↔ WSL-serve build; e2e spec mirroring `tests/e2e/terminal-windows-shell-paste-ownership.spec.ts`.

## AI code-review summary
- **Cross-platform:** behavior unchanged on a native Windows client (`isWindows` / `hostPlatform === 'win32'` still shows the full menu); only a non-Windows runtime host suppresses.
- **SSH / remote / local:** reuses the existing `worktreeHasRemoteConnection` SSH suppression; adds the parallel serve-runtime case. Local project runtimes on Windows are explicitly preserved.
- **Agent:** launching a Claude agent already routes serve-side and is unaffected (only the *shell submenu* render changes).
- **Performance:** one boolean derived from already-computed state; no new probes or renders.
- **Security:** no new shell-launch path; removes nonsensical local-shell entries on remote hosts.

## Reconcile before filing
- Open PR #2160 (default-wsl) edits the same shell-list region on a stale base — reconcile before any upstream push.

<!-- maintainer norm: add X handle before filing -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
