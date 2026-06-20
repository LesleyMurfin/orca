# Lens 3 — Adversarial Correctness Review

**Scope:** Does the recommended option for each bug ACTUALLY fix the bug without introducing
regressions or new edge-case failures? All claims verified against the v1.4.88 fork tree at
`/home/lesley/orca-wsl-floating-wt` this session (the `orca-cursorfix` tree was not touched).

**Bugs reviewed**
- **Bug A** — WSL/bash terminal missing from the "+" shell menu on a serve-runtime connection.
- **Bug B** — Floating-workspace terminal fails with `selector_not_found` (black pane) over serve.

---

## BUG A — A1 (suppress Windows-shell submenu for serve, offer serve-side bash)

### Verdict: **SOUND-WITH-FIXES**

### Verified root-cause facts
- `shouldShowWindowsShellMenu = (isWindows || hostPlatform === 'win32') && !worktreeHasRemoteConnection`
  (`TabBar.tsx:383-385`). `worktreeHasRemoteConnection` is computed purely from `repo.connectionId`
  (`TabBar.tsx:312-318`) → **false** for a serve-runtime-paired worktree, so the local-Windows
  submenu still renders.
- PowerShell + CMD are pushed **unconditionally** under `includeHostShells`; Git Bash and WSL are
  capability-gated (`TabBar.tsx:507-530`). On a Linux serve the probe returns
  `wslAvailable=false`/`gitBashAvailable=false`, so only PowerShell/CMD survive — exactly the symptom.

### Key positive finding (makes A1 viable with no new transport)
The plain "New Terminal" entry already routes serve-side correctly:
`handleNewTab(undefined)` → `isWebRuntimeSessionActive` true → `createWebRuntimeSessionTerminal({command:undefined})`
(`Terminal.tsx:818-827`). With `command` undefined the serve spawns its **default shell (bash)**.
So suppressing the Windows submenu leaves a working "New Terminal" that delivers Lesley's intent
(serve-side bash, no Windows bridge) for free.

### Edge cases checked
| Edge case | Status | Notes |
|---|---|---|
| Local (non-serve) Windows still offers PowerShell/CMD/WSL/GitBash | **HANDLED** — *iff* suppression is keyed on probed `hostPlatform !== 'win32'`, NOT on "a runtime is active." |
| SSH path unchanged | **HANDLED** — already suppressed via `worktreeHasRemoteConnection`; A1 only widens suppression to serve, does not touch SSH. |
| Local Windows-WSL **project runtime** (PR #5519 feature) | **AT RISK** — runs on a `win32` host and must keep its menu. If suppression keys on `activeRuntimeEnvironmentId?.trim()` being set, this regresses #5519. Must key on `hostPlatform`. |
| Mac/Linux client | **HANDLED** — `isWindows` false and a Linux serve's `hostPlatform` is not `win32`; menu never rendered there. |
| New "serve bash" entry routing | **AT RISK** — existing shell items flow through `resolveWindowsShellLaunchTarget(...)` (`TabBar.tsx:582-588`, `:673-679`), a Windows-shell resolver that would mangle `bash`. |

### Required fixes
1. **Key the suppression on probed `windowsTerminalCapabilities.hostPlatform !== 'win32'`** (already
   computed at `TabBar.tsx:368-380`), NOT on "a runtime environment is active." This protects PR
   #5519's local Windows-WSL project-runtime menu.
2. **Do NOT add a bespoke "bash" entry routed through `resolveWindowsShellLaunchTarget`.** Reuse the
   existing plain "New Terminal" item, which already spawns serve-side bash. Add a custom multi-shell
   serve entry only if multi-shell selection on the serve is actually wanted — and if so, bypass the
   Windows-shell resolver.
3. Add a **local-WSL regression test** asserting the menu still renders when `hostPlatform === 'win32'`
   with a WSL project runtime.

### Showstopper
None. A1 is correct given fixes 1–2.

### Required tests (co-located unit + e2e, per maintainer norms)
- Extend `src/renderer/src/components/tab-bar/TabBar.windows-shell-launch.test.ts`:
  - serve runtime (`hostPlatform:'linux'`) ⇒ `windowsShellEntries === undefined`.
  - local Windows ⇒ unchanged 4-shell set.
  - **regression guard:** local Windows-WSL project runtime (`hostPlatform:'win32'`) ⇒ menu present.
- e2e mirroring `tests/e2e/terminal-windows-shell-paste-ownership.spec.ts`: serve-connected "+" yields a
  working bash PTY, no PowerShell/CMD entries.

---

## BUG B — floating terminal `selector_not_found` over serve

### Verdict: **SOUND-WITH-FIXES for option B-a; the note's failure-path framing is DEFECTIVE**

### The note targets the wrong layer (showstopper-class)
The companion note guesses the failure surfaces on the **activate** path. That is wrong. Verified:
- `createWebRuntimeSessionTerminal` swallows the error and returns `false` (`web-runtime-session.ts:92-98`).
- `activateWebRuntimeSessionTab` ALSO swallows and returns `false` (`web-runtime-session.ts:461-466`).
- The visible black-pane + toast comes from a **THIRD path**: the remote-runtime PTY transport.
  `connect()` calls `terminal.create` with `toRuntimeWorktreeSelector(worktreeId)` =
  `id:global-floating-terminal` (`remote-runtime-pty-transport.ts:404-405`); the serve resolver throws
  `selector_not_found` (`orca-runtime.ts:15546`); it is caught at `:439` and surfaced via
  `storedCallbacks.onError(runtimeTerminalErrorMessage(error))` at `:440` → the red `TerminalErrorToast`.

### Why local fallback can never save it (the decisive fact)
Transport selection is driven **solely** by `runtimeEnvironmentId` truthiness:
```
const transport = runtimeEnvironmentId
  ? createRemoteRuntimePtyTransport(runtimeEnvironmentId, transportOptions)
  : createIpcPtyTransport(transportOptions)          // pty-connection.ts:1713-1715
```
For `global-floating-terminal`, `getRuntimeEnvironmentIdForWorktree` finds no repo/owner and falls
through to `settings.activeRuntimeEnvironmentId` (`worktree-runtime-owner.ts:97`). So even after
`createWebRuntimeSessionTerminal` returns false and the local-PTY `store.createTab` fallback runs
(`floating-workspace-tab-creation.ts:45`), the pane still mounts the **remote** transport and re-throws
`selector_not_found`. The creation/activate try/catch blocks are red herrings.

Note: `isRuntimeSelectorNotFoundError` (`worktrees.ts:546`, the note's `:579`) is used only by store-sync
paths to **silently skip**; it is NOT what renders this toast. The note conflates it with the surfacing path.

### activate-vs-create failure-surface conclusion
Neither create nor activate surfaces the error — both swallow it. The actual surface is the remote PTY
transport's `connect()` (`remote-runtime-pty-transport.ts:404-440`), selected by `runtimeEnvironmentId`
truthiness in `pty-connection.ts:1713`.

### Edge cases / options checked
| Option | Fixes the real path? | Status |
|---|---|---|
| **B-a** serve-side virtual session — teach `resolveWorktreeSelector` to accept `global-floating-terminal` as a repo-less session | **YES** — `terminal.create`→`resolveWorktreeSelector` is exactly `connect()`'s callee. `'active'` special-case at `orca-runtime.ts:15488` is precedent. | **SOUND-WITH-FIXES** (not a one-liner) |
| **B-b** client normalizes floating id → real worktree selector | YES mechanically, but semantically wrong (floating is repo-less; ambiguous when serve has no worktrees). | Reject |
| **B-c** keep floating local even when serve-connected | Only if it ALSO forces `runtimeEnvironmentId`/transport to local for the floating id. Skipping the creation RPC alone does nothing (transport is still remote). | **DEFECTIVE as written** |

#### B-a required fixes / edge cases
- Define a **default cwd contract** (serve home or workspace root); otherwise the virtual PTY spawns in
  an unexpected dir (degraded, not erroring).
- Satisfy `session.tabs.activate` / `session.tabs.close` for the virtual id (both also send
  `id:global-floating-terminal`); otherwise those RPCs no-op (already swallowed → degraded, not broken).
- Adding a branch for one synthetic id cannot shadow real `id:` worktrees → **no new `selector_not_found`
  for real worktrees. HANDLED.**

#### B-c required (if chosen for minimalism)
- MUST also return local for `FLOATING_TERMINAL_WORKTREE_ID` in `getRuntimeEnvironmentIdForWorktree`
  (`worktree-runtime-owner.ts:97`) and/or the transport selector (`pty-connection.ts:1713`). Without
  this second edit B-c does nothing.
- Even when correct, gives **client-side** floating terminals (against Lesley's serve-side intent) and
  the split-brain the note flags.

### Local mode intact?
Yes — when no serve runtime is active, `runtimeEnvironmentId` is null, the IPC (local) transport is
selected, and the floating terminal works as today. B-a does not touch the local path.

### Showstopper
**Any fix confined to the creation/activate try/catch blocks will NOT fix this bug.** The
recommended-direction analysis must be re-anchored to `remote-runtime-pty-transport.ts:404-440`
(failure surface) and `pty-connection.ts:1713` / `worktree-runtime-owner.ts:97` (transport selection)
before implementation.

### Recommendation
Proceed with **B-a**, scoped to include the serve cwd contract + `session.tabs.activate/close` handling
for the virtual id.

### Required tests
- Unit on `resolveWorktreeSelector`: `id:global-floating-terminal` → virtual `ResolvedWorktree` with a
  default cwd (mirror the `name:` / #5696 test).
- Unit on `remote-runtime-pty-transport` `connect()`: no longer throws for the synthetic id.
- e2e under `tests/e2e/` (sibling to `floating-workspace-*.spec.ts` + `windows-project-runtime-smoke.spec.ts`):
  open a floating terminal while serve-paired → live PTY, no toast.

---

## Key files (absolute)
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` — Bug B real failure surface (`:404-440`).
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/components/terminal-pane/pty-connection.ts` — transport selection (`:1713-1715`).
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/lib/worktree-runtime-owner.ts` — floating id → serve env (`:78-98`).
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/runtime/web-runtime-session.ts` — create/activate swallow errors (`:92-98`, `:461-466`).
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/lib/floating-workspace-tab-creation.ts` — creation + local fallback (`:32-49`).
- `/home/lesley/orca-wsl-floating-wt/src/main/runtime/orca-runtime.ts` — `resolveWorktreeSelector` (`:15484-15546`), `'active'` precedent (`:15488`).
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/components/Terminal.tsx` — plain serve-bash path that makes A1 viable (`:810-828`).
- `/home/lesley/orca-wsl-floating-wt/src/renderer/src/components/tab-bar/TabBar.tsx` — Bug A menu gates (`:368-385`, `:497-530`).
