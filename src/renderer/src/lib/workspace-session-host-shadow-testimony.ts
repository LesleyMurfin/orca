import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'
import { WORKTREE_KEYED_FIELDS } from './workspace-session-host-contention'
import type { HostSessionSlices } from './workspace-session-host-split'
import {
  hostHasAnsweredForTarget,
  type RemoteWorkspaceTestimonyState
} from './remote-workspace-host-testimony'

/**
 * The shadow minus every parked row whose host has already answered for it. Returns the input by
 * reference when nothing is withheld.
 */
export function shadowRowsTheHostHasNotAnswered(
  shadow: HostSessionSlices | undefined,
  state: RemoteWorkspaceTestimonyState
): HostSessionSlices | undefined {
  if (!shadow) {
    return shadow
  }

  let withheld = false
  const nextShadow: HostSessionSlices = {}

  for (const [hostId, hostSlice] of Object.entries(shadow) as [
    ExecutionHostId,
    WorkspaceSessionState | undefined
  ][]) {
    if (!hostSlice) {
      nextShadow[hostId] = hostSlice
      continue
    }

    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'ssh' || !hostHasAnsweredForTarget(state, parsed.targetId)) {
      nextShadow[hostId] = hostSlice
      continue
    }

    let hostWithheld = false
    let survivingWorktreeKeyedFieldCount = 0
    const nextHostSlice: WorkspaceSessionState = { ...hostSlice }

    for (const field of WORKTREE_KEYED_FIELDS) {
      const record = hostSlice[field]
      if (!isWorkspaceSessionRecord(record)) {
        continue
      }

      let fieldWithheld = false
      const survivingRecord: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(record)) {
        if (parseWorkspaceKey(key)?.type === 'folder') {
          survivingRecord[key] = value
        } else {
          fieldWithheld = true
        }
      }

      if (fieldWithheld) {
        hostWithheld = true
        withheld = true
        if (Object.keys(survivingRecord).length > 0) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: field is a worktree-keyed record field and survivingRecord contains only its surviving entries.
          ;(nextHostSlice as Record<string, unknown>)[field] = survivingRecord
          survivingWorktreeKeyedFieldCount++
        } else {
          delete nextHostSlice[field]
        }
      } else {
        if (Object.keys(record).length > 0) {
          survivingWorktreeKeyedFieldCount++
        }
      }
    }

    if (hostWithheld) {
      if (survivingWorktreeKeyedFieldCount > 0) {
        nextShadow[hostId] = nextHostSlice
      }
    } else {
      nextShadow[hostId] = hostSlice
    }
  }

  return withheld ? nextShadow : shadow
}
