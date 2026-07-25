import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from './e2ee-crypto'
import { handleSharedControlTextFrame } from './remote-runtime-shared-control-frame-handler'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import {
  refreshSharedControlPendingRequestTimeouts,
  resolveSharedControlPendingResponse
} from './remote-runtime-shared-control-state'
import type {
  SharedControlConnectionState,
  SharedControlPendingRequest
} from './remote-runtime-shared-control-types'

// Why: a keepalive frame on the shared-control socket is armed by an unrelated
// long-poll, not by any given pending short RPC. These fake-timer tests pin the
// deadline semantics: keepalives must NOT keep a stuck short RPC alive forever,
// but MAY extend a long-poll that opted into the short-RPC path.
describe('shared control keepalive timeout refresh semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function startRequest(options: { refreshTimeoutOnKeepalive?: boolean } = {}): {
    pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
    promise: Promise<unknown>
    onTimeout: ReturnType<typeof vi.fn>
    markInboundActivity: () => void
  } {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const onTimeout = vi.fn()
    let inboundActivityGeneration = 0
    const promise = requestSharedControl({
      pendingRequests,
      method: 'git.status',
      params: undefined,
      timeoutMs: 1000,
      // ensureReady resolves immediately; the request is "in flight" but the
      // server never answers, modelling a genuinely stuck server-side call.
      ensureReady: () => Promise.resolve(),
      send: () => undefined,
      getInboundActivityGeneration: () => inboundActivityGeneration,
      onTimeout,
      refreshTimeoutOnKeepalive: options.refreshTimeoutOnKeepalive
    })
    // Swallow the eventual rejection so unhandled-rejection noise doesn't leak.
    promise.catch(() => undefined)
    return {
      pendingRequests,
      promise,
      onTimeout,
      markInboundActivity: () => {
        inboundActivityGeneration += 1
      }
    }
  }

  it('times out a stuck short RPC but keeps an active socket', async () => {
    const { pendingRequests, promise, onTimeout, markInboundActivity } = startRequest()

    // Periodic keepalives arrive faster than the 1000ms deadline — as they
    // would while a long-poll subscription streams over the same socket.
    for (let elapsed = 0; elapsed < 1000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200)
      refreshSharedControlPendingRequestTimeouts(pendingRequests)
      markInboundActivity()
    }
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).rejects.toThrow()
    expect(onTimeout).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(0)
  })

  it('keeps refreshing a long-poll request that opted into keepalive refresh', async () => {
    const { pendingRequests, promise, onTimeout } = startRequest({
      refreshTimeoutOnKeepalive: true
    })

    // Same keepalive cadence, but this request opted in, so each keepalive
    // pushes the deadline out and it never fires.
    for (let elapsed = 0; elapsed < 3000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200)
      refreshSharedControlPendingRequestTimeouts(pendingRequests)
    }

    expect(onTimeout).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(1)

    // It still resolves normally once the server finally answers.
    const [requestId] = pendingRequests.keys()
    resolveSharedControlPendingResponse(pendingRequests, requestId!, {
      id: requestId!,
      ok: true,
      result: { done: true },
      _meta: { runtimeId: 'runtime-test' }
    })
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('fires the deadline for a short RPC when no keepalives arrive', async () => {
    const { pendingRequests, promise, onTimeout } = startRequest()

    await vi.advanceTimersByTimeAsync(1001)

    await expect(promise).rejects.toThrow()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(pendingRequests.size).toBe(0)
  })

  it('records the current activity generation immediately before send', async () => {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    let releaseReady!: () => void
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    let generation = 1
    let recordedGeneration: number | null | undefined
    const promise = requestSharedControl({
      pendingRequests,
      method: 'git.status',
      params: undefined,
      timeoutMs: 1000,
      ensureReady: () => ready,
      getInboundActivityGeneration: () => generation,
      send: (requestId) => {
        recordedGeneration = pendingRequests.get(requestId)?.inboundActivityGenerationAtSend
        resolveSharedControlPendingResponse(pendingRequests, requestId, {
          id: requestId,
          ok: true,
          result: null,
          _meta: { runtimeId: 'runtime-test' }
        })
      }
    })

    generation = 2
    releaseReady()

    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(recordedGeneration).toBe(2)
  })

  it('does not send after readiness resolves beyond the absolute deadline', async () => {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    let releaseReady!: () => void
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    const send = vi.fn()
    const onTimeout = vi.fn()
    const promise = requestSharedControl({
      pendingRequests,
      method: 'git.status',
      params: undefined,
      timeoutMs: 1000,
      ensureReady: () => ready,
      send,
      getInboundActivityGeneration: () => 0,
      onTimeout
    })
    promise.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(1001)
    await expect(promise).rejects.toThrow('Timed out')
    releaseReady()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).not.toHaveBeenCalled()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(pendingRequests.size).toBe(0)
  })

  it('rejects and removes immediately when send throws without timing out the socket', async () => {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const onTimeout = vi.fn()
    const sendError = new Error('send failed')
    let rejection: unknown
    const promise = requestSharedControl({
      pendingRequests,
      method: 'git.status',
      params: undefined,
      timeoutMs: 1000,
      ensureReady: () => Promise.resolve(),
      send: () => {
        throw sendError
      },
      getInboundActivityGeneration: () => 0,
      onTimeout
    })
    promise.catch((error: unknown) => {
      rejection = error
    })

    await vi.advanceTimersByTimeAsync(0)
    const rejectionBeforeDeadline = rejection
    const pendingBeforeDeadline = pendingRequests.size
    await vi.advanceTimersByTimeAsync(1000)

    expect(rejectionBeforeDeadline).toEqual(expect.objectContaining({ message: 'send failed' }))
    expect(pendingBeforeDeadline).toBe(0)
    expect(rejection).toEqual(expect.objectContaining({ message: 'send failed' }))
    expect(onTimeout).not.toHaveBeenCalled()
  })
})

describe('shared control validated inbound activity', () => {
  const sharedKey = new Uint8Array(32).fill(7)

  it('marks every valid application frame before its side effects', () => {
    const readyOrder: string[] = []
    handleSharedControlTextFrame(
      frameArgs({
        frame: JSON.stringify({ type: 'e2ee_ready' }),
        state: 'awaiting_ready',
        markInboundActivity: () => readyOrder.push('activity'),
        setState: () => readyOrder.push('state'),
        sendEncrypted: () => (readyOrder.push('send'), true)
      })
    )
    expect(readyOrder).toEqual(['activity', 'state', 'send'])

    const authOrder: string[] = []
    handleSharedControlTextFrame(
      frameArgs({
        frame: encrypted({ type: 'e2ee_authenticated' }),
        state: 'awaiting_authenticated',
        markInboundActivity: () => authOrder.push('activity'),
        setState: () => authOrder.push('state'),
        markReady: () => authOrder.push('ready')
      })
    )
    expect(authOrder.slice(0, 3)).toEqual(['activity', 'state', 'ready'])

    const markInboundActivity = vi.fn()
    handleSharedControlTextFrame(
      frameArgs({ frame: encrypted({ _keepalive: true }), markInboundActivity })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    handleSharedControlTextFrame(
      frameArgs({
        frame: encrypted({
          id: 'unknown-id',
          ok: true,
          result: null,
          _meta: { runtimeId: 'runtime-test' }
        }),
        markInboundActivity
      })
    )
    expect(markInboundActivity).toHaveBeenCalledTimes(2)
  })

  it.each<[string, SharedControlConnectionState, string]>([
    ['malformed ready', 'awaiting_ready', '{'],
    ['invalid auth', 'awaiting_authenticated', encrypted({ type: 'wrong' })],
    ['undecryptable response', 'ready', 'not-ciphertext'],
    ['malformed response', 'ready', encrypt('{', sharedKey)],
    ['invalid response envelope', 'ready', encrypted({ id: 'invalid', ok: true })]
  ])('does not mark %s as inbound activity', (_name, state, frame) => {
    const markInboundActivity = vi.fn()

    handleSharedControlTextFrame(frameArgs({ frame, state, markInboundActivity }))

    expect(markInboundActivity).not.toHaveBeenCalled()
  })

  function encrypted(payload: unknown): string {
    return encrypt(JSON.stringify(payload), sharedKey)
  }

  function frameArgs(
    overrides: Partial<Parameters<typeof handleSharedControlTextFrame>[0]>
  ): Parameters<typeof handleSharedControlTextFrame>[0] {
    return {
      frame: encrypted({ _keepalive: true }),
      state: 'ready',
      sharedKey,
      deviceToken: 'device-token',
      pendingRequests: new Map(),
      subscriptions: new Map(),
      readyWaiters: [],
      setState: vi.fn(),
      handleSocketClosed: vi.fn(),
      sendEncrypted: vi.fn(() => true),
      markInboundActivity: vi.fn(),
      markReady: vi.fn(),
      replaySubscriptions: vi.fn(),
      ...overrides
    }
  }
})
