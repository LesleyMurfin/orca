import { describe, expect, it } from 'vitest'
import type { FeatureWallSetupProgressInput } from './feature-wall-setup-progress'
import { getFeatureWallSetupProgress } from './feature-wall-setup-progress'
import { getFeatureWallSetupSteps } from '../../../../shared/feature-wall-setup-steps'
import type { Worktree } from '../../../../shared/types'

function makeInput(
  overrides: Partial<FeatureWallSetupProgressInput> = {}
): FeatureWallSetupProgressInput {
  return {
    settings: null,
    featureInteractions: {},
    hasConnectedTaskSource: false,
    browserUseSkillInstalled: false,
    orchestrationSkillInstalled: false,
    gitRepoCount: 0,
    worktreesByRepo: {},
    tabsByWorktree: {},
    runtimePaneTitlesByTabId: {},
    hasAutomation: false,
    hasSetupScript: false,
    ...overrides
  }
}

function makeWorktree(id: string): Worktree {
  return { id } as unknown as Worktree
}

describe('getFeatureWallSetupProgress', () => {
  it('tracks Add 2 projects from durable git repo count', () => {
    expect(getFeatureWallSetupProgress(makeInput({ gitRepoCount: 1 })).stepDone).toMatchObject({
      'add-two-repos': false
    })

    const progress = getFeatureWallSetupProgress(makeInput({ gitRepoCount: 2 }))

    expect(progress.stepDone['add-two-repos']).toBe(true)
    expect(progress.coreTotal).toBe(8)
  })

  it('keeps Add 2 projects as the final core setup task', () => {
    expect(getFeatureWallSetupSteps('core').map((step) => step.id)).toEqual([
      'default-agent',
      'notifications',
      'two-agents',
      'three-workspaces',
      'task-sources',
      'agent-capabilities',
      'setup-script',
      'add-two-repos'
    ])
  })

  it('marks two agents complete once the terminal has been split', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'terminal-pane-split': { firstInteractedAt: 1_700_000_000_000, interactionCount: 1 }
        }
      })
    )

    expect(progress.stepDone['two-agents']).toBe(true)
  })

  it('marks worktrees complete once two worktrees exist', () => {
    expect(
      getFeatureWallSetupProgress(
        makeInput({ worktreesByRepo: { 'repo-1': [makeWorktree('worktree-1')] } })
      ).stepDone['three-workspaces']
    ).toBe(false)

    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: {
          'repo-1': [makeWorktree('worktree-1'), makeWorktree('worktree-2')]
        }
      })
    )

    expect(progress.stepDone['three-workspaces']).toBe(true)
  })

  it('marks task sources complete for any supported connected provider', () => {
    const progress = getFeatureWallSetupProgress(makeInput({ hasConnectedTaskSource: true }))

    expect(progress.stepDone['task-sources']).toBe(true)
  })
})
