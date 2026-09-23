import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import {
  SshDualChannelMultiplexer,
  type DualChannelTransports
} from './ssh-dual-channel-multiplexer'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
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
    write: (data: Buffer) => {
      written.push(data)
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

type WrittenPayload = { id?: number; method?: string }

function decodeWrittenPayload(frame: Buffer): WrittenPayload {
  const payloadLen = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLen).toString())
}

describe('SshDualChannelMultiplexer', () => {
  let interactive: MockTransport
  let background: MockTransport
  let transports: DualChannelTransports
  let dualMux: SshDualChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    interactive = createMockTransport()
    background = createMockTransport()
    transports = { interactive, background }
    dualMux = new SshDualChannelMultiplexer(transports)
  })

  afterEach(() => {
    dualMux.dispose()
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
    it('routes a pty.spawn request to the interactive channel only', () => {
      void dualMux.request('pty.spawn', { cols: 80, rows: 24 }).catch(() => {})

      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(0)
      expect(decodeWrittenPayload(interactive.written[0]).method).toBe('pty.spawn')
    })

    it('routes pty.data keystroke notifications to the interactive channel only', () => {
      dualMux.notify('pty.data', { id: 'pty-1', data: 'k' })

      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(0)
      expect(decodeWrittenPayload(interactive.written[0]).method).toBe('pty.data')
    })

    it('routes a terminal resize RPC to the interactive channel only', () => {
      void dualMux.request('pty.resize', { id: 'pty-1', cols: 100, rows: 40 }).catch(() => {})

      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(0)
      expect(decodeWrittenPayload(interactive.written[0]).method).toBe('pty.resize')
    })

    it('routes pty.shutdown to the interactive channel only', () => {
      void dualMux.request('pty.shutdown', { id: 'pty-1' }).catch(() => {})

      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(0)
    })
  })

  describe('background routing (fs scans, git commands)', () => {
    it('routes fs.listFiles scans to the background channel only', () => {
      void dualMux.request('fs.listFiles', { path: '/repo' }).catch(() => {})

      expect(background.written.length).toBe(1)
      expect(interactive.written.length).toBe(0)
      expect(decodeWrittenPayload(background.written[0]).method).toBe('fs.listFiles')
    })

    it('routes fs.readDir scans to the background channel only', () => {
      void dualMux.request('fs.readDir', { path: '/repo' }).catch(() => {})

      expect(background.written.length).toBe(1)
      expect(interactive.written.length).toBe(0)
      expect(decodeWrittenPayload(background.written[0]).method).toBe('fs.readDir')
    })

    it('routes git.status and git.diff RPCs to the background channel only', () => {
      void dualMux.request('git.status', { cwd: '/repo' }).catch(() => {})
      void dualMux.request('git.diff', { cwd: '/repo' }).catch(() => {})

      expect(background.written.length).toBe(2)
      expect(interactive.written.length).toBe(0)
    })

    it('does not head-of-line-block interactive keystrokes behind a pending background scan', () => {
      // A large background scan is issued first and left unresolved (no
      // response fed to the mock transport) to simulate a slow relay-side
      // directory walk.
      void dualMux.request('fs.listFiles', { path: '/repo' }).catch(() => {})

      dualMux.notify('pty.data', { id: 'pty-1', data: 'k' })

      // The keystroke still lands on the interactive transport immediately —
      // proving the two channels are independent, not just independently
      // scheduled writer lanes on one shared socket.
      expect(interactive.written.length).toBe(1)
      expect(background.written.length).toBe(1)
    })
  })

  describe('response correlation', () => {
    it('resolves an interactive request only from a response delivered on the interactive channel', async () => {
      const promise = dualMux.request('pty.spawn', { cols: 80, rows: 24 })
      const { id } = decodeWrittenPayload(interactive.written[0])

      interactive.dataCallbacks[0](makeResponseFrame(id as number, { id: 'pty-1' }, 1))

      await expect(promise).resolves.toEqual({ id: 'pty-1' })
    })

    it('resolves a background request only from a response delivered on the background channel', async () => {
      const promise = dualMux.request('fs.listFiles', { path: '/repo' })
      const { id } = decodeWrittenPayload(background.written[0])

      background.dataCallbacks[0](makeResponseFrame(id as number, { files: [] }, 1))

      await expect(promise).resolves.toEqual({ files: [] })
    })
  })

  describe('disposal', () => {
    it('marks the multiplexer disposed and rejects further requests', async () => {
      dualMux.dispose()

      expect(dualMux.isDisposed()).toBe(true)
      await expect(dualMux.request('pty.spawn')).rejects.toThrow('Multiplexer disposed')
    })

    it('closes both underlying transports on dispose', () => {
      dualMux.dispose()

      expect(interactive.close).toHaveBeenCalled()
      expect(background.close).toHaveBeenCalled()
    })

    it('disposes the whole dual multiplexer when the background channel drops', () => {
      background.closeCallbacks[0]()

      expect(dualMux.isDisposed()).toBe(true)
    })

    it('disposes the whole dual multiplexer when the interactive channel drops', () => {
      interactive.closeCallbacks[0]()

      expect(dualMux.isDisposed()).toBe(true)
    })

    it('rejects a pending interactive request when the background channel drops', async () => {
      const promise = dualMux.request('pty.spawn', { cols: 80, rows: 24 })

      background.closeCallbacks[0]()

      await expect(promise).rejects.toThrow('SSH connection lost, reconnecting...')
    })
  })
})
