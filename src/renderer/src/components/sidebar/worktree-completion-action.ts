import type { Worktree, WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  DONE_WORKSPACE_STATUS_ID,
  getWorkspaceStatus,
  isWorkspaceStatusId
} from '../../../../shared/workspace-statuses'

export type WorktreeCompletionActionKind = 'mark-done' | 'mark-in-progress'

export type WorktreeCompletionAction = {
  kind: WorktreeCompletionActionKind
  targetStatus: WorkspaceStatus
  label: string
  tooltip: string
  ariaLabel: string
}

export function getWorktreeCompletionAction(
  worktrees: readonly Pick<Worktree, 'workspaceStatus'>[],
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): WorktreeCompletionAction | null {
  if (worktrees.length === 0) {
    return null
  }

  const allDone = worktrees.every(
    (worktree) => getWorkspaceStatus(worktree, workspaceStatuses) === DONE_WORKSPACE_STATUS_ID
  )
  const targetStatus = allDone ? DEFAULT_WORKSPACE_STATUS_ID : DONE_WORKSPACE_STATUS_ID

  if (!isWorkspaceStatusId(targetStatus, workspaceStatuses)) {
    return null
  }

  const isMulti = worktrees.length > 1
  if (allDone) {
    return {
      kind: 'mark-in-progress',
      targetStatus,
      label: isMulti ? `Mark ${worktrees.length} In Progress` : 'Mark In Progress',
      tooltip: 'Mark in progress',
      ariaLabel: isMulti ? 'Mark selected workspaces in progress' : 'Mark workspace in progress'
    }
  }

  return {
    kind: 'mark-done',
    targetStatus,
    label: isMulti ? `Mark ${worktrees.length} Done` : 'Mark Done',
    tooltip: 'Mark done',
    ariaLabel: isMulti ? 'Mark selected workspaces done' : 'Mark workspace done'
  }
}
