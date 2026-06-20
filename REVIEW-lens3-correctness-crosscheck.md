# Lens 3 — Adversarial Correctness Review (independent crosscheck)

**Scope:** Does the recommended option for each bug ACTUALLY fix the symptom, without regressing
working paths or introducing new edge-case failures? Read-only. Every `file:line` below was opened
and confirmed against the v1.4.88 fork tree at `/home/lesley/orca-wsl-floating-wt`
(branch `ai/remote-terminal-wsl-floating-fix`, HEAD `6f77fdd4b`) THIS session. The
`orca-cursorfix` tree was not touched. This is an independent crosscheck written to a separate path
so it does not overwrite the original Lens 3 review.

---

## BUG A — option A1 (suppress local Windows shell submenu for serve-runtime worktrees)

### Verdict: SOUND-WITH-FIXES

A1 as **suppression-only** correctly fixes the symptom and does not regress the working paths.
The one required change is scoping the new gate so it does not also suppress the menu on
**local Windows + local project runtime** worktrees. The "offer serve-side bash" half is NOT
required for correctness (the default `new-terminal` "+" entry already yields serve-side bash).

### Code-path trace (verified this session)

- The render gate is `shouldShowWindowsShellMenu` at `TabBar.tsx:383-385`:
  `(isWindows || windowsTerminalCapabilities.hostPlatform === 'win32') && !worktreeHasRemoteConnection`.
- `worktreeHasRemoteConnection` (`TabBar.tsx:312-318`) is `Boolean(repo?.connectionId)` — set ONLY
  for an SSH-repo `connectionId`, **false** for a serve-paired worktree. Confirmed: a serve worktree
  is identified instead by `activeRuntimeEnvironmentId` (`TabBar.tsx:309-311`), a different field.
  So on a serve worktree the gate is `true` and the Windows submenu renders. Root cause confirmed.
- `windowsShellEntries` (`TabBar.tsx:497-548`) pushes PowerShell + CMD **unconditionally** under
  `includeHostShells` (`:507-517`); Git Bash gated by `gitBashAvailable` (`:518-523`), WSL gated by
  `wslAvailable` (`:525-530`). Against a Linux serve the capability probe returns
  `gitBashAvailable=false`/`wslAvailable=false`, so only the two hardcoded Windows shells survive —
  exactly the reported "PowerShell + CMD only" symptom. Confirmed.
- A1-suppress = make `shouldShowWindowsShellMenu` also false when the worktree is on a serve runtime
  (AND a `!activeRuntimeEnvironmentId?.trim()` term, mirroring the existing `!worktreeHasRemoteConnection`).
  When `shouldShowWindowsShellMenu` is false, `windowsShellEntries` returns `undefined`
  (`TabBar.tsx:498-500`).

### Does suppression leave the user with NOTHING? (Lens1's flagged risk) — NO

Traced the "+" menu builder. With `windowsShellEntries === undefined`,
`buildTabCreateMenuOptions({ ..., windowsShellEntries: undefined, ... })` (`TabBar.tsx:551-560`)
falls back to the plain `new-terminal` entry. Selecting it hits
`handleSelectCreateMenuOption` `case 'new-terminal'` (`TabBar.tsx:573-575`) → `onNewTerminalTab()`,
the default terminal launch — which for a serve worktree already spawns the serve-side default
shell (the same routing that the brief confirms works for agents). **So A1-suppress delivers a
working serve-side bash via the default "+" path; the dedicated bash entry is a nicety, not a
correctness requirement.** This resolves Lens1's "the offer-bash half is the real risk": the risk
is real for the *add-bash-entry* sub-option, but A1-suppress alone is already functionally complete.
Ship suppression-only; defer any bash-row add-on.

### Regression analysis

1. **Local Windows desktop, no serve, local project runtime** — MUST still show PowerShell/CMD/
   WSL/GitBash. Here `activeRuntimeEnvironmentId` is null/empty and `worktreeHasRemoteConnection`
   is false, so a gate of the shape `... && !worktreeHasRemoteConnection && !activeRuntimeEnvironmentId`
   stays `true`. No regression — **provided** the new condition keys off
   `activeRuntimeEnvironmentId` (the serve marker), NOT off any broader "is web client" flag.
   **REQUIRED FIX / showstopper-if-missed:** do NOT reuse `isWebClient` or
   `shouldProbeWindowsShellCapabilities` as the suppressor. `shouldProbeWindowsShellCapabilities`
   (`:372-374`) is deliberately TRUE for a local Windows project-runtime worktree; suppressing on it
   would kill the legitimate Windows menu. Key suppression specifically on "a runtime environment is
   active" (`Boolean(activeRuntimeEnvironmentId?.trim())`).
2. **SSH-connected worktree** — already suppressed today via `!worktreeHasRemoteConnection`; A1 does
   not touch that term, so SSH behavior is unchanged. Confirmed.
3. **Mac/Linux-local client** — `isWindows` is false and `hostPlatform` is not `'win32'`, so
   `shouldShowWindowsShellMenu` is already false; the menu never rendered there. A1 is a no-op on
   this path. Confirmed.
4. **Windows-local probing of a serve runtime** — `localProjectRuntime` (`:386-409`) already returns
   `undefined` when `activeRuntimeEnvironmentId?.trim()` is set, so `projectRuntimeShellMenuMode` is
   `null` on a serve worktree today; suppression makes the whole block moot. No new interaction.
   Confirmed.

### Edge cases

- **`hostPlatform` arriving late / loading:** the gate also reads
  `windowsTerminalCapabilities.hostPlatform`. Suppression on `activeRuntimeEnvironmentId` is
  independent of probe timing, so the serve submenu is suppressed immediately regardless of probe
  state — no flash of PowerShell/CMD. Good.
- **Per-worktree, not global:** `activeRuntimeEnvironmentId` is derived via
  `getRuntimeEnvironmentIdForWorktree(s, worktreeId)` (`:309-311`), so a Windows client with BOTH a
  local repo worktree and a serve worktree open keeps the Windows menu on the local one and
  suppresses only the serve one. Correct granularity. Confirmed.

### Required fixes (Bug A)

1. Scope the new suppression to `Boolean(activeRuntimeEnvironmentId?.trim())` (serve runtime active
   for THIS worktree) — not `isWebClient`, not the probe flag. [correctness-critical]
2. Ship suppression-only; defer the bash-entry add-on (matches Lens1; not needed for the repro).
3. Co-located test in `TabBar.windows-shell-launch.test.ts`: serve worktree → no PowerShell/CMD
   rows; local-Windows worktree → rows unchanged.

### Showstopper
None, IF the suppressor keys off `activeRuntimeEnvironmentId`. If it keys off `isWebClient` or the
probe flag instead, it WILL regress the local-Windows project-runtime menu → that variant is
DEFECTIVE.

---

## BUG B — option B-a (serve-side: resolver accepts the synthetic floating id)

### Verdict: SOUND-WITH-FIXES

B-a is in the right layer and addresses the underlying throw, BUT the brief's stated surfacing
mechanism is **mis-traced**, and that changes WHICH server method the fix must cover. The resolver
branch alone is necessary but **not sufficient**; the fix must be validated against the method that
actually surfaces the error to the PTY transport — two of the three server entry points bypass the
resolver via an `id:` fast-path.

### Code-path trace (verified this session) — the brief's surfacing claim is WRONG

Selector sent to serve = `id:global-floating-terminal` (`toRuntimeWorktreeSelector`,
`runtime-worktree-selector.ts:3-9`; `FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'`,
`shared/constants.ts:125`). I traced every server entry point:

- **CREATE** — `session.tabs.createTerminal` (`rpc/methods/session-tabs.ts:39-51`) →
  `createMobileSessionTerminal` (`orca-runtime.ts:14492`) → `resolveTerminalWorkspaceLaunchScope`
  (`:14504`) → `resolveWorktreeSelector('id:global-floating-terminal')` (`:15448`) → **throws
  `selector_not_found`** at `:15546`. BUT the renderer caller `createWebRuntimeSessionTerminal`
  try/catches, `console.warn`s, and returns `false` (`web-runtime-session.ts:67-98`). On `false`,
  `createFloatingWorkspaceTerminalTab` falls through to the LOCAL `store.createTab(...)`
  (`floating-workspace-tab-creation.ts:41-49`). **So the create RPC is swallowed and falls back
  local — it does NOT itself surface the visible error.** This contradicts the OPTIONS/repro framing
  that the resolver throw surfaces via `worktrees.ts:579`.

- **ACTIVATE** — `session.tabs.activate` → `activateMobileSessionTab` (`orca-runtime.ts:3548`).
  `:3553-3555`: `getExplicitWorktreeIdSelector('id:global-floating-terminal')` returns
  `'global-floating-terminal'` (`:20798-20804`), so it uses that id **directly and never calls
  `resolveWorktreeSelector`.** It `.get('global-floating-terminal')` on the tab map, finds no tab,
  throws **`tab_not_found`** (`:3574-3575`) — NOT `selector_not_found`. Caller
  `callWebRuntimeSessionTabMethod` also try/catches → returns `false` (`web-runtime-session.ts:432-467`).

- **LIST / SUBSCRIBE** — `session.tabs.list` / `session.tabs.subscribe`
  (`rpc/methods/session-tabs.ts:16-18, :102-110`) → `listMobileSessionTabs` (`orca-runtime.ts:2644`).
  `:2645-2649`: same `getExplicitWorktreeIdSelector` fast-path → uses the id directly, **never** calls
  the resolver, returns an empty snapshot. No throw.

- **`worktrees.ts:579`** is the predicate `isRuntimeSelectorNotFoundError` (`:546-587`). Its only
  callers (`:2560, :2607, :2692, :2802, :2860, :3285`) are **worktree-meta-persistence / fetch**
  handlers, NOT the floating-terminal create or PTY-attach path. The brief's claim that this is the
  surfacing point is incorrect.

- **ACTUAL visible surface** is the PTY transport. The "Terminal error / please file an issue" toast
  is `TerminalErrorToast.tsx:77`, driven by `storedCallbacks.onError?.(msg)` in
  `pty-transport.ts:751` (the `pty:spawn` catch `:719-753`; the "please file an issue" toast is named
  in the comment at `:730-733`). The black pane + toast is the PTY spawn/attach carrying an
  underlying error message — which is where a serve-routed floating PTY spawn would carry
  `selector_not_found` to the user.

### Why this matters for the fix

Adding a branch ONLY at `resolveWorktreeSelector` (`:15546`) fixes `createMobileSessionTerminal` /
`resolveTerminalWorkspaceLaunchScope`, but does **not** fix `activateMobileSessionTab` or
`listMobileSessionTabs`, which bypass the resolver via the `id:` fast-path
(`getExplicitWorktreeIdSelector`). So:

- If the live failure is **CREATE → serve PTY spawn**, the resolver branch is the right fix — AND it
  changes behavior from "silently local fallback" to "real serve terminal," which is the intended
  parity but is a behavior change to validate (cwd contract below).
- If the live failure is on **ACTIVATE/attach**, the resolver branch does nothing for it; that path
  throws `tab_not_found` from the explicit-id fast-path.

### Regression analysis

1. **Local floating terminal (no serve):** `isWebRuntimeSessionActive(undefined)` is false
   (`web-runtime-session.ts:33-39`), so `createWebRuntimeSessionTerminal` short-circuits at `:60-62`
   and the local `store.createTab` path runs. B-a is a pure server-side resolver addition; never
   executes when no serve is active. **No regression.** Confirmed.
2. **Real serve worktrees:** B-a is additive; existing `id:`/`path:`/`branch:`/`name:`/`issue:`
   branches (`:15492-15538`) are untouched. No regression. Confirmed by reading the resolver body.
3. **`'active'` special-case** (`:15488-15489`) still throws — B-a must not weaken it; a new explicit
   `floating:`/`global:` branch is additive and idiomatic next to it.

### Edge cases

- **cwd for a repo-less session:** the resolver returns a `ResolvedWorktree` whose `path` becomes the
  PTY cwd and `ORCA_WORKTREE_ID` env (`:15471`). A synthetic resolved worktree needs a real existing
  cwd on the serve (serve home / workspace root) or the PTY spawn fails differently. **REQUIRED FIX:**
  pin a concrete existing cwd.
- **Multiple floating tabs:** all share the single id `global-floating-terminal`; the mobile-session
  tab map is keyed by worktree id, so multiple floating terminals collapse into one synthetic bucket
  — verify `targetGroupId` keeps them distinct, matching the local grouping. Worth a test.
- **Floating tab when NO serve connected but code still routes to web-runtime:** cannot happen —
  `createFloatingWorkspaceTerminalTab` only calls the web-runtime path with
  `environmentId = settings.activeRuntimeEnvironmentId` (`floating-workspace-tab-creation.ts:31-35`)
  and the web-runtime fns re-guard with `isWebRuntimeSessionActive` (`:60, :428`). No edge case.
- **Activate/cycle path** (`floating-workspace-terminal-actions.ts:139-150`) gates on
  `isWebRuntimeSessionActive` and calls `activateWebRuntimeSessionTab` → the resolver-bypassing
  fast-path. The resolver fix does NOT cover this surface.

### Required fixes (Bug B)

1. **Empirically confirm the failing server method (create vs activate vs PTY-spawn)** on a live
   repro before committing; `activate`/`list` bypass the resolver via the `id:` fast-path, so a
   resolver-only fix can miss the real surface. [correctness-critical]
2. Give the virtual session a concrete, existing default cwd (serve home / workspace root) so the PTY
   actually spawns. [correctness-critical]
3. Use an explicit `floating:`/`global:` prefix branch (or synthetic-id special-case) next to the
   `'active'` branch; ship the co-located `orca-runtime.test.ts` case (the #5696 pattern).
4. Validate multiple-floating-tab grouping under serve.

### Showstopper
**Conditional showstopper:** if the live repro fails on the **activate/attach** path, B-a *scoped to
`resolveWorktreeSelector` only* does NOT fix it — that path bypasses the resolver via
`getExplicitWorktreeIdSelector` and throws `tab_not_found`, not `selector_not_found`. The fix must be
validated against the method that actually surfaces the error to `pty-transport`, not assumed to be
the resolver. Resolve REQUIRED FIX 1 first.

---

Bug A: SOUND-WITH-FIXES
Bug B: SOUND-WITH-FIXES
