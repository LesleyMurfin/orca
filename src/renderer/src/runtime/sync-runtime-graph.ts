import { paneLeafId, serializePaneTree } from '@/components/terminal-pane/layout-serialization'
import { warnTerminalLifecycleAnomaly } from '@/components/terminal-pane/terminal-lifecycle-diagnostics'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncWindowGraph
} from '../../../shared/runtime-types'
import { getActiveTabNavOrder } from '../components/tab-bar/group-tab-order'

type RegisteredTerminalTab = {
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getContainer: () => HTMLDivElement | null
  getPtyIdForPane: (paneId: number) => string | null
}

const registeredTabs = new Map<string, RegisteredTerminalTab>()
// Why: track when each tab was registered so we can suppress the "no live
// transport" warning during the initial PTY connection window. The warning
// is noise when it fires on mount (PTY spawn/attach is async and hasn't
// finished yet), but valuable if the transport is still missing after the
// grace period — that indicates a real stuck state.
const tabRegisteredAt = new Map<string, number>()
const NO_TRANSPORT_GRACE_MS = 10_000
let syncScheduled = false
let syncEnabled = false
let getStoreState: (() => AppState) | null = null
let mobileSessionSnapshotVersion = 0

export function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void {
  getStoreState = getter
}

export function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void {
  registeredTabs.set(tab.tabId, tab)
  tabRegisteredAt.set(tab.tabId, Date.now())
  scheduleRuntimeGraphSync()
  return () => {
    registeredTabs.delete(tab.tabId)
    tabRegisteredAt.delete(tab.tabId)
    scheduleRuntimeGraphSync()
  }
}

export function setRuntimeGraphSyncEnabled(enabled: boolean): void {
  syncEnabled = enabled
  if (enabled) {
    scheduleRuntimeGraphSync()
  }
}

export function scheduleRuntimeGraphSync(): void {
  if (!syncEnabled || syncScheduled) {
    return
  }
  syncScheduled = true
  queueMicrotask(() => {
    syncScheduled = false
    void syncRuntimeGraph()
  })
}

async function syncRuntimeGraph(): Promise<void> {
  if (!syncEnabled || !getStoreState) {
    return
  }
  // Why: the runtime graph helper cannot import the Zustand store directly
  // because the terminal slice also imports this module to schedule syncs.
  // Injecting the getter from App keeps the runtime graph path out of the
  // store construction cycle and avoids test-time partial initialization.
  const state = getStoreState()
  const graph: RuntimeSyncWindowGraph = {
    tabs: [],
    leaves: [],
    mobileSessionTabs: buildMobileSessionTabSnapshots(state)
  }

  for (const [tabId, registeredTab] of registeredTabs) {
    const tab = Object.values(state.tabsByWorktree)
      .flat()
      .find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }

    const manager = registeredTab.getManager()
    const container = registeredTab.getContainer()
    const activePaneId = manager?.getActivePane()?.id ?? null
    const root =
      container?.firstElementChild instanceof HTMLElement ? container.firstElementChild : null

    graph.tabs.push({
      tabId,
      worktreeId: registeredTab.worktreeId,
      title: tab.customTitle ?? tab.title,
      activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
      layout: serializePaneTree(root)
    })

    const savedPtyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
    for (const pane of manager?.getPanes() ?? []) {
      const leafId = paneLeafId(pane.id)
      const ptyId = registeredTab.getPtyIdForPane(pane.id)
      const savedPtyId = savedPtyIdsByLeafId[leafId] ?? null
      const registeredTime = tabRegisteredAt.get(tabId) ?? 0
      if (!ptyId && savedPtyId && Date.now() - registeredTime > NO_TRANSPORT_GRACE_MS) {
        warnTerminalLifecycleAnomaly('mounted terminal leaf has saved PTY but no live transport', {
          tabId,
          worktreeId: registeredTab.worktreeId,
          leafId,
          paneId: pane.id,
          ptyId: savedPtyId
        })
      }
      const paneTitles = state.runtimePaneTitlesByTabId[tabId] ?? {}
      graph.leaves.push({
        tabId,
        worktreeId: registeredTab.worktreeId,
        leafId,
        paneRuntimeId: pane.id,
        ptyId,
        paneTitle: paneTitles[pane.id] ?? null,
        title: state.runtimePaneTitlesByTabId[tabId]?.[pane.id] ?? tab.customTitle ?? tab.title
      })
    }
  }

  try {
    await window.api.runtime.syncWindowGraph(graph)
  } catch (error) {
    console.error('[runtime] Failed to sync renderer graph:', error)
  }
}

function buildMobileSessionTabSnapshots(state: AppState): RuntimeMobileSessionTabsSnapshot[] {
  const worktreeIds = new Set<string>([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.groupsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree),
    ...state.openFiles.map((file) => file.worktreeId)
  ])

  const snapshots: RuntimeMobileSessionTabsSnapshot[] = []
  for (const worktreeId of worktreeIds) {
    const activeGroupId = state.activeGroupIdByWorktree[worktreeId] ?? null
    const order = getActiveTabNavOrder(state, worktreeId)
    const tabs: RuntimeMobileSessionSnapshotTab[] = []

    for (const item of order) {
      if (item.type === 'terminal') {
        const terminal = (state.tabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === item.id)
        if (!terminal) {
          continue
        }
        tabs.push({
          type: 'terminal',
          id: terminal.id,
          title: terminal.customTitle ?? terminal.title ?? 'Terminal',
          terminalTabId: terminal.id,
          isActive: item.tabId
            ? state.groupsByWorktree[worktreeId]?.some(
                (group) => group.id === activeGroupId && group.activeTabId === item.tabId
              ) === true
            : state.activeTabId === terminal.id
        })
      } else if (item.type === 'editor') {
        const file = state.openFiles.find(
          (candidate) => candidate.id === item.id && candidate.worktreeId === worktreeId
        )
        const markdown = file ? buildMobileMarkdownTab(state, file.id, item.tabId) : null
        if (markdown) {
          tabs.push(markdown)
        }
      }
    }

    const active = tabs.find((tab) => tab.isActive) ?? null
    snapshots.push({
      worktree: worktreeId,
      snapshotVersion: ++mobileSessionSnapshotVersion,
      activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabs
    })
  }

  return snapshots
}

function buildMobileMarkdownTab(
  state: AppState,
  fileId: string,
  unifiedTabId?: string
): RuntimeMobileSessionMarkdownTab | null {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    return null
  }
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return null
  }
  if (file.language !== 'markdown' && file.mode !== 'markdown-preview') {
    return null
  }

  const sourceFile =
    file.mode === 'markdown-preview' && file.markdownPreviewSourceFileId
      ? (state.openFiles.find((candidate) => candidate.id === file.markdownPreviewSourceFileId) ??
        file)
      : file
  const draftContent = state.editorDrafts[sourceFile.id]
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'Markdown'

  return {
    type: 'markdown',
    id: unifiedTabId ?? file.id,
    title,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: 'markdown',
    mode: file.mode,
    isDirty: file.isDirty || sourceFile.isDirty,
    isActive: unifiedTabId
      ? state.groupsByWorktree[file.worktreeId]?.some(
          (group) => group.activeTabId === unifiedTabId
        ) === true
      : state.activeFileId === file.id,
    sourceFileId: sourceFile.id,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    documentVersion: draftContent !== undefined ? hashString(draftContent) : `file:${sourceFile.id}`
  }
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `draft:${value.length}:${(hash >>> 0).toString(16)}`
}
