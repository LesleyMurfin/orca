import {
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE,
  type RemoteRuntimeMultiplexedTerminal,
  type RemoteRuntimeMultiplexedTerminalCallbacks
} from '../../runtime/remote-runtime-terminal-multiplexer'
import { parseExactRemoteRuntimeTerminalGoneCode } from './remote-runtime-terminal-gone-error'

type StructuredRuntimeError = { code: string; message: string }
type SnapshotEvent = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onSnapshot']>
type DataEvent = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onData']>

type RemoteRuntimePtyStagedRebindArgs = {
  handle: string
  bindingGeneration: number
  signal: AbortSignal
  client: { id: string; type: 'desktop' }
  viewport: { cols: number; rows: number } | null
  subscribe: (args: {
    terminal: string
    client: { id: string; type: 'desktop' }
    viewport?: { cols: number; rows: number }
    callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  }) => Promise<RemoteRuntimeMultiplexedTerminal>
  canCommit: (args: {
    bindingGeneration: number
    handle: string
    stream: RemoteRuntimeMultiplexedTerminal
  }) => boolean
  activate: (args: {
    bindingGeneration: number
    handle: string
    stream: RemoteRuntimeMultiplexedTerminal
    subscribedViewport: { cols: number; rows: number } | null
  }) => void
  isActive: (args: {
    bindingGeneration: number
    handle: string
    stream: RemoteRuntimeMultiplexedTerminal
  }) => boolean
  onReplayReady: () => void
  onCommitted: (subscribedViewport: { cols: number; rows: number } | null) => void
  onData: (...event: DataEvent) => void
  onSnapshot: (...event: SnapshotEvent) => void | Promise<void>
  onEnd: () => void
  onError: (message: string) => void
  onFitOverrideChanged: NonNullable<
    RemoteRuntimeMultiplexedTerminalCallbacks['onFitOverrideChanged']
  >
  onDriverChanged: NonNullable<RemoteRuntimeMultiplexedTerminalCallbacks['onDriverChanged']>
  onTransportClose: (error: StructuredRuntimeError) => void
}

export function stageRemoteRuntimePtyRebind(args: RemoteRuntimePtyStagedRebindArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    let stream: RemoteRuntimeMultiplexedTerminal | null = null
    let subscribed = false
    let committed = false
    let replayPending = false
    let replayReady = false
    let committing = false
    let settled = false
    let closed = false
    let snapshot: SnapshotEvent | null = null
    const data: DataEvent[] = []

    const closeStream = (target = stream): void => {
      if (!target || closed) {
        return
      }
      closed = true
      invokeSafely(target.close)
    }

    const removeAbortListener = (): void => {
      args.signal.removeEventListener('abort', onAbort)
    }

    const fail = (error: unknown): void => {
      if (settled || committed) {
        return
      }
      settled = true
      removeAbortListener()
      closeStream()
      reject(error)
    }

    const current = (target: RemoteRuntimeMultiplexedTerminal): boolean =>
      args.isActive({
        bindingGeneration: args.bindingGeneration,
        handle: args.handle,
        stream: target
      })

    const finishCommit = async (target: RemoteRuntimeMultiplexedTerminal): Promise<void> => {
      while (!settled && current(target)) {
        if (snapshot) {
          const event = snapshot
          snapshot = null
          await invokeSafelyAsync(() => args.onSnapshot(...event))
          continue
        }
        if (!replayReady) {
          replayReady = true
          invokeSafely(args.onReplayReady)
        }
        const event = data.shift()
        if (event) {
          invokeSafely(() => args.onData(...event))
          continue
        }
        break
      }
      if (settled) {
        return
      }
      replayPending = false
      settled = true
      removeAbortListener()
      snapshot = null
      data.length = 0
      // The authoritative replay stays input-fenced; only a still-current
      // binding may open input and notify the pane after replay completes.
      if (current(target)) {
        invokeSafely(() => args.onCommitted(args.viewport))
      }
      resolve()
    }

    const commitIfReady = (): void => {
      if (settled || committed || committing || !subscribed || !stream) {
        return
      }
      if (
        args.signal.aborted ||
        !args.canCommit({
          bindingGeneration: args.bindingGeneration,
          handle: args.handle,
          stream
        })
      ) {
        fail(abortRebindError())
        return
      }
      committing = true
      try {
        args.activate({
          bindingGeneration: args.bindingGeneration,
          handle: args.handle,
          stream,
          subscribedViewport: args.viewport
        })
      } catch (error) {
        fail(error)
        return
      }
      if (settled || args.signal.aborted) {
        return
      }
      committed = true
      replayPending = true
      void finishCommit(stream)
    }

    const onAbort = (): void => {
      if (!committed) {
        fail(abortRebindError())
        return
      }
      if (settled) {
        return
      }
      settled = true
      replayPending = false
      removeAbortListener()
      closeStream()
      reject(abortRebindError())
    }
    args.signal.addEventListener('abort', onAbort, { once: true })
    if (args.signal.aborted) {
      onAbort()
      return
    }

    const callbacks: RemoteRuntimeMultiplexedTerminalCallbacks = {
      onData: (...event) => {
        if (!stream || !committed || replayPending) {
          if (!settled) {
            data.push(event)
          }
          return
        }
        if (current(stream)) {
          invokeSafely(() => args.onData(...event))
        }
      },
      onSnapshot: (...event) => {
        if (!stream || !committed || replayPending) {
          if (!settled) {
            // A newer authoritative snapshot already contains all preceding
            // live output, so replay only data that arrives after its boundary.
            data.length = 0
            snapshot = event
          }
          return
        }
        if (current(stream)) {
          void invokeSafelyAsync(() => args.onSnapshot(...event))
        }
      },
      onSubscribed: () => {
        if (!committed && !settled) {
          subscribed = true
          commitIfReady()
        }
      },
      onEnd: () => {
        if (!stream || !committed) {
          fail({ code: 'terminal_gone', message: 'Remote terminal stream ended.' })
        } else if (current(stream)) {
          invokeSafely(args.onEnd)
        }
      },
      onError: (message) => {
        if (message === REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE) {
          return
        }
        if (!stream || !committed) {
          const goneCode = parseExactRemoteRuntimeTerminalGoneCode(message)
          fail({ code: goneCode ?? 'runtime_error', message })
        } else if (current(stream)) {
          invokeSafely(() => args.onError(message))
        }
      },
      onFitOverrideChanged: (event) => {
        if (stream && committed && current(stream)) {
          invokeSafely(() => args.onFitOverrideChanged(event))
        }
      },
      onDriverChanged: (driver) => {
        if (stream && committed && current(stream)) {
          invokeSafely(() => args.onDriverChanged(driver))
        }
      },
      onTransportClose: (error) => {
        if (!stream || !committed) {
          fail(error)
        } else if (current(stream)) {
          invokeSafely(() => args.onTransportClose(error))
        }
      }
    }

    let subscription: Promise<RemoteRuntimeMultiplexedTerminal>
    try {
      subscription = args.subscribe({
        terminal: args.handle,
        client: args.client,
        viewport: args.viewport ?? undefined,
        callbacks
      })
    } catch (error) {
      fail(error)
      return
    }
    void subscription.then(
      (nextStream) => {
        if (settled && !committed) {
          closeStream(nextStream)
          return
        }
        stream = nextStream
        commitIfReady()
      },
      (error) => fail(error)
    )
  })
}

function abortRebindError(): Error {
  const error = new Error('Remote terminal recovery was superseded.')
  error.name = 'AbortError'
  return error
}

function invokeSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // Consumer callbacks cannot roll back an already-settled binding transition.
  }
}

async function invokeSafelyAsync(callback: () => void | Promise<void>): Promise<void> {
  try {
    await callback()
  } catch {
    // Consumer callbacks cannot roll back an already-activated binding transition.
  }
}
