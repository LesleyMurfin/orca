import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  RemoteRuntimeTerminalRecoveryCoordinator,
  beginRemoteRuntimeTerminalRecovery,
  retryRemoteRuntimeTerminalRecoveriesNow,
  type RemoteRuntimeTerminalHandleResolution,
  type RemoteRuntimeTerminalRecoveryDependencies,
  type RemoteRuntimeTerminalRecoveryParticipant,
  type RemoteRuntimeTerminalRecoverySnapshot
} from './remote-runtime-terminal-recovery-coordinator'
import { resolveRemoteRuntimeHostTerminal } from './remote-runtime-host-terminal-resolution'

const OFFLINE = { code: 'remote_runtime_unavailable', message: 'offline' }
type SubscribeArgs = Parameters<
  RemoteRuntimeTerminalRecoveryDependencies['subscribeSessionTabs']
>[0]
type StartCall = {
  args: SubscribeArgs
  handle: { unsubscribe: ReturnType<typeof vi.fn> }
  resolve?: () => void
  reject?: (error: unknown) => void
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function snapshot(version = 1): RemoteRuntimeTerminalRecoverySnapshot {
  return {
    tabs: [
      {
        type: 'terminal',
        id: `snapshot-${version}`,
        parentTabId: 'snapshot-marker',
        leafId: 'snapshot-marker',
        title: 'Snapshot marker',
        isActive: false,
        status: 'ready',
        terminal: `snapshot-${version}`
      }
    ]
  }
}

function participant(
  id: string,
  worktreeId: string | null,
  options: {
    resolve?: (
      value: RemoteRuntimeTerminalRecoverySnapshot | null
    ) => RemoteRuntimeTerminalHandleResolution
    rebind?: RemoteRuntimeTerminalRecoveryParticipant['rebind']
    onGone?: () => void
    onFatal?: RemoteRuntimeTerminalRecoveryParticipant['onFatal']
  } = {}
): RemoteRuntimeTerminalRecoveryParticipant {
  const resolve =
    options.resolve ??
    ((
      _value: RemoteRuntimeTerminalRecoverySnapshot | null
    ): RemoteRuntimeTerminalHandleResolution => ({
      kind: 'ready',
      handle: `handle-${id}`
    }))
  return {
    id,
    worktreeId,
    resolveHandle: vi.fn(resolve),
    rebind: options.rebind ?? vi.fn().mockResolvedValue(undefined),
    onGone: options.onGone ?? vi.fn(),
    onFatal: options.onFatal ?? vi.fn()
  }
}

function createHarness(): {
  dependencies: RemoteRuntimeTerminalRecoveryDependencies
  calls: StartCall[]
  timers: Map<object, { callback: () => void; delayMs: number }>
  deferNext: () => void
  rejectNext: (error: unknown) => void
  fireTimer: () => Promise<void>
} {
  const modes: ({ kind: 'defer' } | { kind: 'reject'; error: unknown })[] = []
  const calls: StartCall[] = []
  const timers = new Map<object, { callback: () => void; delayMs: number }>()
  const dependencies: RemoteRuntimeTerminalRecoveryDependencies = {
    subscribeSessionTabs: vi.fn((args: SubscribeArgs): Promise<{ unsubscribe: () => void }> => {
      const handle = { unsubscribe: vi.fn() }
      const call: StartCall = { args, handle }
      calls.push(call)
      const mode = modes.shift()
      if (mode?.kind === 'reject') {
        return Promise.reject(mode.error)
      }
      if (mode?.kind === 'defer') {
        return new Promise<{ unsubscribe: () => void }>((resolve, reject) => {
          call.resolve = () => resolve(handle)
          call.reject = reject
        })
      }
      return Promise.resolve(handle)
    }),
    setTimer: vi.fn((callback, delayMs) => {
      const timer = {}
      timers.set(timer, { callback, delayMs })
      return timer
    }),
    clearTimer: vi.fn((timer) => timers.delete(timer as object))
  }
  return {
    dependencies,
    calls,
    timers,
    deferNext: () => modes.push({ kind: 'defer' }),
    rejectNext: (error) => modes.push({ kind: 'reject', error }),
    fireTimer: async () => {
      const next = timers.entries().next().value as
        | [object, { callback: () => void; delayMs: number }]
        | undefined
      if (!next) {
        throw new Error('No recovery timer')
      }
      timers.delete(next[0])
      next[1].callback()
      await flush()
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('RemoteRuntimeTerminalRecoveryCoordinator', () => {
  it('coalesces one subscription per worktree and separates different worktrees', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const first = participant('first', 'wt-1')
    const second = participant('second', 'wt-1')
    const other = participant('other', 'wt-2')

    coordinator.register(first)
    coordinator.register(second)
    coordinator.register(other)
    await flush()

    expect(h.calls.map((call) => call.args.worktreeId).sort()).toEqual(['wt-1', 'wt-2'])
    h.calls.find((call) => call.args.worktreeId === 'wt-1')?.args.onSnapshot(snapshot())
    h.calls.find((call) => call.args.worktreeId === 'wt-2')?.args.onSnapshot(snapshot())
    await flush()
    expect(first.rebind).toHaveBeenCalledTimes(1)
    expect(second.rebind).toHaveBeenCalledTimes(1)
    expect(other.rebind).toHaveBeenCalledTimes(1)
  })

  it('skips snapshots for direct handles and rejects direct pending as fatal', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const ready = participant('ready', null)
    const pending = participant('pending', null, { resolve: () => ({ kind: 'pending' }) })

    coordinator.register(ready)
    coordinator.register(pending)
    await flush()

    expect(h.calls).toHaveLength(0)
    expect(ready.rebind).toHaveBeenCalledTimes(1)
    expect(pending.onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_runtime_response' })
    )
  })

  it('retries startup at 250 ms and saturates every later delay at 30 seconds', async () => {
    const h = createHarness()
    h.rejectNext(OFFLINE)
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const recovered = participant('host', 'wt-1')
    coordinator.register(recovered)
    await flush()
    expect([...h.timers.values()].map((timer) => timer.delayMs)).toEqual([250])
    await h.fireTimer()
    expect(h.calls).toHaveLength(2)
    h.calls[1]?.args.onSnapshot(snapshot())
    await flush()
    expect(recovered.rebind).toHaveBeenCalledTimes(1)

    const saturated = createHarness()
    saturated.rejectNext(OFFLINE)
    const saturatedCoordinator = new RemoteRuntimeTerminalRecoveryCoordinator(
      'saturated-env',
      saturated.dependencies
    )
    saturatedCoordinator.register(participant('saturated', 'wt-1'))
    await flush()
    for (let index = 0; index < 10; index += 1) {
      saturated.rejectNext(OFFLINE)
      await saturated.fireTimer()
    }
    expect(vi.mocked(saturated.dependencies.setTimer).mock.calls.map((call) => call[1])).toEqual([
      250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000, 30_000
    ])
  })

  it('retryNow cancels backoff, advances its tier, and never duplicates in-flight work', async () => {
    const h = createHarness()
    const attempts: { reject: (error: unknown) => void }[] = []
    const rebind = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          attempts.push({ reject })
        })
    )
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    coordinator.register(participant('direct', null, { rebind }))
    await flush()
    attempts[0]?.reject(OFFLINE)
    await flush()
    expect([...h.timers.values()][0]?.delayMs).toBe(250)

    coordinator.retryNow()
    await flush()
    expect(rebind).toHaveBeenCalledTimes(2)
    coordinator.retryNow()
    expect(rebind).toHaveBeenCalledTimes(2)
    attempts[1]?.reject(OFFLINE)
    await flush()
    expect([...h.timers.values()][0]?.delayMs).toBe(500)
  })

  it('does not reset backoff after partial sibling success', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const success = participant('success', 'wt-1')
    const failure = participant('failure', 'wt-1', {
      rebind: vi.fn().mockRejectedValue(OFFLINE)
    })
    coordinator.register(success)
    coordinator.register(failure)
    await flush()
    h.calls[0]?.args.onSnapshot(snapshot())
    await flush()
    expect(success.rebind).toHaveBeenCalledTimes(1)
    expect([...h.timers.values()][0]?.delayMs).toBe(250)
    await h.fireTimer()
    h.calls[1]?.args.onSnapshot(snapshot(2))
    await flush()
    expect([...h.timers.values()][0]?.delayMs).toBe(500)
  })

  it('keeps siblings alive and closes subscriptions and timers with the last cancel', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const a = coordinator.register(
      participant('a', 'wt-1', { resolve: () => ({ kind: 'pending' }) })
    )
    const b = coordinator.register(
      participant('b', 'wt-1', { resolve: () => ({ kind: 'pending' }) })
    )
    await flush()
    h.calls[0]?.args.onSnapshot(snapshot())
    await flush()
    a.cancel()
    expect(h.calls[0]?.handle.unsubscribe).not.toHaveBeenCalled()
    b.cancel()
    b.cancel()
    expect(h.calls[0]?.handle.unsubscribe).toHaveBeenCalledTimes(1)

    const retryLease = coordinator.register(
      participant('retry', null, { rebind: vi.fn().mockRejectedValue(OFFLINE) })
    )
    await flush()
    expect(h.timers.size).toBe(1)
    retryLease.cancel()
    expect(h.timers.size).toBe(0)
  })

  it('aborts only the canceled registration while a sibling rebind remains live', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const signals = new Map<string, AbortSignal>()
    const deferredRebind = (id: string): RemoteRuntimeTerminalRecoveryParticipant['rebind'] =>
      vi.fn(
        ({ signal }) =>
          new Promise<void>(() => {
            signals.set(id, signal)
          })
      )
    const first = coordinator.register(
      participant('first', null, { rebind: deferredRebind('first') })
    )
    coordinator.register(participant('second', null, { rebind: deferredRebind('second') }))
    await flush()

    first.cancel()
    expect(signals.get('first')?.aborted).toBe(true)
    expect(signals.get('second')?.aborted).toBe(false)
  })

  it('fences stale runs and releases a late subscription handle', async () => {
    const h = createHarness()
    h.deferNext()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const stale = participant('stale', 'wt-1')
    const leaseA = coordinator.register(stale)
    await flush()
    leaseA.cancel()
    const current = participant('current', 'wt-1')
    coordinator.register(current)
    await flush()

    h.calls[0]?.args.onSnapshot(snapshot())
    h.calls[0]?.resolve?.()
    h.calls[1]?.args.onSnapshot(snapshot(2))
    await flush()
    expect(stale.rebind).not.toHaveBeenCalled()
    expect(current.rebind).toHaveBeenCalledTimes(1)
    expect(h.calls[0]?.handle.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('handles frames, cancellation, and dispose before a late start handle', async () => {
    const h = createHarness()
    h.deferNext()
    h.deferNext()
    h.deferNext()
    const onIdle = vi.fn()
    h.dependencies.onIdle = onIdle

    const early = new RemoteRuntimeTerminalRecoveryCoordinator('early', h.dependencies)
    const earlyParticipant = participant('early', 'wt-1')
    early.register(earlyParticipant)
    await flush()
    h.calls[0]?.args.onSnapshot(snapshot())
    await flush()
    h.calls[0]?.resolve?.()

    const canceled = new RemoteRuntimeTerminalRecoveryCoordinator('canceled', h.dependencies)
    const canceledParticipant = participant('canceled', 'wt-1')
    const canceledLease = canceled.register(canceledParticipant)
    await flush()
    canceledLease.cancel()
    h.calls[1]?.resolve?.()

    const disposed = new RemoteRuntimeTerminalRecoveryCoordinator('disposed', h.dependencies)
    const disposedParticipant = participant('disposed', 'wt-1')
    disposed.register(disposedParticipant)
    await flush()
    disposed.dispose()
    disposed.dispose()
    h.calls[2]?.resolve?.()
    await flush()

    expect(earlyParticipant.rebind).toHaveBeenCalledTimes(1)
    expect(canceledParticipant.rebind).not.toHaveBeenCalled()
    expect(disposedParticipant.rebind).not.toHaveBeenCalled()
    for (const call of h.calls) {
      expect(call.handle.unsubscribe).toHaveBeenCalledTimes(1)
    }
    expect(onIdle).toHaveBeenCalledTimes(3)
  })

  it('freezes queue and snapshot passes across reentrant registrations', async () => {
    const queueHarness = createHarness()
    const queueCoordinator = new RemoteRuntimeTerminalRecoveryCoordinator(
      'queue-env',
      queueHarness.dependencies
    )
    const queueReplacement = participant('queue-replacement', null)
    const queueFirst = participant('queue-first', null, {
      resolve: () => ({ kind: 'gone' }),
      onGone: () => queueCoordinator.register(queueReplacement)
    })

    queueCoordinator.register(queueFirst)
    await Promise.resolve()

    expect.soft(queueReplacement.resolveHandle).not.toHaveBeenCalled()
    queueCoordinator.dispose()
    await flush()

    const snapshotHarness = createHarness()
    const snapshotCoordinator = new RemoteRuntimeTerminalRecoveryCoordinator(
      'snapshot-env',
      snapshotHarness.dependencies
    )
    let snapshotReplacement: RemoteRuntimeTerminalRecoveryParticipant | undefined
    snapshotCoordinator.register(
      participant('snapshot-first', 'wt-1', {
        resolve: () => ({ kind: 'gone' }),
        onGone: () => {
          snapshotReplacement = participant('snapshot-replacement', 'wt-1', {
            resolve: (value) => ({
              kind: 'ready',
              handle: value?.tabs[0]?.terminal ?? 'missing'
            })
          })
          snapshotCoordinator.register(snapshotReplacement)
        }
      })
    )
    await flush()

    snapshotHarness.calls[0]?.args.onSnapshot(snapshot(1))
    await flush()

    expect.soft(snapshotReplacement?.resolveHandle).not.toHaveBeenCalledWith(snapshot(1))
    expect.soft(snapshotHarness.calls).toHaveLength(2)
    snapshotHarness.calls[1]?.args.onSnapshot(snapshot(2))
    await flush()
    expect(snapshotReplacement?.resolveHandle).toHaveBeenCalledWith(snapshot(2))
    expect(snapshotReplacement?.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'snapshot-2', signal: expect.any(AbortSignal) })
    )
  })

  it('keeps established recoverable errors logical, retries only on close, and stops fatal close', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const waiting = participant('waiting', 'wt-1', { resolve: () => ({ kind: 'pending' }) })
    const waitingLease = coordinator.register(waiting)
    await flush()
    h.calls[0]?.args.onError(OFFLINE)
    await flush()
    expect(h.calls).toHaveLength(1)
    expect(h.timers.size).toBe(0)
    h.calls[0]?.args.onClose()
    await flush()
    expect([...h.timers.values()][0]?.delayMs).toBe(250)
    waitingLease.cancel()

    const fatalHarness = createHarness()
    const fatalCoordinator = new RemoteRuntimeTerminalRecoveryCoordinator(
      'fatal-env',
      fatalHarness.dependencies
    )
    const fatal = participant('fatal', 'wt-2', { resolve: () => ({ kind: 'pending' }) })
    fatalCoordinator.register(fatal)
    await flush()
    const fatalCall = fatalHarness.calls[0]
    fatalCall?.args.onError({ code: 'unauthorized', message: 'denied' })
    fatalCall?.args.onClose()
    await flush()
    expect(fatal.onFatal).toHaveBeenCalledTimes(1)
    expect(fatal.onFatal).toHaveBeenCalledWith({ code: 'unauthorized', message: 'denied' })
    expect(fatalHarness.timers.size).toBe(0)
  })

  it.each(['terminal_handle_stale', 'terminal_exited', 'terminal_gone', 'no_connected_pty'])(
    'retires direct terminal errors with code %s',
    async (code) => {
      const h = createHarness()
      const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
      const gone = participant('gone', null, {
        rebind: vi.fn().mockRejectedValue({ code, message: code })
      })
      coordinator.register(gone)
      await flush()
      expect(gone.onGone).toHaveBeenCalledTimes(1)
      expect(gone.onFatal).not.toHaveBeenCalled()
    }
  )

  it('classifies rebind failures and invokes gone/fatal callbacks once', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const gone = participant('gone', null, { resolve: () => ({ kind: 'gone' }) })
    const fatal = participant('fatal', null, {
      rebind: vi.fn().mockRejectedValue({ code: 'runtime_error', message: 'bad args' })
    })
    coordinator.register(gone)
    coordinator.register(fatal)
    await flush()
    expect(gone.onGone).toHaveBeenCalledTimes(1)
    expect(fatal.onFatal).toHaveBeenCalledTimes(1)
    coordinator.retryNow()
    expect(gone.onGone).toHaveBeenCalledTimes(1)
    expect(fatal.onFatal).toHaveBeenCalledTimes(1)
  })

  it('uses cached snapshots for late joiners and prevents concurrent participant rebinds', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const first = participant('first', 'wt-1', { resolve: () => ({ kind: 'pending' }) })
    coordinator.register(first)
    await flush()
    h.calls[0]?.args.onSnapshot(snapshot())
    const attempts: { resolve: () => void }[] = []
    const late = participant('late', 'wt-1', {
      rebind: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            attempts.push({ resolve })
          })
      )
    })
    coordinator.register(late)
    await flush()
    expect(late.rebind).toHaveBeenCalledTimes(1)
    h.calls[0]?.args.onSnapshot(snapshot(2))
    expect(late.rebind).toHaveBeenCalledTimes(1)
    attempts[0]?.resolve()
    await flush()
  })

  it('supersedes duplicate ids without allowing the old cancel to remove the new token', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const pending: { signal: AbortSignal; resolve: () => void }[] = []
    const old = participant('same', null, {
      rebind: vi.fn(
        ({ signal }) =>
          new Promise<void>((resolve) => {
            pending.push({ signal, resolve })
          })
      )
    })
    const oldLease = coordinator.register(old)
    await flush()
    const current = participant('same', null)
    coordinator.register(current)
    await flush()
    expect(pending[0]?.signal.aborted).toBe(true)
    oldLease.cancel()
    expect(current.rebind).toHaveBeenCalledTimes(1)
  })

  it('isolates throwing and reentrant callbacks while still reaching idle once', async () => {
    const h = createHarness()
    const onIdle = vi.fn()
    h.dependencies.onIdle = onIdle
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    let fatalLease: { cancel: () => void }
    coordinator.register(
      participant('gone', null, {
        resolve: () => ({ kind: 'gone' }),
        onGone: () => {
          throw new Error('consumer failed')
        }
      })
    )
    fatalLease = coordinator.register(
      participant('fatal', null, {
        resolve: () => ({ kind: 'pending' }),
        onFatal: () => fatalLease.cancel()
      })
    )
    await flush()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('does not apply a stale fatal event to a reentrant registration', async () => {
    const h = createHarness()
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    const replacements: RemoteRuntimeTerminalRecoveryParticipant[] = []
    const firstFatal = vi.fn(() => {
      const replacement = participant('replacement', 'wt-1')
      replacements.push(replacement)
      coordinator.register(replacement)
    })
    const first = participant('first', 'wt-1', {
      resolve: () => ({ kind: 'pending' }),
      onFatal: firstFatal
    })
    const sibling = participant('sibling', 'wt-1', { resolve: () => ({ kind: 'pending' }) })
    coordinator.register(first)
    coordinator.register(sibling)
    await flush()

    h.calls[0]?.args.onError({ code: 'unauthorized', message: 'denied' })
    await flush()
    expect(firstFatal).toHaveBeenCalledTimes(1)
    expect(sibling.onFatal).toHaveBeenCalledTimes(1)
    expect(replacements[0]?.onFatal).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(2)
    h.calls[1]?.args.onSnapshot(snapshot(2))
    await flush()
    expect(replacements[0]?.rebind).toHaveBeenCalledTimes(1)
  })

  it('resumes a deferred retry when an early-snapshot start handle resolves late', async () => {
    const h = createHarness()
    h.deferNext()
    const rebindCalls: { signal: AbortSignal; abortedAtCall: boolean }[] = []
    const rebind = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      rebindCalls.push({ signal, abortedAtCall: signal.aborted })
      if (rebindCalls.length === 1) {
        throw OFFLINE
      }
    })
    const recovering = participant('recovering', 'wt-1', { rebind })
    const coordinator = new RemoteRuntimeTerminalRecoveryCoordinator('env-1', h.dependencies)
    coordinator.register(recovering)
    await flush()

    h.calls[0]?.args.onSnapshot(snapshot(1))
    await flush()
    expect([...h.timers.values()][0]?.delayMs).toBe(250)

    await h.fireTimer()
    expect(h.calls).toHaveLength(1)
    h.calls[0]?.resolve?.()
    await flush()

    expect(h.calls).toHaveLength(2)
    expect(h.calls[0]?.handle.unsubscribe).toHaveBeenCalledTimes(1)
    h.calls[1]?.args.onSnapshot(snapshot(2))
    await flush()
    expect(rebind).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ signal: expect.anything() })
    )
    expect(rebindCalls).toHaveLength(2)
    expect(rebindCalls[0]?.signal.aborted).toBe(true)
    expect(rebindCalls[1]?.signal).not.toBe(rebindCalls[0]?.signal)
    expect(rebindCalls.every((call) => !call.abortedAtCall)).toBe(true)
  })
})

type BridgeCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onError: (error: { code: string; message: string }) => void
  onClose: () => void
}

function success(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('module recovery adapter', () => {
  it('adapts snapshot and updated events, end, failed responses, and malformed results', async () => {
    vi.useFakeTimers()
    const callbacks: BridgeCallbacks[] = []
    const subscribe = vi.fn(async (_args: unknown, next: BridgeCallbacks) => {
      callbacks.push(next)
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })

    const updated = participant('updated', 'wt-updated', {
      resolve: (value) =>
        value?.tabs[0]?.terminal === 'snapshot-2'
          ? { kind: 'ready', handle: 'fresh' }
          : { kind: 'pending' }
    })
    const updatedLease = beginRemoteRuntimeTerminalRecovery({
      environmentId: 'adapter-updated',
      participant: updated
    })
    await flush()
    callbacks[0]?.onResponse(success({ type: 'snapshot', ...snapshot(1) }))
    callbacks[0]?.onResponse(success({ type: 'updated', ...snapshot(2) }))
    await flush()
    expect(updated.rebind).toHaveBeenCalledWith(expect.objectContaining({ handle: 'fresh' }))
    updatedLease.cancel()

    const ended = participant('ended', 'wt-ended', { resolve: () => ({ kind: 'pending' }) })
    const endedLease = beginRemoteRuntimeTerminalRecovery({
      environmentId: 'adapter-ended',
      participant: ended
    })
    await flush()
    callbacks[1]?.onResponse(success({ type: 'end' }))
    await vi.advanceTimersByTimeAsync(250)
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(3)
    endedLease.cancel()

    const failed = participant('failed', 'wt-failed')
    beginRemoteRuntimeTerminalRecovery({ environmentId: 'adapter-failed', participant: failed })
    await flush()
    callbacks[3]?.onResponse({
      id: 'rpc-failed',
      ok: false,
      error: { code: 'unauthorized', message: 'denied' }
    })
    await flush()
    expect(failed.onFatal).toHaveBeenCalledWith({ code: 'unauthorized', message: 'denied' })

    const malformed = participant('malformed', 'wt-malformed')
    beginRemoteRuntimeTerminalRecovery({
      environmentId: 'adapter-malformed',
      participant: malformed
    })
    await flush()
    callbacks[4]?.onResponse(success({ type: 'unknown' }))
    await flush()
    expect(malformed.onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_runtime_response' })
    )
  })

  it('normalizes unknown startup rejection and keeps the replacement singleton current', async () => {
    vi.useFakeTimers()
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge broke'))
      .mockRejectedValue(OFFLINE)
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    const unknown = participant('unknown', 'wt-1')
    beginRemoteRuntimeTerminalRecovery({ environmentId: 'unknown-env', participant: unknown })
    await flush()
    expect(unknown.onFatal).toHaveBeenCalledWith({ code: 'runtime_error', message: 'bridge broke' })

    const old = beginRemoteRuntimeTerminalRecovery({
      environmentId: 'same-env',
      participant: participant('old', 'wt-1')
    })
    await flush()
    old.cancel()
    const current = beginRemoteRuntimeTerminalRecovery({
      environmentId: 'same-env',
      participant: participant('current', 'wt-1')
    })
    await flush()
    const beforeRetry = subscribe.mock.calls.length
    old.cancel()
    retryRemoteRuntimeTerminalRecoveriesNow()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(beforeRetry + 1)
    current.cancel()
    current.cancel()
  })

  it('rejects malformed recovery tab records before host resolution', async () => {
    const callbacks: BridgeCallbacks[] = []
    const subscribe = vi.fn(async (_args: unknown, next: BridgeCallbacks) => {
      callbacks.push(next)
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    const terminalBase = {
      type: 'terminal',
      id: 'pane:1',
      title: 'Terminal',
      parentTabId: 'tab-1',
      leafId: 'pane:1',
      isActive: true
    }
    const malformedTabs = [
      null,
      { id: 'future-1', title: 'Future surface', isActive: true },
      { ...terminalBase, terminal: 'terminal-1' },
      { ...terminalBase, status: 'starting', terminal: null },
      { ...terminalBase, status: 'ready' },
      { ...terminalBase, status: 'ready', terminal: 42 },
      { ...terminalBase, status: 'ready', terminal: '' },
      {
        type: 'terminal',
        title: 'Terminal',
        leafId: 'pane:1',
        isActive: true,
        status: 'pending-handle',
        terminal: null
      },
      { ...terminalBase, status: 'pending-handle', terminal: 'terminal-1' }
    ]
    const leases: { cancel: () => void }[] = []

    for (const [index, tab] of malformedTabs.entries()) {
      const malformed = participant(`malformed-tab-${index}`, `wt-${index}`, {
        resolve: (value) =>
          resolveRemoteRuntimeHostTerminal(value!, { hostTabId: 'tab-1', leafId: 'pane:1' })
      })
      leases.push(
        beginRemoteRuntimeTerminalRecovery({
          environmentId: `adapter-malformed-tab-${index}`,
          participant: malformed
        })
      )
      await flush()
      callbacks[index]?.onResponse(
        success({ type: 'snapshot', ...snapshot(index + 1), tabs: [tab] })
      )
      await flush()

      expect.soft(malformed.resolveHandle).not.toHaveBeenCalled()
      expect.soft(malformed.rebind).not.toHaveBeenCalled()
      expect.soft(malformed.onGone).not.toHaveBeenCalled()
      expect
        .soft(malformed.onFatal)
        .toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_runtime_response' }))
    }
    leases.forEach((lease) => lease.cancel())
  })

  it('ignores future non-terminal tab types while preserving valid terminal recovery', async () => {
    const callbacks: BridgeCallbacks[] = []
    const subscribe = vi.fn(async (_args: unknown, next: BridgeCallbacks) => {
      callbacks.push(next)
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    const recovering = participant('future-tab', 'wt-1', {
      resolve: (value) => {
        expect(value).toEqual({
          tabs: [expect.objectContaining({ type: 'terminal', terminal: 'terminal-1' })]
        })
        return resolveRemoteRuntimeHostTerminal(value!, {
          hostTabId: 'tab-1',
          leafId: 'pane:1'
        })
      }
    })
    const lease = beginRemoteRuntimeTerminalRecovery({
      environmentId: 'adapter-future-tab',
      participant: recovering
    })
    await flush()

    callbacks[0]?.onResponse(
      success({
        type: 'snapshot',
        tabs: [
          {
            type: 'canvas',
            futurePayload: { version: 1 }
          },
          {
            type: 'terminal',
            id: 'pane:1',
            title: 'Terminal',
            parentTabId: 'tab-1',
            leafId: 'pane:1',
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]
      })
    )
    await flush()

    expect(recovering.onFatal).not.toHaveBeenCalled()
    expect(recovering.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'terminal-1' })
    )
    lease.cancel()
  })
})
