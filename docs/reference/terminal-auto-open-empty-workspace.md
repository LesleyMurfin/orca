# Empty Workspace Initial Terminal Auto-Opening

Orca provides an `autoOpenInitialTerminal` setting to control whether a new terminal tab is automatically created when activating or switching to an empty workspace (a folder workspace or worktree with zero open renderable tabs).

## Background & Motivation

By default, Orca automatically seeds an initial terminal tab whenever a user opens or activates a workspace that currently has no tabs. While convenient for terminal-centric workflows, users who primarily use other tools, AI editor interfaces, or who prefer clean workspaces requested the ability to prevent terminal tabs from opening automatically upon workspace switch.

## Configuration

The setting is accessible via:
- **Settings UI**: Under **Terminal** -> **Pane Interaction**, toggle **"Open terminal on empty workspace"** (`components.settings.TerminalInteraction.autoOpenInitialTerminal`).
- **Global Settings JSON / Config**: Set `autoOpenInitialTerminal` to `true` (default) or `false`.

```json
{
  "autoOpenInitialTerminal": false
}
```

## How It Works

### Workspace Activation
When activating or revealing a workspace (`activateAndRevealFolderWorkspace` or `activateAndRevealWorktree` in `src/renderer/src/lib/worktree-activation.ts`), Orca checks if any renderable tabs exist for the target workspace.
- If tabs already exist, no new terminal is opened regardless of this setting.
- If the tab count is zero:
  - If `autoOpenInitialTerminal` is `true` (default), `shouldAutoCreateInitialTerminal` returns `true` (assuming tombstone conditions allow), and Orca automatically calls `createTab(...)` to seed a terminal.
  - If `autoOpenInitialTerminal` is `false`, `shouldAutoCreateInitialTerminal` returns `false`, leaving the workspace empty until the user explicitly opens a terminal or file tab.

### Initial Terminal Helper & Seeding
In `src/renderer/src/components/terminal/initial-terminal.ts` and `src/renderer/src/lib/worktree-initial-terminal-seeding.ts`:
- `shouldAutoCreateInitialTerminal(renderableTabCount, hasPersistedTerminalState, autoOpenInitialTerminal)` accepts `autoOpenInitialTerminal` (defaulting to `true` for backwards compatibility).
- When `autoOpenInitialTerminal` is `false`, the helper immediately returns `false`.

### Empty Workspace Reseeding & Terminal Watcher
When tabs are closed or removed within a workspace:
- `useTerminalWatcherEffects` checks `autoOpenInitialTerminal` before re-seeding an initial terminal when all tabs are closed.
- If disabled, closing the last tab in a workspace leaves the workspace in an empty state without spawning a replacement terminal tab.
