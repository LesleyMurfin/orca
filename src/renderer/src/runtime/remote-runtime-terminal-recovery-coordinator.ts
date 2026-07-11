import {
  RemoteRuntimeTerminalRecoveryRegistry,
  type ParticipantRecord
} from './remote-runtime-terminal-recovery-registry'
import { subscribeRemoteRuntimeSessionTabsForRecovery } from './remote-runtime-session-tabs-recovery-subscription'
import type {
  RemoteRuntimeTerminalRecoveryLease,
  RemoteRuntimeTerminalRecoveryParticipant
} from './remote-runtime-terminal-recovery-types'

export type {
  RemoteRuntimeTerminalHandleResolution,
  RemoteRuntimeTerminalRecoveryDependencies,
  RemoteRuntimeTerminalRecoveryLease,
  RemoteRuntimeTerminalRecoveryParticipant
} from './remote-runtime-terminal-recovery-types'

export class RemoteRuntimeTerminalRecoveryCoordinator extends RemoteRuntimeTerminalRecoveryRegistry {
  register(
    participant: RemoteRuntimeTerminalRecoveryParticipant
  ): RemoteRuntimeTerminalRecoveryLease {
    if (this.disposed) {
      return { generation: this.generation, cancel: () => {} }
    }
    const existing = this.participants.get(participant.id)
    if (this.participants.size === 0 && !existing) {
      this.retry.attempt = 0
      this.cancelTimer()
      this.beginRun()
    }
    if (existing) {
      this.participants.delete(participant.id)
      existing.lifetime.abort()
    }
    const record: ParticipantRecord = {
      participant,
      token: {},
      lifetime: new AbortController(),
      rebindToken: null
    }
    this.participants.set(participant.id, record)
    if (existing?.participant.worktreeId !== participant.worktreeId) {
      this.releaseUnusedWorktree(existing?.participant.worktreeId ?? null)
    }
    this.idleNotified = false
    this.queueProcess()
    return {
      generation: this.generation,
      cancel: () => {
        if (this.isCurrent(record)) {
          this.removeRecord(record)
        }
      }
    }
  }

  retryNow(): void {
    if (this.disposed || this.participants.size === 0 || !this.retry.timer) {
      return
    }
    this.cancelTimer()
    this.requestRetry()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.participants.forEach((record) => record.lifetime.abort())
    this.participants.clear()
    this.cleanupIdle()
  }

  protected removeRecord(record: ParticipantRecord): void {
    if (!this.isCurrent(record)) {
      return
    }
    this.participants.delete(record.participant.id)
    record.lifetime.abort()
    this.releaseUnusedWorktree(record.participant.worktreeId)
    if (this.participants.size === 0) {
      this.cleanupIdle()
    }
  }

  private cleanupIdle(): void {
    this.cancelTimer()
    this.retry.deferred = false
    this.runAbort?.abort()
    this.runAbort = null
    this.worktrees.forEach((entry) => entry.dispose())
    this.worktrees.clear()
    if (!this.idleNotified) {
      this.idleNotified = true
      if (this.dependencies.onIdle) {
        invokeSafely(this.dependencies.onIdle)
      }
    }
  }

  private cancelTimer(): void {
    const timer = this.retry.timer
    this.retry.timer = null
    if (timer && 'handle' in timer) {
      this.dependencies.clearTimer(timer.handle)
    }
  }
}

const coordinators = new Map<string, RemoteRuntimeTerminalRecoveryCoordinator>()

export function beginRemoteRuntimeTerminalRecovery(args: {
  environmentId: string
  participant: RemoteRuntimeTerminalRecoveryParticipant
}): RemoteRuntimeTerminalRecoveryLease {
  let coordinator = coordinators.get(args.environmentId)
  if (!coordinator) {
    let created: RemoteRuntimeTerminalRecoveryCoordinator
    created = new RemoteRuntimeTerminalRecoveryCoordinator(args.environmentId, {
      subscribeSessionTabs: subscribeRemoteRuntimeSessionTabsForRecovery,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onIdle: () => {
        if (coordinators.get(args.environmentId) === created) {
          coordinators.delete(args.environmentId)
        }
      }
    })
    coordinator = created
    coordinators.set(args.environmentId, coordinator)
  }
  return coordinator.register(args.participant)
}

export function retryRemoteRuntimeTerminalRecoveriesNow(): void {
  coordinators.forEach((coordinator) => coordinator.retryNow())
}

function invokeSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // External callbacks cannot block cleanup or singleton release.
  }
}
