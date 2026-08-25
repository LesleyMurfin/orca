import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTerminalRequestIpcBridge } from './terminal-request-ipc-bridge'

/**
 * Symptom A: resuming a session from Agent Session History on a paired client replied
 * "Terminal creation is unavailable because the worktree owner could not be resolved". The
 * runtime's projects are never persisted client-side, so for a moment after launch/reconnect
 * every one of its worktree ids is unknown to this store. The bridge now waits for that catalog
 * — bounded — instead of turning a not-yet-known owner into a hard failure.
 */
const PENDING_WORKTREE_ID = 'repo-remote::/w'
const UNRESOLVED_OWNER_ERROR =
  'Terminal creation is unavailable because the worktree owner could not be resolved'

type MutableState = Record<string, unknown>

const createTab = vi.fn(() => ({ id: 'tab-new', title: 'Terminal' }))
const replyTerminalCreate = vi.fn()
const listeners = new Set<() => void>()
let state: MutableState

function hydratingRuntimeState(): MutableState {
  return {
    activeWorktreeId: null,
    repos: [{ id: 'repo-local', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [{ id: 'hub-a' }],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    // No status entry yet: the boot probe has not answered, so the host is "checking" — reachable
    // enough that its rows are still owed to this store.
    runtimeStatusByEnvironmentId: new Map(),
    startupWorktreeRefreshCompleted: true,
    settings: {},
    createTab,
    setActiveTabType: vi.fn(),
    setActiveTab: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    unifiedTabsByWorktree: {},
    groupsByWorktree: {}
  }
}

/** The paired runtime publishes the project that owns PENDING_WORKTREE_ID. */
function publishRuntimeRows(): void {
  state.repos = [
    ...(state.repos as unknown[]),
    { id: 'repo-remote', connectionId: null, executionHostId: 'runtime:hub-a' }
  ]
  state.worktreesByRepo = {
    'repo-remote': [
      { id: PENDING_WORKTREE_ID, repoId: 'repo-remote', hostId: 'runtime:hub-a' }
    ]
  }
  for (const listener of listeners) {
    listener()
  }
}

vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-initial-view-mode', () => ({
  initialAgentTabViewModeProps: () => ({})
}))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./terminal-command-state', () => ({
  activateTerminalInitiatedWorktree: vi.fn(),
  focusTerminalInitiatedTab: vi.fn(),
  resolveTerminalPresentation: () => 'focused'
}))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))

function registerBridge(): (data: Record<string, unknown>) => void {
  let requested: ((data: Record<string, unknown>) => void) | null = null
  vi.stubGlobal('window', {
    api: {
      ui: {
        onRequestTerminalCreate: (listener: (data: Record<string, unknown>) => void) => {
          requested = listener
          return () => {}
        },
        replyTerminalCreate
      }
    }
  })
  registerTerminalRequestIpcBridge([])
  if (typeof requested !== 'function') {
    throw new Error('Expected the request-terminal-create listener to be registered')
  }
  return requested
}

beforeEach(() => {
  state = hydratingRuntimeState()
  listeners.clear()
  createTab.mockClear()
  replyTerminalCreate.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('terminal create with a pending worktree owner', () => {
  it('waits for the owning host catalog and then creates the terminal', async () => {
    const requestTerminalCreate = registerBridge()

    requestTerminalCreate({
      requestId: 'req-pending',
      worktreeId: PENDING_WORKTREE_ID,
      source: 'runtime-session'
    })
    // The owner is not unknown, it has not arrived — nothing is answered yet.
    expect(replyTerminalCreate).not.toHaveBeenCalled()

    publishRuntimeRows()
    await vi.waitFor(() => expect(replyTerminalCreate).toHaveBeenCalled())

    expect(createTab).toHaveBeenCalledWith(PENDING_WORKTREE_ID, undefined, undefined, undefined)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-pending',
      tabId: 'tab-new',
      title: 'Terminal'
    })
  })

  it('reports the unresolved owner unchanged when the catalog never arrives', async () => {
    vi.useFakeTimers()
    const requestTerminalCreate = registerBridge()

    requestTerminalCreate({
      requestId: 'req-timeout',
      worktreeId: PENDING_WORKTREE_ID,
      source: 'runtime-session'
    })
    expect(replyTerminalCreate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-timeout',
      error: UNRESOLVED_OWNER_ERROR
    })
  })

  it('still fails an unknown owner closed once its runtime has published rows', async () => {
    const requestTerminalCreate = registerBridge()
    publishRuntimeRows()

    requestTerminalCreate({
      requestId: 'req-unknown',
      worktreeId: 'repo-gone::/w',
      source: 'runtime-session'
    })

    // No wait, no retry: after hydration an unknown id is known-absent.
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-unknown',
      error: UNRESOLVED_OWNER_ERROR
    })
  })
})
