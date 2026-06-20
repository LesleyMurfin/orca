# LENS 1 — Maintainer Acceptability Review

**Question:** For each of two proposed Orca (`stablyai/orca`) fix directions, would the maintainer ACCEPT a PR shaped this way, given their actual code/design patterns and contribution rules?

**Method:** Read-only adversarial review. All claims verified this session against the v1.4.88 fork tree at `/home/lesley/orca-wsl-floating-wt`, HEAD `6f77fdd4b` (confirmed = `release: v1.4.88`). Precedent issues/PRs verified via `gh` (state / author / mergedAt) and, where load-bearing, by inspecting the actual diff shape.

**Source citations confirmed this session:**
- `src/renderer/src/components/tab-bar/TabBar.tsx:300–548` (shell-menu gate + builder)
- `src/main/runtime/orca-runtime.ts:15484–15547` (`resolveWorktreeSelector`)
- `.github/CONTRIBUTING.md` (full)

**Maintainers in this area:** Jinwoo Hong (`Jinwoo-H`) — terminal/WSL/SSH-shell, runtime selectors. slashdevcorpse — runtime model.

---

## BUG A — connected "+" shell menu lacks serve-side bash (WSL menu missing on serve)

### Verdict: **ACCEPTABLE-AS-IS** — back **A1**, as *suppression-only*. (A2 = NEEDS-REWORK.)

### Recommended option
**A1** — suppress the Windows-shell submenu for a serve(Linux) runtime worktree the same way SSH is already suppressed, and (separately) offer a serve-side bash entry.

- **A1 acceptance risk: MED** (drops to LOW if shipped as suppression-only).
- **A2** (fully runtime-aware probe/menu) **acceptance risk: HIGH** → NEEDS-REWORK.

### Maintainer-pattern evidence
- In-tree precedent: the SSH-suppression gate `shouldShowWindowsShellMenu = (isWindows || hostPlatform==='win32') && !worktreeHasRemoteConnection` (`TabBar.tsx:383–385`) plus the rationale comment `TabBar.tsx:381–382` ("SSH-backed PTYs ignore local Windows shell overrides; showing these entries there promises PowerShell/CMD/Git Bash but opens the remote shell"). A1 is the serve-runtime analog of this exact pattern. `worktreeHasRemoteConnection` is computed only from `repo.connectionId` (`:312–318`) → false for a serve-paired worktree, which is the gap.
- **Issue #5327** — OPEN, author **Jinwoo-H** (verified), "Support Windows shell selection for SSH hosts." States the governing principle: "shell choices should be based on the execution host, not the client OS." A1 directly applies this principle.
- **PR #5519** — MERGED 2026-06-17, author slashdevcorpse (verified), "Add project Windows runtime selection." Introduced `src/shared/project-execution-runtime.ts` + `getProjectRuntimeShellMenuMode`, the runtime-aware shell-menu machinery A2 would extend. **Merged only 3 days before this review** — maintainers are actively protective of it.

### Showstoppers / reasons to rework
- **The "offer serve-side bash" half is the risk, not the suppression half.** PowerShell/CMD are pushed unconditionally under `includeHostShells` (`TabBar.tsx:508–517`) into a builder hardcoded to four Windows shells. Bolting a non-Windows bash entry into that builder is where a maintainer is likely to say "do this the runtime-aware way (#5327/#5519)" and push you toward A2. **Mitigation: split A1 into (i) A1-suppress — ship first, LOW risk; the menu then falls back to the same non-Windows path SSH worktrees already get — and (ii) A1-offer-bash — defer / discuss in the issue.**
- **A2 rejection reason:** blast radius into the capability-hook contract (today returns Windows-shell booleans) plus the just-merged #5519 runtime model = high regression surface on Windows-local and Windows-runtime paths. Directly in tension with CONTRIBUTING line 8 / line 49 (cross-platform; verify across platforms + SSH latency).
- **Mandatory to merge:** a co-located unit-test case in `src/renderer/src/components/tab-bar/TabBar.windows-shell-launch.test.ts` asserting the serve-runtime path. Terminal/shell fixes in this repo ship tests (CONTRIBUTING line 47).

### Doc correction surfaced
OPTIONS.md:26 / Bug-A note:8 imply the *menu-render* gate targets the serve. The probe gate is `shouldProbeWindowsShellCapabilities` (`TabBar.tsx:372–374`), which deliberately probes the runtime host. The *render* gate `shouldShowWindowsShellMenu` (`:383–385`) is the one missing the serve case. Substance unchanged; the fix edits `:383–385`, not the probe.

### PR framing
- Title: `fix: don't show local Windows shells for serve-runtime worktrees`
- Pitch: "Mirrors the existing SSH-PTY shell-menu suppression (`TabBar.tsx:381–385`) for serve(Linux) runtimes, applying the #5327 principle that shell choices follow the execution host, not the client OS."

---

## BUG B — floating terminal `selector_not_found` over serve

### Verdict: **ACCEPTABLE-AS-IS** — back **B-a**. (B-b = WRONG-SHAPE; B-c = NEEDS-REWORK as stopgap only.)

### Recommended option
**B-a** — serve-side: teach `resolveWorktreeSelector` to accept the floating workspace's synthetic id (via an explicit `floating:`/`global:` selector) as a virtual, repo-less session with a default cwd, instead of throwing `selector_not_found`.

- **B-a acceptance risk: LOW–MED.**
- **B-b** (client selector-normalize): **HIGH** → WRONG-SHAPE.
- **B-c** (keep floating terminals local): **MED** → NEEDS-REWORK, acceptable only as explicitly-labeled stopgap.

### Maintainer-pattern evidence
- **PR #5696** — MERGED 2026-06-19, author wolfiesch (verified), "fix: support worktree name selectors." Added the `name:` branch to this *exact* `resolveWorktreeSelector` (confirmed in-tree at `orca-runtime.ts:15522–15525`). **I inspected the diff: 28 additions / 4 deletions across 5 files** (selector branch + co-located `orca-runtime.test.ts` + CLI help/selectors). This is the canonical accepted shape for extending this resolver, and B-a maps onto it ~1:1. Authored by an outside contributor, not a maintainer → confirms the shape is accepted from non-maintainers when it ships with a test.
- The resolver already special-cases a non-worktree selector: `if (selector === 'active') throw 'selector_not_found'` (`orca-runtime.ts:15488–15489`). A virtual-session branch is idiomatic here, not novel.
- **PR #4582** — MERGED 2026-06-03, author Jinwoo-H (verified), "Fix remote runtime worktree selectors" = the B-b template. **I inspected the diff: 343 additions / 211 deletions across 32 files** — a sprawling normalization refactor, not a shape you replicate for a floating-terminal fix.

### Showstoppers / reasons to rework
- **B-a:** the only watch-item is the "virtual repo-less session" cwd + tab-graph-placement contract — slashdevcorpse owns the runtime model and will scrutinize where a worktree-less PTY's cwd lands and how it persists. Keep it minimal (recognize the floating selector, spawn a PTY in a sensible default cwd such as serve home/workspace root, return a synthetic `ResolvedWorktree`) and ship the co-located `orca-runtime.test.ts` case #5696 established. Use an explicit `floating:`/`global:` prefix, not a magic `id:` string — every other branch in the resolver uses an explicit prefix (CONTRIBUTING line 14, "follow existing architecture / concrete module names").
- **B-b WRONG-SHAPE:** wrong template (a 343/-211, 32-file refactor) and it silently changes the floating workspace from repo-less to worktree-bound under serve (picking "active/last worktree"), an unrequested semantic change that's ambiguous when no real worktree exists yet.
- **B-c NEEDS-REWORK:** smallest diff but entrenches a local-only assumption that CONTRIBUTING line 12 explicitly forbids ("Orca must work against … remote servers … do not assume a process, file, credential, shell, or network path exists only on the local machine"). Defensible only as an explicitly-labeled stopgap; weakest upstream story.
- **Mandatory to merge:** co-located `src/main/runtime/orca-runtime.test.ts` case (exactly what #5696 shipped).

### PR framing
- Title: `fix: support floating-terminal sessions on remote runtimes`
- Pitch: "Adds a virtual repo-less branch to `resolveWorktreeSelector` for the floating workspace's synthetic id, following the #5696 `name:`-selector pattern and the existing `'active'` special-case, so floating terminals reach parity with local mode under a serve runtime."

---

## Cross-cutting CONTRIBUTING requirements (both PRs)
- **Two bugs → two separate PRs** ("stay focused on a single topic," line 60). Do not combine.
- Every PR must carry a **co-located unit test** (line 47), the **AI code-review summary** covering cross-platform / SSH-remote-local / agent / perf / security (line 65), and an **X handle** (line 67) — omitting these reads as not-following-CONTRIBUTING.
- Branch naming: descriptive `fix/...` (line 24).
- Timing note: both governing precedents (#5519 for A, #5696 for B) merged within 3 days of this review — maintainers are live in this code and will expect conformance to the pattern they just set, which raises A2's and B-b's risk specifically.

---

## Final per-bug verdict
- **Bug A: ACCEPTABLE-AS-IS — back A1 (as suppression-only; defer the bash-entry add-on). A2 = NEEDS-REWORK.**
- **Bug B: ACCEPTABLE-AS-IS — back B-a (mirror #5696's branch+test shape). B-b = WRONG-SHAPE; B-c = NEEDS-REWORK (stopgap only).**
