import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type { RemoteRuntimeTerminalHandleResolution } from './remote-runtime-terminal-recovery-coordinator'

export function resolveRemoteRuntimeHostTerminal(
  snapshot: RuntimeMobileSessionTabsResult,
  args: { hostTabId: string; leafId?: string | null }
): RemoteRuntimeTerminalHandleResolution {
  const surfaces = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalClientTab =>
      tab.type === 'terminal' &&
      (tab.parentTabId === args.hostTabId || tab.id === args.hostTabId) &&
      (!args.leafId || tab.leafId === args.leafId)
  )
  const ready = args.leafId
    ? surfaces.find((tab) => tab.status === 'ready' && tab.terminal)
    : (surfaces.find((tab) => tab.status === 'ready' && tab.terminal && tab.isActive) ??
      surfaces.find((tab) => tab.status === 'ready' && tab.terminal))
  if (ready?.terminal) {
    return { kind: 'ready', handle: ready.terminal }
  }
  return surfaces.length > 0 ? { kind: 'pending' } : { kind: 'gone' }
}
