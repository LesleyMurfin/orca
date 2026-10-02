import React from 'react'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { ActivityTerminalPortalTarget } from './activity/activity-terminal-portal'
import {
  useBrowserGuestPaintRetention,
  useWorktreeBrowserPageIds
} from './browser-pane/host-guest/browser-guest-paint-retention'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from './browser-pane/host-guest/browser-worktree-surface-paintability'
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import { RetainedBrowserPaneOverlayLayer } from './browser-pane/assemble-chrome/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from './emulator-pane/EmulatorPaneOverlayLayer'
import StructuredAgentSessionPaneOverlayLayer from './native-chat/StructuredAgentSessionPaneOverlayLayer'
import AiVaultSessionDropLayer from './tab-group/AiVaultSessionDropLayer'
import { EmptyWorkspaceZeroState } from './workspace/EmptyWorkspaceZeroState'
import { useAppStore } from '../store'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  shouldMeasureHiddenWorktree,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    shouldMeasureHiddenWorktree,
    needsBrowserGuestPaint
  })

  const renderableTabCount = useAppStore((state) =>
    worktreeId ? (state.reconcileWorktreeTabModel?.(worktreeId)?.renderableTabCount ?? 0) : 0
  )
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (state) => state.openNewTerminalTabInActiveWorkspace
  )
  const createTab = useAppStore((state) => state.createTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const openModal = useAppStore((state) => state.openModal)
  const defaultTuiAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const knownWorktree = useAppStore((state) =>
    worktreeId ? state.getKnownWorktreeById?.(worktreeId) : undefined
  )
  const repos = useAppStore((state) => state.repos)
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newAgentShortcut = useShortcutKeyDetails('tab.newAgent')
  const openFileShortcut = useShortcutKeyDetails('worktree.quickOpen')

  const workspaceTitle =
    knownWorktree?.displayName ||
    knownWorktree?.branch ||
    worktreePath.split('/').toReversed().find(Boolean) ||
    worktreePath
  const repo = repos?.find((r) => r.id === knownWorktree?.repoId)
  const repoName = repo?.displayName
  const handleNewTerminal = React.useCallback(() => {
    if (!worktreeId) {
      return
    }
    setActiveWorktree?.(worktreeId)
    if (openNewTerminalTabInActiveWorkspace) {
      void openNewTerminalTabInActiveWorkspace(focusedGroupId ?? '')
    } else if (createTab) {
      createTab(worktreeId, focusedGroupId)
    }
  }, [
    createTab,
    focusedGroupId,
    openNewTerminalTabInActiveWorkspace,
    setActiveWorktree,
    worktreeId
  ])

  const handleNewAgent = React.useCallback(() => {
    if (!worktreeId) {
      return
    }
    setActiveWorktree?.(worktreeId)
    const agentToLaunch =
      defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : 'claude'
    launchAgentInNewTab({
      agent: agentToLaunch,
      worktreeId,
      groupId: focusedGroupId
    })
  }, [defaultTuiAgent, focusedGroupId, setActiveWorktree, worktreeId])

  const handleOpenFile = React.useCallback(() => {
    if (worktreeId) {
      setActiveWorktree?.(worktreeId)
    }
    openModal?.('quick-open')
  }, [openModal, setActiveWorktree, worktreeId])
  return (
    <div
      className={
        isVisible
          ? 'absolute inset-0 flex'
          : shouldKeepPaintable
            ? 'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'absolute inset-0 hidden'
      }
      inert={!isVisible}
      aria-hidden={!isVisible}
    >
      {renderableTabCount === 0 ? (
        <EmptyWorkspaceZeroState
          workspaceTitle={workspaceTitle}
          repoName={repoName}
          onNewTerminal={handleNewTerminal}
          onNewAgent={handleNewAgent}
          onOpenFile={handleOpenFile}
          newTerminalShortcut={newTerminalShortcut}
          newAgentShortcut={newAgentShortcut}
          openFileShortcut={openFileShortcut}
        />
      ) : (
        <>
          <TabGroupSplitLayout
            layout={layout}
            worktreeId={worktreeId}
            focusedGroupId={focusedGroupId}
            isWorktreeActive={isVisible}
          />
          <TerminalPaneOverlayLayer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            isWorktreeActive={isVisible}
            coldParkTerminalPanes={shouldColdParkTerminalPanes}
            isForceParked={isForceParked}
            shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
            activityTerminalPortals={activityTerminalPortals}
            backgroundMountTabIds={backgroundMountTabIds}
            activationDeferredMountTabIds={activationDeferredMountTabIds}
          />
          <RetainedBrowserPaneOverlayLayer
            worktreeId={worktreeId}
            isWorktreeActive={isVisible}
            mountEligible={shouldMountRetainedBrowserOverlay({
              isWorktreeVisible: isVisible,
              hasDeferredBackgroundMounts: backgroundMountTabIds !== null,
              needsBrowserGuestPaint
            })}
          />
          {isVisible || backgroundMountTabIds === null ? (
            <EmulatorPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
          ) : null}
          <StructuredAgentSessionPaneOverlayLayer
            worktreeId={worktreeId}
            isWorktreeActive={isVisible}
          />
        </>
      )}
      <AiVaultSessionDropLayer worktreeId={worktreeId} enabled={isVisible} />
    </div>
  )
})
