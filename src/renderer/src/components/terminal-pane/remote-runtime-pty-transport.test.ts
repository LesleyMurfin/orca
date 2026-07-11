/* eslint-disable max-lines -- Why: remote runtime PTY behavior spans JSON fallback, binary stream, lifecycle, and parser coverage; keeping the matrix together catches transport regressions. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'

describe('createRemoteRuntimePtyTransport', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  const subscriptionUnsubscribe = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null
  let sessionTabsCallbacks: {
    onResponse: (response: unknown) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'ready' }
    })
  }

  function emitSessionTabsSnapshot(tabs: unknown[], snapshotVersion = 1): void {
    sessionTabsCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'snapshot',
        worktree: 'id:wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs
      }
    })
  }

  function latestSubscribePayload(): {
    streamId: number
    terminal: string
    client: { id: string; type: string }
    viewport?: { cols: number; rows: number }
    capabilities?: { desktopViewportClaims?: 1 }
  } {
    const frames = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    const frame = frames.at(-1)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{
      streamId: number
      terminal: string
      client: { id: string; type: string }
      viewport?: { cols: number; rows: number }
      capabilities?: { desktopViewportClaims?: 1 }
    }>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload
  }

  function emitOutput(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamText(data)
      })
    )
  }

  function emitSnapshot(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(data)
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  function latestFrameForOpcode(opcode: TerminalStreamOpcode) {
    return subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((frame) => frame?.opcode === opcode)
  }

  function emitSnapshotFrame(
    streamId: number,
    opcode:
      | TerminalStreamOpcode.SnapshotStart
      | TerminalStreamOpcode.SnapshotChunk
      | TerminalStreamOpcode.SnapshotEnd,
    payload: Uint8Array<ArrayBufferLike>
  ): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode,
        streamId,
        seq: 1,
        payload
      })
    )
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.clearAllMocks()
    subscriptionCallbacks = null
    sessionTabsCallbacks = null
    subscriptionSendBinary.mockReset()
    subscriptionUnsubscribe.mockReset()
    runtimeCall.mockResolvedValue({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
    runtimeSubscribe.mockImplementation(
      async (
        args: { method?: string },
        callbacks: typeof subscriptionCallbacks | typeof sessionTabsCallbacks
      ) => {
        if (args.method === 'session.tabs.subscribe') {
          sessionTabsCallbacks = callbacks
          return { unsubscribe: vi.fn() }
        }
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: subscriptionUnsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  it('attaches to an existing remote runtime terminal handle', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 120,
      rows: 40,
      callbacks: { onError }
    })

    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })

    expect(onError).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(transport.getRuntimeEnvironmentId?.()).toBe('env-1')
    await vi.waitFor(() =>
      expect(latestSubscribePayload().capabilities).toEqual({
        ackOutput: 1,
        desktopViewportClaims: 1
      })
    )
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex',
        params: {}
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('scopes the same legacy handle independently for each runtime environment', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const first = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    const second = createRemoteRuntimePtyTransport('env-2', { worktreeId: 'wt-2' })

    first.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })
    second.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })

    expect(first.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(second.getPtyId()).toBe('remote:env-2@@terminal-1')
  })

  it('parks passive peers when another remote desktop owns the grid', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getFitOverrideForPty, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    await transport.connect({ url: '', cols: 120, rows: 40, callbacks: {} })
    const { streamId } = latestSubscribePayload()
    const ptyId = transport.getPtyId()
    expect(ptyId).not.toBeNull()

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'fit-override-changed',
        streamId,
        mode: 'remote-desktop-fit',
        cols: 96,
        rows: 32
      }
    })

    expect(ptyId ? getFitOverrideForPty(ptyId) : null).toEqual({
      mode: 'remote-desktop-fit',
      cols: 96,
      rows: 32
    })
    if (ptyId) {
      setFitOverride(ptyId, 'desktop-fit', 0, 0)
    }
  })

  it('gives separate paired viewers of the same host pane distinct refresh identities', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const first = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const second = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    first.attach({ existingPtyId: 'remote:terminal-1', cols: 80, rows: 24, callbacks: {} })
    second.attach({ existingPtyId: 'remote:terminal-1', cols: 120, rows: 40, callbacks: {} })

    await vi.waitFor(() => {
      const subscribeFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
      expect(subscribeFrames).toHaveLength(2)
      const clientIds = subscribeFrames.map((frame) => {
        const payload = frame
          ? decodeTerminalStreamJson<{ client: { id: string } }>(frame.payload)
          : null
        return payload?.client.id
      })
      expect(clientIds[0]).toMatch(/^desktop:tab-1:pane:1:/)
      expect(clientIds[1]).toMatch(/^desktop:tab-1:pane:1:/)
      expect(clientIds[0]).not.toBe(clientIds[1])
    })

    first.destroy?.()
    second.destroy?.()
  })

  it('routes encoded restored terminal ids to their owning runtime environment', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-2', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 120,
      rows: 40,
      callbacks: {}
    })

    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex'
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('commits a recovered host handle only after its authoritative snapshot subscribes', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const onReplayData = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtySpawn
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onReplayData }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const firstSubscriptionCallbacks = subscriptionCallbacks

    firstSubscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(sessionTabsCallbacks).not.toBeNull())
    emitSessionTabsSnapshot([
      {
        type: 'terminal',
        id: 'tab-1::pane:1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        title: 'Terminal',
        isActive: true,
        status: 'ready',
        terminal: 'terminal-2'
      }
    ])
    await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-2'))

    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onReplayData).not.toHaveBeenCalled()

    const { streamId } = latestSubscribePayload()
    emitSnapshot(streamId, 'authoritative replay')

    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2')
    expect(onPtySpawn).toHaveBeenCalledOnce()
    expect(onReplayData).toHaveBeenCalledWith('authoritative replay')
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('re-derives the host session handle after a transport close instead of resubscribing the stale one', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtySpawn
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-1' })

    // The dedicated multiplex socket dies (liveness/close) → onTransportClose.
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(sessionTabsCallbacks).not.toBeNull())
    // Why: while the tunnel was down the host re-minted this pane's handle;
    // recovery must use the authoritative logical subscription, not a one-shot
    // list that can race shared-control reconnect (#7718, #8180).
    emitSessionTabsSnapshot([
      {
        type: 'terminal',
        id: 'tab-1::pane:1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        title: 'Terminal',
        isActive: true,
        status: 'ready',
        terminal: 'terminal-2'
      }
    ])
    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-2' })
    )
    expect(transport.getPtyId()).toContain('terminal-1')
    emitSnapshot(latestSubscribePayload().streamId, 'recovered')
    expect(transport.getPtyId()).toContain('terminal-2')
    expect(onPtySpawn).toHaveBeenCalledWith(expect.stringContaining('terminal-2'))
  })

  it('retires the mirror when the host no longer publishes the surface after a transport close', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(sessionTabsCallbacks).not.toBeNull())
    emitSessionTabsSnapshot([])

    // Why: no red xterm error — retire quietly and let the next session-tabs
    // snapshot drive respawn/removal.
    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1'))
    expect(transport.getPtyId()).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not close host-owned terminal handles attached from session snapshots', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    transport.destroy?.()

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close'
      })
    )
  })

  it('detaches laptop-created remote runtime terminals without closing the server session', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    transport.destroy?.()

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close'
      })
    )
  })

  it('retires stale host-owned terminal handles without surfacing pane errors', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId, message: 'terminal_handle_stale' }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-stale')
    expect(transport.getPtyId()).toBeNull()
  })

  it('ignores stale stream end after reattaching a newer remote terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId
    const oldSubscriptionCallbacks = subscriptionCallbacks

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    oldSubscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId }
    })

    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(true)

    await vi.waitFor(() => {
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-new' })
    })
    const newStreamId = latestSubscribePayload().streamId

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: newStreamId }
    })

    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-new')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('drops pending input when attaching a different remote terminal handle', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-old',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      expect(transport.sendInput('queued-for-old')).toBe(true)

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-new',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      runtimeCall.mockClear()

      await vi.advanceTimersByTimeAsync(10)

      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.send'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stale attach subscription rejection after reattaching a newer remote terminal', async () => {
    const oldSubscription = {
      reject: null as ((error: Error) => void) | null
    }
    const newStream = {
      streamId: 2,
      sendInput: vi.fn(() => true),
      resize: vi.fn(() => true),
      serializeBuffer: vi.fn(async () => null),
      close: vi.fn()
    }
    const subscribeTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            oldSubscription.reject = reject
          })
      )
      .mockResolvedValueOnce(newStream)
    vi.doMock('../../runtime/remote-runtime-terminal-multiplexer', () => ({
      getRemoteRuntimeTerminalMultiplexer: vi.fn(() => ({ subscribeTerminal }))
    }))
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscribeTerminal).toHaveBeenCalledTimes(2))

    oldSubscription.reject?.(new Error('terminal_handle_stale'))
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(true)
  })

  it('does not send queued input through a stale stream during remote handle replacement', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    vi.useFakeTimers()
    try {
      subscriptionSendBinary.mockClear()
      runtimeCall.mockClear()

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-new',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('x')).toBe(true)
      vi.advanceTimersByTime(8)

      const inputFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
      expect(inputFrames).toEqual([])
      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-new',
          text: 'x',
          client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
          viewport: { cols: 80, rows: 24 },
          claimViewport: true
        },
        timeoutMs: 15_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a remote terminal created after the pane was destroyed', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    transport.destroy?.()
    resolveCreate({ ok: true, result: { terminal: { handle: 'terminal-late' } } })
    await connect

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.close',
      params: { terminal: 'terminal-late' },
      timeoutMs: 15_000
    })
  })

  it('passes activation intent when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      activate: true
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          tabId: 'tab-1',
          leafId: 'pane:1',
          focus: false,
          presentation: 'background',
          activate: true
        })
      })
    )
  })

  it('scopes ephemeral setup terminals to the floating-terminal selector (#6789)', async () => {
    const { brandEphemeralSetupTerminalWorktreeId } =
      await import('../../../../shared/ephemeral-setup-terminal-worktree-id')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: brandEphemeralSetupTerminalWorktreeId(
        'feature-wall-orchestration-skill-terminal'
      ),
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          worktree: 'id:global-floating-terminal'
        })
      })
    )
  })

  it('passes startup command delivery when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'linked issue context'",
      startupCommandDelivery: 'shell-ready'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        })
      })
    )
  })

  it('prefers connect-time launch metadata when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'old'",
      launchConfig: { agentArgs: '--old', agentEnv: {} },
      launchToken: 'old-token',
      launchAgent: 'codex'
    })

    await transport.connect({
      url: '',
      command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: 'fresh-token',
      launchAgent: 'codex',
      callbacks: {}
    })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
          env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
          launchConfig: {
            agentArgs: '--model gpt-5',
            agentEnv: { CODEX_PROFILE: 'captured' }
          },
          launchToken: 'fresh-token',
          launchAgent: 'codex'
        })
      })
    )
  })

  it('activates pending host session mirrors instead of creating duplicate terminals', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: true,
                status: 'pending-handle',
                terminal: null
              }
            ]
          }
        })
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 2,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-1'
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const result = await transport.connect({ url: '', callbacks: {} })

    expect(result).toEqual({ id: 'remote:env-1@@terminal-1', replay: '' })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: { worktree: 'id:wt-1', tabId: 'host-tab-1', leafId: 'leaf-1' }
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create'
      })
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 80, rows: 24 }
    })
  })

  it('activates the requested split leaf for pending host session mirrors', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: false,
                status: 'pending-handle',
                terminal: null
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: true,
                status: 'pending-handle',
                terminal: null
              }
            ]
          }
        })
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 2,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: false,
                status: 'ready',
                terminal: 'terminal-1'
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-2'
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const result = await transport.connect({ url: '', callbacks: {} })

    expect(result).toEqual({ id: 'remote:env-1@@terminal-2', replay: '' })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: { worktree: 'id:wt-1', tabId: 'host-tab-1', leafId: 'leaf-2' }
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create'
      })
    )
  })

  it('does not attach a pending split leaf to a ready sibling', async () => {
    let listCount = 0
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-1'
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: false,
                status: 'pending-handle',
                terminal: null
              }
            ]
          }
        })
      }
      if (args.method === 'session.tabs.list') {
        listCount += 1
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: listCount + 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: false,
                status: 'ready',
                terminal: 'terminal-1'
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-2'
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const result = await transport.connect({ url: '', callbacks: {} })

    expect(result).toEqual({ id: 'remote:env-1@@terminal-2', replay: '' })
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-2' })
  })

  it('stops polling when a requested split leaf disappears but siblings remain', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'session.tabs.activate') {
          return Promise.resolve({
            ok: true,
            result: {
              worktree: 'id:wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 1,
              activeGroupId: 'group-1',
              activeTabId: 'host-tab-1::leaf-2',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'host-tab-1::leaf-1',
                  parentTabId: 'host-tab-1',
                  leafId: 'leaf-1',
                  title: 'Terminal 1',
                  isActive: false,
                  status: 'ready',
                  terminal: 'terminal-1'
                },
                {
                  type: 'terminal',
                  id: 'host-tab-1::leaf-2',
                  parentTabId: 'host-tab-1',
                  leafId: 'leaf-2',
                  title: 'Terminal 2',
                  isActive: true,
                  status: 'pending-handle',
                  terminal: null
                }
              ]
            }
          })
        }
        if (args.method === 'session.tabs.list') {
          return Promise.resolve({
            ok: true,
            result: {
              worktree: 'id:wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 2,
              activeGroupId: 'group-1',
              activeTabId: 'host-tab-1::leaf-1',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'host-tab-1::leaf-1',
                  parentTabId: 'host-tab-1',
                  leafId: 'leaf-1',
                  title: 'Terminal 1',
                  isActive: true,
                  status: 'ready',
                  terminal: 'terminal-1'
                }
              ]
            }
          })
        }
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-2'
      })

      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(150)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
      expect(
        runtimeCall.mock.calls.filter((call) => call[0].method === 'session.tabs.list')
      ).toHaveLength(1)
      await Promise.resolve()
      await Promise.resolve()
      expect(
        runtimeCall.mock.calls.some((call) => call[0].method.startsWith('session.tabs.close'))
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not close a split parent when the requested leaf times out but a sibling is ready', async () => {
    vi.useFakeTimers()
    try {
      const splitSnapshot = {
        worktree: 'id:wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab-1::leaf-2',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::leaf-1',
            parentTabId: 'host-tab-1',
            leafId: 'leaf-1',
            title: 'Terminal 1',
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'terminal',
            id: 'host-tab-1::leaf-2',
            parentTabId: 'host-tab-1',
            leafId: 'leaf-2',
            title: 'Terminal 2',
            isActive: true,
            status: 'pending-handle',
            terminal: null
          }
        ]
      }
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
          return Promise.resolve({ ok: true, result: splitSnapshot })
        }
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-2'
      })

      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
      expect(
        runtimeCall.mock.calls.some((call) => call[0].method.startsWith('session.tabs.close'))
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling without closing the host tab when a mirror never publishes a ready handle', async () => {
    vi.useFakeTimers()
    try {
      const pendingSnapshot = {
        worktree: 'id:wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab-1::leaf-1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::leaf-1',
            parentTabId: 'host-tab-1',
            leafId: 'leaf-1',
            title: 'Terminal 1',
            isActive: true,
            status: 'pending-handle',
            terminal: null
          }
        ]
      }
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
          return Promise.resolve({ ok: true, result: pendingSnapshot })
        }
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-1'
      })

      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'session.tabs.activate' })
      )
      const listCalls = runtimeCall.mock.calls.filter(
        (call) => call[0].method === 'session.tabs.list'
      )
      expect(listCalls.length).toBeGreaterThan(0)
      expect(listCalls.length).toBeLessThanOrEqual(101)
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.create'
        })
      )
      const closeCalls = runtimeCall.mock.calls.filter((call) =>
        String(call[0].method).startsWith('session.tabs.close')
      )
      expect(closeCalls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('unsubscribes a remote terminal subscription that resolves after destroy', async () => {
    let resolveSubscribe: (value: {
      unsubscribe: () => void
      sendBinary: typeof subscriptionSendBinary
    }) => void = () => {}
    const unsubscribe = vi.fn()
    runtimeSubscribe.mockImplementation(
      (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return new Promise<{ unsubscribe: () => void; sendBinary: typeof subscriptionSendBinary }>(
          (resolve) => {
            resolveSubscribe = (value) => {
              resolve(value)
              queueMicrotask(emitMultiplexReady)
            }
          }
        )
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })
    transport.destroy?.()
    resolveSubscribe({ unsubscribe, sendBinary: subscriptionSendBinary })
    await connect

    expect(unsubscribe).toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
  })

  it('delivers cleaned remote data before deferred title, bell, and OSC 9999 handlers', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitOutput(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after\x1b]0;. Claude working\x07\x07'
    )

    expect(onData).toHaveBeenCalledWith(
      'beforeafter\x1b]0;. Claude working\x07\x07',
      expect.objectContaining({ seq: 1 })
    )
    await vi.waitFor(() =>
      expect(onAgentStatus).toHaveBeenCalledWith({
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      })
    )
    expect(onTitleChange).toHaveBeenCalledWith('. Claude working', '. Claude working')
    expect(onBell).toHaveBeenCalledTimes(1)
  })

  it('processes binary remote data chunks through the terminal parser', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitOutput(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after'
    )

    expect(onData).toHaveBeenCalledWith('beforeafter', expect.objectContaining({ seq: 1 }))
    await vi.waitFor(() =>
      expect(onAgentStatus).toHaveBeenCalledWith({
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      })
    )
  })

  it('reconstructs plain startup rejection data as a local structured error', async () => {
    runtimeSubscribe.mockRejectedValue({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.'
    })
    const {
      _getRemoteRuntimeTerminalMultiplexerCountForTest,
      getRemoteRuntimeTerminalMultiplexer
    } = await import('../../runtime/remote-runtime-terminal-multiplexer')
    const onError = vi.fn()
    const onTransportClose = vi.fn()

    const rejection = await getRemoteRuntimeTerminalMultiplexer('env-1')
      .subscribeTerminal({
        terminal: 'terminal-1',
        client: { id: 'desktop:test', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError,
          onTransportClose
        }
      })
      .catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).toMatchObject({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.'
    })
    expect(onError).not.toHaveBeenCalled()
    expect(onTransportClose).not.toHaveBeenCalled()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
  })

  it('rejects every connecting waiter without pane delivery when error and close precede the handle', async () => {
    let resolveSubscription!: (value: {
      unsubscribe: () => void
      sendBinary: typeof subscriptionSendBinary
    }) => void
    runtimeSubscribe.mockImplementation(
      (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return new Promise((resolve) => {
          resolveSubscription = resolve
        })
      }
    )
    const {
      _getRemoteRuntimeTerminalMultiplexerCountForTest,
      getRemoteRuntimeTerminalMultiplexer
    } = await import('../../runtime/remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const firstError = vi.fn()
    const secondError = vi.fn()
    const firstTransportClose = vi.fn()
    const secondTransportClose = vi.fn()

    const firstPromise = multiplexer.subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop:first', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot: vi.fn(),
        onError: firstError,
        onTransportClose: firstTransportClose
      }
    })
    const secondPromise = multiplexer.subscribeTerminal({
      terminal: 'terminal-2',
      client: { id: 'desktop:second', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot: vi.fn(),
        onError: secondError,
        onTransportClose: secondTransportClose
      }
    })
    const settledPromise = Promise.allSettled([firstPromise, secondPromise])

    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBeNull())
    // Ready alone is not established: the physical handle has not been retained.
    emitMultiplexReady()
    const firstSubscriptionCallbacks = subscriptionCallbacks
    firstSubscriptionCallbacks?.onError?.({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.'
    })
    firstSubscriptionCallbacks?.onClose?.()

    const settled = await settledPromise
    for (const result of settled) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error)
        expect(result.reason).toMatchObject({
          code: 'unauthorized',
          message: 'Remote Orca runtime rejected the pairing token.'
        })
      }
    }
    expect(firstError).not.toHaveBeenCalled()
    expect(secondError).not.toHaveBeenCalled()
    expect(firstTransportClose).not.toHaveBeenCalled()
    expect(secondTransportClose).not.toHaveBeenCalled()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)

    resolveSubscription({
      unsubscribe: subscriptionUnsubscribe,
      sendBinary: subscriptionSendBinary
    })
    await vi.waitFor(() => expect(subscriptionUnsubscribe).toHaveBeenCalledOnce())
    firstSubscriptionCallbacks?.onError?.({ code: 'runtime_error', message: 'late error' })
    firstSubscriptionCallbacks?.onClose?.()
    expect(firstError).not.toHaveBeenCalled()
    expect(secondError).not.toHaveBeenCalled()
    expect(firstTransportClose).not.toHaveBeenCalled()
    expect(secondTransportClose).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
  })

  it('rejects connecting waiters on close before ready without starting recovery', async () => {
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: subscriptionUnsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    const {
      _getRemoteRuntimeTerminalMultiplexerCountForTest,
      getRemoteRuntimeTerminalMultiplexer
    } = await import('../../runtime/remote-runtime-terminal-multiplexer')
    const onError = vi.fn()
    const onTransportClose = vi.fn()
    const streamPromise = getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop:test', type: 'desktop' },
      callbacks: {
        onData: vi.fn(),
        onSnapshot: vi.fn(),
        onError,
        onTransportClose
      }
    })
    const rejectionPromise = streamPromise.catch((error: unknown) => error)

    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBeNull())
    await Promise.resolve()
    subscriptionCallbacks?.onClose?.()
    const rejection = await rejectionPromise

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).toMatchObject({
      code: 'remote_runtime_unavailable',
      message: 'Remote Orca runtime closed the connection.'
    })
    expect(onError).not.toHaveBeenCalled()
    expect(onTransportClose).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
  })

  it('fans one established recoverable close out once per stream after physical release', async () => {
    const {
      _getRemoteRuntimeTerminalMultiplexerCountForTest,
      getRemoteRuntimeTerminalMultiplexer
    } = await import('../../runtime/remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const firstError = vi.fn()
    const secondError = vi.fn()
    let firstStream: { close: () => void } | null = null
    const firstTransportClose = vi.fn(() => {
      expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
      firstStream?.close()
      throw new Error('first recovery callback failed')
    })
    const secondTransportClose = vi.fn()

    const streams = await Promise.all([
      multiplexer.subscribeTerminal({
        terminal: 'terminal-1',
        client: { id: 'desktop:first', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: firstError,
          onTransportClose: firstTransportClose
        }
      }),
      multiplexer.subscribeTerminal({
        terminal: 'terminal-2',
        client: { id: 'desktop:second', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: secondError,
          onTransportClose: secondTransportClose
        }
      })
    ])
    firstStream = streams[0]
    const firstSubscriptionCallbacks = subscriptionCallbacks
    const transportError = {
      code: 'remote_runtime_unavailable',
      message: 'Remote Orca runtime stopped responding; the stream connection was reset.'
    }

    firstSubscriptionCallbacks?.onError?.(transportError)
    expect(firstError).not.toHaveBeenCalled()
    expect(secondError).not.toHaveBeenCalled()
    expect(firstTransportClose).not.toHaveBeenCalled()
    expect(secondTransportClose).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).not.toHaveBeenCalled()

    expect(() => firstSubscriptionCallbacks?.onClose?.()).not.toThrow()
    expect(firstTransportClose).toHaveBeenCalledOnce()
    expect(firstTransportClose).toHaveBeenCalledWith(transportError)
    expect(secondTransportClose).toHaveBeenCalledOnce()
    expect(secondTransportClose).toHaveBeenCalledWith(transportError)
    expect(firstError).not.toHaveBeenCalled()
    expect(secondError).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)

    firstSubscriptionCallbacks?.onError?.({ code: 'runtime_timeout', message: 'late timeout' })
    firstSubscriptionCallbacks?.onClose?.()
    expect(firstTransportClose).toHaveBeenCalledOnce()
    expect(secondTransportClose).toHaveBeenCalledOnce()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
  })

  it('fans one established fatal error out per stream with no recovery and ignores late close', async () => {
    const {
      _getRemoteRuntimeTerminalMultiplexerCountForTest,
      getRemoteRuntimeTerminalMultiplexer
    } = await import('../../runtime/remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    let firstStream: { close: () => void } | null = null
    const firstError = vi.fn(() => {
      expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)
      firstStream?.close()
      throw new Error('first fatal callback failed')
    })
    const secondError = vi.fn()
    const firstTransportClose = vi.fn()
    const secondTransportClose = vi.fn()

    const streams = await Promise.all([
      multiplexer.subscribeTerminal({
        terminal: 'terminal-1',
        client: { id: 'desktop:first', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: firstError,
          onTransportClose: firstTransportClose
        }
      }),
      multiplexer.subscribeTerminal({
        terminal: 'terminal-2',
        client: { id: 'desktop:second', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: secondError,
          onTransportClose: secondTransportClose
        }
      })
    ])
    firstStream = streams[0]
    const firstSubscriptionCallbacks = subscriptionCallbacks

    expect(() =>
      firstSubscriptionCallbacks?.onError?.({
        code: 'unauthorized',
        message: 'Remote Orca runtime rejected the pairing token.'
      })
    ).not.toThrow()
    expect(firstError).toHaveBeenCalledOnce()
    expect(firstError).toHaveBeenCalledWith('Remote Orca runtime rejected the pairing token.')
    expect(secondError).toHaveBeenCalledOnce()
    expect(secondError).toHaveBeenCalledWith('Remote Orca runtime rejected the pairing token.')
    expect(firstTransportClose).not.toHaveBeenCalled()
    expect(secondTransportClose).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
    expect(_getRemoteRuntimeTerminalMultiplexerCountForTest()).toBe(0)

    firstSubscriptionCallbacks?.onClose?.()
    firstSubscriptionCallbacks?.onError?.({ code: 'runtime_error', message: 'late error' })
    expect(firstError).toHaveBeenCalledOnce()
    expect(secondError).toHaveBeenCalledOnce()
    expect(firstTransportClose).not.toHaveBeenCalled()
    expect(secondTransportClose).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
  })

  it('delivers a structured normal close only to recovery-capable streams', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('../../runtime/remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const recoveringError = vi.fn()
    const recoveringClose = vi.fn()
    const nonRecoveringError = vi.fn()

    await Promise.all([
      multiplexer.subscribeTerminal({
        terminal: 'terminal-1',
        client: { id: 'desktop:first', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: recoveringError,
          onTransportClose: recoveringClose
        }
      }),
      multiplexer.subscribeTerminal({
        terminal: 'terminal-2',
        client: { id: 'desktop:second', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: nonRecoveringError
        }
      })
    ])
    const firstSubscriptionCallbacks = subscriptionCallbacks

    firstSubscriptionCallbacks?.onClose?.()

    expect(recoveringClose).toHaveBeenCalledOnce()
    expect(recoveringClose).toHaveBeenCalledWith({
      code: 'remote_runtime_unavailable',
      message: 'Remote Orca runtime closed the connection.'
    })
    expect(recoveringError).not.toHaveBeenCalled()
    expect(nonRecoveringError).toHaveBeenCalledOnce()
    expect(nonRecoveringError).toHaveBeenCalledWith('Remote Orca runtime closed the connection.')
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps terminal event errors scoped to their target stream and physical connection', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('../../runtime/remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const firstError = vi.fn()
    const secondError = vi.fn()
    const firstTransportClose = vi.fn()
    const secondTransportClose = vi.fn()
    const [first, second] = await Promise.all([
      multiplexer.subscribeTerminal({
        terminal: 'terminal-1',
        client: { id: 'desktop:first', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: firstError,
          onTransportClose: firstTransportClose
        }
      }),
      multiplexer.subscribeTerminal({
        terminal: 'terminal-2',
        client: { id: 'desktop:second', type: 'desktop' },
        callbacks: {
          onData: vi.fn(),
          onSnapshot: vi.fn(),
          onError: secondError,
          onTransportClose: secondTransportClose
        }
      })
    ])
    subscriptionSendBinary.mockClear()

    subscriptionCallbacks?.onResponse({
      id: 'terminal-error',
      ok: true,
      result: { type: 'error', streamId: first.streamId, message: 'terminal command failed' },
      _meta: { runtimeId: 'runtime-test' }
    })

    expect(firstError).toHaveBeenCalledOnce()
    expect(firstError).toHaveBeenCalledWith('terminal command failed')
    expect(secondError).not.toHaveBeenCalled()
    expect(firstTransportClose).not.toHaveBeenCalled()
    expect(secondTransportClose).not.toHaveBeenCalled()
    expect(subscriptionUnsubscribe).not.toHaveBeenCalled()
    expect(second.sendInput('still alive')).toBe(true)
    expect(subscriptionSendBinary).toHaveBeenCalledOnce()

    first.close()
    second.close()
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
  })

  it('resubscribes once without a PTY error for established recoverable error then close', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: { onExit, onDisconnect, onError } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const firstSubscriptionCallbacks = subscriptionCallbacks
    firstSubscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote Orca runtime stopped responding; the stream connection was reset.'
    })

    expect(onError).not.toHaveBeenCalled()
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    expect(subscriptionUnsubscribe).not.toHaveBeenCalled()

    firstSubscriptionCallbacks?.onClose?.()

    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()

    firstSubscriptionCallbacks?.onClose?.()
    firstSubscriptionCallbacks?.onError?.({ code: 'runtime_timeout', message: 'late timeout' })
    expect(runtimeSubscribe).toHaveBeenCalledTimes(2)
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('surfaces established fatal transport errors once without recovery', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: { onError } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const firstSubscriptionCallbacks = subscriptionCallbacks

    firstSubscriptionCallbacks?.onError?.({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.'
    })
    firstSubscriptionCallbacks?.onClose?.()

    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith('Remote Orca runtime rejected the pairing token.')
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    expect(subscriptionUnsubscribe).toHaveBeenCalledOnce()
  })

  it('releases pending claimed input when reconnect subscription fails', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: { onError } })
    let rejectReconnect = (_error: Error): void => {}
    runtimeSubscribe.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectReconnect = reject
        })
    )

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    expect(transport.claimViewport?.(101, 33)).toBe(true)
    const accepted = transport.sendInputAccepted?.('\x03')
    await Promise.resolve()
    rejectReconnect(new Error('reconnect failed'))

    await expect(accepted).resolves.toBe(false)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('reconnect failed'))
  })

  it('releases pending claimed input when the remote terminal ends', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: {} })
    const { streamId } = latestSubscribePayload()

    expect(transport.claimViewport?.(101, 33)).toBe(true)
    const accepted = transport.sendInputAccepted?.('x')
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId }
    })

    await expect(accepted).resolves.toBe(false)
  })

  it('retries when a replacement transport closes before its stream installs', async () => {
    const transportCallbacks: NonNullable<typeof subscriptionCallbacks>[] = []
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        transportCallbacks.push(callbacks)
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const connected = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(transportCallbacks).toHaveLength(1))
    transportCallbacks[0].onResponse({ ok: true, result: { type: 'ready' } })
    await connected

    transportCallbacks[0].onClose?.()
    await vi.waitFor(() => expect(transportCallbacks).toHaveLength(2))
    transportCallbacks[1].onResponse({ ok: true, result: { type: 'ready' } })
    transportCallbacks[1].onClose?.()

    await vi.waitFor(() => expect(transportCallbacks).toHaveLength(3))
    transport.destroy?.()
  })

  it('resubscribes with the latest pane viewport after the remote stream closes', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload().viewport).toEqual({ cols: 80, rows: 24 })

    expect(transport.resize(132, 43)).toBe(true)
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      expect(latestSubscribePayload().viewport).toEqual({ cols: 132, rows: 43 })
    })
  })

  it('replays a viewport that changed during the subscribe round-trip once the stream is current', async () => {
    // Why: a resize landing while the subscribe is in flight takes the one-shot
    // RPC fallback, which is refresh-only (no leak) and no-ops before the stream
    // floor exists. The transport must replay the latest viewport over the
    // now-current stream so the PTY does not stall at the subscribe-time width.
    // Hold the multiplex "ready" to keep the round-trip open across the resize.
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    // Drain microtasks WITHOUT advancing timers, so the 33ms viewport batcher
    // cannot fire — the replayed Resize frame must come from the round-trip
    // flush alone (this test fails if that flush is removed).
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve()
      }
    }

    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())

    // Resize while the stream is not yet current (subscribe still pending).
    expect(transport.resize(132, 43)).toBe(true)

    // Release readiness and drain the resolution chain by microtasks only.
    emitMultiplexReady()
    await flushMicrotasks()

    // The Subscribe frame still carries the subscribe-time viewport...
    expect(latestSubscribePayload().viewport).toEqual({ cols: 80, rows: 24 })
    // ...and the newer viewport is replayed as a Resize frame over the stream,
    // before the batcher's 33ms timer could have produced it.
    const resizeFrame = latestFrameForOpcode(TerminalStreamOpcode.Resize)
    expect(resizeFrame && decodeTerminalStreamJson(resizeFrame.payload)).toEqual({
      cols: 132,
      rows: 43
    })

    transport.destroy?.()
  })

  it('replays a claim before input typed during the subscribe round-trip', async () => {
    vi.useFakeTimers()
    try {
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
          subscriptionCallbacks = callbacks
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
      expect(transport.claimViewport?.(101, 33)).toBe(true)
      expect(transport.sendInput('x')).toBe(true)
      await vi.advanceTimersByTimeAsync(8)
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )

      emitMultiplexReady()
      await vi.waitFor(() => {
        const opcodes = subscriptionSendBinary.mock.calls
          .map((call) => decodeTerminalStreamFrame(call[0])?.opcode)
          .filter((opcode) => opcode !== undefined)
        expect(opcodes).toEqual([
          TerminalStreamOpcode.Subscribe,
          TerminalStreamOpcode.ClaimViewport,
          TerminalStreamOpcode.Resize,
          TerminalStreamOpcode.Input
        ])
      })
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid remote terminal input before sending it to the runtime', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      expect(transport.sendInput('b')).toBe(true)
      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('ab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends coalesced terminal input as binary frames once the stream is established', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      expect(transport.sendInput('b')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('ab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not coalesce large remote terminal input chunks above the terminal ceiling', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
      expect(transport.sendInput(chunk)).toBe(true)
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      let frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe(chunk)

      expect(transport.sendInput('tail')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(2)
      frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[1][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns runtime acceptance for acknowledged terminal input', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: '\x03',
        client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
        viewport: { cols: 80, rows: 24 },
        claimViewport: true
      },
      timeoutMs: 15_000
    })
  })

  it('preserves queued remote input order before acknowledged terminal input', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'terminal.create') {
          return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
        }
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 2 } }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-1',
          text: 'a\x03',
          client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
          viewport: { cols: 80, rows: 24 },
          claimViewport: true
        },
        timeoutMs: 15_000
      })
      expect(subscriptionSendBinary).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns false when acknowledged terminal input is rejected by the runtime', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(false)
  })

  it('splits large acknowledged remote input before terminal.send RPCs', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: {
            send: {
              handle: 'terminal-1',
              accepted: true,
              bytesWritten: args.params.text.length
            }
          }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    const chunk = '😀'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES / 4)
    await expect(transport.sendInputAccepted?.(`${chunk}tail`)).resolves.toBe(true)

    const sendCalls = runtimeCall.mock.calls.filter((call) => call[0].method === 'terminal.send')
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[0]?.[0].params.text).toBe(chunk)
    expect(sendCalls[1]?.[0].params.text).toBe('tail')
  })

  it('yields while validating accepted large acknowledged remote input before terminal.send RPCs', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'terminal.create') {
          return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
        }
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: {
              send: {
                handle: 'terminal-1',
                accepted: true,
                bytesWritten: args.params.text.length
              }
            }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })
      runtimeCall.mockClear()

      const accepted = transport.sendInputAccepted?.(text)
      await Promise.resolve()

      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(true)
      const sendTexts = runtimeCall.mock.calls
        .filter((call) => call[0].method === 'terminal.send')
        .map((call) => call[0].params.text)
      expect(sendTexts.join('')).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops large acknowledged remote input after a rejected chunk', async () => {
    const firstChunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    const rejectedChunk = `tail${'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES - 4)}`
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: {
            send: {
              handle: 'terminal-1',
              accepted: args.params.text !== rejectedChunk,
              bytesWritten: args.params.text === rejectedChunk ? 0 : args.params.text.length
            }
          }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.(`${firstChunk}${rejectedChunk}after`)).resolves.toBe(
      false
    )

    const sendTexts = runtimeCall.mock.calls
      .filter((call) => call[0].method === 'terminal.send')
      .map((call) => call[0].params.text)
    expect(sendTexts).toEqual([firstChunk, rejectedChunk])
  })

  it('rejects oversized acknowledged remote input before runtime RPCs', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })
    runtimeCall.mockClear()

    await expect(
      transport.sendInputAccepted?.('😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1))
    ).resolves.toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('preserves literal LF input when sending remote PTY binary frames', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('echo one\necho two\r\n')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('echo one\necho two\r\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid remote viewport updates before sending the latest size', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.resize(80, 24)).toBe(true)
      expect(transport.resize(120, 40)).toBe(true)
      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Resize)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamJson(frame.payload) : null).toEqual({
        cols: 120,
        rows: 40
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends an activity claim before the user input it sizes', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      subscriptionSendBinary.mockClear()

      expect(transport.claimViewport?.(101, 33)).toBe(true)
      expect(transport.sendInput('x')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      const frames = subscriptionSendBinary.mock.calls.map((call) =>
        decodeTerminalStreamFrame(call[0])
      )
      expect(frames.map((frame) => frame?.opcode)).toEqual([
        TerminalStreamOpcode.ClaimViewport,
        TerminalStreamOpcode.Resize,
        TerminalStreamOpcode.Input
      ])
      expect(frames[0]?.streamId).toBe(streamId)
      expect(frames[0] ? decodeTerminalStreamJson(frames[0].payload) : null).toEqual({
        cols: 101,
        rows: 33
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays remote scrollback through the parser without firing stale attention events', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onReplayData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"old","agentType":"codex"}\x07after\x1b]0;Remote title\x07\x07'
    )

    expect(onReplayData).toHaveBeenCalledWith('beforeafter\x1b]0;Remote title\x07\x07')
    await vi.waitFor(() =>
      expect(onTitleChange).toHaveBeenCalledWith('Remote title', 'Remote title')
    )
    expect(onAgentStatus).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
  })

  it('replays binary snapshot chunks without firing stale attention events', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"old","agentType":"codex"}\x07after'
    )

    expect(onReplayData).toHaveBeenCalledWith('beforeafter')
    expect(onAgentStatus).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
    expect(onConnect).toHaveBeenCalled()
  })

  it('resolves explicit binary snapshot requests without replaying into xterm', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(streamId, 'initial')
    expect(onReplayData).toHaveBeenCalledWith('initial')
    expect(onConnect).toHaveBeenCalled()

    const snapshotPromise = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    const snapshotRequestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const snapshotRequestPayload = snapshotRequestFrame
      ? decodeTerminalStreamJson<{ requestId?: number; scrollbackRows?: number }>(
          snapshotRequestFrame.payload
        )
      : null
    expect(snapshotRequestFrame?.streamId).toBe(streamId)
    expect(snapshotRequestPayload).toMatchObject({ requestId: 1, scrollbackRows: 5000 })

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: snapshotRequestPayload?.requestId,
        cols: 132,
        rows: 43,
        seq: 17,
        source: 'headless'
      })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('requested snapshot')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(snapshotPromise).resolves.toEqual({
      data: 'requested snapshot',
      cols: 132,
      rows: 43,
      seq: 17,
      source: 'headless'
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
    expect(onData).not.toHaveBeenCalledWith('requested snapshot', expect.anything())
  })

  it('keeps initial replay separate from in-flight explicit binary snapshot requests', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    const snapshotPromise = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    const snapshotRequestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const snapshotRequestPayload = snapshotRequestFrame
      ? decodeTerminalStreamJson<{ requestId?: number }>(snapshotRequestFrame.payload)
      : null
    expect(snapshotRequestPayload?.requestId).toBe(1)

    emitSnapshot(streamId, 'initial replay')
    expect(onReplayData).toHaveBeenCalledWith('initial replay')
    expect(onConnect).toHaveBeenCalled()

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: snapshotRequestPayload?.requestId,
        cols: 100,
        rows: 20
      })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('requested replay')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(snapshotPromise).resolves.toEqual({
      data: 'requested replay',
      cols: 100,
      rows: 20,
      seq: undefined,
      source: undefined
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
  })

  it('bounds oversized binary snapshots without closing the live stream', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onError = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onError, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ kind: 'scrollback' })
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1024 * 1024))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1024 * 1024))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    emitOutput(streamId, 'live-after-overflow')

    expect(onReplayData).not.toHaveBeenCalled()
    // Why: an oversized snapshot is skipped but live output continues, so the
    // transport classifies it as benign and never surfaces a fatal red banner.
    expect(onError).not.toHaveBeenCalled()
    expect(onConnect).toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith('live-after-overflow', expect.objectContaining({ seq: 1 }))
  })
})
