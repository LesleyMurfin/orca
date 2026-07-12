import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import type { PtyTransport } from './pty-transport-types'

type RuntimeSubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

type RuntimeSubscriptionRecord = {
  method: string
  callbacks: RuntimeSubscriptionCallbacks
  sendBinary: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
}

const eventOrders = [
  ['stream-error', 'control-timeout', 'resume'],
  ['control-timeout', 'stream-close', 'resume'],
  ['resume', 'old-snapshot', 'new-snapshot']
] as const
const terminalGoneCodes = [
  'terminal_handle_stale',
  'terminal_exited',
  'terminal_gone',
  'no_connected_pty'
] as const

function sessionTab(handle: string | null, status: 'ready' | 'pending-handle' = 'ready') {
  return {
    type: 'terminal',
    id: 'host-tab::pane:1',
    parentTabId: 'host-tab',
    leafId: 'pane:1',
    title: 'Terminal',
    isActive: true,
    status,
    terminal: handle
  }
}

function emitSessionSnapshot(
  record: RuntimeSubscriptionRecord,
  tabs: ReturnType<typeof sessionTab>[],
  snapshotVersion: number
): void {
  record.callbacks.onResponse({
    ok: true,
    result: {
      type: snapshotVersion === 1 ? 'snapshot' : 'updated',
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

function subscribePayload(record: RuntimeSubscriptionRecord): {
  streamId: number
  terminal: string
  viewport?: { cols: number; rows: number }
} {
  const frame = record.sendBinary.mock.calls
    .map((call) => decodeTerminalStreamFrame(call[0]))
    .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
  const payload = frame
    ? decodeTerminalStreamJson<{
        streamId: number
        terminal: string
        viewport?: { cols: number; rows: number }
      }>(frame.payload)
    : null
  if (!payload) {
    throw new Error('missing terminal subscribe payload')
  }
  return payload
}

function emitTerminalSnapshot(
  record: RuntimeSubscriptionRecord,
  streamId: number,
  data = 'authoritative',
  options: { queryReplayBarrier?: boolean } = {}
): void {
  for (const [opcode, payload] of [
    [
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        queryReplayBarrier: options.queryReplayBarrier === true
      })
    ],
    [TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(data)],
    [TerminalStreamOpcode.SnapshotEnd, new Uint8Array()]
  ] as const) {
    record.callbacks.onBinary?.(encodeTerminalStreamFrame({ opcode, streamId, seq: 1, payload }))
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
  }
}

async function createIntegrationHarness(
  args: { failFirstSessionStart?: boolean; direct?: boolean; replyToQueries?: boolean } = {}
): Promise<{
  transport: PtyTransport
  records: RuntimeSubscriptionRecord[]
  runtimeCall: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  onPtyExit: ReturnType<typeof vi.fn>
}> {
  const records: RuntimeSubscriptionRecord[] = []
  const runtimeCall = vi.fn(async () => ({ ok: true, result: {} }))
  let failFirstSessionStart = args.failFirstSessionStart === true
  const runtimeSubscribe = vi.fn(
    async (request: { method: string }, callbacks: RuntimeSubscriptionCallbacks) => {
      const record: RuntimeSubscriptionRecord = {
        method: request.method,
        callbacks,
        sendBinary: vi.fn(),
        unsubscribe: vi.fn()
      }
      records.push(record)
      if (request.method === 'session.tabs.subscribe' && failFirstSessionStart) {
        failFirstSessionStart = false
        throw { code: 'runtime_timeout', message: 'first shared-control start timed out' }
      }
      if (request.method === 'terminal.multiplex') {
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe: record.unsubscribe, sendBinary: record.sendBinary }
      }
      return { unsubscribe: record.unsubscribe }
    }
  )
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onError = vi.fn()
  const onPtyExit = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: args.direct ? 'tab-1' : 'web-terminal-host-tab',
    leafId: 'pane:1',
    onPtyExit
  })
  transport.attach({
    existingPtyId: 'remote:env-1@@terminal-1',
    cols: 80,
    rows: 24,
    callbacks: {
      onError,
      ...(args.replyToQueries
        ? {
            onData: (data: string) => {
              if (data.includes('\x1b[6n')) {
                transport.sendInputImmediate('\x1b[1;1R')
              }
            }
          }
        : {})
    }
  })
  await vi.waitFor(() =>
    expect(records.filter((record) => record.method === 'terminal.multiplex')).toHaveLength(1)
  )
  await settle()
  return { transport, records, runtimeCall, onError, onPtyExit }
}

describe('remote runtime PTY cross-lane recovery ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('keeps a pending host surface in recovery and retires a confirmed-gone surface quietly', async () => {
    const pending = await createIntegrationHarness()
    pending.records[0].callbacks.onClose?.()
    await vi.waitFor(() =>
      expect(
        pending.records.filter((record) => record.method === 'session.tabs.subscribe')
      ).toHaveLength(1)
    )
    const pendingSession = pending.records.find(
      (record) => record.method === 'session.tabs.subscribe'
    )!
    emitSessionSnapshot(pendingSession, [sessionTab(null, 'pending-handle')], 1)
    await settle()
    expect(pending.records.filter((record) => record.method === 'terminal.multiplex')).toHaveLength(
      1
    )
    expect(pending.transport.sendInput('still waiting')).toBe(false)

    emitSessionSnapshot(pendingSession, [sessionTab('terminal-2')], 2)
    await vi.waitFor(() =>
      expect(
        pending.records.filter((record) => record.method === 'terminal.multiplex')
      ).toHaveLength(2)
    )
    const recoveredMux = pending.records.filter(
      (record) => record.method === 'terminal.multiplex'
    )[1]
    const recovered = subscribePayload(recoveredMux)
    emitTerminalSnapshot(recoveredMux, recovered.streamId)
    expect(pending.transport.getPtyId()).toBe('remote:env-1@@terminal-2')

    vi.resetModules()
    const gone = await createIntegrationHarness()
    gone.records[0].callbacks.onClose?.()
    await vi.waitFor(() =>
      expect(
        gone.records.filter((record) => record.method === 'session.tabs.subscribe')
      ).toHaveLength(1)
    )
    emitSessionSnapshot(
      gone.records.find((record) => record.method === 'session.tabs.subscribe')!,
      [],
      1
    )
    await settle()
    expect(gone.transport.getPtyId()).toBeNull()
    expect(gone.onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1')
    expect(gone.onError).not.toHaveBeenCalled()
  })

  it('allows the recovered view to answer a live query after its snapshot replay', async () => {
    const harness = await createIntegrationHarness({ direct: true, replyToQueries: true })
    harness.records[0].callbacks.onClose?.()
    await vi.waitFor(() =>
      expect(
        harness.records.filter((record) => record.method === 'terminal.multiplex')
      ).toHaveLength(2)
    )
    const recoveredMux = harness.records.filter(
      (record) => record.method === 'terminal.multiplex'
    )[1]
    const recovered = subscribePayload(recoveredMux)

    emitTerminalSnapshot(recoveredMux, recovered.streamId, 'screen', {
      queryReplayBarrier: true
    })
    await settle()
    expect(harness.transport.sendInput('still fenced')).toBe(false)
    recoveredMux.callbacks.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.QueryReplay,
        streamId: recovered.streamId,
        seq: 9,
        payload: encodeTerminalStreamText('\x1b[6n')
      })
    )
    await settle()
    expect(harness.transport.sendInput('fenced after replay data')).toBe(false)

    recoveredMux.callbacks.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: recovered.streamId,
        seq: 13,
        payload: encodeTerminalStreamText('\x1b[6n')
      })
    )
    await settle()
    expect(harness.transport.sendInput('fenced after pending output')).toBe(false)

    recoveredMux.callbacks.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.QueryReplay,
        streamId: recovered.streamId,
        seq: 13,
        payload: new Uint8Array()
      })
    )
    await settle()
    expect(harness.transport.sendInput('ready after final barrier')).toBe(true)

    const replies = recoveredMux.sendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
      .map((frame) => (frame ? new TextDecoder().decode(frame.payload) : ''))
    expect(replies).toEqual(['\x1b[1;1R', '\x1b[1;1R'])
  })

  it('keeps recovery fenced until an empty query replay barrier arrives', async () => {
    const harness = await createIntegrationHarness({ direct: true })
    harness.records[0].callbacks.onClose?.()
    await vi.waitFor(() =>
      expect(
        harness.records.filter((record) => record.method === 'terminal.multiplex')
      ).toHaveLength(2)
    )
    const recoveredMux = harness.records.filter(
      (record) => record.method === 'terminal.multiplex'
    )[1]
    const recovered = subscribePayload(recoveredMux)

    emitTerminalSnapshot(recoveredMux, recovered.streamId, 'screen', {
      queryReplayBarrier: true
    })
    await settle()
    expect(harness.transport.sendInput('still fenced')).toBe(false)

    recoveredMux.callbacks.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.QueryReplay,
        streamId: recovered.streamId,
        seq: 1,
        payload: new Uint8Array()
      })
    )
    await settle()

    expect(harness.transport.sendInput('ready')).toBe(true)
  })

  it.each(terminalGoneCodes)(
    'retires staged message-only %s errors without a pane error',
    async (code) => {
      const harness = await createIntegrationHarness({ direct: true })
      harness.records[0].callbacks.onClose?.()
      await vi.waitFor(() =>
        expect(
          harness.records.filter((record) => record.method === 'terminal.multiplex')
        ).toHaveLength(2)
      )
      expect(
        harness.records.filter((record) => record.method === 'session.tabs.subscribe')
      ).toEqual([])
      const stagedMux = harness.records.filter(
        (record) => record.method === 'terminal.multiplex'
      )[1]
      const staged = subscribePayload(stagedMux)
      expect(staged.terminal).toBe('terminal-1')

      stagedMux.callbacks.onResponse({
        ok: true,
        result: { type: 'error', streamId: staged.streamId, message: code }
      })
      await settle()

      expect(harness.transport.getPtyId()).toBeNull()
      expect(harness.onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1')
      expect(harness.onPtyExit).toHaveBeenCalledOnce()
      expect(harness.onError).not.toHaveBeenCalled()

      const { retryRemoteRuntimeTerminalRecoveriesNow } =
        await import('../../runtime/remote-runtime-terminal-recovery-coordinator')
      retryRemoteRuntimeTerminalRecoveriesNow()
      await settle()
      expect(
        harness.records.filter((record) => record.method === 'terminal.multiplex')
      ).toHaveLength(2)
      expect(harness.onPtyExit).toHaveBeenCalledOnce()
      expect(harness.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.create' })
      )
      expect(harness.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.close' })
      )
    }
  )

  it('keeps embedded terminal-gone text on the staged fatal path', async () => {
    const harness = await createIntegrationHarness({ direct: true })
    harness.records[0].callbacks.onClose?.()
    await vi.waitFor(() =>
      expect(
        harness.records.filter((record) => record.method === 'terminal.multiplex')
      ).toHaveLength(2)
    )
    const stagedMux = harness.records.filter((record) => record.method === 'terminal.multiplex')[1]
    const staged = subscribePayload(stagedMux)
    const message = 'failed during terminal_gone cleanup'

    stagedMux.callbacks.onResponse({
      ok: true,
      result: { type: 'error', streamId: staged.streamId, message }
    })
    await settle()

    expect(harness.transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(harness.onPtyExit).not.toHaveBeenCalled()
    expect(harness.onError).toHaveBeenCalledWith(message)
  })

  it.each(eventOrders)('recovers one generation for cross-lane order %j', async (order) => {
    vi.useFakeTimers()
    try {
      const harness = await createIntegrationHarness({ failFirstSessionStart: true })
      const initialMux = harness.records[0]
      initialMux.callbacks.onClose?.()
      await settle()
      const firstSession = harness.records.find(
        (record) => record.method === 'session.tabs.subscribe'
      )!

      for (const event of order) {
        if (event === 'stream-error') {
          initialMux.callbacks.onError?.({
            code: 'remote_runtime_unavailable',
            message: 'late old stream error'
          })
        } else if (event === 'stream-close') {
          initialMux.callbacks.onClose?.()
        } else if (event === 'control-timeout') {
          firstSession.callbacks.onError?.({ code: 'runtime_timeout', message: 'late timeout' })
          firstSession.callbacks.onClose?.()
        } else if (event === 'resume') {
          const { retryRemoteRuntimeTerminalRecoveriesNow } =
            await import('../../runtime/remote-runtime-terminal-recovery-coordinator')
          retryRemoteRuntimeTerminalRecoveriesNow()
          await settle()
        } else if (event === 'old-snapshot') {
          emitSessionSnapshot(firstSession, [sessionTab('terminal-old')], 1)
        } else if (event === 'new-snapshot') {
          const current = harness.records.findLast(
            (record) => record.method === 'session.tabs.subscribe'
          )!
          emitSessionSnapshot(current, [sessionTab('terminal-2')], 2)
        }
        await settle()
      }

      let sessions = harness.records.filter((record) => record.method === 'session.tabs.subscribe')
      if (sessions.length === 1) {
        await vi.advanceTimersByTimeAsync(250)
        await settle()
        sessions = harness.records.filter((record) => record.method === 'session.tabs.subscribe')
      }
      const currentSession = sessions.at(-1)!
      if (!order.includes('new-snapshot')) {
        emitSessionSnapshot(currentSession, [sessionTab('terminal-2')], 2)
      }
      await settle()
      const multiplexers = harness.records.filter(
        (record) => record.method === 'terminal.multiplex'
      )
      expect(sessions).toHaveLength(2)
      expect(multiplexers).toHaveLength(2)
      const recoveredMux = multiplexers[1]
      const recovered = subscribePayload(recoveredMux)
      expect(recovered.terminal).toBe('terminal-2')
      expect(harness.transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      emitTerminalSnapshot(recoveredMux, recovered.streamId)

      expect(harness.transport.getPtyId()).toBe('remote:env-1@@terminal-2')
      expect(harness.onError).not.toHaveBeenCalled()
      expect(harness.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.create' })
      )
      expect(harness.runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.close' })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
