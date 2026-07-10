/**
 * Integration coverage for the terminal.multiplex streaming RPC wiring.
 *
 * Guards the fix for the remote-runtime viewport-sizing bug: on an INITIAL
 * desktop multiplex subscribe the handler must route the connecting client's
 * own viewport through `runtime.seedDesktopSubscribeViewport(...)` (not the
 * passive per-resize `updateDesktopViewport` path), so a stale phone fit-hold
 * cannot make a fresh PC/Mac connect inherit the last actor's dims. Reverting
 * that one call site would leave every runtime-level test green, so this pins
 * the integration point itself.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RpcStreamingMethod } from '../core'
import { isStreamingMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_METHODS } from './terminal'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'

function getMultiplexMethod(): RpcStreamingMethod {
  const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.multiplex')
  if (!method || !isStreamingMethod(method)) {
    throw new Error('terminal.multiplex streaming method not found')
  }
  return method
}

// Why: the subscribe path is fully async (multiple awaits between the control
// frame arriving and the seed call). Drain microtasks plus one macrotask turn
// so handleSubscribeFrame runs to completion under real timers.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 25; i++) {
    await Promise.resolve()
  }
}

type ControlHandler = (frame: TerminalStreamFrame) => void

function buildHarness() {
  const seedDesktopSubscribeViewport = vi.fn(async () => true)
  const handleMobileSubscribe = vi.fn(async () => true)
  const emitted: Array<Record<string, unknown>> = []
  let controlHandler: ControlHandler | null = null
  let cleanup: (() => void) | null = null

  const runtime = {
    resolveLiveLeafForHandle: () => ({ ptyId: 'pty-1' }),
    subscribeToTerminalData: () => () => {},
    seedDesktopSubscribeViewport,
    handleMobileSubscribe,
    subscribeToFitOverrideChanges: () => () => {},
    subscribeToDriverChanges: () => () => {},
    subscribeToTerminalResize: () => () => {},
    readTerminal: async () => ({ truncated: false, limited: false, tail: [] as string[] }),
    serializeTerminalBuffer: async () => null,
    getTerminalSize: () => ({ cols: 150, rows: 40 }),
    getMobileDisplayMode: () => 'auto',
    getLayout: () => ({ seq: 1 }),
    getTerminalFitOverride: () => null,
    getDriver: () => ({ kind: 'desktop' as const }),
    // waitForTerminal is fire-and-forget in the handler; never resolve it so the
    // stream stays open until we close the multiplex explicitly.
    waitForTerminal: () => new Promise<never>(() => {}),
    handleMobileUnsubscribe: () => {},
    registerSubscriptionCleanup: (_key: string, cb: () => void) => {
      cleanup = cb
    }
  } as unknown as OrcaRuntimeService

  const ctx = {
    runtime,
    connectionId: 'conn-1',
    signal: new AbortController().signal,
    sendBinary: () => true,
    registerBinaryStreamHandler: (streamId: number, handler: ControlHandler) => {
      if (streamId === 0) {
        controlHandler = handler
      }
      return () => {}
    }
  }

  const emit = (result: unknown): void => {
    emitted.push(result as Record<string, unknown>)
  }

  return {
    seedDesktopSubscribeViewport,
    handleMobileSubscribe,
    emitted,
    start(): Promise<void> {
      // Kicks off the long-lived multiplex handler. Registration + emit('ready')
      // run synchronously before the terminal `await multiplexClosed`, so the
      // control handler is captured by the time this returns.
      return getMultiplexMethod().handler({}, ctx as never, emit)
    },
    subscribe(frame: {
      terminal: string
      streamId: number
      client: { id: string; type: 'mobile' | 'desktop' }
      viewport: { cols: number; rows: number }
    }): void {
      if (!controlHandler) {
        throw new Error('control handler was not registered')
      }
      controlHandler({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 0,
        payload: encodeTerminalStreamJson(frame)
      })
    },
    close(): void {
      cleanup?.()
    }
  }
}

describe('terminal.multiplex — initial subscribe viewport wiring', () => {
  it('routes an initial desktop subscribe through seedDesktopSubscribeViewport with the client viewport', async () => {
    const harness = buildHarness()
    const done = harness.start()

    harness.subscribe({
      terminal: 'term-1',
      streamId: 1,
      client: { id: 'desktop-1', type: 'desktop' },
      viewport: { cols: 150, rows: 40 }
    })
    await flushAsync()

    // The connecting desktop client's own dims must drive the seed — this is
    // the load-bearing wiring assertion. A revert to updateViewportForClient /
    // updateDesktopViewport leaves this spy uncalled.
    expect(harness.seedDesktopSubscribeViewport).toHaveBeenCalledTimes(1)
    expect(harness.seedDesktopSubscribeViewport).toHaveBeenCalledWith('pty-1', {
      cols: 150,
      rows: 40
    })
    // A desktop subscribe must NOT go through the mobile subscribe path.
    expect(harness.handleMobileSubscribe).not.toHaveBeenCalled()

    // The seed runs before getTerminalSize(), so the emitted subscribed frame
    // carries the seeded desktop dims (mirrors the handler's snapshot source).
    const subscribed = harness.emitted.find((e) => e.type === 'subscribed')
    expect(subscribed).toMatchObject({ cols: 150, rows: 40 })

    harness.close()
    await done
  })

  it('routes an initial mobile subscribe through handleMobileSubscribe, not the desktop seed', async () => {
    const harness = buildHarness()
    const done = harness.start()

    harness.subscribe({
      terminal: 'term-1',
      streamId: 2,
      client: { id: 'phone-A', type: 'mobile' },
      viewport: { cols: 49, rows: 20 }
    })
    await flushAsync()

    expect(harness.handleMobileSubscribe).toHaveBeenCalledTimes(1)
    expect(harness.handleMobileSubscribe).toHaveBeenCalledWith('pty-1', 'phone-A', {
      cols: 49,
      rows: 20
    })
    expect(harness.seedDesktopSubscribeViewport).not.toHaveBeenCalled()

    harness.close()
    await done
  })
})
