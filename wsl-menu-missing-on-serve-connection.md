# WSL / bash terminal missing from "+" menu on serve-runtime connection

Local fork-only research note. **No upstream issue/PR/comment was filed** — research only, per instruction.
Source reads: worktree `/home/lesley/orca-wsl-floating-wt` @ v1.4.88, file `src/renderer/src/components/tab-bar/TabBar.tsx` (all line numbers below verified against this tree this session).

## Summary

On a Windows desktop client paired to a remote `orca serve` runtime (headless WSL Ubuntu Linux host, bridge-free topology), the "+" new-terminal shell submenu shows **only PowerShell + CMD** — no "WSL", no "Git Bash". Agent launches (Claude, etc.) correctly route serve-side, so runtime routing works; only the *shell submenu* is wrong. Root cause is confirmed: the **local-Windows shell submenu is rendered for a serve (Linux) worktree**, PowerShell/CMD are pushed unconditionally, and WSL/Git Bash are dropped because the Windows-capability probe is (correctly) targeted at the Linux serve host where `wsl.exe` / git-bash do not exist.

The fix is a fork-local change; the *desired* behavior (Lesley) is that a serve-connected worktree offers a **serve-side bash terminal on the Linux host** — explicitly NOT a "PowerShell bridge in Windows".

## Environment

- Client: Orca desktop on Windows, v1.4.88.
- Runtime: remote `orca serve` on headless WSL Ubuntu (Linux), bridge-free serve topology.
- Worktree is paired to the serve runtime (`activeRuntimeEnvironmentId` is set), NOT an SSH-backed repo (`repo.connectionId` is empty).

## Reproduction

1. From the Windows desktop client, open a worktree whose repo is hosted on the remote serve runtime.
2. Click the tab-bar "+" → shell submenu.

- **Expected:** an entry that opens a shell on the actual execution host — i.e. a serve-side **bash** terminal on the Linux serve.
- **Actual:** only **PowerShell** and **CMD Prompt** appear (both local-Windows shells that cannot reach the Linux serve worktree as intended); WSL and Git Bash rows are absent.

## Root-cause chain (verified, TabBar.tsx @ v1.4.88)

1. **`worktreeHasRemoteConnection` is FALSE for serve worktrees.** It is computed (`TabBar.tsx:312-318`) purely from `repo.connectionId` — the SSH connection id. A serve-runtime-paired repo has no `connectionId`, so this is `false`. (Contrast: the parallel `agentDetectionTargetKey` at `TabBar.tsx:323-338` *does* distinguish `ssh:` vs `runtime:` vs local — but the shell-menu gate does not.)

2. **`shouldShowWindowsShellMenu` therefore stays TRUE** (`TabBar.tsx:383-385`):
   ```ts
   const shouldShowWindowsShellMenu =
     (isWindows || windowsTerminalCapabilities.hostPlatform === 'win32') &&
     !worktreeHasRemoteConnection
   ```
   `isWindows` is true (Windows client) and `worktreeHasRemoteConnection` is false → the whole local-Windows shell submenu renders even though the worktree executes on a Linux serve. The adjacent comment (`TabBar.tsx:381-382`) only excuses SSH:
   > `// Why: SSH-backed PTYs ignore local Windows shell overrides; showing these`
   > `// entries there promises PowerShell/CMD/Git Bash but opens the remote shell.`
   The serve-runtime case has the same problem but is not covered by this gate.

3. **The capability probe targets the LINUX serve.** `runtimeTarget = getActiveRuntimeTarget({ activeRuntimeEnvironmentId })` (`TabBar.tsx:368-371`), and `windowsTerminalCapabilities = useWindowsTerminalCapabilities(shouldProbeWindowsShellCapabilities, false, ownerKey, runtimeTarget)` (`TabBar.tsx:375-380`). When serve-connected, the probe runs on the serve (Linux) host → `wslAvailable = false`, `gitBashAvailable = false`.

4. **The menu-mode does NOT block WSL.** When serve-connected, `localProjectRuntime` is forced `undefined` (`TabBar.tsx:386-387`: returns `undefined` when `activeRuntimeEnvironmentId?.trim()` is set). `getProjectRuntimeShellMenuMode(undefined)` returns `null` (`TabBar.tsx:89-99`). With mode `null`, both `includeHostShells = projectRuntimeShellMenuMode !== 'wsl'` and `includeWslShell = projectRuntimeShellMenuMode !== 'host'` are TRUE (`TabBar.tsx:501-502`). So the *mode* is not what suppresses WSL.

5. **PowerShell + CMD are pushed unconditionally; WSL/Git Bash are capability-gated** (`TabBar.tsx:507-530`):
   - `includeHostShells` → pushes `PowerShell` (`powershell.exe`) and `CMD Prompt` (`cmd.exe`) with no capability check (`TabBar.tsx:508-517`).
   - Git Bash pushed only if `windowsTerminalCapabilities.gitBashAvailable` (`TabBar.tsx:518-523`).
   - WSL pushed only if `includeWslShell && windowsTerminalCapabilities.wslAvailable` (`TabBar.tsx:525-530`).
   On the Linux serve the latter two capabilities are false → **WSL + Git Bash dropped, PowerShell + CMD remain** (hardcoded). This is exactly the observed symptom.

**Design issue:** the entire local-Windows shell submenu is a local-Windows concept being shown for a Linux serve worktree. The two shells it does show (PowerShell/CMD) are local-host shells, not serve-side shells. The menu has no concept of "offer the serve runtime's native shell (bash)".

This violates the maintainer's own contribution rule (`.github/CONTRIBUTING.md`): *"Orca must work against local repositories, remote servers, and SSH worktrees. Do not assume a process, file, credential, **shell**, or network path exists only on the local machine."*

## Candidate fix directions

### (a) Suppress the Windows-shell submenu for serve-runtime worktrees (mirror the SSH precedent), and offer the serve runtime's native shell(s)

Extend the suppression that already exists for SSH so it also covers serve-runtime worktrees, then surface a serve-side bash entry instead. Concretely: make `shouldShowWindowsShellMenu` also false when `activeRuntimeEnvironmentId` is a *Linux* serve runtime (the platform is already known — `windowsTerminalCapabilities.hostPlatform`), and add a serve-side default-shell entry routed through the runtime target.

- **Pros:** Directly matches the maintainer's existing "don't show local shells on a remote PTY" pattern — the `!worktreeHasRemoteConnection` gate + the `TabBar.tsx:381-382` SSH comment. Smallest behavioral surface. Gives Lesley exactly what he wants (serve-side bash, no Windows bridge). The serve PTY already works (agents spawn serve-side), so a plain serve-side shell tab needs no new transport.
- **Cons:** "Offer serve-side bash" needs the serve runtime to expose a default/host shell entry; the current submenu is hardcoded to the four Windows shells, so a new (non-Windows) entry has to be added to the menu builder. Must ensure the new entry routes through the runtime target rather than a local PTY.
- **Maintainer precedent it follows:** the SSH suppression (`!worktreeHasRemoteConnection` + comment at `TabBar.tsx:381-382`); and **upstream issue #5327 (open, author Jinwoo-H)** "Support Windows shell selection for SSH hosts" explicitly states *"Shell choices should be based on the execution host, not the client OS"* — direction (a) is the serve-runtime analog of that stated direction.

### (b) Make the capability probe / menu runtime-aware so it offers serve-side bash (and only host-appropriate shells)

Keep the submenu rendering but teach `useWindowsTerminalCapabilities` / `getProjectRuntimeShellMenuMode` / the shell-push block to recognize a Linux serve runtime and emit Linux shells (bash, plus any detected on the serve) while not emitting PowerShell/CMD.

- **Pros:** More general — would also fix Windows-SSH-host (#5327) and any future remote runtime in one runtime-aware menu. Aligns with the **PR #5519 (MERGED, "Add project Windows runtime selection")** model that already introduced `src/shared/project-execution-runtime.ts` and runtime-aware shell-menu mode (`getLocalProjectExecutionRuntimeContext`, `getProjectRuntimeShellMenuMode`).
- **Cons:** Larger blast radius — touches the capability hook's contract (today it returns Windows-shell booleans). PowerShell/CMD are currently hardcoded under `includeHostShells`, so (b) requires reworking the host-shell push to be platform-conditioned, not just capability-conditioned. Higher risk of regressing the existing local-Windows and Windows-runtime paths that #5519 just stabilized.

**Recommendation for a fork-local fix:** direction **(a)** — it is the minimal, surgical change, matches the existing SSH suppression pattern most closely, and delivers Lesley's stated requirement (serve-side bash, no Windows bridge). Direction (b) is the more upstreamable long-term shape (it generalizes #5327 + #5519) but is heavier and riskier; reserve it if this is ever taken upstream.

## Upstream (dupe-check + norms)

### Duplicate check — result: **NO exact duplicate found**

Searched stablyai/orca issues + PRs (state=all) via `gh` for the serve-runtime shell-menu case. Targeted searches `"serve runtime shell wsl"` and `"wsl shell menu serve"` returned **zero** issues and **zero** PRs. Nearest neighbors:

| # | Type | State | Author | Title | Relation |
|---|------|-------|--------|-------|----------|
| 5327 | Issue | OPEN | Jinwoo-H | Support Windows shell selection for SSH hosts | **Closest precedent.** Same code (`shouldShowWindowsShellMenu`, `worktreeHasRemoteConnection`, quotes the exact `TabBar.tsx:381-382` comment). But it's about *Windows-SSH host wanting to ADD* shells; our bug is *serve runtime wrongly SHOWING local Windows shells*. Same principle ("shells based on execution host, not client OS"), different host kind. NOT a duplicate, but the canonical design statement to align with. |
| 5111 | Issue | OPEN | slashdevcorpse | [Feature]: Allow WSL and PowerShell on diff projects | Per-project shell override; local-Windows only, not serve-runtime. Spawned the #5519 runtime model. Not a dupe. |
| 5097 | Issue | OPEN | babariviere | [Feature]: Allow to change the default shell (via the UI) | Generic default-shell UI; unrelated to remote/serve. Not a dupe. |
| 5519 | PR | MERGED | slashdevcorpse | Add project Windows runtime selection | **Key precedent PR.** Introduced `src/shared/project-execution-runtime.ts` + the runtime-aware shell-menu mode used in this bug's chain. The plumbing direction (b) would extend. Did NOT address serve-runtime (Linux) shell selection. |
| 5003 / 5523 / 4941 / 5132 | Issue | CLOSED | — | Windows SSH targets / DA1-OSC queries / mac remote-runtime black terminals / serve tab-snap | Adjacent terminal/serve work, none about the shell submenu contents. |

No issue or PR describes "+" terminal shell menu missing WSL/bash when connected to a remote serve runtime, the Windows-capability probe running against a serve (Linux) runtime as a *bug*, or serve-side terminal shell selection. **Conclusion: not a duplicate.**

### Precedent PRs in this area (from briefing, verified by author/state)
- **#5519** (MERGED, slashdevcorpse) "Add project Windows runtime selection" — introduced the runtime model + shell-menu mode central to this bug. Most relevant.
- **#4880** (MERGED, rbutera) "detect agents via install-dir resolver when which misses on GUI launch" — agent-detection, runtime-target adjacent.
- **#4949** (MERGED, AmethystLiang) "Fix active agent detection in split-pane layouts" — detection, not shell menu.
- **#5011** (MERGED, LesleyMurfin) "stop main-thread PowerShell ACL storm on env-store reads" — Windows ACL storm (matches memory note), not the shell menu.
- **#4946** (MERGED, Jinwoo-H) "Fix remote runtime terminal rendering" — remote-runtime terminal rendering, adjacent.
> Note: the briefing labeled #4880/#4949/#5011 as "the v1.4.53/54 agent-detection + ACL changes"; verified titles above differ slightly from that gloss but the PR numbers/area are correct.

### Maintainer + contribution norms
- **Maintainers / active authors in this area:** **Jinwoo Hong (`Jinwoo-H`)** — owns terminal + WSL + SSH-host shell work (authored #5327, #4946, and `Fix CI test drift after runtime changes #5655`); **slashdevcorpse** (PR #5519, the runtime model); plus `OrcaWin`, `brennanb2025` on Windows/terminal. The repo maintainer who merged prior fork PRs is Jinwoo Hong.
- **Contribution norms** (`.github/CONTRIBUTING.md`, present; no `PULL_REQUEST_TEMPLATE.md` found):
  - "Every change must stay compatible with macOS, Linux, and Windows unless guarded by a runtime platform check."
  - **"Orca must work against local repositories, remote servers, and SSH worktrees. Do not assume a process, file, credential, shell, or network path exists only on the local machine."** ← this bug is a direct violation; either fix direction should cite it.
  - Branch naming: descriptive `fix/...` / `feat/...` (e.g. `fix/ctrl-backspace-delete-word`).
  - "Run the same checks CI runs" before a PR (`pnpm install && pnpm dev`; lint/typecheck/test).
  - **Test expectations:** terminal/shell fixes ship tests. Co-located unit test exists: `src/renderer/src/components/tab-bar/TabBar.windows-shell-launch.test.ts` and `TabBar.context-menu.test.ts`; Playwright e2e in `tests/e2e/terminal-windows-shell-paste-ownership.spec.ts` (authored by Jinwoo Hong) and siblings. A fix here should add/extend the TabBar windows-shell unit test to assert the serve-runtime case, and ideally an e2e. (Confirms the memory note that Jinwoo Hong's terminal fixes ship Playwright/e2e specs.)

### Fork branches dupe-check (4 named branches)
Verified against `fork/` (LesleyMurfin/orca remote). **None addresses this serve-runtime shell-menu bug.**

- **`Jinwoo-H/default-wsl`** — head commit `83c26a3c2 "Fix Windows setup split terminal behavior"` (+ `Fix Windows dev terminal PATH and shell icons #2152`). Old branch (base era ~v1.4.3/v1.4.4). Touches `TabBar.tsx`, `TerminalPane.tsx`, `use-terminal-pane-lifecycle.ts`, settings panes — about Windows *local* WSL default + split-terminal setup, NOT serve-runtime menu suppression. **Not a fix for this bug.**
- **`Jinwoo-H/floating-terminal-default-on`** — head `7be9ed9fc "Enable Floating Terminal by default"`; the head commit changes only `src/shared/constants.ts` (one flag flip). Very old (no merge-base with current origin/main; ~v1.3.51 era). Unrelated to shell-menu contents. **Not a fix.**
- **`Jinwoo-H/floating-terminal-improvements`** — head `e789a6fec "Fix floating mixed tab review issues"` / `WIP: floating terminal mixed tabs`; touches `FloatingTerminalPanel.tsx`, `web-runtime-session.ts`, `browser` slice. Old (no merge-base; ~v1.4.x early). Floating-terminal panel UX, not the "+" shell submenu. **Not a fix.**
- **`feat/wsl-support`** — head `60d6d5ced`; key commit `51676bafa "feat: add WSL support for repos on WSL filesystems (#340)"` + WSL-path/CI portability fixes. Very old (1.0.x/1.1.0 era). Adds WSL support for repos whose files live on the WSL filesystem (path handling) — NOT remote serve-runtime shell selection. **Not a fix.**

## Honesty / not-verified

- I did NOT run the desktop client to reproduce live (no Windows-client session available here); the reproduction is derived from verified source logic, not an observed run. The agent-side serve routing claim ("agents spawn serve-side") is from the briefing, not independently re-verified this session.
- `gh` dupe-check is bounded by search-term coverage; I used targeted queries plus broad terminal/shell/runtime sweeps (issues and PRs, state=all) and found no exact match, but a duplicate phrased very differently could exist beyond the terms tried.
- The old fork branches (`floating-terminal-*`, `feat/wsl-support`) have no merge-base with current `origin/main`, so I summarized their head commits rather than a clean diff against main; their content is clearly out-of-area regardless.
