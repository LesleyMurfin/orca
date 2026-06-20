# PR (DRAFT — Bug B): fix: support floating-terminal sessions on remote runtimes

> **Status:** DRAFT for review — NOT yet filed upstream. Will be filed on `stablyai/orca` only after build + live test + Lesley's approval.
> **Target branch (at filing):** `fix/floating-terminal-remote-runtime` (split from the integration branch `ai/remote-terminal-wsl-floating-fix`).
> Fixes #<bug-B-issue-number>

## Summary
Teaches `OrcaRuntimeService.resolveWorktreeSelector` to resolve the floating workspace's synthetic id (`global-floating-terminal`) to a **virtual, repo-less session** rooted at the serve user's home directory, instead of throwing `selector_not_found`. This is the callee of the remote PTY transport's `connect()`, which is the real failure surface — so it fixes the black pane at its source.

## Change
`src/main/runtime/orca-runtime.ts` — early branch in `resolveWorktreeSelector` (before the catalog lookup):

```ts
const floatingId =
  selector === FLOATING_TERMINAL_WORKTREE_ID || selector === `id:${FLOATING_TERMINAL_WORKTREE_ID}`
if (floatingId) {
  const cwd = homedir()
  const git = { path: cwd, head: '', branch: '', isBare: false, isMainWorktree: false }
  const merged = mergeWorktree('', git, undefined, 'Floating Terminal')
  return { ...merged, id: FLOATING_TERMINAL_WORKTREE_ID, repoId: '', parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
}
```

- **cwd contract:** the virtual session spawns in `homedir()` (a real, existing directory on the serve).
- Mirrors merged PR #5696 (the `name:` branch on this same resolver) and the existing `'active'` special-case.
- Accepts both the bare sentinel and the `id:`-prefixed form (the transport sends `id:global-floating-terminal`).

## Testing
- Co-located unit tests in `orca-runtime.test.ts`: the floating sentinel (both id forms) resolves to a virtual session at `homedir()`; a genuinely-unknown `id:` still throws `selector_not_found`. **Full suite 455/455 green (Node 24).**
- TODO before filing: live repro on a Win-client ↔ WSL-serve build (server build); e2e spec — floating terminal while serve-paired yields a live PTY with no toast.

## AI code-review summary
- **Cross-platform:** `homedir()` resolves correctly on the serve host OS; no Windows-specific assumptions.
- **SSH / remote / local:** local behavior is unchanged (local uses the `createTab` fallback and never hits this resolver for the floating id); the new branch only affects the remote-runtime path that previously threw.
- **Agent:** unrelated; agent worktrees resolve through the normal catalog path, untouched.
- **Performance:** an early-return string comparison before the `listResolvedWorktrees()` scan — strictly faster for the floating id, no change for others.
- **Security:** repo-less session is scoped to the serve user's home; no path traversal or selector injection (exact-match on a known constant).

## Open scope note for review
The current fix resolves the **create/connect** path (the visible failure). `session.tabs.activate` / `session.tabs.close` for the same synthetic id are lower-impact but should be confirmed on live repro; if they no-op, a follow-up will route them through the same branch.

<!-- maintainer norm: add X handle before filing -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
