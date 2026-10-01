import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { normalizeSshMultiplexerTransports, selectTransportIndex } from './ssh-dual-channel-state'
import { encodeFrame, MessageType, HEADER_LENGTH } from './relay-protocol'

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

type WrittenPayload = {
  method?: string
  id?: number
  params?: Record<string, unknown>
  error?: { code: number; message: string }
}

function decodeWrittenPayload(frame: Buffer): WrittenPayload {
  const payloadLen = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLen).toString())
}

describe('normalizeSshMultiplexerTransports', () => {
  it('wraps a single transport as a one-element list', () => {
    const t = createMockTransport()
    expect(normalizeSshMultiplexerTransports(t)).toEqual([t])
  })

  it('preserves an array of N transports', () => {
    const a = createMockTransport()
    const b = createMockTransport()
    const c = createMockTransport()
    expect(normalizeSshMultiplexerTransports([a, b, c])).toEqual([a, b, c])
  })

  it('expands dual named pair to [interactive, background]', () => {
    const interactive = createMockTransport()
    const background = createMockTransport()
    expect(normalizeSshMultiplexerTransports({ interactive, background })).toEqual([
      interactive,
      background
    ])
  })

  it('rejects an empty transport array', () => {
    expect(() => normalizeSshMultiplexerTransports([])).toThrow(
      'SshChannelMultiplexer requires at least one transport'
    )
  })
})

describe('selectTransportIndex', () => {
  it('maps every method to 0 when only one transport exists', () => {
    expect(selectTransportIndex('pty.spawn', 1)).toBe(0)
    expect(selectTransportIndex('fs.listFiles', 1)).toBe(0)
    expect(selectTransportIndex('git.status', 1)).toBe(0)
  })

  it('maps interactive pty.* to 0 and background to 1 for two transports', () => {
    expect(selectTransportIndex('pty.spawn', 2)).toBe(0)
    expect(selectTransportIndex('pty.data', 2)).toBe(0)
    expect(selectTransportIndex('fs.listFiles', 2)).toBe(1)
    expect(selectTransportIndex('git.diff', 2)).toBe(1)
    expect(selectTransportIndex('pty.history', 2)).toBe(1)
  })

  it('maps bulk fs/git streams to the last transport when N>=3', () => {
    expect(selectTransportIndex('pty.spawn', 3)).toBe(0)
    expect(selectTransportIndex('ports.detect', 3)).toBe(1)
    expect(selectTransportIndex('fs.listFiles', 3)).toBe(2)
    expect(selectTransportIndex('git.status', 3)).toBe(2)
    expect(selectTransportIndex('fs.readFileStream', 3)).toBe(2)
  })
})

describe('SshChannelMultiplexer with 1 transport (legacy single-pipe)', () => {
  let transport: MockTransport
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    transport = createMockTransport()
    mux = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  it('accepts a bare MultiplexerTransport constructor argument', () => {
    expect(mux.isDisposed()).toBe(false)
    expect(transport.dataCallbacks.length).toBe(1)
  })

  it('sends all methods on the single transport', () => {
    void mux.request('pty.spawn', { cols: 80 }).catch(() => {})
    void mux.request('fs.listFiles', { path: '/' }).catch(() => {})
    expect(transport.written.length).toBe(2)
  })

  it('resolves requests from the single pipe', async () => {
    const promise = mux.request('pty.spawn', { cols: 80 })
    const { id } = decodeWrittenPayload(transport.written[0])
    expect(typeof id).toBe('number')
    if (typeof id !== 'number') {
      throw new Error('expected id')
    }
    transport.dataCallbacks[0](makeResponseFrame(id, { id: 'pty-1' }, 1))
    await expect(promise).resolves.toEqual({ id: 'pty-1' })
  })
})

describe('SshChannelMultiplexer with 2 transports', () => {
  let interactive: MockTransport
  let background: MockTransport
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    interactive = createMockTransport()
    background = createMockTransport()
    mux = new SshChannelMultiplexer([interactive, background])
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  it('also accepts { interactive, background } dual shape', () => {
    const a = createMockTransport()
    const b = createMockTransport()
    const dual = new SshChannelMultiplexer({ interactive: a, background: b })
    void dual.request('pty.spawn').catch(() => {})
    expect(a.written.length).toBe(1)
    expect(b.written.length).toBe(0)
    dual.dispose()
  })

  it('routes pty.spawn to transport[0] only', () => {
    void mux.request('pty.spawn', { cols: 80, rows: 24 }).catch(() => {})
    expect(interactive.written.length).toBe(1)
    expect(background.written.length).toBe(0)
    expect(decodeWrittenPayload(interactive.written[0]).method).toBe('pty.spawn')
  })

  it('routes fs.listFiles to transport[1] only', () => {
    void mux.request('fs.listFiles', { path: '/repo' }).catch(() => {})
    expect(background.written.length).toBe(1)
    expect(interactive.written.length).toBe(0)
  })

  it('does not head-of-line-block interactive keystrokes behind a pending background scan', () => {
    void mux.request('fs.listFiles', { path: '/repo' }).catch(() => {})
    mux.notify('pty.data', { id: 'pty-1', data: 'k' })
    expect(interactive.written.length).toBe(1)
    expect(background.written.length).toBe(1)
  })

  it('resolves interactive requests only from transport[0] responses', async () => {
    const promise = mux.request('pty.spawn', { cols: 80, rows: 24 })
    const { id } = decodeWrittenPayload(interactive.written[0])
    expect(typeof id).toBe('number')
    if (typeof id !== 'number') {
      throw new Error('expected id')
    }
    // Wrong channel must not resolve
    background.dataCallbacks[0](makeResponseFrame(id, { id: 'wrong' }, 1))
    interactive.dataCallbacks[0](makeResponseFrame(id, { id: 'pty-1' }, 1))
    await expect(promise).resolves.toEqual({ id: 'pty-1' })
  })

  it('routes rpc.cancel to the originating channel on abort', async () => {
    const controller = new AbortController()
    const promise = mux.request('pty.spawn', { cols: 80, rows: 24 }, { signal: controller.signal })
    const { id } = decodeWrittenPayload(interactive.written[0])
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(interactive.written.length).toBe(2)
    expect(background.written.length).toBe(0)
    expect(decodeWrittenPayload(interactive.written[1]).method).toBe('rpc.cancel')
    expect(decodeWrittenPayload(interactive.written[1]).params).toEqual({ id })
  })

  it('probes liveness on the interactive transport', async () => {
    const probe = mux.probeLiveness(5000)
    expect(interactive.written.length).toBe(1)
    expect(interactive.written[0][0]).toBe(MessageType.KeepAlive)
    background.dataCallbacks[0](makeResponseFrame(1, {}, 1))
    await expect(probe).resolves.toBe(true)
  })

  it('closes both transports on dispose', () => {
    mux.dispose()
    expect(interactive.close).toHaveBeenCalled()
    expect(background.close).toHaveBeenCalled()
    expect(mux.isDisposed()).toBe(true)
  })

  it('settles notifyWithSettlement as accepted on write', () => {
    const settled = vi.fn()
    mux.notifyWithSettlement('pty.ackData', { acknowledgements: [] }, settled)
    expect(interactive.written.length).toBe(1)
    expect(settled).toHaveBeenCalledWith({ outcome: 'accepted' })
  })
})

describe('SshChannelMultiplexer with 3 transports', () => {
  let t0: MockTransport
  let t1: MockTransport
  let t2: MockTransport
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    t0 = createMockTransport()
    t1 = createMockTransport()
    t2 = createMockTransport()
    mux = new SshChannelMultiplexer([t0, t1, t2])
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  it('routes interactive pty to transport[0]', () => {
    void mux.request('pty.resize', { id: 'p', cols: 1, rows: 1 }).catch(() => {})
    expect(t0.written.length).toBe(1)
    expect(t1.written.length).toBe(0)
    expect(t2.written.length).toBe(0)
  })

  it('routes operational non-bulk methods to transport[1]', () => {
    void mux.request('ports.detect').catch(() => {})
    void mux.request('session.resolveHome', { path: '~' }).catch(() => {})
    expect(t1.written.length).toBe(2)
    expect(t0.written.length).toBe(0)
    expect(t2.written.length).toBe(0)
  })

  it('routes bulk fs/git methods to transport[2] (last)', () => {
    void mux.request('fs.listFiles', { path: '/' }).catch(() => {})
    void mux.request('git.diff', { cwd: '/' }).catch(() => {})
    void mux.request('fs.readFileStream', { path: '/a' }).catch(() => {})
    expect(t2.written.length).toBe(3)
    expect(t0.written.length).toBe(0)
    expect(t1.written.length).toBe(0)
  })

  it('keeps interactive writes free while bulk and operational are in flight', () => {
    void mux.request('fs.listFiles', { path: '/' }).catch(() => {})
    void mux.request('ports.detect').catch(() => {})
    mux.notify('pty.data', { id: 'pty-1', data: 'x' })
    expect(t0.written.length).toBe(1)
    expect(t1.written.length).toBe(1)
    expect(t2.written.length).toBe(1)
  })

  it('closes all three transports on dispose', () => {
    mux.dispose()
    expect(t0.close).toHaveBeenCalled()
    expect(t1.close).toHaveBeenCalled()
    expect(t2.close).toHaveBeenCalled()
  })
})
