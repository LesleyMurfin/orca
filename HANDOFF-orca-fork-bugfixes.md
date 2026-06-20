# Handoff — Orca fork bug-fix engagement (2 bugs)

**Created:** 2026-06-20 (Calgary) · **Fork:** LesleyMurfin/orca · **MY work tree:** `/home/lesley/orca-wsl-floating-wt` (branch `ai/remote-terminal-wsl-floating-fix`, off v1.4.88 `6f77fdd4b`)

---

## 🚫 HARD INVARIANT — read first
Do NOT file or publish ANYTHING externally — no GitHub issues, no PRs, no upstream
submissions — until **(1)** the fix is built + tested locally on the fork AND
**(2)** Lesley has reviewed and explicitly approved. All work stays on the fork
until then. No exceptions.

## ⚠️ COORDINATION — another session is live in this fork
- `/home/lesley/projects/external/orca-cursorfix` @ `ai/remote-cursor-fix` is a **DIFFERENT session's**
  remote-runtime **cursor-visibility** fix (split `?25l/?25h` burst). DO NOT edit/build/commit there.
  Its design dir: `RILEY/docs/projects/design/2026-06-20-orca-remote-terminal-cursor-fix/`.
- **My two bugs (WSL menu + floating selector_not_found) live ONLY in `/home/lesley/orca-wsl-floating-wt`.**
- `/home/lesley/projects/external/orca` is STALE (v1.4.53) — git common dir only, do not use for code.
- All three share git common dir `external/orca/.git`; my branch + cursor branch both base off v1.4.88.
- PSN-0005 is edited by BOTH sessions (Lesley: "both edit, serialize") — coordinate merge order at PR time.
- Read current v1.4.88 source in MY worktree (identical base; keeps the cursor tree untouched).
- Upstream dupe-check leads (maintainer branches already in this area): `Jinwoo-H/default-wsl`,
  `Jinwoo-H/floating-terminal-default-on`, `Jinwoo-H/floating-terminal-improvements`, `feat/wsl-support`.

---

## The two bugs (Windows desktop client connected to remote `orca serve`; serve = local WSL Ubuntu, ws://localhost:6768)

### Bug A — connected "+" menu lacks WSL  *(NOT fixed)*
Connected "+" / Ctrl+T offers only PowerShell + CMD; no "New Terminal: WSL" entry.
(Launching a Claude agent DOES spawn in WSL — so routing works; only the menu entry is missing.)
- WSL row renders only if `windowsTerminalCapabilities.wslAvailable` is true.
- Capability probe gated by `!worktreeHasRemoteConnection` — `TabBar.tsx:372-374`
  (`shouldProbeWindowsShellCapabilities = (isWindows || activeRuntimeEnvironmentId || isWebClient) && !worktreeHasRemoteConnection`).
- Default shell = `terminalWindowsShell` setting (denylisted machine-local; `sanitize.py:53`).
- **STILL TO VERIFY:** exact 1.4.88 menu-render gate (`includeWslShell` path ~`TabBar.tsx:525`)
  and whether `worktreeHasRemoteConnection` is even true for a local-WSL-serve worktree.
- **Desired behavior:** WSL terminal option when connected, spawning **serve-side bash**.
  ❌ Do NOT build a "powershell bridge in windows" — Lesley explicitly rejected this.

### Bug B — floating workspace terminal `selector_not_found` + black pane  *(root cause VERIFIED)*
Works locally; fails when serve-connected. Chain (all verified v1.4.88):
- Floating tabs bind to synthetic `FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'` — `shared/constants.ts:125`.
- Serve-connected → routes to serve via `createWebRuntimeSessionTerminal({worktreeId:'global-floating-terminal'})`
  — `floating-workspace-tab-creation.ts:33-34`; activate path `floating-workspace-terminal-actions.ts:142-146`.
- Serve selector resolver can't match the synthetic id — `orca-runtime.ts:15532-15536` → throws
  `selector_not_found` at `orca-runtime.ts:15546`; renderer handling `worktrees.ts:580-585`.
- Local works via `store.createTab(...)` fallback — `floating-workspace-tab-creation.ts:45`.
- NOTE: `floatingTerminalEnabled:false` at `web-preload-api.ts:2668` is WEB-CLIENT ONLY — does NOT
  affect desktop; ruled out.

### Candidate fixes (shared serve-routing family)
- (a) **serve-side:** runtime accepts `'global-floating-terminal'` as a virtual/global session scope.
- (b) **client-side:** bind floating terminals to a real worktree when serve-connected.
- (c) **client-side:** keep floating terminals local even when serve-connected.
Lesley's stated preference for the "+" terminal: **serve-side bash.** Pick the option most aligned
with maintainer code/design patterns so an upstream PR is accepted.

---

## QUALITY GAUNTLET — run in order, no skipping (RULE #20)

| # | Gate | Skill | Output |
|---|------|-------|--------|
| 1 | Options/design | `/design` (fork-local doc) | 3 fix options per bug + decision criteria |
| 2 | **Expert review (design)** | `/peer-review` | Panel scores options vs maintainer patterns → pick fix for upstream acceptance |
| 3 | Implement | — | Code on fork branch only |
| 4 | **Test design** | `/test-architect` | Unit + integration for serve-routing; manual repro matrix (Win client ↔ WSL serve) |
| 5 | **QA execute** | `/qa` | Run tests; confirm repro fixed; no regression in local floating/local "+" paths |
| 6 | **Diff review** | `/code-review` | Diff vs AGENTS.md (cross-platform, no max-lines disable, naming, "why" comments, SSH/GitLab compat) |
| 7 | **Lesley review** | — | Explicit approval |
| 8 | File | — | Issue + linked PR — ONLY after 1–7 |

`/peer-review` is BEFORE implement (right design); `/code-review` is AFTER (right implementation). Both required.

---

## In-flight / state
1. Background agent **`UpstreamResearch`** (general-purpose) — writing bug doc to
   `notes/floating-terminal-remote-selector-not-found.md` + searching upstream issues/PRs for dupes
   + capturing maintainer contribution norms. RETRIEVE its results (SendMessage or check the file).
2. Tracking: **Orca-fork-only** (NO RILEY PRD ledger).
3. Testing the real desktop needs a self-built fork binary (desktop auto-updates from upstream channel).

## AGENTS.md conventions the fix MUST honor (acceptance-critical)
- Cross-platform (mac/linux/win); never hardcode metaKey; use `path.join`.
- Consider SSH use case + GitLab/other git providers (don't assume local-only / GitHub-only).
- No `max-lines` eslint/oxlint disable — split files instead.
- No vague file names (helpers/utils/common); name after the domain concept.
- Short "why" comments for non-obvious/design-driven code.
- Design system: `docs/STYLEGUIDE.md` + shadcn primitives for any UI.
