# Fix-options design — two Orca serve-runtime terminal bugs (v1.4.88)

**Tracking home:** Orca fork only (LesleyMurfin/orca), not a RILEY PRD ledger.
**Work tree:** `/home/lesley/orca-wsl-floating-wt` @ `ai/remote-terminal-wsl-floating-fix` (off v1.4.88 `6f77fdd4b`).
**Companion notes:** `floating-terminal-remote-selector-not-found.md` (Bug B, full), `wsl-menu-missing-on-serve-connection.md` (Bug A, pending BugAResearch), `HANDOFF-orca-fork-bugfixes.md` (plan + coordination).

## 🚫 Hard gate
Build + test locally on the fork, then **Lesley reviews and approves**, BEFORE any upstream issue or PR. Two bugs → two issues → two PRs.

## Quality gauntlet (RULE #20)
`/peer-review` (pick fix vs maintainer patterns) → implement → `/test-architect` → `/qa` → `/code-review` (vs AGENTS.md) → Lesley approval → file issue + PR per bug.

## Topology (verified context, PSN-0005)
Windows desktop client (thin) paired to a headless `orca serve` runtime on WSL Ubuntu (Linux), bridge-free. Terminals/agents route to the serve. Constraint (Lesley): **no "powershell bridge in windows"** — when connected, terminals should run **serve-side bash**.

---

## BUG A — connected "+" terminal menu lacks WSL (serve-side bash)

### Symptom
Connected "+"/Ctrl+T shell submenu offers only **PowerShell + CMD** — no WSL, no Git Bash. Launching a Claude *agent* spawns serve-side fine (runtime routing works); only the terminal shell submenu is wrong.

### Verified root cause (v1.4.88, `src/renderer/src/components/tab-bar/TabBar.tsx`)
1. Submenu shows when `shouldShowWindowsShellMenu = (isWindows || windowsTerminalCapabilities.hostPlatform === 'win32') && !worktreeHasRemoteConnection` (`:383-385`). `worktreeHasRemoteConnection` is true **only for an SSH repo `connectionId`** (`:312-318`) — **false** for a serve-runtime-paired worktree → submenu still shows.
2. PowerShell + CMD are pushed **unconditionally** (`:507-517`). Git Bash gated by `gitBashAvailable`; WSL gated by `wslAvailable` (`:518-530`).
3. Capabilities probed by `useWindowsTerminalCapabilities(shouldProbe, false, ownerKey, runtimeTarget)` where `runtimeTarget = getActiveRuntimeTarget({activeRuntimeEnvironmentId})` (`:368-380`). When serve-connected the probe targets the **Linux serve** → `wslAvailable=false`, `gitBashAvailable=false` → WSL + Git Bash rows dropped; PowerShell/CMD remain (hardcoded).
4. `getProjectRuntimeShellMenuMode(undefined)` returns `null` (`:89-99`); serve-connected → `localProjectRuntime` undefined (`:386-387`) → mode `null` → `includeWslShell = null !== 'host' = true`. **So menu-mode does NOT block WSL — only `wslAvailable=false` does.**

**Net:** the local-Windows shell submenu is rendered for a Linux serve worktree; it can never offer a working shell there, yet shows PowerShell/CMD (which are nonsensical on Linux).

### Fix directions
- **(A1) Suppress the Windows-shell submenu for serve-runtime worktrees (mirror the SSH precedent) and offer the serve's native shell.** Extend the existing `!worktreeHasRemoteConnection` suppression (and the `:381-382` "SSH PTYs ignore local Windows shell overrides" rationale) to also cover serve-runtime worktrees, then surface a serve-side bash "+" entry. Matches maintainer's existing pattern for "don't show local shells on a remote PTY."
  - Pros: aligns with an established maintainer pattern; delivers Lesley's serve-side-bash intent; removes the nonsensical PowerShell/CMD-on-Linux entries.
  - Cons: need to define how the serve's shell(s) are advertised/selected.
- **(A2) Make the capability probe / menu runtime-aware** so a serve(Linux) runtime advertises bash (and the menu offers it) instead of probing for Windows shells.
  - Pros: most "correct"; generalizes to any runtime.
  - Cons: larger surface; touches the capabilities hook + menu build.
- **Upstream dupe-check (Bug A):** No duplicate found (BugAResearch — zero issues/PRs on "serve runtime shell wsl"). Precedents: **Issue #5327** (OPEN, Jinwoo-H, "Support Windows shell selection for SSH hosts") — same code path, quotes the `:381-382` SSH comment, and states the governing principle: *"Shell choices should be based on the execution host, not the client OS."* **PR #5519** (MERGED, slashdevcorpse, "Add project Windows runtime selection") — introduced `src/shared/project-execution-runtime.ts` + `getProjectRuntimeShellMenuMode`, the runtime-aware menu machinery in our chain; did NOT cover the serve (Linux) runtime. Refinement: PowerShell+CMD are hardcoded under `includeHostShells` with **no** capability check — that's why only those two survive on the Linux serve.
- **Recommended direction (BugAResearch):** **(A1)** — suppress the Windows-shell submenu for serve-runtime worktrees the same way SSH is suppressed (extend `!worktreeHasRemoteConnection` / the `:381-382` pattern), and offer a serve-side bash entry. Minimal surgical change; matches the maintainer's "don't show local shells on a remote PTY" precedent; serve PTY already works. **(A2)** (fully runtime-aware probe/menu, generalizing #5327 + #5519) is the more upstreamable long-term shape but heavier — candidate for a follow-up upstream push. _Final pick deferred to `/peer-review`._
- **Maintainer + norms (Bug A):** Jinwoo Hong (Jinwoo-H) owns terminal/WSL/SSH-shell work + merges. CONTRIBUTING.md (no PR template) load-bearing rule this bug violates: *"Do not assume a process, file, credential, SHELL, or network path exists only on the local machine."* Terminal fixes ship tests: co-located `TabBar.windows-shell-launch.test.ts` + Playwright `tests/e2e/terminal-windows-shell-paste-ownership.spec.ts`.

### Honesty / to confirm on live repro
Confirm `hostPlatform`/`wslAvailable` values actually returned by the probe against the serve, and exactly where `onNewTerminalWithShell` routes when serve-connected (does selecting PowerShell currently open a serve-side shell or attempt a local one?).

---

## BUG B — floating workspace terminal `selector_not_found` over serve

### Symptom
Floating workspace terminal = black pane + `selector_not_found` when serve-connected (works locally).

### Verified root cause (v1.4.88)
Floating tabs bind synthetic `FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'` (`shared/constants.ts:125`). Serve-connected → routed to serve via `createWebRuntimeSessionTerminal({worktreeId:'global-floating-terminal'})` (`floating-workspace-tab-creation.ts:33-34`; activate path `floating-workspace-terminal-actions.ts:142-146`). Serve's selector resolver can't match the synthetic id (`orca-runtime.ts:15532-15546`) → throws `selector_not_found`; renderer surfaces it (`worktrees.ts:579`). Local works via `createTab` fallback (`floating-workspace-tab-creation.ts:45`). Full chain + repro: `floating-terminal-remote-selector-not-found.md`.

### Failure surface — CORRECTED (Lens 3 adversarial review, verified)
The earlier "activate/PTY-attach" guess was WRONG. Both `createWebRuntimeSessionTerminal` and `activateWebRuntimeSessionTab` swallow the error and return `false`; activate/list also bypass `resolveWorktreeSelector` via the `id:` fast-path. The visible black-pane + toast comes from the **remote PTY transport `connect()`** (`remote-runtime-pty-transport.ts:404-440`; cross-check traces the toast to `pty-transport.ts:751` → `TerminalErrorToast`), where `terminal.create` calls `resolveWorktreeSelector('id:global-floating-terminal')` → throws. **B-a is correct because it teaches `resolveWorktreeSelector` (the CREATE callee) to resolve the sentinel** — the common throw point. STILL TO DO: confirm on a LIVE repro which method visibly surfaces, per both Lens 3 reviews. Authoritative synthesis: `REVIEW-FINDINGS.md`.

### Status (2026-06-20): IMPLEMENTED on this branch, unit-tested green
- Bug A (A1 suppression, keyed on probed `hostPlatform !== 'win32'`, no new bash entry): `TabBar.tsx` + co-located test — 8/8 pass.
- Bug B (B-a virtual repo-less resolver branch at `homedir()`): `orca-runtime.ts` + co-located test — full suite 455/455 pass (Node 24).
- NOT yet done: live-repro validation (build patched client ↔ WSL serve), `/test-architect` e2e specs, `/code-review` (oxlint+tsc), Lesley approval. NOTHING filed upstream.

### Fix directions
- **(B-a) Serve-side:** teach the resolver to accept `global-floating-terminal` (or an explicit `global:`/`floating:` selector) as a **virtual, repo-less session** with a default cwd, instead of throwing. Precedent: **#5695/#5696** ("support worktree name selectors") added a `name:` branch to the same `resolveWorktreeSelector`.
  - Pros: parity with local; keeps synthetic-id design; resolver already special-cases `'active'`. Cons: introduces a worktree-less session concept (cwd + tab-graph placement).
- **(B-b) Client-side selector normalization:** when serve-connected, resolve the floating terminal to a real serve-known worktree selector. Precedent: **#4582** ("Fix remote runtime worktree selectors") normalizes renderer ids → runtime `id:` selectors. Pros: no server change. Cons: changes floating-workspace semantics under serve; ambiguous when no real worktree exists.
- **(B-c) Keep floating terminals local** even when serve-connected (skip web-runtime path for the synthetic id; always local-PTY fallback). Pros: smallest; matches the "local synthetic workspace" comment (`constants.ts:123-124`). Cons: split-brain (local floating terminals, remote repo terminals); may surprise users expecting everything remote.

### Upstream dupe-check (Bug B)
No existing upstream issue for this specific bug as of 2026-06-20 (BugBResearch). Precedents: #5695/#5696 (template for B-a), #4582 (template for B-b).

---

## Decision criteria for `/peer-review`
1. **Upstream acceptance** — which option best matches the maintainer's existing code/design patterns (resolver special-cases; SSH-suppression precedent; runtime-target plumbing)?
2. **Honors Lesley's constraints** — serve-side bash; no powershell bridge; bridge-free topology.
3. **Smallest correct surface** — minimal blast radius, no collision with in-flight work (cursor-fix branch edits `pty-connection.ts`/scheduler; the floating fix lives in `floating-workspace-*`/`orca-runtime.ts`; the WSL-menu fix lives in `TabBar.tsx`/capabilities hook — confirm zero overlap).
4. **Testability** — can we write the maintainer-expected tests (Jinwoo Hong's terminal fixes shipped Playwright/e2e specs)?

_Recommendations deferred to `/peer-review`; do not pre-commit a direction here._
