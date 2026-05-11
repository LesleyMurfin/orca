# Onboarding "First Repo Required" — Pre-Merge Review

**Status: PR #1677 is OPEN, not yet merged.** This doc is a pre-merge review of the changes on branch `brennanb2025/onboarding-first-repo-required` (commits `eac61212` "feat(onboarding): require first project before closing wizard" and `d2448f82` "fix(onboarding): suppress composer for folder repos and prune dead dismissed path"). It is NOT a follow-up tracker for an already-shipped change.

**What the PR does:** makes the repo step (step 4 of the onboarding wizard) a hard gate. Specifically, it removes the "I'll add one later" affordance from the repo step and removes every renderer-side `closeWith('dismissed', ...)` writer on that step, so onboarding only closes once the user adds a project. `useCloseWith` is also narrowed to `outcome: 'completed'` and the unreachable `onboarding_dismissed` track call is dropped.

**What this doc is:** a punch list of concrete gaps uncovered while reviewing the proposed gate against Orca's actual user paths — most importantly, the SSH-only user — and against the existing repo-step controller logic in `src/renderer/src/components/onboarding/use-onboarding-flow.ts`. The macro decision to keep the gate (vs. restoring a soft-skip) is settled per the PR author and is out of scope. Each item below is either a P0 that should block the merge, a P1 that should land before merge or as an immediate follow-up, or a P2 that is genuinely optional polish.

**For a reviewer reading this cold:** the PR's diff is small (`use-onboarding-flow-persistence.ts`, `use-onboarding-flow.ts`, `tests/e2e/onboarding.spec.ts` plus `OnboardingFlow.tsx` from the earlier commit), but the affected user surface is large because the gate has no escape. Most items below describe gaps in *recovery paths* that the soft-skip used to provide. The fixes are mostly additive — no item below requires undoing the gate itself.

## Reviewer's quick map

**Branch state.** `brennanb2025/onboarding-first-repo-required`, two commits ahead of `main`:
- `eac61212` `feat(onboarding): require first project before closing wizard`
- `d2448f82` `fix(onboarding): suppress composer for folder repos and prune dead dismissed path`

**The four onboarding steps** (`use-onboarding-flow.ts`):
1. `agent` (step index 0)
2. `theme` (step index 1)
3. `notifications` (step index 2)
4. `repo` (step index 3) ← this is the gate

So `lastCompletedStep === 3` means "user finished notifications and is sitting on the repo gate." This matters for #3.

**Key files referenced repeatedly below** (paths relative to repo root):
- `src/renderer/src/components/onboarding/RepoStep.tsx` — the step UI (Open folder / Clone repo CTAs).
- `src/renderer/src/components/onboarding/OnboardingFlow.tsx` — wizard shell, owns the `z-[100]` overlay.
- `src/renderer/src/components/onboarding/use-onboarding-flow.ts` — the flow controller (`completeRepo`, `clone`, `skip`).
- `src/renderer/src/components/onboarding/use-onboarding-flow-persistence.ts` — `useCloseWith` (now `'completed'`-only) and `persistStep`.
- `src/renderer/src/components/onboarding/should-show-onboarding.ts` — gate predicate.
- `src/renderer/src/components/sidebar/AddRepoDialog.tsx` and `AddRepoSteps.tsx` — the existing SSH-aware add-repo dialog. Source of `useRemoteRepo` (the hook #1 wants to extract).
- `src/main/ipc/worktrees.ts` and `src/main/repo-worktrees.ts` — folder-worktree synthesis. Relevant to #2.
- `src/main/ipc/repos.ts` — `repos:add` / `repos:addRemote` IPC.
- `src/main/persistence.ts` — `OnboardingState` parse boundary. Relevant to #3 and #5.
- `src/shared/types.ts:1372` — `OnboardingOutcome` type. Relevant to #5.
- `src/shared/telemetry-events.ts` — onboarding event registry. Relevant to #4 and #5.
- `src/preload/index.ts:167-244` — native file-drop preload bridge. Relevant to #9.

**Competitor patterns referenced** (for context on the SSH-as-peer and empty-state-as-gate ideas):
- emdash, t3code: SSH/remote as a peer of local in their first-run.
- Superset: empty-state home view as gate, drag-drop folder onto the empty surface.

**How to read the priorities.**
- **P0** = should block this PR's merge.
- **P1** = should land before merge OR as an immediate follow-up; explicitly call out which in the PR description.
- **P2** = nice to have, no merge dependency.

**Decisions a reviewer should make / push back on:**
1. Is the SSH path (#1) in-scope for this PR or a fast follow-up? It's the only P0 in the list besides nothing.
2. For #3, which of the three migration options? Option 1 (legacy marker) is the safest, option 3 (accept the trap) is the cheapest — but the doc currently flags option 3 as risky without PostHog sizing.
3. Is shipping #4 (telemetry) before GA acceptable, or does it need to land in this PR?

---

**Architectural note (problem statement only).** All "modal during onboarding" needs hit a z-index issue. The wizard at `z-[100]` (`OnboardingFlow.tsx:76`) sits above Radix `Dialog` (`z-50`, `components/ui/dialog.tsx:34,56`), `Sheet`, `Command`, `Tooltip`, and `HoverCard` (all `z-50`), and `Popover` (`z-[60]`, `popover.tsx:72`). Sonner toasts use `z-index: 999999999` and render above the wizard — they're not z-blocked. Any future "open a thing inside the wizard" work needs to either: (a) bring the wizard into the modal-stack family with explicit z-ordering and Radix portal sibling-DOM-order awareness, or (b) extract portable internals (as #1 does for `useRemoteRepo`). Out of scope for this fix list, but flag it so the next "I want to open a thing from inside the wizard" task doesn't re-discover it.

## P0 — Block merge

### 1. SSH-only users have no in-wizard path

The repo step (`RepoStep.tsx`) offers two CTAs: "Open a folder" (local picker) and "Clone a repo" (clones to `settings.workspaceDir` on the local machine). An SSH-only user — one whose code lives on a remote dev box and not on the local laptop — cannot complete either action. The only acknowledgement that SSH exists today is a small footnote ("SSH? Set hosts up in Settings") at the bottom of the step.

Without the gate, this user could click "I'll add one later", configure their SSH target via Settings, then use the sidebar's `AddRepoDialog` to pick a repo on the remote. With the gate as currently proposed in PR #1677, that escape is gone, and the wizard has no equivalent flow of its own.

The desktop SSH flow Orca already supports:

1. **Settings → SSH** (`SshPane.tsx`, `SshTargetForm.tsx`) — add label, host, username, identity, optional proxy/jump host, grace period; verify. (Passwords/passphrases are prompted at connection time, not configured in the form.)
2. **Sidebar → Add Repo → "SSH connected target"** (`AddRepoDialog.tsx:363-402`) — pick a connected target, then type or browse (`RemoteFileBrowser.tsx`) to a git repo path on the remote.

Recommended fix: add a third CTA on the repo step — "Connect a remote (SSH)" — that navigates *in-place* inside the wizard's content area to a wizard-renderable `RemoteRepoStep` (with a Back arrow back to the two-CTA RepoStep). For the empty-SSH-targets case, render a nested `SshTargetForm` view inside `RemoteRepoStep` — not a Settings deep-link.

Why not reuse `AddRepoDialog` directly: `OnboardingFlow` is `z-[100]` (`OnboardingFlow.tsx:76`); Radix `Dialog` overlay and content are both `z-50` (`components/ui/dialog.tsx:34,56`). Mounting `AddRepoDialog` from inside the wizard renders the dialog UNDER the wizard overlay. Fixing that requires either lifting the wizard's z-index *and* updating Radix portal stacking (risky) or extracting the dialog's portable internals — which is what this fix does.

The hook is already factored out: extract `useRemoteRepo` (`AddRepoSteps.tsx:22-27`) and the `RemoteStep` JSX (`AddRepoSteps.tsx:181-299`) into a wizard-renderable `RemoteRepoStep` component. On `repos.addRemote` success, treat the resulting repo as the activation event the gate is waiting on (same code path as Open Folder / Clone today, routed through the activation primitive in #2). `RemoteStep` JSX uses `<DialogHeader>` / `<DialogTitle>` / `<DialogDescription>` (`AddRepoSteps.tsx:12, 198-224`); the wizard-renderable variant must replace these with plain `<h2>` / `<p>` (or wizard-step heading components) since Radix's title/description primitives require a `Dialog.Root` ancestor and will throw a11y warnings otherwise.

One gotcha: `useRemoteRepo` currently accepts parent state mutators (`setStep`, `setAddedRepo`, `closeModal`) by reference (`AddRepoSteps.tsx:22-27`). Refactor it to return a result object instead of pushing into parent state — ~30 minutes of work. This is the only meaningful precondition. In the wizard caller, the success branch replaces `setStep('setup') + setAddedRepo(repo) + closeModal()` with a single `onRepoAdded(repo)` callback that the wizard wires to its `completeRepo`/`activateRepoForUser` flow. The dialog's standalone 'setup' confirmation view has no wizard equivalent — the wizard's exit IS the confirmation.

On the not-a-git-repo branch (`AddRepoSteps.tsx:130-148`), mirror the local 'Open a folder' silent-fallback behavior at `use-onboarding-flow.ts:349-352` — silently retry the add with `kind: 'folder'`. Skip the `'confirm-non-git-folder'` Radix dialog: it would render under the wizard's `z-[100]` overlay, and the wizard already provides the user's consent context (they explicitly chose 'Connect a remote' on a wizard step they cannot dismiss). The sidebar `AddRepoDialog` keeps its existing dialog flow — that surface is outside the wizard and the asymmetry is intentional.

Effort is the same as or less than mounting `AddRepoDialog` itself, and it doesn't collide with the wizard overlay. This keeps the gate honest — "you must add a project" includes remote repos — and matches how emdash and t3code present remote/SSH as a peer of local in their first-run flows. Without this, the gate effectively excludes Orca's SSH audience.

## P1 — Should fix before merge or in a fast follow-up

### 2. `completeRepo` strands the user when `worktrees:list` returns `[]`

`completeRepo()` in `use-onboarding-flow.ts:241-284` (as modified by `d2448f82`) calls `activateAndRevealWorktree(worktreesByRepo[repoId]?.[0])` and then `closeWith('completed', ...)`. The `worktrees:list` IPC handler at `src/main/ipc/worktrees.ts:172-220` synthesizes a folder worktree via `createFolderWorktree(repo)` for `kind: 'folder'` repos (`worktrees.ts:180-181`, `repo-worktrees.ts:5-16`), so folders activate normally — the `d2448f82` comment that folders "complete onboarding via the activateAndRevealWorktree call above" is correct.

The real edge case is SSH-remote git: when the SSH provider is unavailable mid-`fetchWorktrees` (reconnect, network blip, transient `listWorktrees` failure caught at `worktrees.ts:210-219`), the handler returns `[]`. If that lands while `completeRepo` is awaiting `fetchWorktrees`, `worktreesByRepo[repoId]?.[0]` is `undefined` and `activateAndRevealWorktree(undefined)` is a silent no-op — user closes the wizard onto the empty home view despite a successful add. This is a transient race, not a guaranteed user-facing bug, which is why this is P1 rather than P0.

Recommended fix: introduce an `activateRepoForUser(repo)` primitive that handles two cases:

- **Has worktree** (git + worktree present, or any folder repo via the synthesized worktree): `activateAndRevealWorktree(worktreesByRepo[repoId][0].id)` (existing behavior).
- **Empty worktree list** (SSH disconnect / remote unavailable / transient `worktrees:list` failure): `setActiveRepo(repoId)`. The user lands on the home view with the repo selected. When SSH reconnects, the next `fetchAllWorktrees` cycle populates worktrees and the home view reflects them. The gate's "you added a repo" promise is honored at minimum-viable-fidelity.

Frame this as one primitive, not a per-kind branch — `completeRepo` calls `activateRepoForUser(repo)` and trusts it. The empty-list fallback is the only degenerate branch; the worktree-present branch covers folders, local git, and connected SSH-remote git via the same code path.

**Ordering contract:** `activateRepoForUser` runs BEFORE `closeWith` (preserving today's order in `completeRepo` at `use-onboarding-flow.ts:245-256`). The primitive may queue UI side-effects that only manifest after wizard unmount (the existing `openModal('new-workspace-composer', ...)` after `closeWith` already does this). The primitive itself MUST NOT open Radix surfaces directly — it only mutates store state (`setActiveRepo`, etc.) so the post-`closeWith` openers see the right active repo. This avoids the wizard-z-index trap.

Rejected alternative: opening the new-workspace composer for folders. The composer's git-only contract is intentional and loosening it is the larger refactor commit `d2448f82` on this branch already chose to avoid (see its commit message — "suppress composer for folder repos").

The gate's promise — "add a project and you're in" — has to actually deliver a usable surface. Verify by adding an SSH-remote repo with the SSH connection deliberately broken between add and worktree-list, to repro the empty-worktree-list edge case. Local folder, fresh-clone git, and SSH-remote-with-good-connection all activate normally via the existing `activateAndRevealWorktree` path.

### 3. In-flight users get retroactively gated on next launch (post-merge)

`shouldShowOnboarding()` in `should-show-onboarding.ts:6` returns true for any user with `onboarding !== null && closedAt === null`. Once PR #1677 ships, anyone who was partway through onboarding under the previous "I'll add one later" build will hit the new hard gate the next time they launch, with no warning and no migration.

**No safe migration without a new discriminator.** The natural-seeming predicate `lastCompletedStep >= 3 && closedAt === null` does NOT uniquely identify old-build users — it is exactly the state of any new-build user who reached the repo gate without adding a project yet. Verified:

- `use-onboarding-flow-persistence.ts:142-159` — completing the notifications step (step index 3) calls `persistStep(3)` and persists `lastCompletedStep === 3` with no project added yet.
- `tests/e2e/onboarding.spec.ts:344-356` — the e2e for the gate explicitly asserts `lastCompletedStep === 3 && closedAt === null && outcome === null` as the expected state of a new user sitting on the repo gate.

Auto-skipping that state would let any new user bypass the required first repo by quitting and relaunching during step 4 — exactly the regression the gate was added to prevent.

Recommended fix: do not ship a migration based on the existing fields. Three viable options, in order of preference:

1. **Add a persisted "saw soft-skip" marker.** Pre-merge, write a one-time migration in `persistence.ts` that sets `legacySoftSkipEligible: true` on any existing `OnboardingState` row at first-load under the new build. Then the predicate becomes `legacySoftSkipEligible && closedAt === null` and is unambiguous. ~10 LOC + two schema fields (the eligibility flag + a one-shot discriminator `_legacySoftSkipMigrationDone` so the migration runs exactly once per install — defaulted `true` on new rows in `getDefaultOnboardingState` so a new user closing mid-flow on this build cannot retroactively be marked legacy; absent on legacy rows, which is what triggers the stamp at parse time in `Store.load`).
2. **Gate on app version.** If `settings.json` (or wherever app metadata is persisted) gains a `lastSeenVersion` field this release, treat any user whose `lastSeenVersion` is below the gate-merge version AND whose `closedAt === null` as legacy-skipped. Larger change because `lastSeenVersion` likely doesn't exist yet.
3. **Accept the trap, communicate via release notes.** Cheapest, but the asymmetry the original framing pointed out still bites: one trapped SSH-only power user who upgraded mid-flow files the issue that defines the release. Acceptable only if the cohort is empirically near-zero (size via PostHog before deciding).

PostHog sizing (Orca project 406068, count of `closedAt === null && onboarding !== null` users without a recent `onboarding_completed`) is now a precondition for option 3, not optional. For options 1 and 2 it's only useful as instrumentation.

The previous version of this section recommended setting `closedAt = Date.now()` on `lastCompletedStep >= 3 && closedAt === null` "with no date gate needed." That recommendation was wrong — the predicate is satisfied by every new-build user on the gate, not just legacy ones. Do not implement it.

### 4. Telemetry blind spot for users stuck on step 4 — ship before GA

Commit `d2448f82` on this branch removes `closeWith('dismissed', ...)` entirely. With PR #1677, the repo step's outcome is `completed`-or-nothing — gate failure is silent. Without explicit signals, you cannot distinguish "user closed the wizard cleanly" from "user gave up and quit the app." If the gate ships to GA without telemetry, the first signal of a failure mode will be a support ticket.

Ship before GA / public release of the gate. Extend the existing `onboarding_step4_*` namespace (`telemetry-events.ts:290-291, 374-383, 541-544`) rather than coining a parallel one — keeps PostHog dashboards and `cohort` injection (`telemetry-events.ts:619`) working without schema-registry churn. All new events inherit the `cohort` discriminator already present on every onboarding event.

- **Wizard abandoned on step 4 (NEW).** The skip-blocked guard at `use-onboarding-flow.ts:398-401` is defensive only — `OnboardingFlow.tsx:179, 197` gates the Skip and Continue buttons on `currentStep.id !== 'repo'`, and `OnboardingFlow.tsx:65-69` routes Cmd/Ctrl+Enter on the repo step to `flowOpenFolder` instead of `next`/`skip`. So `setError('Add a project to continue.')` at `use-onboarding-flow.ts:401` never fires in normal usage — instrumenting it captures nothing. Instead, emit `onboarding_step4_abandoned` from a `beforeunload` listener inside `OnboardingFlow.tsx` (synchronous `beforeunload` + sync IPC, the only reliable shutdown signal in Orca). Mounting the listener inside `OnboardingFlow.tsx` (rather than `App.tsx`) keeps it scoped to the wizard's lifetime and gates on `currentStep.id === 'repo'` so completed wizards don't emit a spurious abandonment. Properties: `duration_ms` (time on step 4, via `consumeStepDurationMs()`), `path_revealed_ssh: boolean` (whether the SSH CTA was visible). What this captures: Cmd+Q, native window close, and renderer reload. What it does NOT capture: app crashes, force-kill, OS shutdown — renderer telemetry is fire-and-forget async IPC (`src/renderer/src/lib/telemetry.ts:50`) and the renderer process is gone before any of those land. For crash coverage you'd need a main-process check on next launch (read persisted `lastCompletedStep === 3 && closedAt === null && lastQuitWasClean === false` and emit a delayed `onboarding_step4_abandoned_recovered` event) — out of scope here, but flag it if crash rates on step 4 turn out to matter. Add the new event to the registry alongside the existing `onboarding_step4_*` schemas (`telemetry-events.ts:374-383`). A renderer `useEffect` cleanup is NOT a substitute — async IPC will be cancelled before delivery during a real shutdown.
- **Clone failure.** Already exists as `onboarding_step4_path_failed { path: 'clone_url', reason: 'clone_failed' }` (`use-onboarding-flow.ts:385`). No new event. Optionally extend `onboardingFailureReasonSchema` to add `'auth_failed' | 'network_error'` if a finer breakdown is desired.
- **SSH CTA revealed (NEW, depends on #1 landing).** Add `onboarding_step4_path_revealed { path: 'ssh' }` so we can see whether SSH-only users actually discover the third CTA. Add `'ssh'` to `onboardingPathSchema` (`telemetry-events.ts:290`). The same schema addition lights up the next bullet.
- **SSH CTA clicked.** Reuse `onboarding_step4_path_clicked { path: 'ssh' }` — clicked-on-SSH parallels clicked-on-clone. Lands automatically once `'ssh'` is added to `onboardingPathSchema`.
- **`time_on_step` distribution for step 4.** `onboarding_step_completed` already emits `duration_ms` (`use-onboarding-flow.ts:264-267`) but only on success — long-tail and abandonment cases are exactly the ones that don't fire it. The new `onboarding_step4_abandoned` event above carries `duration_ms`, which closes the long-tail gap without a heartbeat or per-event opt-in. No timer plumbing.

Schema-edit pointer: `onboardingStep4PathFailedSchema` (`telemetry-events.ts:377-383`) requires `path: onboardingPathSchema`. It does not need to change for the abandonment event (which is its own schema, no `path` property). If a future failure-shaped event has no natural `path`, make `path` optional on `onboardingStep4PathFailedSchema` rather than adding a sentinel like `'none'` to `onboardingPathSchema` — smaller change, no fallout on existing dashboards.

### 5. `OnboardingOutcome` shared type is stale on this branch

`src/shared/types.ts:1372` still defines `OnboardingOutcome = 'completed' | 'dismissed'` even though commit `d2448f82` on this branch removes every renderer-side `'dismissed'` writer. Either restore the soft-skip (out of scope per "Out of scope" below) or narrow the type to `'completed'`. Leaving it half-alive invites accidental resurrection.

The dead branch is wider than just the type alias: `src/main/persistence.ts:144` still accepts both literals at the parse boundary; `src/shared/telemetry-events.ts:392` defines `onboardingDismissedSchema`; `:544` registers `onboarding_dismissed` in `eventSchemas`; and `:638` lists it in the cohort roster. ~10–15 LOC across 3 files (`src/shared/types.ts`, `src/main/persistence.ts`, `src/shared/telemetry-events.ts`) plus a one-line policy decision.

Policy decision: on disk the persistence loader at `src/main/persistence.ts:144` will see legacy `outcome: 'dismissed'` rows from users who dismissed under the old build. Recommended: keep accepting the legacy value at the parse boundary (don't break old users), but stop writing new ones — narrow `OnboardingOutcome` to `'completed'` at the type level and let `persistence.ts` coerce legacy `'dismissed'` to `null` (or to a new `'legacy_dismissed'` literal if downstream wants to distinguish). Don't remove `onboardingDismissedSchema` from the telemetry registry until a release after this — keeps old clients valid if they retry queued events.

## P2 — Nice to have

### 6. Clone failures have no escape

A bad URL, expired credentials, a large/slow repo, or a network blip surfaces as an inline error on the repo step (`RepoStep.tsx:97-101`) and that's it. Without the gate these users could click "I'll add one later" and recover; with PR #1677 they cannot.

Adding the SSH CTA (issue 1) gives most of these users another viable path. A "Having trouble? Open Settings" link or a back-to-previous-step affordance would cover the residual case where a user has no SSH target and the only repo they want is failing to clone.

### 7. Workspace directory is fixed silently

"Clone a repo" clones into `settings.workspaceDir` (`use-onboarding-flow.ts:380`). The repo step shows the workspace path in small grey text at the bottom but does not let you change it inline. Users on multiple disks, or with strong opinions about where their code lives, may want to clone elsewhere.

This predates PR #1677, but the new hard gate means a user who dislikes the workspace dir can no longer say "skip, I'll do this manually later". A "Change…" link next to the workspace path on this step would cost little and remove a small friction point.

### 8. App-quit during onboarding (verify-then-close)

Manual smoke test: open Orca → step 4 → quit (Cmd+Q) → reopen. Verify the wizard resumes at step 4 (not step 1) and that `lastCompletedStep` clamping at `src/main/persistence.ts` and `use-onboarding-flow.ts:36` (`Math.min(Math.max(onboarding.lastCompletedStep, 0), STEPS.length - 1)`) preserves the resume point. Expected to work today; this item closes when verified. 5-minute test, not a design item.

### 9. Drag-and-drop folders onto RepoStep

Superset's `StartView` accepts folder drops directly on the empty surface. Orca's `RepoStep` does not. For a hard gate, the lowest-friction "I have a folder, take it" path is unblocked by ~25 LOC, hooking into the existing preload `terminal:file-dropped-from-preload` bridge with a new wizard-step resolver target. React `onDrop` handlers do NOT fire for OS file drops in Orca — the preload at `src/preload/index.ts:167-244` calls `e.preventDefault()` on the document root and routes via IPC. Implementation: extend `NativeDropResolution`'s target union, add a `data-native-file-drop-target='onboarding-repo-step'` marker on the drop zone, subscribe via `window.api.ui.onFileDrop` from the wizard, and route the first directory through `repos.add({ kind: 'folder' })`. Pairs naturally with the `activateRepoForUser` primitive from #2. Optional, but high value-per-line.

## Future direction (out of scope for this PR)

**Empty-state home view as the gate.** Superset (the closest comparable Electron desktop competitor) ships exactly this pattern: wizard for *preferences* (agent, theme, notifications), a persistent first-project empty-state on the home view. This dissolves four classes of bug at once: modal stacking inside the wizard (the architectural note above), the empty-worktree-list activation gap (#2), clone-fail trap (#6), and the in-flight upgrade trap (#3). It also matches the standard macOS app pattern. This is the right long-term direction, but it's a structural rewrite of the wizard's terminal step — not "the same fix, refactored." Track separately.

## Out of scope

- Whether to gate at all. The decision to require a first project stands; this doc only addresses gaps in the current gate's coverage and recovery paths.
- Soft-skip with reminder. Considered and rejected once the SSH path is added — the strongest "I want to skip" case (SSH user trapped) goes away with issue 1, and the remaining "let me poke around" case is weak for a workspace-orchestrator app.
- A4 / empty-state home view. See "Future direction" section above. Different in kind from the patches in this doc.
