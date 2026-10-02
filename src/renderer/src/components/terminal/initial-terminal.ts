export function shouldAutoCreateInitialTerminal(
  renderableTabCount: number,
  hasPersistedTerminalState = false,
  autoOpenInitialTerminal = true
): boolean {
  if (!autoOpenInitialTerminal) {
    return false
  }
  // Why: desktop callers pass isTerminalWorkspaceEmptiedOnPurpose, so an empty row with no close
  // record (legacy data, or a writer that is not a close) still reads as never initialized.
  return renderableTabCount === 0 && !hasPersistedTerminalState
}
