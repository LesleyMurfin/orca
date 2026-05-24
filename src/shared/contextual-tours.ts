export type ContextualTourId =
  | 'right-sidebar'
  | 'workspace-board'
  | 'browser'
  | 'tasks'
  | 'automations'
  | 'workspace-creation'

export type ContextualTourStep = {
  title: string
  body: string
  targetSelector: string
  requiredForStart?: boolean
  fallbackCopy?: string
}

export type ContextualTour = {
  id: ContextualTourId
  allowedActiveModals?: readonly string[]
  steps: readonly ContextualTourStep[]
}

export const CONTEXTUAL_TOURS = [
  {
    id: 'right-sidebar',
    steps: [
      {
        title: 'Use the sidebar for workspace context',
        body: 'Open files, search, source control, checks, and SSH ports without leaving the workspace.',
        targetSelector: '[data-contextual-tour-target="right-sidebar-shell"]',
        requiredForStart: true
      },
      {
        title: 'Switch tools from the activity buttons',
        body: 'Pick the tool you need; Orca only shows buttons that apply to the current project.',
        targetSelector: '[data-contextual-tour-target="right-sidebar-activity"]'
      },
      {
        title: 'Keep the panel sized for the job',
        body: 'Use the toggle or resize edge to make room while keeping the current tool ready.',
        targetSelector: '[data-contextual-tour-target="right-sidebar-panel"]'
      }
    ]
  },
  {
    id: 'workspace-board',
    steps: [
      {
        title: 'Plan work on the board',
        body: 'Use the board when you want to see workspaces by status instead of by project.',
        targetSelector: '[data-contextual-tour-target="workspace-board-surface"]',
        requiredForStart: true
      },
      {
        title: 'Move work through lanes',
        body: 'Statuses make active, reviewing, and finished work easy to scan.',
        targetSelector: '[data-contextual-tour-target="workspace-board-lanes"]'
      },
      {
        title: 'Drag cards and tune density',
        body: 'Drop cards into lanes, resize columns, or switch compact mode from the board controls.',
        targetSelector: '[data-contextual-tour-target="workspace-board-cards"]'
      }
    ]
  },
  {
    id: 'browser',
    steps: [
      {
        title: 'Preview the app here',
        body: 'Use the address bar for localhost, URLs, or search while you keep coding nearby.',
        targetSelector:
          '[data-contextual-tour-target="browser-address"], [data-orca-browser-address-bar="true"]',
        requiredForStart: true
      },
      {
        title: 'Grab page context for agents',
        body: 'On supported local pages, grab controls can copy elements or hand page context to an agent.',
        targetSelector: '[data-contextual-tour-target="browser-grab-control"]'
      },
      {
        title: 'Mark design feedback in place',
        body: 'On supported local pages, annotate elements and send those notes to an agent.',
        targetSelector: '[data-contextual-tour-target="browser-annotation-control"]'
      }
    ]
  },
  {
    id: 'tasks',
    steps: [
      {
        title: 'Choose the work source',
        body: 'Switch between connected providers and project filters without changing pages.',
        targetSelector: '[data-contextual-tour-target="tasks-source-filters"]',
        requiredForStart: true
      },
      {
        title: 'Filter to the work you need',
        body: 'Use presets and search to narrow issues, reviews, merge requests, or tasks.',
        targetSelector: '[data-contextual-tour-target="tasks-search-presets"]'
      },
      {
        title: 'Start from tracked work',
        body: 'Open an item or create one, then use it to start a workspace with the right context.',
        targetSelector:
          '[data-contextual-tour-target="tasks-actions"], [data-contextual-tour-target="tasks-search-presets"]'
      }
    ]
  },
  {
    id: 'automations',
    steps: [
      {
        title: 'Review recurring work',
        body: 'The list shows scheduled agent work, next runs, and external automation sources.',
        targetSelector: '[data-contextual-tour-target="automations-list"]',
        requiredForStart: true
      },
      {
        title: 'Create a schedule',
        body: 'Add an automation for recurring checks, maintenance, or follow-up agent work.',
        targetSelector: '[data-contextual-tour-target="automations-create"]'
      },
      {
        title: 'Run and inspect results',
        body: 'Use overview and runs to trigger work manually and review what happened.',
        targetSelector: '[data-contextual-tour-target="automations-runs"]'
      }
    ]
  },
  {
    id: 'workspace-creation',
    allowedActiveModals: ['new-workspace-composer', 'add-repo'],
    steps: [
      {
        title: 'Confirm the project source',
        body: 'Choose or confirm the folder, clone, remote project, or existing project before creating work.',
        targetSelector: '[data-contextual-tour-target="workspace-creation-source"]',
        requiredForStart: true
      },
      {
        title: 'Review advanced options',
        body: 'Use Advanced or setup-step options for scripts, existing worktrees, notes, or workspace details.',
        targetSelector: '[data-contextual-tour-target="workspace-creation-setup"]'
      },
      {
        title: 'Create when the inputs are ready',
        body: 'Start the workspace after the project, name, agent, and setup choices look right.',
        targetSelector: '[data-contextual-tour-target="workspace-creation-action"]'
      }
    ]
  }
] as const satisfies readonly ContextualTour[]

export const CONTEXTUAL_TOUR_IDS = CONTEXTUAL_TOURS.map((tour) => tour.id)

export function isContextualTourId(value: unknown): value is ContextualTourId {
  return typeof value === 'string' && CONTEXTUAL_TOUR_IDS.includes(value as ContextualTourId)
}

export function getContextualTour(id: ContextualTourId): ContextualTour {
  return CONTEXTUAL_TOURS.find((tour) => tour.id === id)!
}

export function normalizeContextualTourIds(value: unknown): ContextualTourId[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<ContextualTourId>()
  for (const item of value) {
    if (isContextualTourId(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}
