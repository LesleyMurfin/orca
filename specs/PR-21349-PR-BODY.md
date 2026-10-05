## ELI5

When a remote terminal session exits or terminates, Orca displays an alert banner saying "Remote terminal was closed." Previously, dismissing that alert banner (clicking "×") would either leave the dead pane permanently stuck in split layouts (#21342), or (in an initial attempt) silently destroy the entire pane/tab and wipe out the user's scrollback output before they could read or copy crash logs.

This change cleanly resolves both issues by **decoupling notification dismissal from pane teardown**:
1. Dismissing the alert ("×") simply hides the banner, leaving the terminal scrollback buffer intact for reading and copying.
2. An explicit **"Close Pane"** action button is displayed on the banner, allowing the user to intentionally tear down the dead remote terminal pane when ready.

## What Changed

- **`TerminalErrorToast.tsx`**:
  - Decoupled toast dismissal (`×`) from container teardown: clicking `×` now only calls `onDismiss()` to hide the notification, preserving the terminal buffer.
  - Added an explicit `<Button>` labeled `"Close Pane"` (localized via `translate(...)`) when `isRemoteTerminalClosedError(error)` and `onClosePane` are present. Clicking this button triggers `onClosePane()`.
  - Strengthened `isRemoteTerminalClosedError(error)` to use line-anchored matching (`error.split('\n')`), preventing false-positive substring matches when accumulated multiline errors contain remote terminal closed text.
- **`TerminalPaneSurface.tsx`**:
  - Wired `onClosePane={() => executeClosePane(activePane.id)}` into `TerminalErrorToast`. This uses `executeClosePane` directly because the remote PTY is already verified dead, safely bypassing redundant running-process prompts.
- **`TerminalErrorToast.test.ts` & `terminal-error-remote-closed-localization.test.ts`**:
  - Added unit test coverage proving that clicking `×` does *not* close the pane.
  - Added test coverage verifying that clicking `"Close Pane"` invokes `onClosePane`.
  - Verified localized strings (English, Chinese, and accumulated multiline errors).

## Why

Unlike transient errors (such as SSH reconnection or unverified pane owners) where a user waits for reconnection, `Remote terminal was closed.` indicates that the remote PTY has permanently exited. However, silently tearing down the container upon dismissal of the error toast caused unexpected data loss on single-pane tabs by closing the tab and erasing the terminal scrollback buffer. Providing an explicit "Close Pane" button respects user consent while ensuring dead panes can be cleanly evicted from split layouts.

## Linked Issue

### Architectural Context (RFC #21556)
- **Roadmap Phase:** Step 4: Close & Teardown (Gap 4)
- **Severity / Priority:** P2 (Medium)
- **System Impact:** Eliminates dead zombie split panes while preserving terminal buffer output upon notification dismissal.
- **Master Tracking RFC:** Part of [stablyai/orca#21556](https://github.com/stablyai/orca/issues/21556)

Fixes #21342

## Testing

- [x] Tested locally with unit and localization test suites
- [x] Proved RED first, then GREEN under independent verification:
  - `TerminalErrorToast.test.ts`: 48/48 passed
  - `terminal-error-remote-closed-localization.test.ts`: 4/4 passed
  - `oxlint`: 0 errors
  - `tsc --noEmit -p config/tsconfig.tc.web.json`: Clean (exit code 0)
- [x] Multi-machine ARM64 physical verification path documented (desktop clients paired to ARM64 Raspberry Pi OS Docker/host).
