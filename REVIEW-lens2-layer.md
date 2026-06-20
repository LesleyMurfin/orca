# LENS 2 — Right-Layer & PR-Collision review

Read-only adversarial peer review of the two serve-runtime terminal bug fixes
(v1.4.88 fork, worktree `/home/lesley/orca-wsl-floating-wt` @ `ai/remote-terminal-wsl-floating-fix`).
All citations verified this session against this tree and against `gh`.

Two questions answered per bug:
1. Is each proposed fix in the correct architectural layer (client renderer vs serve runtime vs shared)?
2. Does it collide with in-flight work on the same fork — the cursor-fix branch or any open upstream PR?

---

## Cursor-fix branch (collision baseline)

`ai/remote-cursor-fix` (worktree `/home/lesley/projects/external/orca-cursorfix`, working-tree-only,
no commits yet). Authoritative dirty file set (`git diff --name-only`):

- `src/renderer/src/components/terminal-pane/pty-connection.ts`
- `src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts`
- `src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.test.ts`

Its design-dir ACK PRs (`REVIEW-FINDINGS.md`): #4992 / #5038 / #5015 edit `terminal.ts`
batcher + `remote-runtime-terminal-multiplexer.ts handleBinary` — none of which is a Bug A or Bug B file.

---

## BUG A — connected "+" terminal menu lacks WSL / serve-side bash (recommended option: A1)

### Layer verdict: RIGHT-LAYER (client renderer)

- The defect is a renderer-rendering decision: a local-Windows shell submenu is *displayed*
  for a serve (Linux) worktree. The governing constructs — `shouldShowWindowsShellMenu`
  (`TabBar.tsx:382-385`) and the `!worktreeHasRemoteConnection` suppression gate — are
  renderer-local in `TabBar.tsx`. The maintainer's own SSH-suppression precedent lives in this
  exact spot (the `:380-382` "SSH-backed PTYs ignore local Windows shell overrides" comment + gate).
  A1 extends that same renderer gate to cover serve runtimes. Correct layer.
- The "should this live in shared `project-execution-runtime.ts`?" alternative is WRONG:
  verified this session that `getProjectRuntimeShellMenuMode` is a **TabBar-local helper
  (`TabBar.tsx:89-99`)**, not in the shared module. `src/shared/project-execution-runtime.ts`
  exports runtime *resolution + types only* (`resolveProjectExecutionRuntime`,
  `ProjectExecutionRuntimeResolution`, etc.) — it never decides what shell rows render.
  So the menu-mode/suppression decision is already renderer-layer by the maintainer's own
  structure (PR #5519). Pushing it into shared would be the wrong layer.

### Files A1 touches
- `src/renderer/src/components/tab-bar/TabBar.tsx` (suppression gate + serve-side bash entry)
- `src/renderer/src/components/tab-bar/TabBar.windows-shell-launch.test.ts` (+ `TabBar.context-menu.test.ts`)

(A2, the rejected heavier option, would additionally touch
`src/renderer/src/lib/windows-terminal-capabilities.ts` — still renderer-layer, not shared.)

### Collision check
- **vs cursor-fix branch: NONE.** Set intersection of cursorfix dirty files ∩ Bug A files = empty.
  cursorfix touches `pty-connection.ts` + scheduler only.
- **vs open upstream PRs:**
  - **PR #5580** (`nwparker/drag-terminal-pane-as-new-tab`, OPEN) edits `TabBar.tsx` but only at
    ~line 925 (drag handlers) — far from the shell-menu block (`:312-530`). No symbol overlap.
  - **PR #2160** (`Jinwoo-H/default-wsl`, "Fix Windows setup split terminal behavior", OPEN, base
    `main`, maintainer-authored) edits `TabBar.tsx` at the **shell-list push block (hunks `@497`/`@520`)**
    — the *same logical region* as Bug A's root cause (`:507-530`) — plus `windows-terminal-capabilities.ts`
    and the windows-shell tests. It is on a stale base (line numbers `-497/+486` vs v1.4.88's `:507`), so it
    is **not** a clean textual conflict today and does not collide in the fork tree. BUT it is the same code
    surface, by the maintainer who owns this area — so if A1 is ever pushed upstream it must be reconciled
    with #2160. Upstream-reconciliation risk, not a fork-tree collision.

### Bug A one-line verdict: **RIGHT-LAYER-NO-COLLISION**
(watch-item: same-region open PR #2160 = upstream reconciliation risk, not a fork conflict)

---

## BUG B — floating-workspace terminal `selector_not_found` over serve (recommended option: B-a)

### Layer verdict: RIGHT-LAYER (serve runtime)

- B-a teaches `OrcaRuntimeService.resolveWorktreeSelector` (`orca-runtime.ts:15484-15546`) to accept
  the synthetic `global-floating-terminal` id as a virtual, repo-less session instead of throwing
  `selector_not_found` (`:15540-15546`). This is the serve-runtime layer, and it matches the maintainer's
  exact precedent: **#5695 / #5696 added the `name:` branch to this same resolver**, and the resolver already
  special-cases the literal `'active'` selector (`:15487-15489`). Correct layer.
- The client-side alternatives are legitimate layers for *their* approach but not the maintainer's pattern:
  B-b (selector normalization in `runtime-worktree-selector.ts` / `web-runtime-session.ts`, precedent #4582)
  and B-c (keep floating local in `floating-workspace-*`). B-a (serve resolver) is the layer the maintainer
  uses for selector semantics, so the recommendation picks the right layer.

### Files B-a touches
- `src/main/runtime/orca-runtime.ts` (resolver branch for the synthetic/global id)
- `src/main/runtime/orca-runtime.test.ts`

(B-b/B-c, if chosen instead, would touch the client files: `floating-workspace-tab-creation.ts`,
`floating-workspace-terminal-actions.ts`, `web-runtime-session.ts`, `runtime-worktree-selector.ts`.)

### Collision check
- **vs cursor-fix branch: NONE.** cursorfix touches no `orca-runtime.ts` or floating-workspace file.
- **vs open upstream PRs:**
  - `gh pr list --search resolveWorktreeSelector` → **zero** open PRs.
  - PRs that touch `orca-runtime.ts` were inspected (#5487, #5694, #5873). **None edits the resolver body
    or the `selector_not_found` throw block.** #5694 references `resolveWorktreeSelector` only at unchanged
    call-sites (`await this.resolveWorktreeSelector(...)` context lines — it's "Prevent stale terminal panes",
    not a resolver change). #5487 / #5873 hunks are in unrelated `OrcaRuntimeService` methods.
  - The resolver region B-a edits is therefore **uncontended**. (`orca-runtime.ts` is high-traffic, so expect
    routine rebasing, but no symbol-level collision on the resolver.)

### Bug B one-line verdict: **RIGHT-LAYER-NO-COLLISION**

---

## Summary

| Bug | Layer verdict | Files the fix touches | Collision vs cursor-fix / open PRs |
|-----|---------------|------------------------|-------------------------------------|
| A (A1) | RIGHT-LAYER (client renderer; TabBar suppression gate, NOT shared) | `TabBar.tsx` + `TabBar.windows-shell-launch.test.ts` | None in fork tree (cursorfix disjoint); same-region OPEN PR **#2160** = upstream reconciliation risk |
| B (B-a) | RIGHT-LAYER (serve runtime; resolver, per #5695/#5696) | `orca-runtime.ts` + `orca-runtime.test.ts` | None — resolver region uncontended by any open PR |

The design doc's zero-overlap assumption (cursorfix in `pty-connection.ts`/scheduler; WSL fix in
`TabBar.tsx`/capabilities; floating fix in `orca-runtime.ts`/floating-*) is **CONFIRMED**. The one item it
under-weights: open PR #2160 already touches Bug A's shell-list region — worth noting before any upstream A1 push.

- **Bug A: RIGHT-LAYER-NO-COLLISION**
- **Bug B: RIGHT-LAYER-NO-COLLISION**
