import { describe, expect, it } from 'vitest'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { Worktree } from '../../../../shared/types'
import { getWorktreeCompletionAction } from './worktree-completion-action'

function makeWorktree(workspaceStatus?: string): Pick<Worktree, 'workspaceStatus'> {
  return { workspaceStatus }
}

describe('getWorktreeCompletionAction', () => {
  it('targets Done for an active workspace', () => {
    const action = getWorktreeCompletionAction(
      [makeWorktree('in-progress')],
      cloneDefaultWorkspaceStatuses()
    )

    expect(action).toMatchObject({
      kind: 'mark-done',
      targetStatus: 'completed',
      label: 'Mark Done',
      ariaLabel: 'Mark workspace done'
    })
  })

  it('reverses a done workspace back to In Progress', () => {
    const action = getWorktreeCompletionAction(
      [makeWorktree('completed')],
      cloneDefaultWorkspaceStatuses()
    )

    expect(action).toMatchObject({
      kind: 'mark-in-progress',
      targetStatus: 'in-progress',
      label: 'Mark In Progress',
      ariaLabel: 'Mark workspace in progress'
    })
  })

  it('marks a mixed multi-selection done and includes the selected count', () => {
    const action = getWorktreeCompletionAction(
      [makeWorktree('completed'), makeWorktree('todo')],
      cloneDefaultWorkspaceStatuses()
    )

    expect(action).toMatchObject({
      kind: 'mark-done',
      targetStatus: 'completed',
      label: 'Mark 2 Done',
      ariaLabel: 'Mark selected workspaces done'
    })
  })

  it('reverses an all-done multi-selection together', () => {
    const action = getWorktreeCompletionAction(
      [makeWorktree('completed'), makeWorktree('completed')],
      cloneDefaultWorkspaceStatuses()
    )

    expect(action).toMatchObject({
      kind: 'mark-in-progress',
      targetStatus: 'in-progress',
      label: 'Mark 2 In Progress',
      ariaLabel: 'Mark selected workspaces in progress'
    })
  })

  it('hides when the target status is not part of the current status board', () => {
    expect(
      getWorktreeCompletionAction(
        [makeWorktree('todo')],
        [{ id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }]
      )
    ).toBeNull()
  })
})
