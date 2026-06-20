# REVIEW-FINDINGS — 3-lens expert panel, two Orca serve-runtime terminal bugs (v1.4.88)

**Date:** 2026-06-20 (Calgary) · **Fork:** LesleyMurfin/orca · **Work tree:** `/home/lesley/orca-wsl-floating-wt` @ `ai/remote-terminal-wsl-floating-fix` (off v1.4.88 `6f77fdd4b`)
**Panel inputs (on disk):** `REVIEW-lens1-maintainer.md`, `REVIEW-lens2-layer.md`, `REVIEW-lens3-correctness.md` (+ `.ORIG.md` backup). Cross-check (independent re-run): `REVIEW-lens3-correctness-crosscheck.md`.
**Design artifact reviewed:** `OPTIONS-wsl-menu-and-floating-terminal.md` + research notes `wsl-menu-missing-on-serve-connection.md`, `floating-terminal-remote-selector-not-found.md`.

## 🚫 Hard gate (unchanged)
Nothing upstream until built + tested locally on the fork AND Lesley has explicitly approved. Two bugs → two issues → two PRs.

---

## CONSOLIDATED VERDICT: **PROCEED — no engagement-level showstopper.** Both fixes validated with required refinements.

| Bug | Lens1 (maintainer) | Lens2 (layer/collision) | Lens3 (correctness) | Consolidated |
|-----|--------------------|--------------------------|----------------------|--------------|
| **A** — WSL/bash menu missing on serve | ACCEPTABLE-AS-IS → **A1 suppression-only** (defer bash add-on); A2=rework | RIGHT-LAYER-NO-COLLISION (renderer `TabBar.tsx`) | **SOUND-WITH-FIXES** | **PROCEED with A1, suppression-only, keyed on `hostPlatform`** |
| **B** — floating terminal `selector_not_found` over serve | ACCEPTABLE-AS-IS → **B-a** (mirror #5696); B-b wrong-shape, B-c stopgap | RIGHT-LAYER-NO-COLLISION (serve `orca-runtime.ts` resolver) | **SOUND-WITH-FIXES** (note's failure-path framing was DEFECTIVE — corrected below) | **PROCEED with B-a, re-anchored to the real failure surface** |

The single "showstopper" the panel raised (Lens3, Bug B) is a **root-cause framing correction**, not a reason to abandon the chosen fix — B-a already targets the correct callee. No loop-back to `/design` required; the direction is refined, not rejected.

---

## BUG A — final direction: **A1, suppression-only, keyed on probed `hostPlatform`**

**What to build:** Extend the existing SSH-style shell-menu suppression so the local-Windows shell submenu is NOT rendered for a serve(Linux)-runtime worktree. Do **not** bolt a bespoke "bash" entry into the Windows-shell builder.

**Why this shape (panel consensus):**
- Mirrors the maintainer's own SSH-PTY suppression pattern (`TabBar.tsx:381-385`) and applies the #5327 principle "shell choices follow the execution host, not the client OS." (Lens1)
- Correct layer — the render decision is renderer-local in `TabBar.tsx`, confirmed NOT in shared `project-execution-runtime.ts`. (Lens2)
- The plain **"New Terminal"** entry already routes serve-side with `command: undefined`, which the serve spawns as its **default shell (bash)** (`Terminal.tsx:818-827`). So suppressing the Windows submenu *already* delivers Lesley's serve-side-bash intent with **no new transport and no PowerShell bridge**. (Lens3 — key enabling finding)

**MANDATORY correctness fixes (Lens3) — without these A1 regresses:**
1. **Key the suppression on probed `windowsTerminalCapabilities.hostPlatform !== 'win32'`** (already computed `TabBar.tsx:368-380`) — NOT on "an `activeRuntimeEnvironmentId` is set." Keying on runtime-active would regress PR #5519's **local Windows-WSL project-runtime** menu (runs on a win32 host, must keep its 4-shell menu).
2. **Do NOT add a bash entry routed through `resolveWindowsShellLaunchTarget`** (`TabBar.tsx:582-588`, `:673-679`) — that resolver would mangle `bash`. Reuse the existing plain "New Terminal" → serve bash path.

**Required tests (maintainer norm — co-located unit + e2e):**
- `TabBar.windows-shell-launch.test.ts`: serve runtime (`hostPlatform:'linux'`) ⇒ `windowsShellEntries === undefined`; local Windows ⇒ unchanged 4-shell set; **regression guard:** local Windows-WSL project runtime (`hostPlatform:'win32'`) ⇒ menu still present.
- e2e (mirror `tests/e2e/terminal-windows-shell-paste-ownership.spec.ts`): serve-connected "+" yields a working bash PTY, no PowerShell/CMD entries.

**Watch-items (not blockers):**
- Open PR **#2160** (Jinwoo-H/default-wsl) edits the same shell-list region on a stale base — no fork-tree conflict today, but reconcile before any upstream A1 push. (Lens2)
- Doc fix: the *render* gate is `shouldShowWindowsShellMenu` (`:383-385`), not the probe gate `shouldProbeWindowsShellCapabilities` (`:372-374`) — the fix edits the render gate. (Lens1)

**PR framing:** `fix: don't show local Windows shells for serve-runtime worktrees` — "mirrors existing SSH-PTY suppression for serve(Linux) runtimes, per #5327's execution-host principle."

---

## BUG B — final direction: **B-a, re-anchored to the real failure surface**

**ROOT-CAUSE CORRECTION (Lens3 — supersedes the OPTIONS/PSN framing):** The error does **NOT** surface on the create or activate path — both `createWebRuntimeSessionTerminal` (`web-runtime-session.ts:92-98`) and `activateWebRuntimeSessionTab` (`:461-466`) swallow the error and return `false`. The visible black-pane + toast comes from the **remote-runtime PTY transport**: `connect()` calls `terminal.create` with selector `id:global-floating-terminal` (`remote-runtime-pty-transport.ts:404-405`); the serve resolver throws `selector_not_found` (`orca-runtime.ts:15546`); caught at `:439` and surfaced via `onError(...)` at `:440` → red `TerminalErrorToast`.
- The local `createTab` fallback **cannot** save it: transport is chosen solely by `runtimeEnvironmentId` truthiness (`pty-connection.ts:1713-1715`), and `getRuntimeEnvironmentIdForWorktree` falls through to `settings.activeRuntimeEnvironmentId` for the floating id (`worktree-runtime-owner.ts:97`). So the pane mounts the **remote** transport and re-throws even after the local fallback runs.

**SHOWSTOPPER (correctness):** Any fix confined to the create/activate try/catch blocks will NOT fix this bug. B-a is correct **because** it targets `resolveWorktreeSelector` — which is exactly `connect()`'s callee — so it fixes the real surface.

**What to build:** Teach `OrcaRuntimeService.resolveWorktreeSelector` (`orca-runtime.ts:15484-15546`) to accept the floating workspace's synthetic id as a **virtual, repo-less session** (via explicit `floating:`/`global:` prefix, not a magic `id:` string) instead of throwing.

**Why this shape (panel consensus):**
- 1:1 with merged PR **#5696** (added the `name:` branch to this exact resolver, shipped with co-located `orca-runtime.test.ts`); resolver already special-cases the literal `'active'` selector (`:15488`). (Lens1)
- Correct layer (serve runtime), region uncontended by any open PR. (Lens2)

**MANDATORY scope additions (Lens3):**
- Define a **default cwd contract** for the virtual session (serve home or workspace root) — else the PTY spawns in an unexpected dir.
- Handle `session.tabs.activate` / `session.tabs.close` for the virtual id (both also send `id:global-floating-terminal`) — else those RPCs no-op (degraded).
- Use an explicit `floating:`/`global:` prefix (every other resolver branch uses an explicit prefix; CONTRIBUTING "concrete module names"). (Lens1)

**Required tests:**
- Unit on `resolveWorktreeSelector`: synthetic floating id → virtual `ResolvedWorktree` with default cwd (mirror #5696's test); real `id:` worktrees unaffected.
- Unit on `remote-runtime-pty-transport` `connect()`: no longer throws for the synthetic id.
- e2e: floating terminal while serve-paired → live PTY, no toast.

**Rejected options:** B-b (WRONG-SHAPE — wrong template #4582 = 343/-211 refactor; silently rebinds floating to a real worktree). B-c (NEEDS-REWORK/DEFECTIVE-as-written — must ALSO force the transport local for the floating id in `worktree-runtime-owner.ts:97`/`pty-connection.ts:1713`, else it does nothing; and yields client-side floating terminals against Lesley's serve-side intent).

**PR framing:** `fix: support floating-terminal sessions on remote runtimes` — "adds a virtual repo-less branch to `resolveWorktreeSelector` for the floating workspace, following #5696's selector pattern and the existing `'active'` special-case."

---

## Cross-cutting (both PRs, CONTRIBUTING)
- Two separate PRs (single-topic rule). Co-located unit test per PR (mandatory). AI code-review summary covering cross-platform / SSH-remote-local / agent / perf / security. Descriptive `fix/...` branch. X handle.
- Both governing precedents (#5519 for A, #5696 for B) merged within ~3 days of this review — maintainers are live in this code; conform to the pattern they just set (raises A2's and B-b's risk specifically — both rejected).

## Next steps (gated)
1. **Correct the root-cause framing** in `OPTIONS-...md` + PSN-0005 for Bug B (real surface = PTY transport `connect()`, not the create/activate catch).
2. Implement A1 (suppression keyed on `hostPlatform`, no new bash entry) + B-a (virtual repo-less resolver branch w/ cwd contract + activate/close) on this branch.
3. `/test-architect` → `/qa` (confirm both repros fixed on a LIVE Win-client ↔ WSL-serve build; no regression to local / SSH / #5519 menus) → `/code-review` (vs AGENTS.md).
4. **Lesley review + explicit approval.**
5. THEN file 2 issues + 2 linked PRs.
