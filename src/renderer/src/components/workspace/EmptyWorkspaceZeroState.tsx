import React from 'react'
import { FileText, FolderOpen, Sparkles, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

export type EmptyWorkspaceZeroStateShortcuts = {
  newTerminal?: string
  newAgent?: string
  openFile?: string
}

export type EmptyWorkspaceZeroStateProps = {
  workspaceTitle?: string
  repoName?: string
  repositoryName?: string
  onNewTerminal: () => void
  onNewAgent?: () => void
  onOpenFile?: () => void
  newTerminalShortcut?: ShortcutKeyComboDetails | string
  newAgentShortcut?: ShortcutKeyComboDetails | string
  openFileShortcut?: ShortcutKeyComboDetails | string
  shortcuts?: EmptyWorkspaceZeroStateShortcuts
}

function ZeroStateShortcutBadge({
  shortcut
}: {
  shortcut?: ShortcutKeyComboDetails | string
}): React.JSX.Element | null {
  if (!shortcut) {
    return null
  }
  if (typeof shortcut === 'string') {
    if (!shortcut.trim()) {
      return null
    }
    return (
      <ShortcutKeyCombo
        keys={[shortcut]}
        keyCapClassName="min-w-0 px-1.5 py-0.5 text-xs shadow-xs"
      />
    )
  }
  if (shortcut.keys && shortcut.keys.length > 0) {
    return (
      <ShortcutKeyCombo
        keys={shortcut.keys}
        doubleTap={shortcut.doubleTap}
        keyCapClassName="min-w-0 px-1.5 py-0.5 text-xs shadow-xs"
      />
    )
  }
  return null
}

export function EmptyWorkspaceZeroState({
  workspaceTitle,
  repoName,
  repositoryName,
  onNewTerminal,
  onNewAgent,
  onOpenFile,
  newTerminalShortcut,
  newAgentShortcut,
  openFileShortcut,
  shortcuts
}: EmptyWorkspaceZeroStateProps): React.JSX.Element {
  const repo = repositoryName || repoName
  const terminalShortcut = newTerminalShortcut ?? shortcuts?.newTerminal
  const agentShortcut = newAgentShortcut ?? shortcuts?.newAgent
  const fileShortcut = openFileShortcut ?? shortcuts?.openFile

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center p-6 text-center select-none"
      data-empty-workspace-zero-state
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-12 items-center justify-center rounded-xl border border-border/80 bg-secondary/50 text-muted-foreground shadow-xs">
            <FolderOpen className="size-6 text-foreground/80" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {workspaceTitle ||
                translate('workspace.zeroState.noOpenTabs', 'No open tabs in this workspace')}
            </h2>
            {repo ? <span className="text-xs text-muted-foreground">{repo}</span> : null}
            <p className="text-sm text-muted-foreground">
              {translate('workspace.zeroState.subtitle', 'Choose an action to get started')}
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            className="justify-between w-full"
            onClick={onNewTerminal}
          >
            <div className="flex items-center gap-2.5">
              <TerminalSquare className="size-4 opacity-90" />
              <span className="leading-none">
                {translate('workspace.zeroState.newTerminal', 'New Terminal')}
              </span>
            </div>
            <ZeroStateShortcutBadge shortcut={terminalShortcut} />
          </Button>

          {onNewAgent ? (
            <Button
              type="button"
              variant="outline"
              className="justify-between w-full"
              onClick={onNewAgent}
            >
              <div className="flex items-center gap-2.5">
                <Sparkles className="size-4 opacity-90" />
                <span className="leading-none">
                  {translate('workspace.zeroState.newAgent', 'New Agent')}
                </span>
              </div>
              <ZeroStateShortcutBadge shortcut={agentShortcut} />
            </Button>
          ) : null}

          {onOpenFile ? (
            <Button
              type="button"
              variant="outline"
              className="justify-between w-full"
              onClick={onOpenFile}
            >
              <div className="flex items-center gap-2.5">
                <FileText className="size-4 opacity-90" />
                <span className="leading-none">
                  {translate('workspace.zeroState.openFile', 'Open File')}
                </span>
              </div>
              <ZeroStateShortcutBadge shortcut={fileShortcut} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default EmptyWorkspaceZeroState
