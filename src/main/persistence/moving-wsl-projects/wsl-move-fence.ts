/**
 * What the WSL move journal fences on this desktop. The journal itself is the fence: it already
 * lives outside the profile store, so an older build rewriting the profile cannot drop it, and the
 * scope it names is the manifest's own (design, section 4.3).
 *
 * - Fenced (read-only): from `source-fenced` until the host owns the projects. Edits, new
 *   terminals and session writes for these rows are refused.
 * - Hidden: once the destination committed. The source rows stay (retained) but are not listed.
 */
import type { WslMoveCutover, WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import { WSL_MOVE_CUTOVER_PHASES } from '../../../shared/wsl-move/wsl-move-cutover'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'

export type WslMoveScopeIds = {
  repoIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
}

export type WslMoveFenceState = {
  /** Rows a move is taking right now: shown as "Moving…", and read-only. */
  fenced: WslMoveScopeIds
  /** Rows the WSL host now owns: kept for a downgrade, never listed. */
  hidden: WslMoveScopeIds
}

const phaseIndex = (phase: WslMoveCutoverPhase): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
const FENCED_FROM = phaseIndex('source-fenced')
const HIDDEN_FROM = phaseIndex('destination-committed')

/** Throws when the journal cannot be read: callers keep every WSL project fenced then. */
export function resolveWslMoveFence(userDataPath: string): WslMoveFenceState {
  return wslMoveFenceFromCutovers(listWslMoveCutovers(userDataPath))
}

export function wslMoveFenceFromCutovers(cutovers: readonly WslMoveCutover[]): WslMoveFenceState {
  const fenced = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  const hidden = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  for (const cutover of cutovers) {
    const index = phaseIndex(cutover.phase)
    const target = index >= HIDDEN_FROM ? hidden : index >= FENCED_FROM ? fenced : null
    if (!target) {
      continue // `prepared` touches nothing on the source.
    }
    const { scopeRepoIds, scopeFolderWorkspaceIds } = cutover.manifest.source
    for (const id of scopeRepoIds) {
      target.repoIds.add(id)
    }
    for (const id of scopeFolderWorkspaceIds) {
      target.folderWorkspaceIds.add(id)
    }
  }
  return { fenced, hidden }
}
