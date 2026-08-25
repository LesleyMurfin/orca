import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import {
  hasPendingTerminalWorktreeOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import {
  activateTerminalInitiatedWorktree,
  focusTerminalInitiatedTab,
  resolveTerminalPresentation
} from './terminal-command-state'

/**
 * A paired runtime's projects are never persisted client-side: they arrive live, so at app start,
 * on reconnect, and right after a runtime drop every one of its worktree ids is briefly unknown to
 * this store. Bound the wait so a genuinely unknown id still reports the ordinary unresolved-owner
 * error instead of leaving the request hanging.
 */
const PENDING_TERMINAL_OWNER_HYDRATION_TIMEOUT_MS = 10_000

function waitForTerminalOwnerHydration(worktreeId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
    const timer = setTimeout(finish, PENDING_TERMINAL_OWNER_HYDRATION_TIMEOUT_MS)
    unsubscribe = useAppStore.subscribe(() => {
      if (!hasPendingTerminalWorktreeOwner(useAppStore.getState(), worktreeId)) {
        finish()
      }
    })
    // Why: the catalog can land between the pending verdict and this subscription.
    if (!hasPendingTerminalWorktreeOwner(useAppStore.getState(), worktreeId)) {
      finish()
    }
  })
}

export function registerTerminalRequestIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    // Why: only the pending-owner branch below awaits; every other verdict still replies
    // synchronously, so a create request is never deferred by a decision this renderer can make now.
    window.api.ui.onRequestTerminalCreate(async (data) => {
      try {
        let store = useAppStore.getState()
        const worktreeId = data.worktreeId ?? store.activeWorktreeId
        if (!worktreeId) {
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            error: translate('auto.hooks.useIpcEvents.f000b2ff76', 'No active worktree')
          })
          return
        }
        let worktreeRoute = resolveTerminalWorktreeRoute(store, worktreeId)
        if (!worktreeRoute && hasPendingTerminalWorktreeOwner(store, worktreeId)) {
          // Why: the owner is not unknown, it has not arrived yet — a workspace resumed from
          // history or the AI Vault hits this on every cold start of a paired client.
          await waitForTerminalOwnerHydration(worktreeId)
          store = useAppStore.getState()
          worktreeRoute = resolveTerminalWorktreeRoute(store, worktreeId)
        }
        if (!worktreeRoute) {
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.unresolvedTerminalWorktreeOwner',
              'Terminal creation is unavailable because the worktree owner could not be resolved'
            )
          })
          return
        }
        // Why: runtime-session requests are host-owned tabs materialized by this renderer, not ordinary local creates.
        if (worktreeRoute.runtimeEnvironmentId && data.source !== 'runtime-session') {
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.7a64b31991',
              'Local terminal creation is unavailable while a remote runtime is active'
            )
          })
          return
        }
        const terminalPresentation = resolveTerminalPresentation(data)
        const shouldActivate = terminalPresentation === 'focused'
        const shouldSurfaceOwner =
          terminalPresentation !== 'background' && data.surfaceOwner !== false
        if (shouldActivate) {
          activateTerminalInitiatedWorktree(store, worktreeId)
        }
        // Why: the paired launch client already resolved the mode, so its choice wins over the host renderer's local default.
        const tabOptions = data.launchAgent
          ? {
              ...(shouldActivate ? {} : { activate: false, recordInteraction: false }),
              launchAgent: data.launchAgent,
              ...(data.viewMode
                ? { viewMode: data.viewMode }
                : initialAgentTabViewModeProps(store.settings, {
                    agent: data.launchAgent,
                    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
                      getConnectionIdFromState(store, worktreeId)
                    )
                  })),
              ...(data.cwd ? { startupCwd: data.cwd } : {})
            }
          : shouldActivate
            ? data.cwd
              ? { startupCwd: data.cwd }
              : undefined
            : {
                activate: false,
                recordInteraction: false,
                ...(data.cwd ? { startupCwd: data.cwd } : {})
              }
        const tab = store.createTab(worktreeId, data.targetGroupId, undefined, tabOptions)
        if (!shouldActivate) {
          // Why: renderer-backed Codex startup must mount its new TerminalPane without switching UI or connecting every saved tab.
          requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })
        }
        if (data.afterTabId) {
          const createdUnifiedTab = useAppStore
            .getState()
            .unifiedTabsByWorktree[worktreeId]?.find((item) => item.entityId === tab.id)
          const anchorUnifiedTab = useAppStore
            .getState()
            .unifiedTabsByWorktree[worktreeId]?.find((item) => item.id === data.afterTabId)
          if (
            createdUnifiedTab &&
            anchorUnifiedTab &&
            createdUnifiedTab.groupId === anchorUnifiedTab.groupId
          ) {
            const group = useAppStore
              .getState()
              .groupsByWorktree[worktreeId]?.find((item) => item.id === createdUnifiedTab.groupId)
            const order = (group?.tabOrder ?? []).filter((id) => id !== createdUnifiedTab.id)
            const anchorIndex = order.indexOf(anchorUnifiedTab.id)
            order.splice(
              anchorIndex === -1 ? order.length : anchorIndex + 1,
              0,
              createdUnifiedTab.id
            )
            useAppStore.getState().reorderUnifiedTabs(createdUnifiedTab.groupId, order, {
              recordInteraction: false
            })
          }
        }
        if (shouldActivate) {
          store.setActiveTabType('terminal')
          store.setActiveTab(tab.id)
        }
        if (shouldSurfaceOwner) {
          store.revealWorktreeInSidebar(worktreeId)
          focusTerminalInitiatedTab(tab.id)
        }
        if (data.title) {
          store.setTabCustomTitle(tab.id, data.title, { recordInteraction: false })
        }
        if (data.command) {
          store.queueTabStartupCommand(tab.id, {
            command: data.command,
            ...(data.env ? { env: data.env } : {}),
            ...(data.envToDelete ? { envToDelete: data.envToDelete } : {}),
            ...(data.launchConfig ? { launchConfig: data.launchConfig } : {}),
            ...(data.resumeProviderSession
              ? { resumeProviderSession: data.resumeProviderSession }
              : {}),
            ...(data.launchToken ? { launchToken: data.launchToken } : {}),
            ...(data.launchAgent ? { launchAgent: data.launchAgent } : {}),
            ...(data.startupCommandDelivery
              ? { startupCommandDelivery: data.startupCommandDelivery }
              : {})
          })
        }
        window.api.ui.replyTerminalCreate({
          requestId: data.requestId,
          tabId: tab.id,
          title: data.title ?? tab.title
        })
      } catch (err) {
        window.api.ui.replyTerminalCreate({
          requestId: data.requestId,
          error: err instanceof Error ? err.message : 'Terminal creation failed'
        })
      }
    })
  )
}
