# Worktree Post-Create Base Refresh

## Problem

Before this change, only one local-create path was intentionally stale-on-create:

- `baseBranch` resolves to a remote-tracking ref.
- That ref exists locally.
- Fetch freshness is stale.

In that path, Orca starts `getOrStartRemoteFetch(...)` and does not await it before `git worktree add` ([src/main/ipc/worktree-remote.ts](/Users/jinjingliang/Documents/projects/orca/https-github.com-stablyai-orca-issues-2307/src/main/ipc/worktree-remote.ts:531), [src/main/ipc/worktree-remote.ts](/Users/jinjingliang/Documents/projects/orca/https-github.com-stablyai-orca-issues-2307/src/main/ipc/worktree-remote.ts:724)). The new worktree may be created from stale `refs/remotes/<remote>/<branch>`.

Later, `reconcileWorktreeBaseStatus` classifies the result (`current` / `drift` / `base_changed` / `unknown`) but did not repair the worktree ([src/main/runtime/orca-runtime.ts](/Users/jinjingliang/Documents/projects/orca/https-github.com-stablyai-orca-issues-2307/src/main/runtime/orca-runtime.ts:6068)).

Important current behavior constraints:

- If the remote-tracking ref does not exist locally, create blocks on fetch before `addWorktree`; this path is not stale-on-create.
- If fetch freshness is hit, create previously did not schedule reconcile: no `checking`, no post-create classification ([src/main/ipc/worktree-remote.ts](/Users/jinjingliang/Documents/projects/orca/https-github.com-stablyai-orca-issues-2307/src/main/ipc/worktree-remote.ts:551)).
- `refreshLocalBaseRefOnWorktreeCreate` is separate and default-off ([src/shared/constants.ts](/Users/jinjingliang/Documents/projects/orca/https-github.com-stablyai-orca-issues-2307/src/shared/constants.ts:145)). It may fast-forward a local branch pointer, but does not make the remote-tracking base fresh ([src/main/git/worktree.ts](/Users/jinjingliang/Documents/projects/orca/https-github.com-stablyai-orca-issues-2307/src/main/git/worktree.ts:164)).

## Root Cause

Latency optimization decouples create from fetch completion, but reconcile is read-only. There is no guarded post-fetch fast-forward of the just-created worktree.

## Non-Goals

- Do not block the optimistic local-create path on network fetch.
- Do not mutate worktrees after any user/setup/agent filesystem or commit activity.
- Do not change base-ref selection semantics.
- Do not add extra fetches beyond existing `getOrStartRemoteFetch` reuse.
- Do not broaden to SSH in this change.

## Design

1. Keep current non-blocking create behavior in the optimistic path.

2. Extend reconcile with guarded auto-refresh before emitting `drift`.

Trigger only when:
- `postFetchSha !== createdBaseSha`.
- `createdBaseSha` is an ancestor of `postFetchSha`.

Action:
- `git reset --hard <postFetchSha>` in the created worktree.

3. Required guards before reset.

- Reconcile token still current.
- Worktree `instanceId` still matches create-time value.
- Worktree path still exists and is still a git worktree.
- `HEAD` still equals `createdBaseSha`.
- Current branch still equals created branch (skip detached/switch).
- Worktree is clean via `git status --porcelain` (include untracked).

4. Status behavior.

- Reset succeeds: emit `current`.
- Any guard fails in fast-forward case: emit existing `drift` payload.
- Non-ancestor: emit `base_changed`.
- Keep existing publish-remote conflict behavior unchanged: only run on `current` / `drift` / `base_changed` (not on `unknown`).

5. Close the fresh-cache classification gap.

Freshness-hit creates now still schedule reconcile by passing `Promise.resolve({ ok: true })` as `fetchPromise`. This adds `checking` -> `current` consistency without starting another fetch.

## Required Plumbing Changes

- Thread `createdWorktreePath` and `createdInstanceId` from create into reconcile args.
  - Reconcile currently only gets `worktreeId`; that is insufficient for safe mutation without extra lookups and path-reuse protection.
- Add a runtime helper for “validate untouched + reset hard to postFetchSha”.
- Re-validate token immediately before mutation and before emit.

## Consistency and Concurrency

- Token check handles stale async completions in one runtime instance.
- `instanceId` check is mandatory for same-path delete/recreate races.
- Fetch cache key canonicalizes by git common-dir + remote, so parallel creates across linked worktrees share one in-flight fetch/freshness window.
- External git mutations between create and reconcile are expected; guards must downgrade to non-mutating classification.
- Multi-window renderers are unaffected; event type remains `WorktreeBaseStatusEvent`.

## Edge Cases

- Fetch fails/offline: emit `unknown`, no mutation.
- Base ref missing after fetch (`rev-parse` fails): emit `unknown`.
- Force-push/rewrite (non-ancestor): emit `base_changed`, no mutation.
- User/setup/agent file writes (including untracked): skip reset, emit `drift`.
- User commit before reconcile: `HEAD` mismatch, skip reset.
- Branch switched/detached: skip reset.
- Worktree removed/recreated at same path: token + instance check prevent wrong-target mutation.

## Rollout

1. Add reconcile-time untouched-state/reset helper in runtime.
2. Pass `createdWorktreePath` + `createdInstanceId` into reconcile.
3. Invoke helper after ancestry check and before drift emit.
4. Always schedule reconcile in the optimistic-base path, including freshness-hit creates.
5. Add tests for:
   - successful guarded auto-refresh to `current`;
   - dirty/untracked skip;
   - HEAD-changed skip;
   - branch-switched/detached skip;
   - non-ancestor `base_changed`;
   - stale-token and instance-id mismatch skip;
   - deleted/recreated path skip;
   - freshness-hit path schedules reconcile (if adopted).
6. Keep non-blocking cold-fetch create test intent intact (`src/main/ipc/worktrees.test.ts`).
