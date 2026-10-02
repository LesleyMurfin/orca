// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'

type MockStore = {
  renderableTabCount: number
  openNewTerminalTabInActiveWorkspace: Mock
  createTab: Mock
  setActiveWorktree: Mock
  openModal: Mock
  launchAgentInNewTab: Mock
  defaultTuiAgent: string | null
  getKnownWorktreeById: Mock
  repos: { id: string; displayName: string }[]
}

const mockStore: MockStore = vi.hoisted(() => ({
  renderableTabCount: 0,
  openNewTerminalTabInActiveWorkspace: vi.fn(),
  createTab: vi.fn(),
  setActiveWorktree: vi.fn(),
  openModal: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  defaultTuiAgent: 'codex',
  getKnownWorktreeById: vi.fn(() => ({
    id: 'wt-empty',
    displayName: 'feature/empty-state',
    repoId: 'repo-1'
  })),
  repos: [{ id: 'repo-1', displayName: 'my-org/my-project' }]
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      reconcileWorktreeTabModel: () => ({
        renderableTabCount: mockStore.renderableTabCount,
        activeRenderableTabId: null
      }),
      openNewTerminalTabInActiveWorkspace: mockStore.openNewTerminalTabInActiveWorkspace,
      createTab: mockStore.createTab,
      setActiveWorktree: mockStore.setActiveWorktree,
      openModal: mockStore.openModal,
      settings: { defaultTuiAgent: mockStore.defaultTuiAgent },
      getKnownWorktreeById: mockStore.getKnownWorktreeById,
      repos: mockStore.repos
    }
    return selector(state)
  }
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: (args: unknown) => mockStore.launchAgentInNewTab(args)
}))

vi.mock('./tab-group/TabGroupSplitLayout', () => ({
  default: () => <div data-testid="tab-group-split-layout">TabGroupSplitLayout</div>
}))

vi.mock('./terminal-pane/TerminalPaneOverlayLayer', () => ({
  default: () => null
}))

vi.mock('./browser-pane/assemble-chrome/BrowserPaneOverlayLayer', () => ({
  RetainedBrowserPaneOverlayLayer: () => null
}))

vi.mock('./emulator-pane/EmulatorPaneOverlayLayer', () => ({
  default: () => null
}))

vi.mock('./native-chat/StructuredAgentSessionPaneOverlayLayer', () => ({
  default: () => null
}))

vi.mock('./tab-group/AiVaultSessionDropLayer', () => ({
  default: () => null
}))

vi.mock('./browser-pane/host-guest/browser-guest-paint-retention', () => ({
  useBrowserGuestPaintRetention: () => false,
  useWorktreeBrowserPageIds: () => []
}))

vi.mock('./browser-pane/host-guest/browser-worktree-surface-paintability', () => ({
  shouldKeepHiddenWorktreeSurfacePaintable: () => false,
  shouldMountRetainedBrowserOverlay: () => false
}))

describe('TerminalWorktreeSplitSurface with EmptyWorkspaceZeroState', () => {
  let container: HTMLDivElement
  let root: Root
  const defaultLayout: TabGroupLayoutNode = { type: 'leaf', groupId: 'group-1' }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockStore.renderableTabCount = 0
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('mounts EmptyWorkspaceZeroState when renderableTabCount === 0', async () => {
    mockStore.renderableTabCount = 0

    await act(async () => {
      root.render(
        <WorktreeSplitSurface
          worktreeId="wt-empty"
          worktreePath="/data/projects/my-project"
          layout={defaultLayout}
          isVisible={true}
          shouldMeasureHiddenWorktree={false}
          shouldColdParkTerminalPanes={false}
          isForceParked={false}
          activityTerminalPortals={[]}
          backgroundMountTabIds={null}
          activationDeferredMountTabIds={null}
        />
      )
    })

    expect(container.querySelector('[data-empty-workspace-zero-state]')).not.toBeNull()
    expect(container.textContent).toContain('feature/empty-state')
    expect(container.textContent).toContain('my-org/my-project')
    expect(container.querySelector('[data-testid="tab-group-split-layout"]')).toBeNull()
  })

  it('triggers onNewTerminal when clicking New Terminal in empty state', async () => {
    mockStore.renderableTabCount = 0

    await act(async () => {
      root.render(
        <WorktreeSplitSurface
          worktreeId="wt-empty"
          worktreePath="/data/projects/my-project"
          layout={defaultLayout}
          isVisible={true}
          shouldMeasureHiddenWorktree={false}
          shouldColdParkTerminalPanes={false}
          isForceParked={false}
          activityTerminalPortals={[]}
          backgroundMountTabIds={null}
          activationDeferredMountTabIds={null}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const terminalButton = buttons.find((b) => b.textContent?.includes('New Terminal'))
    expect(terminalButton).toBeDefined()

    await act(async () => {
      terminalButton?.click()
    })

    expect(mockStore.openNewTerminalTabInActiveWorkspace).toHaveBeenCalledTimes(1)
  })

  it('triggers onNewAgent when clicking New Agent in empty state', async () => {
    mockStore.renderableTabCount = 0

    await act(async () => {
      root.render(
        <WorktreeSplitSurface
          worktreeId="wt-empty"
          worktreePath="/data/projects/my-project"
          layout={defaultLayout}
          isVisible={true}
          shouldMeasureHiddenWorktree={false}
          shouldColdParkTerminalPanes={false}
          isForceParked={false}
          activityTerminalPortals={[]}
          backgroundMountTabIds={null}
          activationDeferredMountTabIds={null}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const agentButton = buttons.find((b) => b.textContent?.includes('New Agent'))
    expect(agentButton).toBeDefined()

    await act(async () => {
      agentButton?.click()
    })

    expect(mockStore.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'wt-empty'
      })
    )
  })

  it('triggers onOpenFile when clicking Open File in empty state', async () => {
    mockStore.renderableTabCount = 0

    await act(async () => {
      root.render(
        <WorktreeSplitSurface
          worktreeId="wt-empty"
          worktreePath="/data/projects/my-project"
          layout={defaultLayout}
          isVisible={true}
          shouldMeasureHiddenWorktree={false}
          shouldColdParkTerminalPanes={false}
          isForceParked={false}
          activityTerminalPortals={[]}
          backgroundMountTabIds={null}
          activationDeferredMountTabIds={null}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const fileButton = buttons.find((b) => b.textContent?.includes('Open File'))
    expect(fileButton).toBeDefined()

    await act(async () => {
      fileButton?.click()
    })

    expect(mockStore.openModal).toHaveBeenCalledWith('quick-open')
  })

  it('mounts TabGroupSplitLayout when renderableTabCount > 0', async () => {
    mockStore.renderableTabCount = 1

    await act(async () => {
      root.render(
        <WorktreeSplitSurface
          worktreeId="wt-empty"
          worktreePath="/data/projects/my-project"
          layout={defaultLayout}
          isVisible={true}
          shouldMeasureHiddenWorktree={false}
          shouldColdParkTerminalPanes={false}
          isForceParked={false}
          activityTerminalPortals={[]}
          backgroundMountTabIds={null}
          activationDeferredMountTabIds={null}
        />
      )
    })

    expect(container.querySelector('[data-empty-workspace-zero-state]')).toBeNull()
    expect(container.querySelector('[data-testid="tab-group-split-layout"]')).not.toBeNull()
  })
})
