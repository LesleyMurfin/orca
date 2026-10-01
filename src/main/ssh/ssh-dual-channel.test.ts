import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import {
  SshChannelMultiplexer,
  type DualChannelTransports,
  type MultiplexerTransport
} from './ssh-channel-multiplexer'
import { SingleChannelState } from './ssh-dual-channel-state'
import { encodeFrame, MessageType, HEADER_LENGTH } from './relay-protocol'

// Why: the interactive (PTY/keystroke) and background (fs scan/git) RPC lanes
// must live on physically separate transports — a shared TCP channel still
// head-of-line-blocks keystroke echo behind a large `fs.listFiles` response
// even with the in-process writer lanes `SshChannelMultiplexer` already has.
// These tests prove the dual multiplexer opens two independent channels and
// routes every RPC to the right one.

type MockTransport = MultiplexerTransport & {
  dataCallbacks: ((data: Buffer) => void)[]
  closeCallbacks: (() => void)[]
  written: Buffer[]
  close: Mock<() => void>
}

function createMockTransport(): MockTransport {
  const dataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const written: Buffer[] = []

  return {
    write: (
      data: Buffer,
      onSettled?: (result: { ok: true } | { ok: false; error: Error }) => void
    ) => {
      written.push(data)
      onSettled?.({ ok: true })
    },
    onData: (cb) => dataCallbacks.push(cb),
    onClose: (cb) => closeCallbacks.push(cb),
    close: vi.fn(),
    dataCallbacks,
    closeCallbacks,
    written
  }
}

function makeResponseFrame(requestId: number, result: unknown, seq: number): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result
    })
  )
  return encodeFrame(MessageType.Regular, seq, 0, payload)
}

function makeRequestFrame(
  requestId: number,
  method: string,
  params?: Record<string, unknown>,
  seq = 1
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method,
      ...(params !== undefined ? { params } : {})
    })
  )
  return encodeFrame(MessageType.Regular, seq, 0, payload)
}

type WrittenPayload = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
  result?: unknown
}

function decodeWrittenPayload(frame: Buffer): WrittenPayload {
  const payloadLen = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLen).toString())
}

describe('SshChannelMultiplexer dual-transport mode', () => {
  let interactive: MockTransport
  let background: MockTransport
  let transports: DualChannelTransports
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    interactive = createMockTransport()
    background = createMockTransport()
    transports = { interactive, background }
    mux = new SshChannelMultiplexer(transports)
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  describe('channel setup', () => {
    it('opens both the interactive and background channels on construction', () => {
      expect(interactive.dataCallbacks.length).toBe(1)
      expect(interactive.closeCallbacks.length).toBe(1)
      expect(background.dataCallbacks.length).toBe(1)
      expect(background.closeCallbacks.length).toBe(1)
    })

    it('writes nothing to either channel until an RPC is issued', () => {
      expect(interactive.written.length).toBe(0)
      expect(background.written.length).toBe(0)
    })
  })

  describe('interactive routing (PTY, keystrokes, resize)', () => {
    it('routes pty.spawn (lifecycle) to the background priority channel', () => {
      void mux.request('pty.spawn', { cols: 80, rows: 24 }).catch(() => {})

      expect(background.written.length).toBe(1)
      expect(interactive.written.length).toBe(0)
      expect(decodeWrittenPayload(background.written[0]).method).toBe('pty.spawn')
    })

    it('routes pty.data keystroke notifications to the interactive channel only', () => {
      mux.notify('pty.data', { id: 'pty-1', data: 'k' })

      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(0)
      expect(decodeWrittenPayload(interactive.written[0]).method).toBe('pty.data')
    })

    it('routes a terminal resize RPC to the interactive channel only', () => {
      void mux.request('pty.resize', { id: 'pty-1', cols: 100, rows: 40 }).catch(() => {})

      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(0)
      expect(decodeWrittenPayload(interactive.written[0]).method).toBe('pty.resize')
    })

    it('routes pty.shutdown (lifecycle) to the background priority channel', () => {
      void mux.request('pty.shutdown', { id: 'pty-1' }).catch(() => {})

      expect(background.written.length).toBe(1)
      expect(interactive.written.length).toBe(0)
    })
    it('routes bulk PTY methods (pty.replay, pty.history, pty.dumpScrollback) to the background channel', () => {
      void mux.request('pty.history', { id: 'pty-1' }).catch(() => {})
      void mux.request('pty.replay', { id: 'pty-1' }).catch(() => {})
      void mux.request('pty.dumpScrollback', { id: 'pty-1' }).catch(() => {})

      expect(background.written.length).toBe(3)
      expect(interactive.written.length).toBe(0)
    })
  })

  describe('background routing (fs scans, git commands)', () => {
    it('routes fs.listFiles scans to the background channel only', () => {
      void mux.request('fs.listFiles', { path: '/repo' }).catch(() => {})

      expect(background.written.length).toBe(1)
      expect(interactive.written.length).toBe(0)
      expect(decodeWrittenPayload(background.written[0]).method).toBe('fs.listFiles')
    })

    it('routes fs.readDir scans to the background channel only', () => {
      void mux.request('fs.readDir', { path: '/repo' }).catch(() => {})

      expect(background.written.length).toBe(1)
      expect(interactive.written.length).toBe(0)
      expect(decodeWrittenPayload(background.written[0]).method).toBe('fs.readDir')
    })

    it('routes git.status and git.diff RPCs to the background channel only', () => {
      void mux.request('git.status', { cwd: '/repo' }).catch(() => {})
      void mux.request('git.diff', { cwd: '/repo' }).catch(() => {})

      expect(background.written.length).toBe(2)
      expect(interactive.written.length).toBe(0)
    })

    it('does not head-of-line-block interactive keystrokes behind a pending background scan', () => {
      // A large background scan is issued first and left unresolved (no
      // response fed to the mock transport) to simulate a slow relay-side
      // directory walk.
      void mux.request('fs.listFiles', { path: '/repo' }).catch(() => {})

      mux.notify('pty.data', { id: 'pty-1', data: 'k' })

      // The keystroke still lands on the interactive transport immediately —
      // proving the two channels are independent, not just independently
      // scheduled writer lanes on one shared socket.
      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(1)
    })
  })

  describe('response correlation', () => {
    it('resolves a lifecycle request only from a response on its priority channel', async () => {
      const promise = mux.request('pty.spawn', { cols: 80, rows: 24 })
      const { id } = decodeWrittenPayload(background.written[0])
      expect(typeof id).toBe('number')
      if (typeof id !== 'number') {
        throw new Error('Expected request id to be a number')
      }

      // Wrong channel must not resolve
      interactive.dataCallbacks[0](makeResponseFrame(id, { id: 'wrong' }, 1))
      background.dataCallbacks[0](makeResponseFrame(id, { id: 'pty-1' }, 1))
      await expect(promise).resolves.toEqual({ id: 'pty-1' })
    })

    it('resolves a background request only from a response delivered on the background channel', async () => {
      const promise = mux.request('fs.listFiles', { path: '/repo' })
      const { id } = decodeWrittenPayload(background.written[0])
      expect(typeof id).toBe('number')
      if (typeof id !== 'number') {
        throw new Error('Expected request id to be a number')
      }

      background.dataCallbacks[0](makeResponseFrame(id, { files: [] }, 1))
      await expect(promise).resolves.toEqual({ files: [] })
    })
  })

  describe('disposal', () => {
    it('marks the multiplexer disposed and rejects further requests', async () => {
      mux.dispose()

      expect(mux.isDisposed()).toBe(true)
      await expect(mux.request('pty.spawn')).rejects.toThrow('Multiplexer disposed')
    })

    it('closes both underlying transports on dispose', () => {
      mux.dispose()

      expect(interactive.close).toHaveBeenCalled()
      expect(background.close).toHaveBeenCalled()
    })

    it('disposes the whole dual multiplexer when the background channel drops', () => {
      background.closeCallbacks[0]()

      expect(mux.isDisposed()).toBe(true)
    })

    it('disposes the whole dual multiplexer when the interactive channel drops', () => {
      interactive.closeCallbacks[0]()

      expect(mux.isDisposed()).toBe(true)
    })

    it('rejects a pending request when either channel drops (whole mux disposes)', async () => {
      const promise = mux.request('fs.listFiles', { path: '/' })

      interactive.closeCallbacks[0]()

      await expect(promise).rejects.toThrow('SSH connection lost, reconnecting...')
    })
  })

  describe('incoming requests and abort signals', () => {
    it('returns an error response payload with exact numeric error code when onRequest handler throws with custom code', async () => {
      mux.onRequest('custom.action', () => {
        const error = Object.assign(new Error('Action rejected'), { code: -32042 })
        throw error
      })

      interactive.dataCallbacks[0](makeRequestFrame(101, 'custom.action', { target: 'alpha' }))
      await vi.runAllTimersAsync()

      expect(interactive.written.length).toBe(1)
      const response = decodeWrittenPayload(interactive.written[0])
      expect(response.id).toBe(101)
      expect(response.error).toEqual({
        code: -32042,
        message: 'Action rejected'
      })
    })

    it('rejects immediately when request is called with an already aborted signal', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(
        mux.request('pty.spawn', { cols: 80, rows: 24 }, { signal: controller.signal })
      ).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Request "pty.spawn" was cancelled'
      })
      expect(interactive.written.length).toBe(0)
    })

    it('aborts a pending request and notifies rpc.cancel when signal is triggered', async () => {
      const controller = new AbortController()
      const promise = mux.request(
        'pty.spawn',
        { cols: 80, rows: 24 },
        { signal: controller.signal }
      )
      expect(background.written.length).toBe(1)
      const { id } = decodeWrittenPayload(background.written[0])
      expect(typeof id).toBe('number')

      controller.abort()

      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Request "pty.spawn" was cancelled'
      })
      // rpc.cancel follows the pending request's priority channel (background for spawn)
      expect(background.written.length).toBe(2)
      expect(interactive.written.length).toBe(0)
      const cancelFrame = decodeWrittenPayload(background.written[1])
      expect(cancelFrame.method).toBe('rpc.cancel')
      expect(cancelFrame.params).toEqual({ id })
    })

    it('routes rpc.cancel to the channel of a timed out request', async () => {
      const promise = mux.request('pty.spawn', { cols: 80, rows: 24 }, { timeoutMs: 1000 })
      expect(background.written.length).toBe(1)
      const { id } = decodeWrittenPayload(background.written[0])
      expect(typeof id).toBe('number')

      vi.advanceTimersByTime(1000)

      await expect(promise).rejects.toMatchObject({
        code: 'SSH_MUX_REQUEST_TIMEOUT',
        message: 'Request "pty.spawn" timed out after 1000ms'
      })
      expect(background.written.length).toBe(2)
      expect(interactive.written.length).toBe(0)
      const cancelFrame = decodeWrittenPayload(background.written[1])
      expect(cancelFrame.method).toBe('rpc.cancel')
      expect(cancelFrame.params).toEqual({ id })
    })

    it('routes direct notify rpc.cancel to originating channel for pending requests', () => {
      void mux.request('pty.spawn', { cols: 80, rows: 24 }).catch(() => {})
      expect(background.written.length).toBe(1)
      const { id } = decodeWrittenPayload(background.written[0])
      expect(typeof id).toBe('number')

      mux.notify('rpc.cancel', { id })

      expect(background.written.length).toBe(2)
      expect(interactive.written.length).toBe(0)
      const cancelPayload = decodeWrittenPayload(background.written[1])
      expect(cancelPayload.method).toBe('rpc.cancel')
      expect(cancelPayload.params).toEqual({ id })
    })

    it('does not send rpc response if multiplexer is disposed during async request processing', async () => {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      mux.onRequest('async.action', () => promise)

      interactive.dataCallbacks[0](makeRequestFrame(202, 'async.action'))
      expect(interactive.written.length).toBe(0)

      mux.dispose()
      resolve({ done: true })
      await vi.runAllTimersAsync()

      // No response frame should be written after disposal
      expect(interactive.written.length).toBe(0)
    })

    it('cleans up immediately and prevents orphaned timers if transport write throws synchronously', async () => {
      const writeError = new Error('Transport write failure')
      background.write = vi.fn(() => {
        throw writeError
      })

      const abortController = new AbortController()
      await expect(
        mux.request(
          'pty.spawn',
          { cols: 80, rows: 24 },
          {
            signal: abortController.signal,
            timeoutMs: 1000
          }
        )
      ).rejects.toThrow('Transport write failure')

      // Advancing past timeout must not trigger another rejection or cancel notification
      vi.advanceTimersByTime(2000)
      expect(interactive.written.length).toBe(0)
      expect(background.written.length).toBe(0)

      // Aborting the signal must also be a no-op because cleanup already detached the listener
      abortController.abort()
      expect(interactive.written.length).toBe(0)
    })
  })

  describe('resource deallocation & inverse falsification (Round 3)', () => {
    it('cleans up all request handlers and rejects new registrations after disposal', async () => {
      const handler = vi.fn()
      mux.onRequest('test.method', handler)

      mux.dispose()

      // Registering on disposed multiplexer must return a no-op cleanup
      const unreg = mux.onRequest('new.method', vi.fn())
      expect(typeof unreg).toBe('function')
      unreg()

      // Sending frames for previously registered method must be dropped
      interactive.dataCallbacks[0](makeRequestFrame(301, 'test.method'))
      await vi.runAllTimersAsync()
      expect(handler).not.toHaveBeenCalled()
      expect(interactive.written.length).toBe(0)
    })

    it('safely dispatches all onDispose handlers even if a handler unregisters itself during traversal', () => {
      const order: number[] = []
      let unreg2!: () => void

      mux.onDispose(() => {
        order.push(1)
        unreg2()
      })
      unreg2 = mux.onDispose(() => {
        order.push(2)
      })
      mux.onDispose(() => {
        order.push(3)
      })

      mux.dispose('shutdown')

      // All handlers snapshotted for dispatch run safely without mutation skipping
      expect(order).toEqual([1, 2, 3])
    })
  })

  describe('single channel state lifecycle & boundary resilience (Round 4)', () => {
    it('stops feeding decoder and drops outgoing frames once SingleChannelState is disposed', () => {
      const mockTransport = createMockTransport()
      const onFrame = vi.fn()
      const state = new SingleChannelState('interactive', mockTransport, onFrame)

      expect(state.isDisposed()).toBe(false)
      state.sendJsonRpc({ jsonrpc: '2.0', method: 'ping' })
      expect(mockTransport.written.length).toBe(1)

      state.dispose()
      expect(state.isDisposed()).toBe(true)
      expect(mockTransport.close).toHaveBeenCalled()

      // Further outgoing frames are dropped
      state.sendJsonRpc({ jsonrpc: '2.0', method: 'ping' })
      expect(mockTransport.written.length).toBe(1)

      // Incoming data on transport callback is ignored
      mockTransport.dataCallbacks[0](Buffer.from([0, 1, 2, 3]))
      expect(onFrame).not.toHaveBeenCalled()
    })
  })

  describe('notifyWithSettlement', () => {
    it('settles with accepted when transport write succeeds', () => {
      const settled = vi.fn()
      interactive.supportsWriteSettlement = true
      mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)

      expect(interactive.written.length).toBe(1)
      expect(settled).toHaveBeenCalledWith({ outcome: 'accepted' })
    })

    it('settles with refused when multiplexer is disposed', () => {
      const settled = vi.fn()
      mux.dispose('shutdown')
      mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)

      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'refused',
          reason: 'transport_disposed'
        })
      )
    })
  })

  describe('probeLiveness', () => {
    it('sends keepalive frame on interactive transport and resolves true on incoming frame', async () => {
      const probePromise = mux.probeLiveness(5000)

      expect(interactive.written.length).toBe(1)
      // First byte of keepalive frame is MessageType.KeepAlive (9)
      expect(interactive.written[0][0]).toBe(MessageType.KeepAlive)

      // Simulate incoming frame on background channel
      background.dataCallbacks[0](makeResponseFrame(999, { ok: true }, 1))
      await expect(probePromise).resolves.toBe(true)
    })

    it('resolves false when liveness probe times out', async () => {
      const probePromise = mux.probeLiveness(1000)
      vi.advanceTimersByTime(1000)
      await expect(probePromise).resolves.toBe(false)
    })

    it('resolves false immediately if probeLiveness is called on a disposed multiplexer', async () => {
      mux.dispose()
      await expect(mux.probeLiveness(1000)).resolves.toBe(false)
    })
  })
})
