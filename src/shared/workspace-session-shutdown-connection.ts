import { parseAppSshPtyId } from './ssh-pty-id'
import type { WorkspaceSessionState } from './workspace-session-state-types'

/**
 * Whether this SSH target was connected when the client last quit.
 *
 * GAP-03 decline (`reconciledWorktreeIds`) only applies after a genuine offline gap. An absent base
 * `tabsByWorktree` row for an SSH-routed worktree is normal on every boot (those rows never land in
 * the local partition), so it is not evidence of server-side closes by itself.
 *
 * Prefers `activeConnectionIdsAtShutdown`. When that field is missing (older sessions / interrupted
 * shutdowns), infers from base `remoteSessionIdsByTabId` only — never from the SSH partition mirror,
 * which is the stale cache GAP-03 exists to decline.
 */
export function wasTargetConnectedAtLastShutdown(
  session: WorkspaceSessionState,
  targetId: string | null
): boolean {
  if (!targetId) {
    return false
  }
  if (session.activeConnectionIdsAtShutdown !== undefined) {
    return session.activeConnectionIdsAtShutdown.includes(targetId)
  }
  for (const sessionId of Object.values(session.remoteSessionIdsByTabId ?? {})) {
    if (parseAppSshPtyId(sessionId)?.connectionId === targetId) {
      return true
    }
  }
  return false
}
