import { isRecoverableRemoteRuntimeConnectionError } from '../../../shared/remote-runtime-client-error-classification'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  RemoteRuntimeSessionTabsRecoverySubscription,
  normalizeRecoveryError
} from './remote-runtime-session-tabs-recovery-subscription'
import type {
  RemoteRuntimeTerminalHandleResolution,
  RemoteRuntimeTerminalRecoveryDependencies,
  RemoteRuntimeTerminalRecoveryParticipant
} from './remote-runtime-terminal-recovery-types'

type StructuredError = { code: string; message: string }
export type ParticipantRecord = {
  participant: RemoteRuntimeTerminalRecoveryParticipant
  token: object
  lifetime: AbortController
  rebindToken: object | null
}
type RetryTimer = { token: object; handle?: unknown }

const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const
const TERMINAL_GONE_CODES = new Set([
  'terminal_handle_stale',
  'terminal_exited',
  'terminal_gone',
  'no_connected_pty'
])

export abstract class RemoteRuntimeTerminalRecoveryRegistry {
  protected readonly participants = new Map<string, ParticipantRecord>()
  protected readonly worktrees = new Map<string, RemoteRuntimeSessionTabsRecoverySubscription>()
  protected readonly retry = {
    attempt: 0,
    timer: null as RetryTimer | null,
    deferred: false,
    processQueued: false
  }
  protected generation = 0
  protected runAbort: AbortController | null = null
  protected disposed = false
  protected idleNotified = false

  constructor(
    protected readonly environmentId: string,
    protected readonly dependencies: RemoteRuntimeTerminalRecoveryDependencies
  ) {}

  protected abstract removeRecord(record: ParticipantRecord): void

  protected beginRun(): void {
    this.runAbort?.abort()
    this.worktrees.forEach((entry) => entry.dispose())
    this.worktrees.clear()
    this.generation += 1
    this.runAbort = new AbortController()
    this.retry.deferred = false
    this.queueProcess()
  }

  protected queueProcess(): void {
    if (this.retry.processQueued) {
      return
    }
    this.retry.processQueued = true
    void Promise.resolve().then(() => {
      this.retry.processQueued = false
      if (this.disposed || this.retry.timer || this.participants.size === 0) {
        return
      }
      const generation = this.generation
      Array.from(this.participants.values()).forEach((record) => {
        if (generation === this.generation) {
          this.processRecord(record)
        }
      })
    })
  }

  private processRecord(
    record: ParticipantRecord,
    providedSnapshot?: RuntimeMobileSessionTabsResult
  ): void {
    if (!this.isCurrent(record) || record.rebindToken) {
      return
    }
    let snapshot = providedSnapshot
    const { worktreeId } = record.participant
    if (worktreeId && !snapshot) {
      const entry = this.worktrees.get(worktreeId) ?? this.openWorktree(worktreeId)
      snapshot = entry.snapshot ?? undefined
      if (!snapshot) {
        return
      }
    }
    let resolution: RemoteRuntimeTerminalHandleResolution
    try {
      resolution = record.participant.resolveHandle(snapshot ?? null)
    } catch (error) {
      this.settle(record, normalizeRecoveryError(error))
      return
    }
    if (resolution.kind === 'gone') {
      this.settle(record, 'gone')
    } else if (resolution.kind === 'ready') {
      this.startRebind(record, resolution.handle)
    } else if (!worktreeId) {
      this.settle(record, {
        code: 'invalid_runtime_response',
        message: 'A direct terminal recovery cannot remain pending.'
      })
    }
  }

  private startRebind(record: ParticipantRecord, handle: string): void {
    const token = {}
    const generation = this.generation
    const runSignal = this.runAbort?.signal ?? AbortSignal.abort()
    const signal = AbortSignal.any([record.lifetime.signal, runSignal])
    record.rebindToken = token
    void Promise.resolve()
      .then(() => record.participant.rebind({ handle, generation, signal }))
      .then(
        () => this.finishRebind(record, token, generation, signal),
        (error) => this.finishRebind(record, token, generation, signal, error)
      )
  }

  private finishRebind(
    record: ParticipantRecord,
    token: object,
    generation: number,
    signal: AbortSignal,
    error?: unknown
  ): void {
    if (record.rebindToken === token) {
      record.rebindToken = null
    }
    if (!this.isCurrent(record) || generation !== this.generation || signal.aborted) {
      this.runDeferredRetry()
      return
    }
    if (error === undefined) {
      this.removeRecord(record)
    } else {
      this.handleParticipantError(record, normalizeRecoveryError(error))
    }
    this.runDeferredRetry()
  }

  private openWorktree(worktreeId: string): RemoteRuntimeSessionTabsRecoverySubscription {
    let entry: RemoteRuntimeSessionTabsRecoverySubscription
    entry = new RemoteRuntimeSessionTabsRecoverySubscription(
      worktreeId,
      this.generation,
      this.environmentId,
      this.dependencies.subscribeSessionTabs,
      {
        onSnapshot: (snapshot) => this.acceptSnapshot(entry, snapshot),
        onError: (error) => this.endWorktree(entry, error, false),
        onClose: () => this.endWorktree(entry, null, true),
        onStartReady: () => {
          if (this.isCurrentEntry(entry)) {
            this.runDeferredRetry()
          }
        },
        onStartError: (error) => this.endWorktree(entry, error, true)
      }
    )
    this.worktrees.set(worktreeId, entry)
    entry.start()
    return entry
  }

  private acceptSnapshot(
    entry: RemoteRuntimeSessionTabsRecoverySubscription,
    snapshot: RuntimeMobileSessionTabsResult
  ): void {
    if (!this.isCurrentEntry(entry)) {
      return
    }
    Array.from(this.participants.values()).forEach((record) => {
      if (this.isCurrentEntry(entry) && record.participant.worktreeId === entry.worktreeId) {
        this.processRecord(record, snapshot)
      }
    })
  }

  private endWorktree(
    entry: RemoteRuntimeSessionTabsRecoverySubscription,
    error: StructuredError | null,
    replace: boolean
  ): void {
    if (!this.isCurrentEntry(entry) || (!replace && error && isRecoverable(error))) {
      return
    }
    this.removeWorktree(entry)
    if (error) {
      this.handleWorktreeError(entry.worktreeId, error)
    } else if (this.hasWorktreeParticipants(entry.worktreeId)) {
      this.scheduleRetry()
    }
    this.runDeferredRetry()
  }

  private handleWorktreeError(worktreeId: string, error: StructuredError): void {
    Array.from(this.participants.values()).forEach((record) => {
      if (record.participant.worktreeId === worktreeId) {
        this.handleParticipantError(record, error)
      }
    })
  }

  private handleParticipantError(record: ParticipantRecord, error: StructuredError): void {
    if (TERMINAL_GONE_CODES.has(error.code)) {
      this.settle(record, 'gone')
    } else if (isRecoverable(error)) {
      this.scheduleRetry()
    } else {
      this.settle(record, error)
    }
  }

  private scheduleRetry(): void {
    if (this.retry.timer || this.retry.deferred || this.participants.size === 0) {
      return
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.retry.attempt, RETRY_DELAYS_MS.length - 1)]
    this.retry.attempt += 1
    const timer: RetryTimer = { token: {} }
    this.retry.timer = timer
    const handle = this.dependencies.setTimer(() => {
      if (this.retry.timer !== timer) {
        return
      }
      this.retry.timer = null
      this.requestRetry()
    }, delay)
    timer.handle = handle
    if (this.retry.timer !== timer) {
      this.dependencies.clearTimer(handle)
    }
  }

  protected requestRetry(): void {
    if (this.disposed || this.participants.size === 0) {
      return
    }
    if (this.hasInFlight()) {
      this.retry.deferred = true
    } else {
      this.beginRun()
    }
  }

  private runDeferredRetry(): void {
    if (!this.retry.deferred || this.hasInFlight()) {
      return
    }
    this.retry.deferred = false
    this.beginRun()
  }

  private hasInFlight(): boolean {
    return (
      [...this.participants.values()].some((record) => record.rebindToken !== null) ||
      [...this.worktrees.values()].some((entry) => entry.startPending)
    )
  }

  private settle(record: ParticipantRecord, outcome: StructuredError | 'gone'): void {
    if (!this.isCurrent(record)) {
      return
    }
    this.removeRecord(record)
    if (outcome === 'gone') {
      invokeSafely(record.participant.onGone)
    } else {
      invokeSafely(() => record.participant.onFatal(outcome))
    }
  }

  protected releaseUnusedWorktree(worktreeId: string | null): void {
    if (!worktreeId || this.hasWorktreeParticipants(worktreeId)) {
      return
    }
    const entry = this.worktrees.get(worktreeId)
    if (entry) {
      this.removeWorktree(entry)
    }
  }

  private removeWorktree(entry: RemoteRuntimeSessionTabsRecoverySubscription): void {
    if (this.worktrees.get(entry.worktreeId) === entry) {
      this.worktrees.delete(entry.worktreeId)
    }
    entry.dispose()
  }

  protected isCurrent(record: ParticipantRecord): boolean {
    return this.participants.get(record.participant.id)?.token === record.token
  }

  private isCurrentEntry(entry: RemoteRuntimeSessionTabsRecoverySubscription): boolean {
    return this.worktrees.get(entry.worktreeId) === entry && entry.generation === this.generation
  }

  private hasWorktreeParticipants(worktreeId: string): boolean {
    return [...this.participants.values()].some(
      (record) => record.participant.worktreeId === worktreeId
    )
  }
}

function isRecoverable(error: StructuredError): boolean {
  return isRecoverableRemoteRuntimeConnectionError(error)
}

function invokeSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // External callbacks cannot block cleanup or sibling progress.
  }
}
