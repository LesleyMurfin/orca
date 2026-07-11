/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalCreate,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
import { createPtyOutputProcessor } from './pty-transport'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  runtimeTerminalErrorMessage,
  toRemoteRuntimePtyId
} from '../../runtime/runtime-terminal-stream'
import {
  getRemoteRuntimeTerminalMultiplexer,
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE,
  type RemoteRuntimeMultiplexedTerminal
} from '../../runtime/remote-runtime-terminal-multiplexer'
import { resolveRemoteRuntimeHostTerminal } from '../../runtime/remote-runtime-host-terminal-resolution'
import {
  beginRemoteRuntimeTerminalRecovery,
  type RemoteRuntimeTerminalRecoveryLease,
  type RemoteRuntimeTerminalRecoverySnapshot
} from '../../runtime/remote-runtime-terminal-recovery-coordinator'
import {
  toRuntimeTerminalWorktreeSelector,
  toRuntimeWorktreeSelector
} from '../../runtime/runtime-worktree-selector'
import {
  createRemoteRuntimePtyTextBatcher,
  createRemoteRuntimeViewportBatcher
} from './remote-runtime-pty-batching'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { stageRemoteRuntimePtyRebind } from './remote-runtime-pty-staged-rebind'
import { findEmbeddedRemoteRuntimeTerminalGoneCode } from './remote-runtime-terminal-gone-error'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '@/runtime/web-terminal-surface-id'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 8
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000
let nextRemoteRuntimeRecoveryParticipantId = 1

/**
 * PTY transport backing a renderer terminal pane with a terminal on a remote Orca
 * runtime, over runtime RPC plus the multiplexed stream (create, subscribe, input,
 * resize, close, reattach).
 */
export function createRemoteRuntimePtyTransport(
  runtimeEnvironmentId: string,
  opts: IpcPtyTransportOptions = {}
): PtyTransport {
  const {
    command,
    startupCommandDelivery,
    env,
    launchConfig,
    launchToken,
    launchAgent,
    worktreeId,
    tabId,
    leafId,
    activate,
    onPtyExit,
    onPtySpawn,
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let destroyed = false
  let handle: string | null = null
  let remotePtyId: string | null = null
  let currentRuntimeEnvironmentId = runtimeEnvironmentId
  let multiplexedStream: RemoteRuntimeMultiplexedTerminal | null = null
  let multiplexedStreamHandle: string | null = null
  let desiredViewport: { cols: number; rows: number } | null = null
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  let bindingGeneration = 0
  let recovering = false
  let recoveryLease: RemoteRuntimeTerminalRecoveryLease | null = null
  let stagedRecoveryToken: object | null = null
  let pendingViewportClaim = false
  let pendingClaimInput = ''
  const viewportClaimReadyWaiters = new Set<(ready: boolean) => void>()
  const clearPendingViewportClaim = (): void => {
    pendingViewportClaim = false
    pendingClaimInput = ''
    for (const resolve of viewportClaimReadyWaiters) {
      resolve(false)
    }
    viewportClaimReadyWaiters.clear()
  }
  // Why: tab/leaf ids identify the mirrored host pane, so every paired viewer
  // shares them. The instance suffix keeps one viewer's refresh off peer records.
  const clientId = `desktop:${tabId ?? 'tab'}:${leafId ?? 'leaf'}:${createBrowserUuid()}`
  const recoveryParticipantId = `remote-pty:${nextRemoteRuntimeRecoveryParticipantId++}`
  const createRemoteOutputProcessor = () =>
    createPtyOutputProcessor({
      onTitleChange,
      onBell,
      onAgentBecameIdle,
      onAgentBecameWorking,
      onAgentExited,
      onAgentStatus
    })
  let outputProcessor = createRemoteOutputProcessor()

  function findReadyHostSessionHandle(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): string | null {
    const resolution = resolveRemoteRuntimeHostTerminal(snapshot, { hostTabId, leafId })
    return resolution.kind === 'ready' ? resolution.handle : null
  }

  function hasHostSessionTerminalSurface(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): boolean {
    return resolveRemoteRuntimeHostTerminal(snapshot, { hostTabId, leafId }).kind !== 'gone'
  }

  async function waitForHostSessionHandle(hostTabId: string): Promise<string | null> {
    if (!worktreeId) {
      return null
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    const activated = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.activate', {
      worktree,
      tabId: hostTabId,
      ...(leafId ? { leafId } : {})
    })
    const immediate = findReadyHostSessionHandle(activated, hostTabId)
    if (immediate) {
      return immediate
    }

    const startedAt = Date.now()
    while (!destroyed) {
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return null
      }
      // Why: host mirrors can be published before their PTY handle is ready,
      // but a stuck pending surface must not poll the runtime forever.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(HOST_SESSION_ATTACH_POLL_MS, remainingMs))
      )
      const listed = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
        worktree
      })
      const handle = findReadyHostSessionHandle(listed, hostTabId)
      if (handle) {
        return handle
      }
      if (!hasHostSessionTerminalSurface(listed, hostTabId)) {
        return null
      }
    }
    return null
  }

  async function attachHostSessionMirror(
    options: Parameters<PtyTransport['connect']>[0]
  ): Promise<PtyConnectResult | undefined> {
    if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
      return undefined
    }
    const hostTabId = toHostSessionTabId(tabId)
    const hostHandle = await waitForHostSessionHandle(hostTabId)
    if (!hostHandle || destroyed) {
      if (!destroyed) {
        storedCallbacks.onError?.('Remote terminal was closed.')
      }
      return undefined
    }

    prepareBindingReplacement()
    handle = hostHandle
    remotePtyId = toRemoteRuntimePtyId(hostHandle, currentRuntimeEnvironmentId)
    connected = true
    desiredViewport = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    }
    invokeSafely(() => onPtySpawn?.(remotePtyId!))

    await subscribeToHandle()
    if (destroyed || !connected || !remotePtyId) {
      return undefined
    }

    return {
      id: remotePtyId,
      replay: ''
    } satisfies PtyConnectResult
  }

  async function callRuntime<TResult>(method: string, params?: unknown): Promise<TResult> {
    const response = await window.api.runtimeEnvironments.call({
      selector: currentRuntimeEnvironmentId,
      method,
      params,
      timeoutMs: 15_000
    })
    return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>)
  }

  async function closeRemoteTerminal(handleOverride?: string): Promise<void> {
    const targetHandle = handleOverride ?? handle
    if (!targetHandle) {
      return
    }
    try {
      await callRuntime('terminal.close', { terminal: targetHandle })
    } catch {
      // Best-effort parity with local disconnect/kill.
    }
  }

  async function sendInputAcceptedToRuntime(data: string): Promise<boolean> {
    const targetHandle = handle
    const targetGeneration = bindingGeneration
    if (!connected || !targetHandle || recovering) {
      return false
    }
    if (!data) {
      return true
    }
    await inputBatcher.drain()
    if (!isCurrentBinding(targetGeneration, targetHandle) || recovering) {
      return false
    }
    if (pendingViewportClaim && !getCurrentMultiplexedStream(targetHandle)) {
      const ready = await new Promise<boolean>((resolve) => {
        viewportClaimReadyWaiters.add(resolve)
      })
      if (!ready || !connected || handle !== targetHandle) {
        return false
      }
    }
    // Why: normal remote sendInput may be waiting on yielded size validation;
    // drain it before acknowledged writes so terminal bytes stay ordered.
    const text = `${inputBatcher.takePending()}${data}`
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(text)
      if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
        return false
      }
    } catch {
      return false
    }
    if (!isCurrentBinding(targetGeneration, targetHandle) || recovering) {
      return false
    }
    try {
      for (const chunk of iterateTerminalInputChunks(text)) {
        if (!isCurrentBinding(targetGeneration, targetHandle) || recovering) {
          return false
        }
        // Why: acknowledged sends are ordered behind any pending debounce text,
        // but they must not collapse large paste input back into one remote RPC.
        const result = await callRuntime<{ send: RuntimeTerminalSend }>('terminal.send', {
          terminal: targetHandle,
          text: chunk,
          client: { id: clientId, type: 'desktop' },
          ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
        })
        if (result.send.accepted !== true) {
          return false
        }
      }
      return isCurrentBinding(targetGeneration, targetHandle) && !recovering
    } catch (error) {
      // Why: stale-handle errors must retire the mirror (recoverable via the
      // next snapshot) rather than dead-end in a red xterm banner (#7718).
      if (isCurrentBinding(targetGeneration, targetHandle) && !recovering) {
        handleRemoteTerminalError(error)
      }
      return false
    }
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(REMOTE_TERMINAL_INPUT_FLUSH_MS, (text) => {
    const targetHandle = handle
    const targetGeneration = bindingGeneration
    if (!connected || !targetHandle || recovering) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (stream?.sendInput(text)) {
      return
    }
    if (pendingViewportClaim) {
      // Why: a claim during subscribe/reconnect has no stream record to own
      // yet. Hold its input until the stream can emit claim+input in one order.
      pendingClaimInput += text
      return
    }
    void callRuntime('terminal.send', {
      terminal: targetHandle,
      text,
      client: { id: clientId, type: 'desktop' },
      ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
    }).catch((error) => {
      if (isCurrentBinding(targetGeneration, targetHandle) && !recovering) {
        handleRemoteTerminalError(error)
      }
    })
  })

  function sendViewportUpdate(cols: number, rows: number, claim = false): void {
    const targetHandle = handle
    if (!connected || !targetHandle || recovering) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (claim ? stream?.claimViewport(cols, rows) : stream?.resize(cols, rows)) {
      if (claim) {
        pendingViewportClaim = false
      }
      return
    }
    if (claim) {
      pendingViewportClaim = true
    }
    void callRuntime('terminal.updateViewport', {
      terminal: targetHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: { cols, rows },
      ...(claim ? { claim: true } : {})
    }).catch(() => {})
  }

  const viewportBatcher = createRemoteRuntimeViewportBatcher(
    REMOTE_TERMINAL_VIEWPORT_FLUSH_MS,
    sendViewportUpdate
  )

  function rememberViewport(cols: number, rows: number): void {
    desiredViewport = { cols, rows }
  }

  function getCurrentMultiplexedStream(
    targetHandle: string
  ): RemoteRuntimeMultiplexedTerminal | null {
    return multiplexedStreamHandle === targetHandle ? multiplexedStream : null
  }

  function closeMultiplexedStream(): void {
    multiplexedStream?.close()
    multiplexedStream = null
    multiplexedStreamHandle = null
  }

  function isCurrentBinding(targetGeneration: number, targetHandle: string): boolean {
    return (
      !destroyed && connected && bindingGeneration === targetGeneration && handle === targetHandle
    )
  }

  function isCurrentRemoteTerminal(
    targetGeneration: number,
    targetHandle: string,
    targetPtyId: string | null
  ): boolean {
    return (
      isCurrentBinding(targetGeneration, targetHandle) &&
      remotePtyId === targetPtyId &&
      targetPtyId !== null
    )
  }

  function retireRemoteTerminalId(): void {
    bindingGeneration += 1
    recovering = false
    stagedRecoveryToken = null
    cancelRecoveryLease()
    inputBatcher.clear()
    viewportBatcher.clear()
    outputProcessor.clearAccumulatedState()
    connected = false
    clearPendingViewportClaim()
    const stalePtyId = remotePtyId
    handle = null
    remotePtyId = null
    closeMultiplexedStream()
    if (stalePtyId) {
      invokeSafely(() => onPtyExit?.(stalePtyId))
    }
  }

  function cancelRecoveryLease(): void {
    const lease = recoveryLease
    recoveryLease = null
    if (lease) {
      invokeSafely(lease.cancel)
    }
  }

  function prepareBindingReplacement(): void {
    bindingGeneration += 1
    recovering = false
    stagedRecoveryToken = null
    cancelRecoveryLease()
    inputBatcher.clear()
    viewportBatcher.clear()
    clearPendingViewportClaim()
    replaceOutputProcessor()
    closeMultiplexedStream()
  }

  function replaceOutputProcessor(): void {
    outputProcessor.clearAccumulatedState()
    outputProcessor = createRemoteOutputProcessor()
  }

  function handleRemoteTerminalError(error: unknown): void {
    const message = runtimeTerminalErrorMessage(error)
    if (message === REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE) {
      // Why: an oversized initial snapshot is skipped but live output keeps
      // flowing — informational, not fatal, so never surface a red xterm banner.
      return
    }
    if (findEmbeddedRemoteRuntimeTerminalGoneCode(message)) {
      // Why: paired web clients consume host-published PTY handles. If the host
      // retires one between snapshots, clear this mirror and wait for the next
      // session-tabs update instead of surfacing a red xterm error.
      retireRemoteTerminalId()
      return
    }
    invokeSafely(() => storedCallbacks.onError?.(message))
  }

  function processRemoteData(
    data: string,
    meta: { seq?: number; rawLength?: number } | undefined,
    isStillCurrent: () => boolean
  ): void {
    const deliveryProcessor = outputProcessor
    deliveryProcessor.processData(data, storedCallbacks, undefined, meta)
    clearInvalidatedOutputSideEffects(deliveryProcessor, isStillCurrent)
  }

  function processRemoteSnapshot(
    data: string,
    meta: { pendingEscapeTailAnsi?: string } | undefined,
    isStillCurrent: () => boolean
  ): void | Promise<void> {
    // Why: a snapshot with no body can still carry a pending mid-escape tail
    // that must be replayed so the next live chunk completes it. An empty
    // authoritative snapshot must still clear stale mirror contents.
    const deliveryProcessor = outputProcessor
    const replayCompletion = deliveryProcessor.processData(data, storedCallbacks, {
      replayingBufferedData: true,
      suppressAttentionEvents: true,
      ...(meta?.pendingEscapeTailAnsi ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi } : {})
    })
    clearInvalidatedOutputSideEffects(deliveryProcessor, isStillCurrent)
    if (replayCompletion) {
      return replayCompletion.finally(() => {
        clearInvalidatedOutputSideEffects(deliveryProcessor, isStillCurrent)
      })
    }
  }

  function clearInvalidatedOutputSideEffects(
    deliveryProcessor: ReturnType<typeof createPtyOutputProcessor>,
    isStillCurrent: () => boolean
  ): void {
    if (!isStillCurrent()) {
      // `processData` queues derived OSC/BEL work after delivering output. A
      // reentrant attach invalidates that delivery, so discard its queued facts.
      deliveryProcessor.clearAccumulatedState()
    }
  }

  function endCurrentRemoteTerminal(
    targetGeneration: number,
    targetHandle: string,
    targetPtyId: string | null
  ): void {
    if (!isCurrentRemoteTerminal(targetGeneration, targetHandle, targetPtyId)) {
      return
    }
    bindingGeneration += 1
    recovering = false
    stagedRecoveryToken = null
    cancelRecoveryLease()
    inputBatcher.clear()
    viewportBatcher.clear()
    clearPendingViewportClaim()
    outputProcessor.clearAccumulatedState()
    connected = false
    handle = null
    remotePtyId = null
    multiplexedStream = null
    multiplexedStreamHandle = null
    invokeSafely(() => storedCallbacks.onExit?.(0))
    invokeSafely(() => storedCallbacks.onDisconnect?.())
    if (targetPtyId) {
      invokeSafely(() => onPtyExit?.(targetPtyId))
    }
  }

  function startRecovery(
    sourceGeneration: number,
    sourceHandle: string,
    sourcePtyId: string | null
  ): void {
    if (!isCurrentRemoteTerminal(sourceGeneration, sourceHandle, sourcePtyId)) {
      return
    }
    const recoveryBindingGeneration = ++bindingGeneration
    recovering = true
    stagedRecoveryToken = null
    inputBatcher.clear()
    viewportBatcher.clear()
    clearPendingViewportClaim()
    replaceOutputProcessor()
    closeMultiplexedStream()
    cancelRecoveryLease()
    const hostMirror = Boolean(tabId && worktreeId && isWebTerminalSurfaceTabId(tabId))
    const hostTabId = hostMirror && tabId ? toHostSessionTabId(tabId) : null
    const participant = {
      id: recoveryParticipantId,
      worktreeId: hostMirror ? (worktreeId ?? null) : null,
      resolveHandle: (snapshot: RemoteRuntimeTerminalRecoverySnapshot | null) => {
        if (hostTabId) {
          return snapshot
            ? resolveRemoteRuntimeHostTerminal(snapshot, { hostTabId, leafId })
            : { kind: 'pending' as const }
        }
        return { kind: 'ready' as const, handle: sourceHandle }
      },
      rebind: ({ handle: nextHandle, signal }: { handle: string; signal: AbortSignal }) =>
        rebindRecoveredTerminal({
          recoveryBindingGeneration,
          nextHandle,
          signal
        }),
      onGone: () => {
        if (bindingGeneration === recoveryBindingGeneration && recovering) {
          recoveryLease = null
          retireRemoteTerminalId()
        }
      },
      onFatal: (error: { code: string; message: string }) => {
        if (bindingGeneration !== recoveryBindingGeneration || !recovering) {
          return
        }
        recoveryLease = null
        stagedRecoveryToken = null
        invokeSafely(() => storedCallbacks.onError?.(error.message))
      }
    }
    recoveryLease = beginRemoteRuntimeTerminalRecovery({
      environmentId: currentRuntimeEnvironmentId,
      participant
    })
  }

  function rebindRecoveredTerminal(args: {
    recoveryBindingGeneration: number
    nextHandle: string
    signal: AbortSignal
  }): Promise<void> {
    const token = {}
    stagedRecoveryToken = token
    let previousPtyId: string | null = null
    let nextPtyId: string | null = null
    let activatedStream: RemoteRuntimeMultiplexedTerminal | null = null
    const isRecoveredBindingCurrent = (): boolean =>
      activatedStream !== null &&
      isCurrentRemoteTerminal(args.recoveryBindingGeneration, args.nextHandle, nextPtyId) &&
      multiplexedStream === activatedStream &&
      multiplexedStreamHandle === args.nextHandle
    const promise = stageRemoteRuntimePtyRebind({
      handle: args.nextHandle,
      bindingGeneration: args.recoveryBindingGeneration,
      signal: args.signal,
      client: { id: clientId, type: 'desktop' },
      viewport: desiredViewport,
      subscribe: (subscription) =>
        getRemoteRuntimeTerminalMultiplexer(currentRuntimeEnvironmentId).subscribeTerminal(
          subscription
        ),
      canCommit: ({ bindingGeneration: candidateGeneration }) =>
        !destroyed &&
        connected &&
        recovering &&
        bindingGeneration === candidateGeneration &&
        stagedRecoveryToken === token,
      activate: ({ bindingGeneration: candidateGeneration, handle: nextHandle, stream }) => {
        previousPtyId = remotePtyId
        nextPtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
        if (multiplexedStream && multiplexedStream !== stream) {
          closeMultiplexedStream()
        }
        handle = nextHandle
        remotePtyId = nextPtyId
        multiplexedStream = stream
        multiplexedStreamHandle = nextHandle
        bindingGeneration = candidateGeneration
        activatedStream = stream
      },
      isActive: ({ bindingGeneration: candidateGeneration, handle: candidateHandle, stream }) =>
        candidateGeneration === args.recoveryBindingGeneration &&
        candidateHandle === args.nextHandle &&
        stream === activatedStream &&
        isRecoveredBindingCurrent(),
      onCommitted: (subscribedViewport) => {
        const stream = getCurrentMultiplexedStream(args.nextHandle)
        const stillCurrent = (): boolean =>
          isCurrentRemoteTerminal(args.recoveryBindingGeneration, args.nextHandle, nextPtyId) &&
          getCurrentMultiplexedStream(args.nextHandle) === stream
        if (!stream || !stillCurrent()) {
          return
        }
        recovering = false
        recoveryLease = null
        if (stream && desiredViewport && !sameViewport(desiredViewport, subscribedViewport)) {
          // Why: a resize racing the subscribe handshake must converge on the
          // committed stream, never fall back to the stale handle's RPC lane.
          invokeSafely(() => stream.resize(desiredViewport!.cols, desiredViewport!.rows))
        }
        if (nextPtyId && nextPtyId !== previousPtyId) {
          invokeSafely(() => onPtySpawn?.(nextPtyId!))
        }
        if (!stillCurrent()) {
          return
        }
        invokeSafely(() => storedCallbacks.onConnect?.())
        if (stillCurrent()) {
          invokeSafely(() => storedCallbacks.onStatus?.('shell'))
        }
      },
      onData: (data, meta) => processRemoteData(data, meta, isRecoveredBindingCurrent),
      onSnapshot: (data, meta) => processRemoteSnapshot(data, meta, isRecoveredBindingCurrent),
      onEnd: () =>
        endCurrentRemoteTerminal(args.recoveryBindingGeneration, args.nextHandle, nextPtyId),
      onError: handleRemoteTerminalError,
      onFitOverrideChanged: (event) => {
        if (nextPtyId) {
          setFitOverride(nextPtyId, event.mode, event.cols, event.rows)
        }
      },
      onDriverChanged: (driver) => {
        if (nextPtyId) {
          setDriverForPty(nextPtyId, driver)
        }
      },
      onTransportClose: () =>
        startRecovery(args.recoveryBindingGeneration, args.nextHandle, nextPtyId)
    })
    return promise.finally(() => {
      if (stagedRecoveryToken === token) {
        stagedRecoveryToken = null
      }
    })
  }

  async function subscribeToHandle(): Promise<void> {
    if (!handle) {
      return
    }
    const subscribedHandle = handle
    const subscribedPtyId = remotePtyId
    // Why: the viewport we hand the subscribe request. A resize landing during
    // the round-trip falls back to the one-shot RPC, which is refresh-only (no
    // leak) and no-ops before the stream record exists — so replay the latest
    // remembered viewport through the stream once it's current (below).
    const subscribedViewport = desiredViewport
    const subscribedGeneration = bindingGeneration
    const isCurrentSubscription = (): boolean =>
      isCurrentRemoteTerminal(subscribedGeneration, subscribedHandle, subscribedPtyId)
    const nextStream = await getRemoteRuntimeTerminalMultiplexer(
      currentRuntimeEnvironmentId
    ).subscribeTerminal({
      terminal: subscribedHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: subscribedViewport ?? undefined,
      callbacks: {
        onData: (data, meta) => {
          if (isCurrentSubscription()) {
            processRemoteData(data, meta, isCurrentSubscription)
          }
        },
        onSnapshot: (data, meta) => {
          if (isCurrentSubscription()) {
            processRemoteSnapshot(data, meta, isCurrentSubscription)
          }
        },
        onSubscribed: () => {
          if (!isCurrentSubscription()) {
            return
          }
          invokeSafely(() => storedCallbacks.onConnect?.())
          invokeSafely(() => storedCallbacks.onStatus?.('shell'))
        },
        onEnd: () =>
          endCurrentRemoteTerminal(subscribedGeneration, subscribedHandle, subscribedPtyId),
        onError: (message) => {
          if (isCurrentSubscription()) {
            handleRemoteTerminalError(message)
          }
        },
        onFitOverrideChanged: (event) => {
          if (isCurrentSubscription() && subscribedPtyId) {
            setFitOverride(subscribedPtyId, event.mode, event.cols, event.rows)
          }
        },
        onDriverChanged: (driver) => {
          if (isCurrentSubscription() && subscribedPtyId) {
            setDriverForPty(subscribedPtyId, driver)
          }
        },
        onTransportClose: () =>
          startRecovery(subscribedGeneration, subscribedHandle, subscribedPtyId)
      }
    })
    if (!isCurrentRemoteTerminal(subscribedGeneration, subscribedHandle, subscribedPtyId)) {
      nextStream.close()
      return
    }
    closeMultiplexedStream()
    multiplexedStream = nextStream
    multiplexedStreamHandle = subscribedHandle
    // Why: a viewport change that landed during the subscribe round-trip took
    // the now-no-op one-shot fallback, so the stream record is still at the
    // subscribe-time size. Replay the latest remembered viewport so the PTY
    // tracks the current width instead of stalling until the next resize.
    if (pendingViewportClaim && desiredViewport) {
      nextStream.claimViewport(desiredViewport.cols, desiredViewport.rows)
      pendingViewportClaim = false
      const queuedInput = pendingClaimInput
      pendingClaimInput = ''
      if (queuedInput) {
        nextStream.sendInput(queuedInput)
      }
      for (const resolve of viewportClaimReadyWaiters) {
        resolve(true)
      }
      viewportClaimReadyWaiters.clear()
    } else if (
      desiredViewport &&
      (desiredViewport.cols !== subscribedViewport?.cols ||
        desiredViewport.rows !== subscribedViewport?.rows)
    ) {
      nextStream.resize(desiredViewport.cols, desiredViewport.rows)
    }
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      if (destroyed || !worktreeId) {
        return
      }

      try {
        if (isWebTerminalSurfaceTabId(tabId ?? '')) {
          return await attachHostSessionMirror(options)
        }

        const commandToSend = options.command ?? command
        const startupCommandDeliveryToSend =
          options.startupCommandDelivery ?? startupCommandDelivery
        const envToSend = options.env ?? env
        const launchConfigToSend = options.launchConfig ?? launchConfig
        const launchTokenToSend = options.launchToken ?? launchToken
        const launchAgentToSend = options.launchAgent ?? launchAgent
        const created = await callRuntime<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
          worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
          ...(commandToSend !== undefined ? { command: commandToSend } : {}),
          ...(startupCommandDeliveryToSend !== undefined
            ? { startupCommandDelivery: startupCommandDeliveryToSend }
            : {}),
          ...(envToSend !== undefined ? { env: envToSend } : {}),
          ...(launchConfigToSend !== undefined ? { launchConfig: launchConfigToSend } : {}),
          ...(launchTokenToSend !== undefined ? { launchToken: launchTokenToSend } : {}),
          ...(launchAgentToSend !== undefined ? { launchAgent: launchAgentToSend } : {}),
          tabId,
          leafId,
          focus: false,
          // Why: this transport is backing an already-mounted renderer pane;
          // activation here is local state, not permission for remote UI reveal.
          presentation: 'background',
          ...(activate === true ? { activate: true } : {})
        })
        handle = created.terminal.handle
        if (destroyed) {
          // Why: this is a cancelled launch, not a connected shared session.
          // Close the server PTY so rapid tab-open/tab-close does not leak.
          await closeRemoteTerminal(created.terminal.handle)
          return
        }

        prepareBindingReplacement()
        handle = created.terminal.handle
        remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
        connected = true
        desiredViewport = {
          cols: options.cols ?? 80,
          rows: options.rows ?? 24
        }
        invokeSafely(() => onPtySpawn?.(remotePtyId!))

        await subscribeToHandle()
        if (destroyed || !connected || !remotePtyId) {
          return
        }

        return {
          id: remotePtyId,
          replay: ''
        } satisfies PtyConnectResult
      } catch (error) {
        storedCallbacks.onError?.(runtimeTerminalErrorMessage(error))
        return undefined
      }
    },

    attach(options) {
      if (destroyed) {
        return
      }
      prepareBindingReplacement()
      storedCallbacks = options.callbacks
      currentRuntimeEnvironmentId =
        getRemoteRuntimePtyEnvironmentId(options.existingPtyId) ?? runtimeEnvironmentId
      const nextHandle = getRemoteRuntimeTerminalHandle(options.existingPtyId)
      handle = nextHandle
      if (!handle) {
        connected = false
        remotePtyId = null
        invokeSafely(() => storedCallbacks.onError?.('Remote runtime terminal id is invalid.'))
        return
      }
      // Why: legacy restored ids omitted their runtime owner. Canonicalize at
      // attach so renderer stores and lifecycle guards never share raw aliases.
      remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      const targetHandle = handle
      const targetPtyId = remotePtyId
      const targetGeneration = bindingGeneration
      void subscribeToHandle().catch((error) => {
        if (!isCurrentRemoteTerminal(targetGeneration, targetHandle, targetPtyId)) {
          return
        }
        if (handle === targetHandle && multiplexedStreamHandle !== targetHandle) {
          closeMultiplexedStream()
        }
        clearPendingViewportClaim()
        handleRemoteTerminalError(error)
      })
    },

    disconnect() {
      bindingGeneration += 1
      recovering = false
      stagedRecoveryToken = null
      cancelRecoveryLease()
      inputBatcher.clear()
      viewportBatcher.clear()
      outputProcessor.clearAccumulatedState()
      if (!connected && !handle) {
        return
      }
      connected = false
      clearPendingViewportClaim()
      const id = remotePtyId
      closeMultiplexedStream()
      handle = null
      remotePtyId = null
      invokeSafely(() => storedCallbacks.onDisconnect?.())
      if (id) {
        invokeSafely(() => onPtyExit?.(id))
      }
    },

    detach() {
      bindingGeneration += 1
      recovering = false
      stagedRecoveryToken = null
      cancelRecoveryLease()
      inputBatcher.clear()
      viewportBatcher.clear()
      outputProcessor.clearAccumulatedState()
      connected = false
      clearPendingViewportClaim()
      closeMultiplexedStream()
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !handle || recovering) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: callers use \r or terminal.send's enter flag for semantic Enter;
      // literal LF bytes from paste/programmatic input must survive the stream.
      return inputBatcher.push(data)
    },

    // Why: terminal query replies (CPR/DSR/DA/OSC color/pixel size) are read by
    // the querying program in raw mode with a short timeout. The 8ms input
    // debounce makes the reply miss that window, so it lands on the shell prompt
    // and is echoed literally / spliced into typed input (#7329). Flush any
    // pending batched input first so byte order is preserved, then send the
    // reply immediately without arming the debounce timer.
    sendInputImmediate(data: string): boolean {
      const targetHandle = handle
      const targetGeneration = bindingGeneration
      if (!connected || !targetHandle || recovering) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: earlier input (e.g. a large paste) may still be in async byte-length
      // validation, so it is captured in the batcher's validationTail and NOT in
      // takePending(). Bypassing the queue here would send the reply ahead of it
      // and reorder bytes on the wire. In that rare window, route the reply
      // through the batcher's ordered queue and flush what is already validated;
      // the reply lands right after the pending input once its validation
      // resolves. Order correctness beats the immediacy that the debounce
      // normally trades away.
      if (inputBatcher.hasPendingValidation()) {
        const accepted = inputBatcher.push(data)
        inputBatcher.flush()
        return accepted
      }
      const pending = inputBatcher.takePending()
      const text = `${pending}${data}`
      const stream = getCurrentMultiplexedStream(targetHandle)
      if (stream?.sendInput(text)) {
        return true
      }
      if (pendingViewportClaim) {
        pendingClaimInput += text
        return true
      }
      void callRuntime('terminal.send', {
        terminal: targetHandle,
        text,
        client: { id: clientId, type: 'desktop' },
        ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
      }).catch((error) => {
        if (isCurrentBinding(targetGeneration, targetHandle) && !recovering) {
          handleRemoteTerminalError(error)
        }
      })
      return true
    },

    sendInputAccepted: sendInputAcceptedToRuntime,

    claimViewport(cols: number, rows: number): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (recovering) {
        return true
      }
      viewportBatcher.clear()
      sendViewportUpdate(cols, rows, true)
      return true
    },

    resize(cols: number, rows: number, meta): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (recovering) {
        return true
      }
      if (meta?.claim) {
        viewportBatcher.clear()
        sendViewportUpdate(cols, rows, true)
        return true
      }
      // Why: xterm fit can emit resize bursts while the user drags panes or
      // restores layouts. Remote runtimes only need the last viewport in a frame.
      viewportBatcher.queue(cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    getPtyId() {
      return remotePtyId
    },

    getConnectionId() {
      return null
    },

    getRuntimeEnvironmentId() {
      return currentRuntimeEnvironmentId
    },

    async serializeBuffer(opts) {
      if (!connected || !handle || recovering) {
        return null
      }
      return getCurrentMultiplexedStream(handle)?.serializeBuffer(opts) ?? null
    },

    destroy() {
      destroyed = true
      this.disconnect()
      inputBatcher.clear()
      viewportBatcher.clear()
    }
  }
}

function sameViewport(
  left: { cols: number; rows: number } | null,
  right: { cols: number; rows: number } | null
): boolean {
  return left?.cols === right?.cols && left?.rows === right?.rows
}

function invokeSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // Pane callbacks cannot break transport fencing or lifecycle cleanup.
  }
}
