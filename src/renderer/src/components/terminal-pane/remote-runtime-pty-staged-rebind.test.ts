import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks
} from '../../runtime/remote-runtime-terminal-multiplexer'
import { stageRemoteRuntimePtyRebind } from './remote-runtime-pty-staged-rebind'

describe('stageRemoteRuntimePtyRebind', () => {
  it('applies the latest staged fit and driver state in wire order after activation', async () => {
    const events: string[] = []
    let callbacks!: RemoteRuntimeMultiplexedTerminalCallbacks
    const stream: RemoteRuntimeMultiplexedTerminal = {
      streamId: 1,
      sendInput: vi.fn(() => true),
      resize: vi.fn(() => true),
      claimViewport: vi.fn(() => true),
      serializeBuffer: vi.fn(async () => null),
      close: vi.fn()
    }
    const promise = stageRemoteRuntimePtyRebind({
      handle: 'terminal-2',
      bindingGeneration: 2,
      signal: new AbortController().signal,
      client: { id: 'desktop:test', type: 'desktop' },
      viewport: { cols: 120, rows: 40 },
      subscribe: async (args) => {
        callbacks = args.callbacks
        return stream
      },
      canCommit: () => true,
      activate: () => events.push('activate'),
      isActive: () => true,
      onReplayReady: () => events.push('replay-ready'),
      onCommitted: () => events.push('committed'),
      onData: vi.fn(),
      onSnapshot: vi.fn(),
      onEnd: vi.fn(),
      onError: vi.fn(),
      onFitOverrideChanged: (event) => events.push(`fit:${event.mode}:${event.cols}x${event.rows}`),
      onDriverChanged: (driver) => events.push(`driver:${driver.kind}`),
      onTransportClose: vi.fn()
    })
    await Promise.resolve()

    callbacks.onFitOverrideChanged?.({ mode: 'mobile-fit', cols: 40, rows: 20 })
    callbacks.onFitOverrideChanged?.({ mode: 'remote-desktop-fit', cols: 96, rows: 32 })
    callbacks.onDriverChanged?.({ kind: 'desktop' })
    callbacks.onDriverChanged?.({ kind: 'mobile', clientId: 'phone-1' })
    callbacks.onSubscribed?.()

    await promise

    expect(events).toEqual([
      'activate',
      'fit:remote-desktop-fit:96x32',
      'driver:mobile',
      'replay-ready',
      'committed'
    ])
  })

  it('stops staged delivery when the fit callback supersedes the binding', async () => {
    const events: string[] = []
    let bindingCurrent = true
    let callbacks!: RemoteRuntimeMultiplexedTerminalCallbacks
    const stream: RemoteRuntimeMultiplexedTerminal = {
      streamId: 1,
      sendInput: vi.fn(() => true),
      resize: vi.fn(() => true),
      claimViewport: vi.fn(() => true),
      serializeBuffer: vi.fn(async () => null),
      close: vi.fn()
    }
    const promise = stageRemoteRuntimePtyRebind({
      handle: 'terminal-reused',
      bindingGeneration: 2,
      signal: new AbortController().signal,
      client: { id: 'desktop:test', type: 'desktop' },
      viewport: { cols: 120, rows: 40 },
      subscribe: async (args) => {
        callbacks = args.callbacks
        return stream
      },
      canCommit: () => true,
      activate: () => events.push('activate'),
      isActive: () => bindingCurrent,
      onReplayReady: () => events.push('replay-ready'),
      onCommitted: () => events.push('committed'),
      onData: vi.fn(),
      onSnapshot: vi.fn(),
      onEnd: vi.fn(),
      onError: vi.fn(),
      onFitOverrideChanged: () => {
        events.push('fit')
        bindingCurrent = false
      },
      onDriverChanged: () => events.push('driver'),
      onTransportClose: vi.fn()
    })
    await Promise.resolve()

    callbacks.onFitOverrideChanged?.({ mode: 'remote-desktop-fit', cols: 96, rows: 32 })
    callbacks.onDriverChanged?.({ kind: 'mobile', clientId: 'phone-1' })
    callbacks.onSubscribed?.()

    await promise

    expect(events).toEqual(['activate', 'fit'])
  })
})
