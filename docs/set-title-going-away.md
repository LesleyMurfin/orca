# Set Title Input Disappearing

## Problem

Opening `Set Title...` from a terminal pane context menu can flash the pane-title input and immediately close it, usually on the first control-click/context-menu attempt. The input should stay open and focused so the user can type a pane title. A second attempt often works, which points to a first-open focus/blur race rather than a persistence or layout issue.

## Current Behavior

- Terminal pane context-menu state lives in `useTerminalPaneContextMenu`. The hook records the clicked pane and opens the Radix dropdown on `contextmenu` capture (`src/renderer/src/components/terminal-pane/use-terminal-pane-context-menu.ts:216`).
- The hook deliberately ignores a close-all event for the first 100ms after opening (`src/renderer/src/components/terminal-pane/use-terminal-pane-context-menu.ts:64`) and the dropdown also ignores early pointer-down outside events (`src/renderer/src/components/terminal-pane/TerminalContextMenu.tsx:88`, `src/renderer/src/components/terminal-pane/TerminalContextMenu.tsx:119`). That protects menu opening, not the later rename input.
- `Set Title...` calls `onSetTitle` directly from the dropdown item (`src/renderer/src/components/terminal-pane/TerminalContextMenu.tsx:228`), which resolves the menu pane and enters rename mode (`src/renderer/src/components/terminal-pane/use-terminal-pane-context-menu.ts:209`).
- Entering rename mode only sets `renameValue` and `renamingPaneId` (`src/renderer/src/components/terminal-pane/TerminalPane.tsx:1143`). The input is then portaled into the pane while `renamingPaneId` matches (`src/renderer/src/components/terminal-pane/TerminalPane.tsx:1466`).
- The input focuses/selects itself on the next animation frame (`src/renderer/src/components/terminal-pane/TerminalPane.tsx:1211`) and commits on every blur (`src/renderer/src/components/terminal-pane/TerminalPane.tsx:1489`).
- When the pane has no existing title, `handleRenameSubmit` treats the empty value as a completed blank rename and closes the input (`src/renderer/src/components/terminal-pane/TerminalPane.tsx:1173`). If a delayed xterm/menu focus handoff blurs the just-mounted input before typing starts, the input disappears without user intent.
- Current E2E coverage opens the menu and immediately fills after seeing the input (`tests/e2e/terminal-panes.spec.ts:44`), then separately asserts focus for editing an existing title (`tests/e2e/terminal-panes.spec.ts:226`). It does not assert that a first-open blank `Set Title...` input remains focused across the post-menu focus handoff.

## Proposed Design

Add a short rename activation guard in `TerminalPane.tsx` so the inline title input does not commit from blur until it has survived the initial mount/focus handoff.

1. Track a rename activation session with refs near the existing rename refs:
   - `renameBlurCommitEnabledRef`
   - `renameSessionIdRef`, incremented every time rename mode starts or closes
   - `renameFocusRetryFrameRef` or equivalent cleanup for a scheduled refocus
   - `renameEnableBlurFrameRef` or equivalent cleanup for the delayed enable step
2. In `handleStartRename`, before setting `renamingPaneId`, increment `renameSessionIdRef`, disable blur commits for the new session, cancel any pending rename frames, and keep the current `renameSubmittedRef` double-submit guard intact.
3. In the rename focus effect, capture the current session id, focus/select the input on the next animation frame, then enable blur commits only from a later frame if the captured session id still matches, the same pane is still being renamed, the input is still mounted, and `document.activeElement` is still the input.
4. Replace `onBlur={handleRenameSubmit}` with a small `handleRenameBlur` callback:
   - If blur commits are not enabled and the same rename session is still active, do not submit yet.
   - Schedule one refocus/select attempt on the next frame if the input is still mounted and the session id still matches.
   - After that refocus attempt, if the input is active, enable blur commits. If focus moved somewhere else and cannot be restored, enable blur commits and call `handleRenameSubmit` once so an intentional click-away during the guard still behaves like the existing blur-submit flow.
   - Once blur commits are enabled, call `handleRenameSubmit` unchanged.
5. Keep `Enter` submit and `Escape` cancel immediate. They are explicit user actions and should not wait for the blur guard.
6. Clear pending animation frames and increment `renameSessionIdRef` when rename mode closes or the component unmounts, so stale callbacks from a prior session cannot mutate the next session even if the user reopens rename on the same pane quickly.

This keeps the current commit semantics after activation: clicking away after the input has settled still submits or clears as today, Enter submits, Escape cancels, empty title removes an existing pane title, and successful titles still persist via `persistLayoutSnapshot`.

Add a brief "why" comment around the guard: the context-menu selection can be followed by a delayed xterm/Radix focus handoff, and that synthetic early blur must not be treated as title submission.

The intended first-open event sequence is:

1. User invokes the terminal context menu and chooses `Set Title...`.
2. `handleStartRename` creates a new rename session, disables blur commits, and renders the input.
3. The focus effect focuses/selects the input on an animation frame.
4. A delayed xterm/Radix focus handoff blurs the input before activation is complete.
5. `handleRenameBlur` suppresses that early blur for the same session and schedules one refocus.
6. If refocus succeeds, blur commits become enabled and the input remains ready for typing. If refocus fails because focus is now intentionally elsewhere, the handler submits once through the existing `handleRenameSubmit` path.

## Alternatives Considered

| Approach | Why not |
| --- | --- |
| Defer `handleStartRename` until after the dropdown fully closes | This still relies on timing around Radix and xterm focus recovery, and it delays visible feedback from the menu selection without fixing blur-submit semantics. |
| Change the terminal context-menu focus policy globally | The menu already has copy/paste/split focus rules. Broadly changing Radix/xterm focus behavior risks regressions across terminal input, paste, and quick-command flows for a bug isolated to inline title editing. |
| Require explicit save/cancel controls instead of blur-submit | This would avoid blur races, but it changes an established lightweight inline-edit interaction and is larger UX scope than the reported regression needs. |

## Architecture Fit

```text
TerminalContextMenu
  onSelect Set Title...
        |
        v
useTerminalPaneContextMenu.resolveMenuPane()
        |
        v
TerminalPane.handleStartRename()
        |
        v
renamingPaneId + renameValue + rename guard refs
        |
        v
portaled .pane-title-input in target pane
        |
        +--> Enter/Escape: explicit submit/cancel
        +--> Blur before activation: guarded refocus or one fallback submit
        +--> Blur after activation: existing handleRenameSubmit
```

Data-flow paths:

- Happy path: menu resolves a pane, `handleStartRename` seeds the current title, the input survives activation, the user types, Enter or post-settle blur calls `handleRenameSubmit`, `paneTitlesRef` updates, and `persistLayoutSnapshot` saves the title.
- Nil pane path: `resolveMenuPane` returns `null`, `onSetTitle` does nothing, and no rename session starts.
- Empty title path: explicit Enter or post-settle blur with trimmed empty text runs the existing removal/reset logic; an early synthetic blur no longer removes an untitled input before the user can type.
- Upstream focus handoff path: Radix/xterm focus moves away before activation; the guard suppresses that first blur, attempts one refocus for the current session, then either enables normal blur commits or submits once if focus cannot be restored.

## Edge Cases

- Untitled pane, first `Set Title...`: blank input remains visible and focused instead of immediately committing empty.
- Existing titled pane, edit from title button: the input still opens focused with text selected; an early synthetic blur should not close it.
- Reopen rename quickly on the same pane: stale scheduled frames from the previous session must no-op because their captured `renameSessionIdRef` value no longer matches.
- User intentionally clicks elsewhere after the input has settled: blur still submits using existing behavior.
- User intentionally clicks elsewhere before the input has settled: the guard may attempt one refocus, but if focus is not restored it submits once through the existing blur path instead of leaving the editor stranded.
- User presses `Escape`: cancels immediately, even during the activation guard.
- User presses `Enter` with blank text: still removes/reset the pane title through the existing explicit submit path.
- User presses `Enter` and the input blurs during unmount: `renameSubmittedRef` must still prevent a second submit.
- Agent OSC/tab-title churn remains unrelated: pane titles are stored in `paneTitles`/`titlesByLeafId`, not tab `customTitle`.
- SSH/runtime panes are unaffected because this is renderer-only focus state. No path, shell, PTY, or remote filesystem behavior changes.

## Test Plan

- Add focused E2E coverage to `tests/e2e/terminal-panes.spec.ts`:
  - Open the terminal pane context menu on a fresh pane using the effective menu gesture: macOS control-click for the reported path; Windows control-right-click when `rightClickToPaste` is enabled so the app menu is reached; otherwise right-click. Assert the menu opened before clicking `Set Title...` so failures are attributed to gesture handling instead of rename logic.
  - Click `Set Title...`.
  - Assert `.pane-title-input` is visible and focused after the menu closes, then wait a short stabilization interval or poll for the same condition so the old flash-and-close regression fails.
  - Type a title and press `Enter`; assert `.pane-title-text` renders that title.
  - Press `Enter` from the input and assert the input unmounts once and the title appears once, preserving the existing `renameSubmittedRef` Enter-plus-blur protection.
- Keep the existing `Set Title stays pane-local during agent title churn` test because it covers persistence, tab title isolation, remove, and split behavior.
- Add or update a small unit test only if the blur guard is extracted into a pure helper. If implemented directly as React refs in `TerminalPane.tsx`, Playwright coverage is the valuable regression test because the bug is browser focus sequencing.
- Run:
  - targeted E2E: `pnpm test:e2e tests/e2e/terminal-panes.spec.ts`
  - `pnpm typecheck`
  - `pnpm lint`

## Rollout Order

1. Implement the rename activation guard in `TerminalPane.tsx`.
2. Add the first-open context-menu `Set Title...` Playwright regression test.
3. Run targeted E2E and required checks.
4. Manually validate in Electron: first control-click/right-click `Set Title...` on an untitled pane keeps the input open and focused; second attempt still works; Escape, Enter, blank title reset, remove button, split panes, and agent title churn remain unchanged.

## ref-oss

Not used. This is an Orca-specific interaction between the terminal pane manager, xterm focus recovery, Radix dropdown close behavior, and the pane-title portal. Mature OSS references would not materially reduce design risk compared with fixing and testing the local focus/blur contract.
