## Current State
- Target Issue: #21342 (Dismissing 'Remote terminal was closed' toast clears alert banner without tearing down dead pane)
- Active PR: #21349 (fix(terminal): teardown dead pane when dismissing remote terminal closed toast (#21342))
- Branch: fix/21342-terminal-error-toast-pane-teardown
- TDD Verification: Complete. TestWriter proved RED; CodeWriter implemented fix; TestRunner verified GREEN (49/49 tests pass).
- Agent Reviews: riley_pr_agent (APPROVED), riley_pr_check (PASS), riley_the_maintainer (APPROVED).
## Summary
When a remote terminal session terminates, dismissing the error toast should tear down the dead terminal pane across all locales (English, bilingual, and localized).

## Files to Touch
- `src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx`
- `src/renderer/src/components/terminal-pane/TerminalPaneSurface.tsx`
- `src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts`
- `src/renderer/src/components/terminal-pane/terminal-error-remote-closed-localization.test.ts`

## Step-by-Step
1. Write RED unit tests for `isRemoteTerminalClosedError` with localized and bilingual strings.
2. Implement code in `TerminalErrorToast.tsx` to recognize translated remote terminal closed strings.
3. Verify GREEN test execution.
4. Run code review agent (`riley-pr-agent`).
5. Run test check agent (`riley-pr-check`).
6. Run maintainer audit agent (`riley-the-maintainer`).

## Verification
- `HUSKY=0 pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts`
- `HUSKY=0 pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/terminal-error-remote-closed-localization.test.ts`
- `NODE_OPTIONS="--max-old-space-size=8192" node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.web.json`
- `npx oxlint src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx src/renderer/src/components/terminal-pane/TerminalPaneSurface.tsx src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts`

## Notes for Next Agent
Ensure `isRemoteTerminalClosedError` checks both `REMOTE_TERMINAL_CLOSED_MARKER` and the translated `remoteTerminalClosed` string from `translate(...)`.
