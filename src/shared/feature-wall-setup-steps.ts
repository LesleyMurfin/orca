export type FeatureWallSetupStepId =
  | 'default-agent'
  | 'add-two-repos'
  | 'notifications'
  | 'two-agents'
  | 'three-workspaces'
  | 'task-sources'
  | 'agent-capabilities'
  | 'setup-script'
  | 'browser-element'
  | 'review-notes'
  | 'automation'
  | 'mobile'
  | 'agent-tracking'

export type FeatureWallSetupStepTier = 'core' | 'advanced'

export type FeatureWallSetupStep = {
  readonly id: FeatureWallSetupStepId
  readonly tier: FeatureWallSetupStepTier
  readonly name: string
  readonly subtitle: string
  readonly description: string
}

export const FEATURE_WALL_SETUP_STEPS: readonly FeatureWallSetupStep[] = [
  {
    id: 'default-agent',
    tier: 'core',
    name: 'Pick a default agent',
    subtitle: 'Pick a default agent',
    description: 'Start new work with the agent you trust most, without choosing every time.'
  },
  {
    id: 'notifications',
    tier: 'core',
    name: 'Configure notifications',
    subtitle: 'Configure notifications',
    description: 'Know when agents need attention, finish work, or get blocked.'
  },
  {
    id: 'two-agents',
    tier: 'core',
    name: 'Start 2 agents in one worktree',
    subtitle: 'Start 2 agents in one worktree',
    description: 'Watch two agents work in the same codebase side by side.'
  },
  {
    id: 'three-workspaces',
    tier: 'core',
    name: 'Create 2 worktrees',
    subtitle: 'Create 2 worktrees',
    description: 'Keep separate tasks in separate worktrees so agents can work independently.'
  },
  {
    id: 'task-sources',
    tier: 'core',
    name: 'Enable task sources',
    subtitle: 'Enable task sources',
    description: 'Start work directly from your tasks and keep PR status in view.'
  },
  {
    id: 'agent-capabilities',
    tier: 'core',
    name: 'Enable advanced agent capabilities',
    subtitle: 'Enable advanced agent capabilities',
    description: 'Enable the tools that let agents work more independently.'
  },
  {
    id: 'setup-script',
    tier: 'core',
    name: 'Configure a setup script',
    subtitle: 'Configure a setup script',
    description:
      "Add a script that runs automatically when you create a new worktree, so you don't have to run the same command every time."
  },
  {
    id: 'add-two-repos',
    tier: 'core',
    name: 'Add 2 projects',
    subtitle: 'Add 2 projects',
    description: 'Bring your key repos into Orca and run agent work across them in parallel.'
  },
  {
    id: 'browser-element',
    tier: 'advanced',
    name: 'Send a browser element to an agent',
    subtitle: 'Send a browser element to an agent',
    description: 'Open a browser tab, grab an element, and send that page context to an agent.'
  },
  {
    id: 'review-notes',
    tier: 'advanced',
    name: 'Send notes to an agent',
    subtitle: 'Send notes to an agent',
    description: 'Add review notes on a diff or markdown file, then send them back to an agent.'
  },
  {
    id: 'automation',
    tier: 'advanced',
    name: 'Add an automation',
    subtitle: 'Add an automation',
    description: 'Create a recurring agent job for checks, maintenance, or follow-up work.'
  },
  {
    id: 'mobile',
    tier: 'advanced',
    name: 'Try mobile',
    subtitle: 'Try mobile',
    description: 'Generate a mobile pairing code or QR code so Orca is reachable from your phone.'
  },
  {
    id: 'agent-tracking',
    tier: 'advanced',
    name: 'Configure agent tracking',
    subtitle: 'Configure agent tracking',
    description: 'Enable agent status hooks so Orca can track working, waiting, and blocked agents.'
  }
] as const

export const FEATURE_WALL_SETUP_STEP_IDS = FEATURE_WALL_SETUP_STEPS.map((step) => step.id)

export function getFeatureWallSetupSteps(
  tier?: FeatureWallSetupStepTier
): readonly FeatureWallSetupStep[] {
  return tier
    ? FEATURE_WALL_SETUP_STEPS.filter((step) => step.tier === tier)
    : FEATURE_WALL_SETUP_STEPS
}
