import {
  hasFeatureInteraction,
  type FeatureInteractionState
} from '../../../../shared/feature-interactions'
import {
  FEATURE_WALL_SETUP_STEPS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { GlobalSettings, TerminalTab, Worktree } from '../../../../shared/types'
import { getAgentLabel } from '../../lib/agent-status'

export type FeatureWallSetupProgressInput = {
  settings: GlobalSettings | null
  featureInteractions: FeatureInteractionState
  hasConnectedTaskSource: boolean
  browserUseSkillInstalled: boolean
  orchestrationSkillInstalled: boolean
  gitRepoCount: number
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  hasAutomation: boolean
  hasSetupScript: boolean
}

export type FeatureWallSetupProgress = {
  stepDone: Record<FeatureWallSetupStepId, boolean>
  coreDoneCount: number
  coreTotal: number
  advancedDoneCount: number
  advancedTotal: number
}

function hasTwoAgentSessionsInOneWorktree(input: FeatureWallSetupProgressInput): boolean {
  for (const [worktreeId, tabs] of Object.entries(input.tabsByWorktree)) {
    if (
      !Object.values(input.worktreesByRepo).some((worktrees) =>
        worktrees.some((w) => w.id === worktreeId)
      )
    ) {
      continue
    }
    let agentSessionCount = 0
    for (const tab of tabs) {
      const paneTitles = input.runtimePaneTitlesByTabId[tab.id]
      if (paneTitles && Object.keys(paneTitles).length > 0) {
        agentSessionCount += Object.values(paneTitles).filter((title) =>
          getAgentLabel(title)
        ).length
      } else if (getAgentLabel(tab.title)) {
        agentSessionCount += 1
      }
      if (agentSessionCount >= 2) {
        return true
      }
    }
  }
  return false
}

function countWorkspaces(worktreesByRepo: Record<string, Worktree[]>): number {
  return Object.values(worktreesByRepo).reduce((sum, worktrees) => sum + worktrees.length, 0)
}

export function getFeatureWallSetupProgress(
  input: FeatureWallSetupProgressInput
): FeatureWallSetupProgress {
  const interactions = input.featureInteractions
  const agentCapabilitiesDone =
    (input.browserUseSkillInstalled ||
      hasFeatureInteraction(interactions, 'agent-browser-setup')) &&
    (input.orchestrationSkillInstalled ||
      hasFeatureInteraction(interactions, 'agent-orchestration-setup')) &&
    hasFeatureInteraction(interactions, 'computer-use-setup')
  const stepDone: Record<FeatureWallSetupStepId, boolean> = {
    'default-agent':
      Boolean(input.settings?.defaultTuiAgent) && input.settings?.defaultTuiAgent !== 'blank',
    'add-two-repos': input.gitRepoCount >= 2,
    notifications:
      input.settings?.notifications.enabled === true &&
      input.settings.notifications.agentTaskComplete === true,
    'two-agents':
      hasFeatureInteraction(interactions, 'terminal-pane-split') ||
      hasTwoAgentSessionsInOneWorktree(input),
    'three-workspaces': countWorkspaces(input.worktreesByRepo) >= 2,
    'task-sources': input.hasConnectedTaskSource,
    'agent-capabilities': agentCapabilitiesDone,
    'setup-script': input.hasSetupScript,
    'browser-element': hasFeatureInteraction(interactions, 'browser-grab'),
    'review-notes': hasFeatureInteraction(interactions, 'review-notes'),
    automation: input.hasAutomation || hasFeatureInteraction(interactions, 'automation-created'),
    mobile:
      input.settings?.experimentalMobile === true ||
      hasFeatureInteraction(interactions, 'mobile-pairing'),
    'agent-tracking': input.settings ? input.settings.agentStatusHooksEnabled !== false : false
  }
  const coreSteps = FEATURE_WALL_SETUP_STEPS.filter((step) => step.tier === 'core')
  const advancedSteps = FEATURE_WALL_SETUP_STEPS.filter((step) => step.tier === 'advanced')
  return {
    stepDone,
    coreDoneCount: coreSteps.filter((step) => stepDone[step.id]).length,
    coreTotal: coreSteps.length,
    advancedDoneCount: advancedSteps.filter((step) => stepDone[step.id]).length,
    advancedTotal: advancedSteps.length
  }
}
