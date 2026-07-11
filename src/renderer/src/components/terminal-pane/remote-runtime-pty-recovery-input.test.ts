import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { installRemoteRuntimePtyRecoveryFixture } from './remote-runtime-pty-recovery-test-fixture'

const recoverableClose = {
  code: 'remote_runtime_unavailable',
  message: 'Remote Orca runtime connection closed.'
}

describe('remote runtime PTY recovery input and viewport fencing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('clears queued input, rejects recovery input, and converges the latest viewport', async () => {
    vi.useFakeTimers()
    try {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const transport = await fixture.createAttachedTransport()
      const initial = fixture.streams[0]

      expect(transport.sendInput('queued-before-recovery')).toBe(true)
      initial.args.callbacks.onTransportClose?.(recoverableClose)

      expect(transport.sendInput('during recovery')).toBe(false)
      expect(transport.sendInputImmediate('during recovery')).toBe(false)
      await expect(transport.sendInputAccepted?.('during recovery')).resolves.toBe(false)
      expect(transport.resize(132, 44)).toBe(true)
      await vi.runAllTimersAsync()

      expect(initial.stream.sendInput).not.toHaveBeenCalled()
      expect(fixture.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )
      expect(fixture.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.updateViewport' })
      )

      const rebind = fixture.registrations[0].participant.rebind({
        handle: 'terminal-2',
        generation: 4,
        signal: new AbortController().signal
      })
      await fixture.settle()
      const staged = fixture.streams.at(-1)!
      expect(staged.args.viewport).toEqual({ cols: 132, rows: 44 })

      expect(transport.resize(140, 50)).toBe(true)
      expect(staged.stream.resize).not.toHaveBeenCalled()
      staged.args.callbacks.onSubscribed?.()
      await rebind

      expect(staged.stream.resize).toHaveBeenCalledOnce()
      expect(staged.stream.resize).toHaveBeenCalledWith(140, 50)
      expect(fixture.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.updateViewport' })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send the next acknowledged chunk after recovery changes generation', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    let resolveFirstSend!: (value: unknown) => void
    let sendCount = 0
    fixture.runtimeCall.mockImplementation(
      (args: { method: string; params?: { text?: string } }) => {
        if (args.method !== 'terminal.send') {
          return Promise.resolve({ ok: true, result: {} })
        }
        sendCount += 1
        if (sendCount > 1) {
          return Promise.resolve({
            ok: true,
            result: {
              send: {
                handle: 'terminal-1',
                accepted: true,
                bytesWritten: args.params?.text?.length ?? 0
              }
            }
          })
        }
        return new Promise((resolve) => {
          resolveFirstSend = resolve
        })
      }
    )
    const transport = await fixture.createAttachedTransport()
    const initial = fixture.streams[0]
    const firstChunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    const input = `${firstChunk}tail`
    expect([...iterateTerminalInputChunks(input)]).toHaveLength(2)

    const accepted = transport.sendInputAccepted?.(input)
    await vi.waitFor(() =>
      expect(
        fixture.runtimeCall.mock.calls.filter((call) => call[0].method === 'terminal.send')
      ).toHaveLength(1)
    )
    initial.args.callbacks.onTransportClose?.(recoverableClose)
    resolveFirstSend({
      ok: true,
      result: {
        send: { handle: 'terminal-1', accepted: true, bytesWritten: firstChunk.length }
      }
    })

    await expect(accepted).resolves.toBe(false)
    expect(
      fixture.runtimeCall.mock.calls.filter((call) => call[0].method === 'terminal.send')
    ).toHaveLength(1)
  })

  it('returns false when deferred acknowledged-input validation crosses recovery', async () => {
    vi.useFakeTimers()
    try {
      const fixture = installRemoteRuntimePtyRecoveryFixture()
      const transport = await fixture.createAttachedTransport()
      const initial = fixture.streams[0]
      const input = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      const accepted = transport.sendInputAccepted?.(input)
      await Promise.resolve()
      initial.args.callbacks.onTransportClose?.(recoverableClose)
      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(false)
      expect(fixture.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an old immediate fallback rejection after a same-handle commit', async () => {
    const fixture = installRemoteRuntimePtyRecoveryFixture()
    let rejectFallback!: (error: Error) => void
    fixture.runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.send') {
        return new Promise((_resolve, reject) => {
          rejectFallback = reject
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = await fixture.createAttachedTransport({
      options: { onPtyExit },
      callbacks: { onError }
    })
    const initial = fixture.streams[0]
    initial.stream.sendInput.mockReturnValue(false)

    expect(transport.sendInputImmediate('old fallback')).toBe(true)
    initial.args.callbacks.onTransportClose?.(recoverableClose)
    const rebind = fixture.registrations[0].participant.rebind({
      handle: 'terminal-1',
      generation: 5,
      signal: new AbortController().signal
    })
    await fixture.settle()
    const committed = fixture.streams.at(-1)!
    committed.args.callbacks.onSubscribed?.()
    await rebind

    rejectFallback(new Error('terminal_gone'))
    await fixture.settle()

    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(transport.isConnected()).toBe(true)
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
