# Hide Repeated Worktree Branch

## Problem

The worktree sidebar still spends a second line on the branch when the branch label is identical to the workspace title.

- `src/renderer/src/components/sidebar/WorktreeCard.tsx:186` derives the rendered branch label.
- `src/renderer/src/components/sidebar/WorktreeCard.tsx:190` only hides the repeated branch when `experimentalCompactWorktreeCards` is enabled, and only on a raw exact match.
- `src/renderer/src/components/sidebar/WorktreeCard.tsx:563` keeps the metadata row mounted whenever compact cards are disabled, so a duplicate branch can leave an otherwise-empty row.
- `src/renderer/src/components/sidebar/WorktreeList.tsx:2887` renders nested lineage child branch text directly, bypassing `WorktreeCard`.
- `src/renderer/src/components/sidebar/WorktreeCard.quick-actions.test.tsx:142` currently asserts the old default behavior: duplicate branch rows remain visible unless compact cards are enabled.

## Root Cause

The earlier duplicate-branch suppression was tied to the experimental compact-card setting instead of being a baseline worktree-card rule. It also compares raw strings, so trim-only display-name differences still render duplicate branch text. `WorktreeCard` keeps the non-compact metadata row mounted even when that row has no visible content, and the lightweight lineage-child renderer always renders its branch span directly.

## Non-goals

- Do not rename workspaces, branches, or persisted metadata.
- Do not change folder workspace badges.
- Do not change PR, issue, Linear, comment, port, cache, conflict, SSH, unread, primary, sparse, or inline-agent rendering.
- Do not change grouping, sorting, virtualized row measurement, or drag behavior.

## Design

1. Keep `branchDisplayName` as the `refs/heads/` display normalizer, and add `shouldShowWorktreeBranchLabel(branchLabel, workspaceTitle)` in `WorktreeCardHelpers.tsx`.
   - Input: the already display-normalized branch label and the workspace display name.
   - Trim both inputs for comparison only.
   - Return `false` for blank branch labels and exact trimmed matches.
   - Return `true` for different names, including case-only differences and custom human titles.
   - Do not mutate, persist, or globally replace either label with the trimmed value.
2. Use the helper in `WorktreeCard.tsx`.
   - `showBranch` becomes `!isFolder && shouldShowWorktreeBranchLabel(branch, worktree.displayName)`, independent of `experimentalCompactWorktreeCards`.
   - Replace the compact-only comments near `showBranch` and `hasMetaRow`; they will be stale after this change.
   - Keep `branch` as the existing display-normalized string for cache keys and fetch inputs. Do not use `showBranch` to gate `hostedReviewCacheKey`, issue keys, Linear keys, or fetch effects.
   - Keep `showMetaRowDetails` as `!compactCards && (hasDetails || hasPorts)`, but compute it before `hasMetaRow`.
   - `hasMetaRow` should mount only for visible metadata content: repo badge, folder badge, conflict badge, visible branch, cache timer, or `showMetaRowDetails`.
   - Keep compact-card placement rules for unread, primary, details, and ports unchanged.
3. Use the same helper in the nested lineage child renderer in `WorktreeList.tsx`.
   - Compute `childBranchLabel` once from `branchDisplayName(child.worktree.branch)`.
   - Compute `showChildRepoBadge` from the existing rule: `Boolean(child.repo && groupBy !== 'repo')`.
   - Hide the branch span when `shouldShowWorktreeBranchLabel(childBranchLabel, child.worktree.displayName)` is false.
   - Hide only the child repo/branch row when both `showChildRepoBadge` and the visible branch are absent. The separate linked issue/comment row must keep its current behavior.
   - Do not add new folder badges or change repo badge grouping behavior in this lightweight renderer.
4. Update tests.
   - Add direct coverage for `branchDisplayName` handling `refs/heads/...`.
   - Add direct `shouldShowWorktreeBranchLabel` coverage for already-normalized blank labels, trim-only matches, case-only differences, and custom titles.
   - Replace the default-behavior assertion that duplicate branch rows remain visible.
   - Cover duplicate suppression with compact cards disabled.
   - Cover custom titles still showing branch labels.
   - Update the non-compact unread/primary assertion: primary and unread controls alone should not force an otherwise-empty metadata row.
   - Cover non-compact details or ports still keeping the metadata row after a duplicate branch is hidden.
   - Add lineage-child regressions for duplicate suppression when grouped by repo, custom titles still showing the branch, and repo badges still preserving the child metadata row outside repo grouping.
   - Do not prove suppression with a raw substring check for the duplicated name; the workspace title still renders. Assert the branch span or metadata-row marker instead.

## Consistency

This is pure renderer derivation from the current `worktree.branch`, `worktree.displayName`, `repo`, settings, and cache state. It adds no IPC, no filesystem access, no persisted metadata changes, and no extra cache invalidation path. Do not store or memoize the hidden/shown result outside render; multi-window updates, external git branch changes, title renames, and SSH reconnect/disconnect states continue through the existing store refreshes and re-render the derived visibility.

## Edge Cases

- Branch stored as `refs/heads/foo` and display name `foo`: hide the branch.
- Branch `foo` and display name ` foo `: hide the branch.
- Branch `refs/heads/`, detached HEAD, or any empty branch label: hide the branch span.
- Branch `foo` and display name `Foo`: show the branch, preserving case-sensitive custom title intent.
- Empty branch labels: do not render an empty branch row.
- Folder repositories: continue showing the folder badge, not branch text.
- Cards with repo badges, conflict badges, cache timers, non-compact details, or ports still render their metadata row.
- Nested lineage child cards preserve repo badges when grouped outside repo mode; when grouped by repo, a duplicate branch can remove the child repo/branch row entirely.
- SSH-backed repos use the same renderer inputs, so no local-path or provider-specific assumptions are introduced.

## Rollout

1. Implement and export the branch visibility helper in `WorktreeCardHelpers.tsx`.
2. Update `WorktreeCard.tsx` to use the helper and visible-content based metadata-row gating.
3. Update `WorktreeList.tsx` nested lineage child rendering to use the helper.
4. Update focused sidebar tests and run:
   - `pnpm test -- src/renderer/src/components/sidebar/WorktreeCard.quick-actions.test.tsx src/renderer/src/components/sidebar/WorktreeList.lineage-child-card.test.ts`
5. Run `pnpm typecheck` and `pnpm lint`.
