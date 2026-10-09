# PC / WSL Orca update path (Lesley)

Inventory of unfinished local PC/WSL Orca work versus `stablyai/orca`, plus the
path to bring Lesley's PC current. **PR-only.** This document does not retarget
the WSL CLI and does not apply factory/mtl-02 host work.

Snapshot date: 2026-09-06.

## Constraints (do not skip)

| Lock | Meaning |
| --- | --- |
| **WSL Orca LOCKED** | Do **not** change `~/.local/bin/orca` (AppImage / extracted launcher) without an explicit **GO**. CLI retarget is out of band. |
| **No factory apply** | Host work on mtl-02 factory cutover is out of scope. |
| **No duplicate canary** | `stablyai/orca#18790` PTY reap fix — canary pack already in flight on `revive_labs`. Do not open a second factory canary client PR unless PC needs its own serve binary. |
| **Fork merge rule** | Existing LesleyMurfin/orca PRs are draft. Do not self-merge; Lesley merges every fork PR. |

`revive_labs` docs/MOPs were **not readable** from this environment (private repo
not in the GitHub token scope; Drive had factory settings for mtl-02, not a PC
`serve@canary` MOP). Confirm canary status on the factory lane before any PC
serve cutover.

## Current PC / WSL posture

- **Client / CLI host:** WSL, native extracted AppImage at
  `~/.local/share/orca/squashfs-root` (Revive PRD-5175 **bridge-free** launcher).
  This is **not** the Windows `orca-wsl-bridge.ps1` path the fork installer still
  documents, and it is **not** upstream's post-#15081 cache layout
  (`${XDG_CACHE_HOME:-~/.cache}/orca/appimage/<namespace>/<generation>` +
  `launcher/orca-ide`).
- **Fork `main`:** `LesleyMurfin/orca` @ `bc98655a3` (2026-08-25,
  `fix(remote): stop an empty host inventory settling the mirror (#16414)`).
- **Upstream `main`:** `stablyai/orca` @ `6fcd82918` (2026-09-06). Fork `main` is
  **1,146 commits behind** and 0 ahead. The fork still has the pre-#15081
  FUSE AppImage CLI wrapper (`src/main/cli/appimage-cli-wrapper.ts` execs the
  outer AppImage with `ELECTRON_RUN_AS_NODE`).
- **Latest Linux desktop release with #15081:**
  [v1.4.197](https://github.com/stablyai/orca/releases/tag/v1.4.197)
  (2026-09-04). #15081 merged 2026-09-01 21:06 UTC; it is in `v1.4.195+`.

## What already landed upstream (do not re-open)

| Work | Upstream | Notes |
| --- | --- | --- |
| AppImage extract-once / stable CLI entrypoint | [#15081](https://github.com/stablyai/orca/pull/15081) **merged** 2026-09-01 | Official replacement for "re-open the outer AppImage every command". Closes #11609, #12530, #16650. **Adopting it rewrites the registered CLI.** That is a WSL retarget → **GO required**. |
| Floating terminal on remote runtime | [#5946](https://github.com/stablyai/orca/pull/5946) merged | Fork branch `ai/remote-terminal-wsl-floating-fix` (no PR) is leftover June docs + already-merged code. |
| Hide local Windows shells on serve worktrees | [#5947](https://github.com/stablyai/orca/pull/5947) merged | Same leftover branch. |
| Worktree `id:` selector path equivalence | [#16494](https://github.com/stablyai/orca/pull/16494) merged | Lesley. |
| Serve session tab persist, remote PTY/ConPTY, parcel-watcher pack, CLI `~/.local/bin` fallback | #5131, #6009, #6027, #4860, #3959 merged | Historical PC/serve fixes. |

## Open PRs that matter for PC current-ness

### Must land on `stablyai/orca` (upstream)

| PR | State | PC relevance | Action |
| --- | --- | --- | --- |
| [stablyai/orca#18790](https://github.com/stablyai/orca/pull/18790) `fix/worker-release-incarnation-reap` | OPEN, **CONFLICTING**, last push 2026-09-05 | Headless-serve PTY leak on relay epoch bump. Needed on any serve PC pairs to (factory canary **or** a local WSL `orca serve`). | **Do not duplicate.** Wait for canary pack / rebase+merge. PC client AppImage does **not** need a separate PR for this unless Lesley runs a local serve that must pick up the fix before upstream merge. |
| [stablyai/orca#16829](https://github.com/stablyai/orca/pull/16829) `ai/16733-local-worktree-owner-fallback` | OPEN, **CONFLICTING**, 2026-08-27 | Keeps unstamped **local** git worktrees routable when a runtime is saved. Matters for PC folder + git worktrees. | Rebase onto current `stablyai/orca` `main`; do not open a twin. |
| [stablyai/orca#10612](https://github.com/stablyai/orca/pull/10612) `ai/serve-stats-json-10608` | OPEN **draft**, stale since 2026-07-27 | `orca serve stats [--json]` — PC/scripts querying a headless serve. Duplicated on the fork as #18 / #24. | Rebase the existing upstream draft. Do not open a third copy. |

### Stay on Revive fork / `revive_labs` (do not push to upstream as-is)

| PR / branch | Why it stays | Next step |
| --- | --- | --- |
| [LesleyMurfin/orca#15](https://github.com/LesleyMurfin/orca/pull/15) reconnect supervisor | Fork-only draft; against Aug-25 `main`. | Rebase onto **current upstream** `main` only if the mid-stream client-event drop still reproduces on v1.4.197; then open one new `stablyai/orca` PR. |
| [LesleyMurfin/orca#16](https://github.com/LesleyMurfin/orca/pull/16) PRB-0003 spawn-loop backoff | Fork-only; 31 commits / noisy diff vs stale `main`. | Same: reproduce on current upstream, then one clean PR. |
| [LesleyMurfin/orca#17](https://github.com/LesleyMurfin/orca/pull/17) per-client view decouple | **GATED** — architecture decision pending. | Keep on fork until Lesley un-gates. |
| [LesleyMurfin/orca#18](https://github.com/LesleyMurfin/orca/pull/18) / [#24](https://github.com/LesleyMurfin/orca/pull/24) serve stats | Superseded by upstream #10612. | Close #18 as duplicate of #24; treat #24 as the fork mirror of #10612. |
| [LesleyMurfin/orca#19](https://github.com/LesleyMurfin/orca/pull/19) `orca environment config` | **HIGH-BLAST** remote settings write path. | Hold on fork. Upstream only after allowlist review + rebase. |
| [LesleyMurfin/orca#20](https://github.com/LesleyMurfin/orca/pull/20) Explorer/Git worktree path | UI; not required to get the PC CLI/serve current. | Optional later rebase. |
| [LesleyMurfin/orca#21](https://github.com/LesleyMurfin/orca/pull/21) `appRunning: serve` | Headless-status UX. | Rebase onto upstream if `orca status` still prints `appRunning: false` on v1.4.197 serve. |
| [LesleyMurfin/orca#22](https://github.com/LesleyMurfin/orca/pull/22) stale-dispatch reclaim | **BLOCKED** on `9b092fd12` — do not merge. | Keep blocked on fork. |
| `ai/remote-terminal-wsl-floating-fix` | No PR; code already merged upstream (#5946/#5947). | Leave. Do not open. |
| `ai/serve-port-explicit-pin-8535` | Upstream [#8602](https://github.com/stablyai/orca/pull/8602) **closed**. | Leave. |
| Factory canary pack / mtl-02 cutover | `revive_labs` + host. | Out of scope. |

### Upstream AppImage CLI follow-ups (do not land on PC without GO)

These are still **open** on `stablyai/orca` and overlap #15081. Several are likely
superseded. Do **not** install them onto `~/.local/bin/orca`.

- [#17971](https://github.com/stablyai/orca/pull/17971), [#17343](https://github.com/stablyai/orca/pull/17343),
  [#14230](https://github.com/stablyai/orca/pull/14230), [#13136](https://github.com/stablyai/orca/pull/13136),
  [#14006](https://github.com/stablyai/orca/pull/14006), [#13289](https://github.com/stablyai/orca/pull/13289),
  [#11705](https://github.com/stablyai/orca/pull/11705)

## Recommended PC update path (no launcher rewrite)

Goal: Lesley's PC tracks current Orca **without** touching `~/.local/bin/orca`.

1. **Leave the WSL CLI pointer alone.** Verify only:
   ```bash
   readlink -f ~/.local/bin/orca || true
   head -n 20 ~/.local/bin/orca
   test -x ~/.local/share/orca/squashfs-root/AppRun && echo APP_RUN_OK
   ```
   Expected: the script/exec still targets `~/.local/share/orca/squashfs-root`
   (PRD-5175 bridge-free). If it already points at
   `~/.cache/orca/appimage/.../launcher/orca-ide`, stop and treat that as an
   accidental retarget — do not "fix" it without GO.
2. **Do not `orca` Settings → install CLI / register command.** That is the
   #15081 path and will rewrite `~/.local/bin/orca`.
3. **Payload-only refresh (safe without GO):** download
   `orca-linux.AppImage` from [v1.4.197](https://github.com/stablyai/orca/releases/tag/v1.4.197)
   (or newer) into a staging dir, `--appimage-extract`, then **replace the
   contents of** `~/.local/share/orca/squashfs-root` and keep the same
   `AppRun` invocation the existing launcher uses. Do not run the official
   installer; do not move `~/.local/bin/orca`.
4. **Pairing / desktop restore:** after a payload swap, re-pair only if the
   serve identity or port changed. Factory serve updates are the canary lane
   (#18790), not this PR.
5. **Fork git sync (optional, source tree only):**
   `git fetch upstream && git rebase upstream/main` on a **new** branch — do
   not fast-forward LesleyMurfin `main` from this agent. The 1,146-commit lag
   is why the July/August fork drafts look huge.
6. **Local WSL `orca serve`:** if PC hosts its own serve, it will not have
   #18790 until that PR merges (or a Revive canary AppImage is extracted via
   step 3). Pairing to factory canary does not require a PC client PR.

## Explicit GO — WSL launcher retarget

Only after Lesley says **GO**. Until then, skip this section.

1. Record the current launcher (for rollback):
   ```bash
   cp -a ~/.local/bin/orca ~/.local/bin/orca.pre-15081.$(date +%Y%m%d)
   ```
2. Decide target:
   - **A — stay bridge-free / squashfs-root:** keep step 3 from the safe path;
     only rewrite `~/.local/bin/orca` if the shebang/exec line is wrong, and
     point it at `~/.local/share/orca/squashfs-root/AppRun` (or `orca-ide`),
     never at the outer `.AppImage`.
   - **B — adopt upstream #15081:** install/register CLI from a v1.4.197+
     desktop/AppImage so the command becomes the stable
     `~/.cache/orca/appimage/.../launcher/orca-ide`. This **is** a retarget.
3. Prove CLI before declaring done:
   ```bash
   command -v orca
   orca --version
   orca status
   ```
   Confirm `command -v orca` is still the intended file (not `/usr/bin/orca`
   GNOME Orca).
4. If rollback: restore `~/.local/bin/orca.pre-15081.*` and re-test
   `orca --version`.

## This environment's PR action

Opened **this** tracking PR only. Did **not**:

- retarget `~/.local/bin/orca`
- open a second #18790 / factory canary PR
- rebase the July fork drafts onto 1,146-commit-newer upstream
- apply anything on mtl-02
