import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from './pairing'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

const DISCONNECTED_TEST_PAIRING: PairingOffer = {
  v: 2,
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'test-device-token',
  publicKeyB64: 'unused-test-key'
}

type TestableSharedControlConnection = {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  scheduleReconnect: () => void
  clearReconnectTimer: () => void
  closeSubscription: (requestId: string) => void
  handleSocketClosed: (error: RemoteRuntimeClientError) => void
  open: ReturnType<typeof vi.fn<() => void>>
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RemoteRuntimeSharedControlConnection resume', () => {
  it('cancels owned backoff immediately and stays idle after the last close', () => {
    vi.useFakeTimers()
    const connection = new RemoteRuntimeSharedControlConnection(DISCONNECTED_TEST_PAIRING)
    const unsafe = connection as unknown as TestableSharedControlConnection
    const open = vi.fn(() => unsafe.clearReconnectTimer())
    unsafe.open = open
    unsafe.subscriptions.set('sub-1', createSubscription())

    connection.retryNow()
    expect(open).not.toHaveBeenCalled()

    unsafe.scheduleReconnect()

    connection.retryNow()

    expect(open).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(connection.getDiagnostics()).toMatchObject({
      reconnectAttempt: 1,
      subscriptionCount: 1
    })

    unsafe.closeSubscription('sub-1')
    connection.retryNow()

    expect(open).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    connection.close()
  })

  it('resumes the next backoff tier when an immediate retry remains offline', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const connection = new RemoteRuntimeSharedControlConnection(DISCONNECTED_TEST_PAIRING)
    const unsafe = connection as unknown as TestableSharedControlConnection
    const offline = new RemoteRuntimeClientError('remote_runtime_unavailable', 'still offline')
    const open = vi.fn(() => {
      unsafe.clearReconnectTimer()
      unsafe.handleSocketClosed(offline)
    })
    unsafe.open = open
    unsafe.subscriptions.set('sub-1', createSubscription())
    unsafe.scheduleReconnect()

    connection.retryNow()

    expect(open).toHaveBeenCalledOnce()
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 500)
    expect(vi.getTimerCount()).toBe(1)
    expect(connection.getDiagnostics()).toMatchObject({
      state: 'reconnecting',
      reconnectAttempt: 2,
      subscriptionCount: 1
    })
    unsafe.closeSubscription('sub-1')
    expect(vi.getTimerCount()).toBe(0)
    connection.close()
  })
})

function createSubscription(): SharedControlLogicalSubscription<unknown> {
  return {
    requestId: 'sub-1',
    method: 'session.tabs.subscribe',
    params: null,
    callbacks: { onResponse: vi.fn(), onError: vi.fn() },
    sent: true,
    closed: false,
    closeAfterReady: false,
    remoteSubscriptionId: null
  }
}
