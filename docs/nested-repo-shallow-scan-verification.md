# Nested Repo Shallow Scan Verification

## User Issue

A user imports a non-git parent folder as a project group. The parent folder contains many sibling git repositories, but also contains a very large non-repo folder. The user reported:

> Thanks -- removing the parent .git worked, the group import shows up now. But it only finds 1 of 44 repos and says "Showing partial results from a bounded scan."
>
> The folder has ~107,000 directories total -- 44 sibling repos, each with a big node_modules/vendor tree (front-leadsales alone is ~9,700 dirs). It looks like the discovery scan recurses into subdirectories without pruning at .git boundaries and doesn't honor .gitignore, so it exhausts its budget inside the first repo's dependency tree and returns only ai-service (the alphabetically-first repo).

The current scanner already prunes discovered repos and skips exact noisy folder names like `node_modules` and `vendor`. The remaining failure mode is a large non-repo sibling folder that sorts before later sibling repos:

```text
platform/
  ai-service/.git
  archive/
    archived-service-001/.git
    archived-service-002/.git
    ...
  z-web-client/.git
```

With depth-first traversal, Orca can find `ai-service`, then spend the bounded scan inside `archive` before reaching `z-web-client`.

## Fix

Nested repo discovery now uses a queue-based shallow-first traversal:

- Inspect all folders at the current depth before descending.
- Record a folder as a repo when it has `.git`.
- Do not descend into discovered repos.
- Keep the existing max repo, max depth, timeout, and skipped-directory bounds.

This makes the bounded scan prefer nearby service repos over deep contents of an alphabetically early non-repo folder.

## Verification Scenario

Create a parent folder with:

```text
parent/
  archive/
    archived-service-001/.git
    ...
    archived-service-101/.git
  z-web-client/.git
```

Then import `parent` as a project group.

Expected behavior:

- The dialog shows partial bounded scan results.
- `z-web-client` appears in the result list even though `archive` sorts first.
- Selecting only `z-web-client` imports it under the created project group.
- No archived repos are imported unless selected.

## Automated Coverage

Targeted tests:

```bash
pnpm exec vitest run --config config/vitest.config.ts src/main/project-groups/nested-repo-discovery.test.ts src/main/ipc/repos-remote.test.ts
```

E2E regression:

```bash
pnpm run test:e2e -- tests/e2e/folder-setup-shallow-priority.spec.ts
```
