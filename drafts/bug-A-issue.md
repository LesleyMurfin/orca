# Issue (DRAFT — Bug A): Connected to a remote `orca serve`, the "+" terminal menu offers only PowerShell + CMD

> **Status:** DRAFT for review — NOT yet filed upstream. Will be filed on `stablyai/orca` only after build + live test + Lesley's approval.

## Summary
When the desktop client is paired to a headless `orca serve` runtime running on Linux (e.g. WSL Ubuntu, bridge-free serve topology), the new-tab "+" / `Ctrl+T` shell submenu shows only **PowerShell** and **CMD** — there is no working shell option for that host. PowerShell/CMD are meaningless on the Linux serve, and selecting them cannot open a usable shell.

## Environment
- Orca v1.4.88
- Windows desktop client paired to a headless `orca serve` on WSL Ubuntu (Linux host)
- Bridge-free serve topology (terminals/agents route to the serve)

## Steps to reproduce
1. Run `orca serve` on a Linux host.
2. Pair the Windows desktop client to that serve.
3. Open the "+" new-terminal menu (or press `Ctrl+T`).

**Expected:** the menu reflects the *execution host* — i.e. it should not advertise local Windows shells that can't run on the Linux serve; the plain "New Terminal" should open the serve's default shell (bash).

**Actual:** the menu lists PowerShell + CMD (local Windows shells) and no WSL/Git Bash. These entries promise a Windows shell but the runtime host is Linux.

## Root cause
In `src/renderer/src/components/tab-bar/TabBar.tsx`, the Windows-shell submenu is gated by:

```ts
const shouldShowWindowsShellMenu =
  (isWindows || windowsTerminalCapabilities.hostPlatform === 'win32') &&
  !worktreeHasRemoteConnection
```

`worktreeHasRemoteConnection` is `true` only for an **SSH** repo `connectionId` — it is `false` for a serve-runtime-paired worktree, so the menu still renders. PowerShell + CMD are pushed unconditionally under `includeHostShells` (no capability check), while WSL/Git Bash rows are gated on `wslAvailable`/`gitBashAvailable` — both `false` when the probe targets the Linux serve. Net: only the two nonsensical local-Windows shells survive on a Linux host.

This is the same situation the existing SSH suppression already handles (`TabBar.tsx`: *"SSH-backed PTYs ignore local Windows shell overrides"*), and matches the principle in #5327: **shell choices should follow the execution host, not the client OS.**

## Related
- #5327 (OPEN) — "Support Windows shell selection for SSH hosts" — same code path, states the execution-host principle.
- #5519 (MERGED) — introduced `getProjectRuntimeShellMenuMode` / project Windows runtime selection; did not cover the serve (Linux) runtime.

<!-- maintainer norm: add X handle before filing -->
