import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeTerminalRecoverySnapshot } from '../../runtime/remote-runtime-terminal-recovery-coordinator'
import {
  installRemoteRuntimePtyRecoveryFixture,
  type RecoveryStreamRecord
} from './remote-runtime-pty-recovery-test-fixture'

const recoverableClose = {
  code: 'remote_runtime_unavailable',
  message: 'Remote Orca runtime connection closed.'
}

function readySnapshot(handle: string): RemoteRuntimeTerminalRecoverySnapshot {
  return {
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab::pane:1',
        parentTabId: 'host-tab',
        leafId: 'pane:1',
        title: 'Terminal',
        isActive: true,
        status: 'ready',
        terminal: handle
      }
    ]
  }
}

async function beginStagedRebind(args: {
  fixture: ReturnType<typeof installRemoteRuntimePtyRecoveryFixture>
  initial: RecoveryStreamRecord
  handle?: string
  signal?: AbortSignal
}): Promise<{
  promise: Promise<void>
  staged: RecoveryStreamRecord
  participant: ReturnType<
    typeof installRemoteRuntimePtyRecoveryFixture
  >['registrations'][number]['participant']
}> {
  args.initial.args.callbacks.onTransportClose?.(recoverableClose)
  expect(args.fixture.registrations).toHaveLength(1)
  const participant = args.fixture.registrations[0].participant
  const promise = participant.rebind({
    handle: args.handle ?? 'terminal-2',
    signal: args.signal ?? new AbortController().signal
  })
  await args.fixture.settle()
  const staged = args.fixture.streams.at(-1)
  if (!staged || staged === args.initial) {
    throw new Error('missing staged terminal subscription')
  }
  return { promise, staged, participant }
}

describe('remote runtime PTY recovery binding lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('buffers the staged snapshot and commits exactly once on the first subscribed event', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onConnect = vi.fn()
    const onStatus = vi.fn()
    const onError = vi.fn()
    const onPtySpawn = vi.fn()
    const transport = await fixture.createAttachedTransport({
      options: { onPtySpawn },
      callbacks: { onReplayData, onData, onConnect, onStatus, onError }
    })
    const initial = fixture.streams[0]
    initial.args.callbacks.onSubscribed?.()
    onConnect.mockClear()
    onStatus.mockClear()

    const { promise, staged } = await beginStagedRebind({ fixture, initial })
    let settled = false
    void promise.then(() => {
      settled = true
    })
    staged.args.callbacks.onSnapshot('authoritative', { pendingEscapeTailAnsi: '\u001b[' })

    await fixture.settle()
    expect(settled).toBe(false)
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(onReplayData).not.toHaveBeenCalled()
    expect(onPtySpawn).not.toHaveBeenCalled()

    staged.args.callbacks.onSubscribed?.()
    await expect(promise).resolves.toBeUndefined()

    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2')
    expect(onPtySpawn).toHaveBeenCalledWith('remote:env-1@@terminal-2')
    expect(onReplayData).toHaveBeenCalledWith('authoritative', {
      pendingEscapeTailAnsi: '\u001b['
    })
    expect(onConnect).toHaveBeenCalledOnce()
    expect(onStatus).toHaveBeenCalledOnce()
    expect(onStatus).toHaveBeenCalledWith('shell')

    staged.args.callbacks.onSnapshot('resync')
    staged.args.callbacks.onSubscribed?.()
    staged.args.callbacks.onData('live')
    initial.args.callbacks.onSnapshot('late-old-snapshot')
    initial.args.callbacks.onData('late-old-data')
    initial.args.callbacks.onEnd?.()
    initial.args.callbacks.onError?.('late old error')
    initial.args.callbacks.onTransportClose?.(recoverableClose)

    expect(onReplayData).toHaveBeenCalledTimes(2)
    expect(onReplayData).not.toHaveBeenCalledWith('late-old-snapshot', expect.anything())
    expect(onData).toHaveBeenCalledWith('live')
    expect(onData).not.toHaveBeenCalledWith('late-old-data', expect.anything())
    expect(onPtySpawn).toHaveBeenCalledOnce()
    expect(onConnect).toHaveBeenCalledOnce()
    expect(onStatus).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2')
  })

  it('keeps input paused until authoritative replay precedes commit notifications', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    const events: string[] = []
    let transport!: Awaited<ReturnType<typeof fixture.createAttachedTransport>>
    const onPtySpawn = vi.fn(() => events.push('spawn'))
    transport = await fixture.createAttachedTransport({
      options: { onPtySpawn },
      callbacks: {
        onReplayData: () => {
          events.push(`replay:${transport.sendInput('during replay')}`)
        },
        onConnect: () => events.push('connect'),
        onStatus: () => events.push('status')
      }
    })
    const initial = fixture.streams[0]
    const { promise, staged } = await beginStagedRebind({ fixture, initial })

    staged.args.callbacks.onSnapshot('authoritative')
    staged.args.callbacks.onSubscribed?.()
    await promise

    expect(events).toEqual(['replay:false', 'spawn', 'connect', 'status'])
    expect(transport.sendInput('after replay')).toBe(true)
  })

  it('keeps input and live output paused until asynchronous replay finishes', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    let finishReplay!: () => void
    const replayFinished = new Promise<void>((resolve) => {
      finishReplay = resolve
    })
    const onReplayData = vi.fn(() => replayFinished)
    const onData = vi.fn()
    const onConnect = vi.fn()
    const transport = await fixture.createAttachedTransport({
      callbacks: { onReplayData, onData, onConnect }
    })
    const initial = fixture.streams[0]
    const { promise, staged } = await beginStagedRebind({ fixture, initial })

    staged.args.callbacks.onSnapshot('authoritative')
    staged.args.callbacks.onSubscribed?.()
    staged.args.callbacks.onData('live-after-snapshot')
    await fixture.settle()

    expect(onReplayData).toHaveBeenCalledWith('authoritative')
    expect(transport.sendInput('while replay is parsing')).toBe(false)
    expect(onData).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()

    finishReplay()
    await expect(promise).resolves.toBeUndefined()

    expect(onData).toHaveBeenCalledWith('live-after-snapshot')
    expect(onConnect).toHaveBeenCalledOnce()
    expect(transport.sendInput('after replay parsed')).toBe(true)
  })

  it('does not reopen an activated binding aborted during asynchronous replay', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    let finishReplay!: () => void
    const replayFinished = new Promise<void>((resolve) => {
      finishReplay = resolve
    })
    const onConnect = vi.fn()
    const transport = await fixture.createAttachedTransport({
      callbacks: { onReplayData: () => replayFinished, onConnect }
    })
    const initial = fixture.streams[0]
    const abort = new AbortController()
    const { promise, staged } = await beginStagedRebind({
      fixture,
      initial,
      signal: abort.signal
    })

    staged.args.callbacks.onSnapshot('authoritative')
    staged.args.callbacks.onSubscribed?.()
    await fixture.settle()
    abort.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    finishReplay()
    await fixture.settle()

    expect(staged.stream.close).toHaveBeenCalledOnce()
    expect(onConnect).not.toHaveBeenCalled()
    expect(transport.sendInput('aborted binding')).toBe(false)
  })

  it('drops queued live output superseded by a newer authoritative snapshot', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    let finishInitialReplay!: () => void
    const initialReplayFinished = new Promise<void>((resolve) => {
      finishInitialReplay = resolve
    })
    const onReplayData = vi.fn((data: string) =>
      data === 'initial snapshot' ? initialReplayFinished : undefined
    )
    const onData = vi.fn()
    const transport = await fixture.createAttachedTransport({ callbacks: { onReplayData, onData } })
    const initial = fixture.streams[0]
    const { promise, staged } = await beginStagedRebind({ fixture, initial })

    staged.args.callbacks.onSnapshot('initial snapshot')
    staged.args.callbacks.onSubscribed?.()
    staged.args.callbacks.onData('before newer snapshot')
    staged.args.callbacks.onSnapshot('newer snapshot')
    staged.args.callbacks.onData('after newer snapshot')
    await fixture.settle()

    finishInitialReplay()
    await promise

    expect(onReplayData.mock.calls.map(([data]) => data)).toEqual([
      'initial snapshot',
      'newer snapshot'
    ])
    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('after newer snapshot')
    expect(transport.sendInput('after resync replay')).toBe(true)
  })

  it('delivers an empty authoritative snapshot so stale terminal contents are cleared', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    const onReplayData = vi.fn()
    const transport = await fixture.createAttachedTransport({ callbacks: { onReplayData } })
    const initial = fixture.streams[0]
    const { promise, staged } = await beginStagedRebind({ fixture, initial })

    staged.args.callbacks.onSnapshot('')
    staged.args.callbacks.onSubscribed?.()
    await promise

    expect(onReplayData).toHaveBeenCalledWith('')
    expect(transport.sendInput('after empty replay')).toBe(true)
  })

  it('drops old deferred OSC effects when replay reattaches the transport', async () => {
    vi.useFakeTimers()
    try {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const onPtySpawn = vi.fn()
      const onTitleChange = vi.fn()
      const onBell = vi.fn()
      const onAgentStatus = vi.fn()
      const oldConnect = vi.fn()
      const oldStatus = vi.fn()
      let transport!: Awaited<ReturnType<typeof fixture.createAttachedTransport>>
      transport = await fixture.createAttachedTransport({
        options: { onPtySpawn, onTitleChange, onBell, onAgentStatus },
        callbacks: {
          onReplayData: () => {
            transport.attach({
              existingPtyId: 'remote:env-1@@terminal-manual',
              callbacks: {}
            })
          },
          onConnect: oldConnect,
          onStatus: oldStatus
        }
      })
      const initial = fixture.streams[0]
      const { promise, staged } = await beginStagedRebind({ fixture, initial })

      staged.args.callbacks.onSnapshot(
        '\u001b]0;old recovery title\u0007\u001b]9999;{"state":"working"}\u0007\u0007'
      )
      staged.args.callbacks.onSubscribed?.()
      await promise
      await fixture.settle()
      await vi.runAllTimersAsync()

      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-manual')
      expect(onPtySpawn).not.toHaveBeenCalled()
      expect(oldConnect).not.toHaveBeenCalled()
      expect(oldStatus).not.toHaveBeenCalled()
      expect(onTitleChange).not.toHaveBeenCalled()
      expect(onAgentStatus).not.toHaveBeenCalled()
      expect(onBell).not.toHaveBeenCalled()
      expect(transport.sendInput('manual binding')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not concatenate partial live OSC state across a reentrant attach', async () => {
    vi.useFakeTimers()
    try {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const onAgentStatus = vi.fn()
      const onTitleChange = vi.fn()
      let transport!: Awaited<ReturnType<typeof fixture.createAttachedTransport>>
      let reattached = false
      transport = await fixture.createAttachedTransport({
        options: { onAgentStatus, onTitleChange },
        callbacks: {
          onData: () => {
            if (!reattached) {
              reattached = true
              transport.attach({
                existingPtyId: 'remote:env-1@@terminal-1',
                callbacks: {}
              })
            }
          }
        }
      })
      const initial = fixture.streams[0]
      initial.args.callbacks.onSubscribed?.()
      const statusOsc =
        '\u001b]9999;{"state":"working","prompt":"cross binding","agentType":"codex"}\u0007'
      const splitAt = statusOsc.indexOf(',"prompt"')

      initial.args.callbacks.onData(statusOsc.slice(0, splitAt))
      await fixture.settle()
      const replacement = fixture.streams[1]
      replacement.args.callbacks.onData(statusOsc.slice(splitAt))
      await vi.runAllTimersAsync()

      expect(onAgentStatus).not.toHaveBeenCalled()
      expect(onTitleChange).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears full live OSC title and bell effects queued after reentrant attach', async () => {
    vi.useFakeTimers()
    try {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const onAgentStatus = vi.fn()
      const onTitleChange = vi.fn()
      const onBell = vi.fn()
      let transport!: Awaited<ReturnType<typeof fixture.createAttachedTransport>>
      transport = await fixture.createAttachedTransport({
        options: { onAgentStatus, onTitleChange, onBell },
        callbacks: {
          onData: () =>
            transport.attach({
              existingPtyId: 'remote:env-1@@terminal-1',
              callbacks: {}
            })
        }
      })
      const initial = fixture.streams[0]
      initial.args.callbacks.onSubscribed?.()

      initial.args.callbacks.onData(
        '\u001b]9999;{"state":"working"}\u0007\u001b]0;old live title\u0007\u0007'
      )
      await fixture.settle()
      await vi.runAllTimersAsync()

      expect(onAgentStatus).not.toHaveBeenCalled()
      expect(onTitleChange).not.toHaveBeenCalled()
      expect(onBell).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['transport-close', 'stream-error', 'stream-end', 'abort', 'startup'] as const)(
    'settles a staged %s once without mutating the committed binding',
    async (failure) => {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const onReplayData = vi.fn()
      const onError = vi.fn()
      const onPtySpawn = vi.fn()
      const transport = await fixture.createAttachedTransport({
        options: { onPtySpawn },
        callbacks: { onReplayData, onError }
      })
      const initial = fixture.streams[0]
      const abort = new AbortController()
      initial.args.callbacks.onTransportClose?.(recoverableClose)
      expect(fixture.registrations).toHaveLength(1)
      if (failure === 'startup') {
        fixture.subscribeTerminal.mockRejectedValueOnce({
          code: 'runtime_timeout',
          message: 'staged startup timed out'
        })
      }
      const promise = fixture.registrations[0].participant.rebind({
        handle: 'terminal-2',
        signal: abort.signal
      })
      await fixture.settle()
      const staged = failure === 'startup' ? null : fixture.streams.at(-1)!

      if (failure === 'transport-close') {
        staged?.args.callbacks.onTransportClose?.({
          code: 'runtime_timeout',
          message: 'staged stream timed out'
        })
      } else if (failure === 'stream-error') {
        staged?.args.callbacks.onError?.('staged terminal error')
      } else if (failure === 'stream-end') {
        staged?.args.callbacks.onEnd?.()
      } else if (failure === 'abort') {
        abort.abort()
      }

      const error = await promise.catch((reason: unknown) => reason)
      if (failure === 'transport-close') {
        expect(error).toMatchObject({ code: 'runtime_timeout' })
      } else if (failure === 'stream-end') {
        expect(error).toMatchObject({ code: 'terminal_gone' })
      } else if (failure === 'abort') {
        expect(error).toMatchObject({ name: 'AbortError' })
      } else if (failure === 'startup') {
        expect(error).toMatchObject({ code: 'runtime_timeout' })
      } else {
        expect(error).toMatchObject({ code: 'runtime_error' })
      }
      staged?.args.callbacks.onSubscribed?.()
      staged?.args.callbacks.onEnd?.()

      if (staged) {
        expect(staged.stream.close).toHaveBeenCalledOnce()
      }
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(onReplayData).not.toHaveBeenCalled()
      expect(onPtySpawn).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
    }
  )

  it('distinguishes duplicate committed, staged, and current committed close sources', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    const transport = await fixture.createAttachedTransport()
    const initial = fixture.streams[0]
    const first = await beginStagedRebind({ fixture, initial, handle: 'terminal-1' })

    initial.args.callbacks.onTransportClose?.(recoverableClose)
    expect(fixture.registrations).toHaveLength(1)

    first.staged.args.callbacks.onTransportClose?.({
      code: 'runtime_timeout',
      message: 'staged attempt closed'
    })
    await expect(first.promise).rejects.toMatchObject({ code: 'runtime_timeout' })
    expect(fixture.registrations).toHaveLength(1)

    const retryPromise = first.participant.rebind({
      handle: 'terminal-1',
      signal: new AbortController().signal
    })
    await fixture.settle()
    const committed = fixture.streams.at(-1)!
    committed.args.callbacks.onSubscribed?.()
    await expect(retryPromise).resolves.toBeUndefined()

    first.staged.args.callbacks.onTransportClose?.(recoverableClose)
    expect(fixture.registrations).toHaveLength(1)
    committed.args.callbacks.onTransportClose?.(recoverableClose)
    expect(fixture.registrations).toHaveLength(2)
    expect(fixture.registrations[0].participant.id).toBe(fixture.registrations[1].participant.id)
    expect(transport.sendInput('paused-again')).toBe(false)
  })

  it('fences same-handle reattach callbacks and ignores attach after destroy', async () => {
    vi.useFakeTimers()
    try {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const oldData = vi.fn()
      const currentData = vi.fn()
      const currentReplay = vi.fn()
      const currentError = vi.fn()
      const onTitleChange = vi.fn()
      const transport = await fixture.createAttachedTransport({
        options: { onTitleChange },
        callbacks: { onData: oldData }
      })
      const initial = fixture.streams[0]

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        cols: 90,
        rows: 30,
        callbacks: { onData: currentData, onReplayData: currentReplay, onError: currentError }
      })
      await fixture.settle()
      const replacement = fixture.streams[1]
      initial.args.callbacks.onSnapshot('late\u001b]0;old title\u0007')
      initial.args.callbacks.onData('late old data')
      initial.args.callbacks.onEnd?.()
      initial.args.callbacks.onError?.('late old error')
      replacement.args.callbacks.onData('current data')
      await vi.runAllTimersAsync()

      expect(initial.stream.close).toHaveBeenCalledOnce()
      expect(oldData).not.toHaveBeenCalled()
      expect(currentReplay).not.toHaveBeenCalled()
      expect(onTitleChange).not.toHaveBeenCalled()
      expect(currentData).toHaveBeenCalledWith('current data')
      expect(currentError).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')

      transport.destroy?.()
      const streamCount = fixture.streams.length
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-after-destroy',
        callbacks: { onError: currentError }
      })
      await fixture.settle()

      expect(fixture.streams).toHaveLength(streamCount)
      expect(transport.getPtyId()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a stable participant id and routes host versus direct handle resolution', async () => {
    const directFixture = installRemoteRuntimePtyRecoveryFixture()
    const direct = await directFixture.createAttachedTransport()
    directFixture.streams[0].args.callbacks.onTransportClose?.(recoverableClose)
    const directParticipant = directFixture.registrations[0].participant

    expect(directParticipant.worktreeId).toBeNull()
    expect(directParticipant.resolveHandle(null)).toEqual({
      kind: 'ready',
      handle: 'terminal-1'
    })

    const directRebind = directParticipant.rebind({
      handle: 'terminal-1',
      signal: new AbortController().signal
    })
    await directFixture.settle()
    directFixture.streams.at(-1)?.args.callbacks.onSubscribed?.()
    await directRebind
    directFixture.streams.at(-1)?.args.callbacks.onTransportClose?.(recoverableClose)
    expect(directFixture.registrations[1].participant.id).toBe(directParticipant.id)
    expect(direct.sendInput('paused')).toBe(false)

    vi.resetModules()
    const hostFixture = installRemoteRuntimePtyRecoveryFixture()
    const host = await hostFixture.createAttachedTransport({
      options: { tabId: 'web-terminal-host-tab', leafId: 'pane:1' }
    })
    hostFixture.streams[0].args.callbacks.onTransportClose?.(recoverableClose)
    const hostParticipant = hostFixture.registrations[0].participant

    expect(hostParticipant.worktreeId).toBe('wt-1')
    expect(hostParticipant.resolveHandle(readySnapshot('terminal-2'))).toEqual({
      kind: 'ready',
      handle: 'terminal-2'
    })
    expect(hostParticipant.resolveHandle({ ...readySnapshot('terminal-2'), tabs: [] })).toEqual({
      kind: 'gone'
    })
    expect(host.sendInput('paused')).toBe(false)
  })
})
