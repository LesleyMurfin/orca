import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import type WorktreeCardComponent from './WorktreeCard'
import { branchDisplayName, shouldShowWorktreeBranchLabel } from './WorktreeCardHelpers'
import type * as WorkspaceDeleteQuickAction from './workspace-delete-quick-action'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const recordFeatureInteraction = vi.fn()
const setWorkspacePortScan = vi.fn()
const setWorkspacePortScanRefreshing = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'unread']
let tabsByWorktree: Record<string, { id: string }[]> = {}
let ptyIdsByTabId: Record<string, string[]> = {}
let browserTabsByWorktree: Record<string, { id: string }[]> = {}
let settings: Partial<GlobalSettings> | null = null
let workspacePortScan: WorkspacePortScanResult | null = null
let workspaceDeleteModifierPressed = false
let WorktreeCard: typeof WorktreeCardComponent

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      openModal,
      recordFeatureInteraction,
      remoteBranchConflictByWorktreeId: {},
      settings,
      setWorkspacePortScan,
      setWorkspacePortScanRefreshing,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      workspacePortScan: workspacePortScan ? { key: 'test-scan', result: workspacePortScan } : null,
      browserTabsByWorktree,
      ptyIdsByTabId,
      tabsByWorktree,
      updateWorktreeMeta,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

vi.mock('./workspace-delete-quick-action', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceDeleteQuickAction>()
  return {
    ...actual,
    useWorkspaceDeleteModifierPressed: () => workspaceDeleteModifierPressed
  }
})

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/quick-action',
    repoId: 'repo-1',
    path: '/repo/worktrees/quick-action',
    displayName: 'Quick action',
    branch: 'quick-action',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: true,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('worktree branch label helpers', () => {
  it('normalizes full refs/heads branch labels for display', () => {
    expect(branchDisplayName('refs/heads/feature/hide-branch')).toBe('feature/hide-branch')
    expect(branchDisplayName('refs/heads/')).toBe('')
  })

  it('hides blank and trim-only duplicate branch labels', () => {
    expect(shouldShowWorktreeBranchLabel('', 'workspace')).toBe(false)
    expect(shouldShowWorktreeBranchLabel('   ', 'workspace')).toBe(false)
    expect(shouldShowWorktreeBranchLabel('quick-action', ' quick-action ')).toBe(false)
  })

  it('shows case-only differences and custom workspace titles', () => {
    expect(shouldShowWorktreeBranchLabel('quick-action', 'Quick-action')).toBe(true)
    expect(shouldShowWorktreeBranchLabel('quick-action', 'Custom workspace')).toBe(true)
  })
})

describe('WorktreeCard quick actions', () => {
  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'unread']
    tabsByWorktree = {}
    ptyIdsByTabId = {}
    browserTabsByWorktree = {}
    settings = null
    workspacePortScan = null
    workspaceDeleteModifierPressed = false
  })

  it('marks the unread toggle as a workspace-board-preserving action', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('data-workspace-board-preserve-open=""')
  })

  it('hides the repeated branch row by default when it repeats the workspace title', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'quick-action', branch: 'refs/heads/quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('quick-action')
    expect(markup).not.toContain('text-[11px] text-muted-foreground truncate leading-none')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('tabindex="0"')
  })

  it('hides the repeated branch row when the title only differs by whitespace', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: ' quick-action ', branch: 'quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('tabindex="0"')
  })

  it('does not render an empty branch metadata row', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'detached workspace', branch: 'refs/heads/' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('detached workspace')
    expect(markup).not.toContain('text-[11px] text-muted-foreground truncate leading-none')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  })

  it('keeps the folder badge instead of branch text for folder repositories', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'folder workspace', branch: 'folder workspace' })}
        repo={{ ...makeRepo(), kind: 'folder' }}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('Folder')
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).not.toContain('text-[11px] text-muted-foreground truncate leading-none')
  })

  it('keeps the branch row when the workspace has a custom title', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Custom workspace', branch: 'quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('Custom workspace')
    expect(markup).toContain('quick-action')
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('text-[11px] text-muted-foreground truncate leading-none')
  })

  it('keeps the branch row when case differs from the workspace title', () => {
    worktreeCardProperties = []

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'Quick-action', branch: 'quick-action' })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('Quick-action')
    expect(markup).toContain('quick-action')
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('text-[11px] text-muted-foreground truncate leading-none')
  })

  it('uses the pre-compact unread lane and primary badge when compact cards are disabled', () => {
    worktreeCardProperties = ['status', 'unread']

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'main',
          branch: 'main',
          isMainWorktree: true
        })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('primary')
    expect(markup).not.toContain('aria-label="Primary worktree"')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  })

  it('keeps the non-compact metadata row for details after hiding a duplicate branch', () => {
    worktreeCardProperties = ['comment']

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'quick-action',
          branch: 'quick-action',
          comment: 'Needs follow-up'
        })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('aria-label="Workspace metadata"')
    expect(markup).not.toContain('text-[11px] text-muted-foreground truncate leading-none')
  })

  it('keeps the non-compact metadata row for ports after hiding a duplicate branch', () => {
    worktreeCardProperties = ['ports']
    const worktree = makeWorktree({ displayName: 'quick-action', branch: 'quick-action' })
    workspacePortScan = {
      platform: 'unknown',
      scannedAt: 1,
      ports: [
        {
          id: 'port-1',
          kind: 'workspace',
          bindHost: '127.0.0.1',
          connectHost: '127.0.0.1',
          port: 5173,
          pid: 1234,
          processName: 'vite',
          protocol: 'http',
          owner: {
            worktreeId: worktree.id,
            repoId: worktree.repoId,
            displayName: worktree.displayName,
            path: worktree.path,
            confidence: 'cwd'
          }
        }
      ]
    }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} hideRepoBadge />
    )

    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('aria-label="1 live port"')
    expect(markup).not.toContain('text-[11px] text-muted-foreground truncate leading-none')
  })

  it('moves unread and primary into the title row when compact cards are enabled', () => {
    worktreeCardProperties = ['status', 'unread']
    settings = { experimentalCompactWorktreeCards: true }

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'main',
          branch: 'main',
          isMainWorktree: true
        })}
        repo={makeRepo()}
        isActive={false}
        hideRepoBadge
      />
    )

    expect(markup).toContain('aria-label="Primary worktree"')
    expect(markup).not.toContain('>primary<')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  })

  it('hides delete by default for an inactive workspace', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('shows delete as the top-right quick action while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('shows delete as the quick action for folder workspace instances while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          id: 'repo-1::/repo::workspace:123e4567-e89b-12d3-a456-426614174000',
          path: '/repo',
          isMainWorktree: false
        })}
        repo={{ ...makeRepo(), kind: 'folder' }}
        isActive={false}
      />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('shows delete for a current workspace while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true
    const worktree = makeWorktree()

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive isCurrentWorktree />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('does not show delete for the main worktree while Option/Alt is held', () => {
    workspaceDeleteModifierPressed = true

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ isMainWorktree: true })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not replace sleep with delete for a workspace with live activity', () => {
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('aria-label="Sleep workspace"')
    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show sleep as the top-right quick action for an active workspace', () => {
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive />
    )

    expect(markup).not.toContain('aria-label="Sleep workspace"')
    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show delete when the workspace is current but not selected in the sidebar', () => {
    const worktree = makeWorktree()

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} isCurrentWorktree />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })
})
