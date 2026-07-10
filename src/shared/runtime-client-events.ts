import type {
  CreateWorktreeResult,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './types'
import type { SshConnectionState } from './ssh-types'

export type RuntimeClientEvent =
  | { type: 'reposChanged' }
  | { type: 'worktreesChanged'; repoId: string }
  // Why: SSH connections live on the runtime host; paired clients have no IPC
  // channel for ssh:state-changed, so without this event their reconnect
  // overlays never learn the host connected (STA-1468).
  | { type: 'sshStateChanged'; targetId: string; state: SshConnectionState }
  | {
      type: 'linearLinkedIssueUpdated'
      worktreeId: string
      identifier: string
      workspaceId: string
    }
  | {
      type: 'activateWorktree'
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
      // Why: the acting device's clientId. When present, the runtime delivers the
      // event only to that self subscriber so paired peers are not force-followed
      // onto the worktree (client view decoupling). Absent for CLI/creation
      // activations, which still broadcast to all clients.
      originClientId?: string
    }

export type RuntimeClientEventStreamMessage =
  | ({ type: 'ready'; subscriptionId: string } & {
      snapshot?: {
        // Reserved for future hydration. Current clients refresh through the
        // existing repo/worktree RPCs after receiving server events.
        repos?: unknown[]
      }
    })
  | RuntimeClientEvent
  | { type: 'end' }

export type RuntimeActivateWorktreeEvent = Extract<RuntimeClientEvent, { type: 'activateWorktree' }>

export function toRuntimeActivateWorktreeEvent(
  repoId: string,
  worktreeId: string,
  setup?: CreateWorktreeResult['setup'],
  startup?: WorktreeStartupLaunch,
  defaultTabs?: CreateWorktreeResult['defaultTabs'],
  originClientId?: string
): RuntimeActivateWorktreeEvent {
  return {
    type: 'activateWorktree',
    repoId,
    worktreeId,
    ...(setup ? { setup } : {}),
    ...(startup ? { startup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(originClientId ? { originClientId } : {})
  }
}
