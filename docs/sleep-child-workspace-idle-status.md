# Sleep Child Workspace Idle Status

## Problem or goal

When a workspace is rendered as a nested child preview under its parent, sleeping that child leaves its status indicator green. The nested preview should show the same status as a normal card for the same workspace. For a plain slept workspace with no live terminals, browsers, or intentionally visible agent status rows, that status is the idle/inactive state used by normal workspace cards.

The code currently names this visual state `inactive`; this doc uses "idle" for the requested UX behavior and `inactive` for the existing type value.

## Current behavior with file:line references

- `src/renderer/src/components/sidebar/sleep-worktree-flow.ts:83` runs the shared sleep flow for one or more worktrees. It shuts down browsers first at `src/renderer/src/components/sidebar/sleep-worktree-flow.ts:114`, then shuts down terminals with `keepIdentifiers: true` at `src/renderer/src/components/sidebar/sleep-worktree-flow.ts:127`.
- `src/renderer/src/lib/worktree-status.ts:21` documents the key liveness rule: `tab.ptyId` is only a wake hint after sleep, while `ptyIdsByTabId` is the live PTY source of truth. `getWorktreeStatus` filters to live tabs at `src/renderer/src/lib/worktree-status.ts:27` and returns `inactive` when there are no live terminals or browser tabs at `src/renderer/src/lib/worktree-status.ts:46` and `src/renderer/src/lib/worktree-status.ts:53`.
- Normal sidebar cards already use that shared status model. `WorktreeCard` reads `useWorktreeActivityStatus(worktree.id)` at `src/renderer/src/components/sidebar/WorktreeCard.tsx:209`, and `StatusIndicator` maps `inactive` to the grey idle dot at `src/renderer/src/components/sidebar/StatusIndicator.tsx:50` through `src/renderer/src/components/sidebar/StatusIndicator.tsx:58`.
- Workspace board compact cards also use the shared model: `src/renderer/src/components/sidebar/WorkspaceKanbanCard.tsx:111` reads `useWorktreeActivityStatus`, then renders `StatusIndicator` at `src/renderer/src/components/sidebar/WorkspaceKanbanCard.tsx:190`.
- The nested child preview is the outlier. `WorktreeList` renders child previews separately from `WorktreeCard` at `src/renderer/src/components/sidebar/WorktreeList.tsx:972`, passes those previews into the parent row at `src/renderer/src/components/sidebar/WorktreeList.tsx:1173`, and hardcodes the child dot to `bg-emerald-500` at `src/renderer/src/components/sidebar/WorktreeList.tsx:1006` through `src/renderer/src/components/sidebar/WorktreeList.tsx:1008`.

## Proposed design

Replace the hardcoded child preview dot with the same status derivation and rendering used by normal workspace cards.

Implementation should extract the nested child preview body into a small module-scoped React component in `WorktreeList.tsx`, for example `LineageChildPreviewRow`. Export it by name if the focused component test needs direct access. Move it to a concretely named sibling file only if the prop surface stays small; this row currently depends on `WorktreeList` row shape and callbacks, so forcing a sibling file could create noisy prop plumbing.

Do not declare the component inside the `WorktreeList` render body. A render-local component gets a new function identity on every parent render and can remount child previews, context menus, tooltips, and inline agent rows unnecessarily.

That component should:

- Accept the existing child row data and event callbacks.
- Call `useWorktreeActivityStatus(child.worktree.id)` at the component top level.
- Render `<StatusIndicator status={status} aria-hidden="true" />` plus the same sr-only label pattern used by `WorktreeCard` and `WorkspaceKanbanCard`.
- Preserve the existing indentation, context menu, selection, activation, repo badge, branch text, metadata, child toggle, and inline agent row behavior.

Do not call `useWorktreeActivityStatus` inside the current `renderLineageChildPreview` callback. That callback is invoked while mapping dynamic child rows, so putting hooks there would violate React hook ordering. A child component keeps the hook order local to each preview row while letting React mount one hook instance per visible child preview.

No sleep-flow state mutation is needed for this bug. The sleep flow already clears live browser and PTY state; the child preview is simply bypassing the shared renderer that observes those stores. Do not add an optimistic "sleeping" override in the nested preview: if browser or terminal shutdown fails, the existing store state remains the source of truth and the shared status should stay active until the underlying live state is actually cleared.

The status contract is:

- The nested child preview must render the same `StatusIndicator` label and visual state that `WorktreeCard` or `WorkspaceKanbanCard` would render for the same `worktree.id` at the same store snapshot.
- A slept child with no live PTY, no browser tabs, and no visible retained/fresh explicit agent status resolves to `inactive`.
- A slept child may still show `permission`, `working`, or `done` if the shared `useWorktreeActivityStatus` model intentionally promotes a visible agent row. The fix should not special-case those states away in the child preview.

## Alternatives considered

| Approach | How it works | Why it is worse or better |
| --- | --- | --- |
| Proposed: reuse `useWorktreeActivityStatus` and `StatusIndicator` in a child preview component | The nested row becomes another consumer of the shared status model, with hook ordering isolated inside the row component. | Best fit. It fixes the divergent renderer without changing sleep semantics or duplicating status rules. |
| Push sleep-specific status into `sleep-worktree-flow.ts` | Sleep would write a child-preview-specific idle flag after teardown. | Worse. It creates a second status source, risks stale optimistic UI on partial shutdown failure, and does not help other status changes outside sleep. |
| Replace nested previews with full `WorktreeCard` rows | Parent lineage rendering would reuse the existing card entirely. | Too large for this bug. It could be a future simplification, but it risks changing layout density, drag/selection behavior, and inline metadata beyond the status dot regression. |

## Architecture and data flow

```text
Sleep context menu / action
        |
        v
runSleepWorktrees(worktreeId)
        |
        +--> shutdownWorktreeBrowsers(worktreeId) --> browserTabsByWorktree
        |
        +--> shutdownWorktreeTerminals(worktreeId, keepIdentifiers: true)
                                                     |
                                                     v
                                           live PTY maps / tab state
                                                     |
                                                     v
                           useWorktreeActivityStatus(worktreeId)
                                                     |
                                                     v
              +----------------------+----------------+----------------------+
              |                      |                                       |
        WorktreeCard          WorkspaceKanbanCard              LineageChildPreviewRow
              |                      |                                       |
              +----------------------+----------------+----------------------+
                                                     |
                                                     v
                                            StatusIndicator
```

Data paths to preserve:

- Happy path: a live child has live PTY and/or browser state, `useWorktreeActivityStatus` resolves `active` or an explicit agent state, and the child preview renders the matching `StatusIndicator`. After sleep clears live browser and PTY state, the store update invalidates the hook subscription and the preview rerenders to `inactive` unless visible agent-row promotion still applies.
- Nil or missing store entries: absent tab, browser, PTY, or pane-title maps must follow the existing hook defaults (`EMPTY_TABS`, `EMPTY_BROWSER_TABS`, and empty live maps) and render `inactive`, not throw or invent a fallback color.
- Empty collections and collapsed lineage: children that are not rendered should not mount `LineageChildPreviewRow` and therefore should not add status subscriptions. Rendered children with empty terminal/browser collections should show the shared inactive state.
- Upstream or partial sleep failure: if browser shutdown fails, terminal shutdown is skipped for that worktree and the preview should continue reflecting the still-live state. If terminal shutdown fails after browsers are cleared, the preview should reflect whichever live PTY state remains. The existing sleep toast is the user-facing failure signal; the preview should not mask failure by forcing idle.

## Edge cases

- Slept terminals with preserved wake hints: child previews must still go idle because `ptyIdsByTabId[tabId]` is empty even if `tab.ptyId` remains populated.
- Browser-only child workspaces: they should stay green while a browser tab is live and go idle after `shutdownWorktreeBrowsers` clears browser state.
- Child with fresh explicit `working`, `waiting`, `blocked`, or `done` agent rows: the preview should match `useWorktreeActivityStatus` priority exactly, including retained done rows if they are still intentionally visible.
- Active child workspace under a parent row: the parent row can still use the active surface via `childIsActive`; the child preview dot should reflect liveness, not selection.
- Collapsed lineage: no extra status subscriptions should mount for hidden child previews.
- SSH workspaces: rely on the same `ptyIdsByTabId` and browser-tab state; do not add local filesystem assumptions.
- Selection and keyboard accessibility: preserve the current `role="option"`, `aria-selected`, `aria-current`, option id, click, double-click, and context-menu propagation behavior. The status label should be present for assistive technology through the existing sr-only pattern, while the visible dot remains `aria-hidden`.

## Test plan

- Unit/component coverage:
  - Add a focused renderer test for the extracted child preview component, mocking `useWorktreeActivityStatus` or store state to verify `inactive` renders the `Inactive` sr-only label and the shared `StatusIndicator` instead of the old hardcoded `bg-emerald-500` dot.
  - Add a second case for `active` or `working` so the preview proves it is wired to the shared status component, not merely hardcoded grey.
  - Add a retained/fresh explicit agent status case only if the component test owns enough fixture setup to make it readable; otherwise leave that priority behavior covered by `use-worktree-activity-status.test.tsx` and `worktree-status.test.ts`.
  - Keep the existing status derivation tests in `src/renderer/src/lib/worktree-status.test.ts` as the source of truth for live PTY sleep semantics.
- Playwright coverage:
  - Extend `tests/e2e/worktree-lineage.spec.ts`. Seed a parent/child lineage, give the child live terminal state, verify the child preview is active, invoke Sleep on the child from its context menu, then verify the child preview exposes the `Inactive` sr-only label. Prefer the semantic label over asserting Tailwind color classes.
  - Prefer testing through the context menu because the regression is specific to the nested child rendering path and real sleep action.
- Manual validation:
  - Create or seed a parent with a child workspace.
  - Sleep the child while it is shown under the parent.
  - Confirm the nested child dot changes from green to idle/grey while a normal card for the same workspace shows the same state.

## Rollout order

1. Extract the nested child preview into a hook-safe component.
2. Replace the hardcoded emerald dot with `useWorktreeActivityStatus` plus `StatusIndicator`.
3. Add the focused component/unit coverage.
4. Extend the lineage Playwright scenario if the context-menu sleep path is stable enough in CI; otherwise keep the Playwright test as a follow-up but include the component regression test in the same PR.
5. Run the targeted unit tests, then `pnpm run test:e2e -- tests/e2e/worktree-lineage.spec.ts` when Electron E2E is available.

## Ref-oss

Used. Repos were synced with the `ref-oss` workflow.

Reference checked:

- VS Code repo: `/Users/thebr/projects/orca-ref-oss/vscode`
- `src/vs/workbench/contrib/files/browser/views/explorerView.ts:442` creates shared `ResourceLabels` for explorer rows.
- `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts:1013` applies row resources through `templateData.label.setResource(...)` with file decoration options instead of hardcoding per-row status classes.
- `src/vs/workbench/browser/labels.ts:687` through `src/vs/workbench/browser/labels.ts:714` resolves decorations centrally and applies label/badge/icon classes from the decoration service.
- `src/vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.ts:18` through `src/vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.ts:45` derives decoration data from the explorer item model.

Pattern to reuse: nested tree rows should feed their model state into the same shared status/decorator renderer as top-level rows. Orca should reuse its own `useWorktreeActivityStatus` and `StatusIndicator`, not copy VS Code code.
