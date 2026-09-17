import { withSpan } from '../../../observability/tracer'
import { SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { defineMethod, type RpcAnyMethod } from '../core'
import { CloseLifecycleTab, CloseTab } from './session-tabs-schemas'

const ABSENT_SESSION_TAB_ERROR_CODES: Record<string, true> = {
  selector_not_found: true,
  tab_not_found: true,
  terminal_tab_not_found: true
}

function isSessionTabNotFoundError(error: unknown): boolean {
  if (typeof error === 'string') {
    return ABSENT_SESSION_TAB_ERROR_CODES[error] === true
  }
  if (!error || typeof error !== 'object') {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message =
    error instanceof Error
      ? error.message
      : 'message' in error && typeof error.message === 'string'
        ? error.message
        : undefined
  return (
    (code !== undefined && ABSENT_SESSION_TAB_ERROR_CODES[code] === true) ||
    (message !== undefined && ABSENT_SESSION_TAB_ERROR_CODES[message] === true)
  )
}
export const SESSION_TAB_CLOSE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.close',
    params: CloseTab,
    handler: async (params, context) => {
      const requiresIntent =
        context.clientKind === undefined ||
        (context.clientKind === 'runtime' &&
          context.clientCapabilities?.includes(SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY) ===
            true)
      return withSpan(
        'runtime.session-tabs.close',
        async (span) => {
          // Why: old runtime clicks and cleanup are wire-identical, so changing their behavior would regress mixed-version pairings.
          if (!params.reason && requiresIntent) {
            const result = await context.runtime.refuseUnattributedMobileSessionTabClose(
              params.worktree,
              params.tabId
            )
            span.setAttribute('decision', `refused-${result.refusalReason ?? 'missing-intent'}`)
            return result
          }
          let result
          try {
            result = await context.runtime.closeMobileSessionTab(
              params.worktree,
              params.tabId,
              {
                reason: 'user',
                ...(context.pairedDeviceId ? { clientNavigationId: context.pairedDeviceId } : {})
              }
            )
          } catch (error) {
            // Why: closing an already absent tab or worktree is an idempotent success (#21189).
            if (isSessionTabNotFoundError(error)) {
              span.setAttribute('decision', 'allowed-already-absent')
              return { closed: true, notFound: true }
            }
            throw error
          }
          span.setAttribute(
            'decision',
            result.refused ? `refused-${result.refusalReason ?? 'unknown'}` : 'allowed'
          )
          return result
        },
        {
          kind: 'client',
          attributes: {
            attribution: 'session-tab-close',
            runtimeId: context.runtime.getRuntimeId(),
            origin: context.clientKind ?? 'in-process',
            deviceId: context.pairedDeviceId ?? 'in-process',
            worktree: params.worktree,
            tabId: params.tabId,
            closeReason:
              params.reason ??
              (requiresIntent
                ? 'missing'
                : context.clientKind === 'mobile'
                  ? 'legacy-mobile-user'
                  : 'legacy-runtime-user'),
            connectionGeneration: context.connectionId ?? 'in-process',
            requestId: context.requestId ?? 'in-process'
          }
        }
      )
    }
  }),
  defineMethod({
    name: 'session.tabs.closeLifecycle',
    params: CloseLifecycleTab,
    handler: async (params, context) =>
      withSpan(
        'runtime.session-tabs.close-lifecycle',
        async (span) => {
          let result
          try {
            result = await context.runtime.closeMobileSessionTab(
              params.worktree,
              params.tabId,
              {
                reason: params.reason,
                expectedPublicationEpoch: params.publicationEpoch,
                expectedTerminalHandle: params.terminal,
                ...(context.pairedDeviceId ? { clientNavigationId: context.pairedDeviceId } : {})
              }
            )
          } catch (error) {
            // Why: closing an already absent tab or worktree is an idempotent success (#21189).
            if (isSessionTabNotFoundError(error)) {
              span.setAttribute('decision', 'allowed-already-absent')
              return { closed: true, notFound: true }
            }
            throw error
          }
          span.setAttribute(
            'decision',
            result.refused ? `refused-${result.refusalReason ?? 'unknown'}` : 'allowed'
          )
          return result
        },
        {
          kind: 'client',
          attributes: {
            attribution: 'session-tab-lifecycle-close',
            runtimeId: context.runtime.getRuntimeId(),
            origin: context.clientKind ?? 'in-process',
            deviceId: context.pairedDeviceId ?? 'in-process',
            worktree: params.worktree,
            tabId: params.tabId,
            terminal: params.terminal,
            closeReason: params.reason,
            connectionGeneration: context.connectionId ?? 'in-process',
            requestId: context.requestId ?? 'in-process',
            publicationEpoch: params.publicationEpoch
          }
        }
      )
  })
]
