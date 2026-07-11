import type { Mock } from 'vitest'
import { vi } from 'vitest'
import type { IpcPtyTransportOptions, PtyTransport } from './pty-transport-types'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks
} from '../../runtime/remote-runtime-terminal-multiplexer'
import type {
  RemoteRuntimeTerminalRecoveryLease,
  RemoteRuntimeTerminalRecoveryParticipant
} from '../../runtime/remote-runtime-terminal-recovery-coordinator'

export type RecoveryStreamRecord = {
  args: {
    terminal: string
    client: { id: string; type: 'desktop' | 'mobile' }
    viewport?: { cols: number; rows: number }
    callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  }
  stream: RemoteRuntimeMultiplexedTerminal & {
    sendInput: Mock<(text: string) => boolean>
    resize: Mock<(cols: number, rows: number) => boolean>
    close: Mock<() => void>
  }
}

export type RecoveryRegistration = {
  environmentId: string
  participant: RemoteRuntimeTerminalRecoveryParticipant
  lease: RemoteRuntimeTerminalRecoveryLease & { cancel: Mock<() => void> }
}

export type RemoteRuntimePtyRecoveryFixture = {
  runtimeCall: Mock
  subscribeTerminal: Mock
  streams: RecoveryStreamRecord[]
  registrations: RecoveryRegistration[]
  createAttachedTransport: (args?: {
    handle?: string
    environmentId?: string
    options?: IpcPtyTransportOptions
    callbacks?: Parameters<PtyTransport['attach']>[0]['callbacks']
  }) => Promise<PtyTransport>
  settle: () => Promise<void>
}

export function installRemoteRuntimePtyRecoveryFixture(): RemoteRuntimePtyRecoveryFixture {
  const runtimeCall = vi.fn(async () => ({ ok: true, result: {} }))
  const streams: RecoveryStreamRecord[] = []
  const registrations: RecoveryRegistration[] = []
  let nextStreamId = 1

  const subscribeTerminal = vi.fn(
    async (args: RecoveryStreamRecord['args']): Promise<RemoteRuntimeMultiplexedTerminal> => {
      const stream: RecoveryStreamRecord['stream'] = {
        streamId: nextStreamId++,
        sendInput: vi.fn(() => true),
        resize: vi.fn(() => true),
        serializeBuffer: vi.fn(async () => null),
        close: vi.fn()
      }
      streams.push({ args, stream })
      return stream
    }
  )

  const beginRecovery = vi.fn(
    (args: {
      environmentId: string
      participant: RemoteRuntimeTerminalRecoveryParticipant
    }): RemoteRuntimeTerminalRecoveryLease => {
      const lease = { generation: registrations.length + 1, cancel: vi.fn() }
      registrations.push({ ...args, lease })
      return lease
    }
  )

  vi.doMock('../../runtime/remote-runtime-terminal-multiplexer', () => ({
    REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE:
      'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.',
    getRemoteRuntimeTerminalMultiplexer: vi.fn(() => ({ subscribeTerminal }))
  }))
  vi.doMock('../../runtime/remote-runtime-terminal-recovery-coordinator', () => ({
    beginRemoteRuntimeTerminalRecovery: beginRecovery
  }))
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: runtimeCall,
        subscribe: vi.fn()
      }
    }
  })

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 6; turn += 1) {
      await Promise.resolve()
    }
  }

  return {
    runtimeCall,
    subscribeTerminal,
    streams,
    registrations,
    settle,
    async createAttachedTransport(args = {}) {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const environmentId = args.environmentId ?? 'env-1'
      const handle = args.handle ?? 'terminal-1'
      const transport = createRemoteRuntimePtyTransport(environmentId, {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        ...args.options
      })
      transport.attach({
        existingPtyId: `remote:${environmentId}@@${handle}`,
        cols: 80,
        rows: 24,
        callbacks: args.callbacks ?? {}
      })
      await settle()
      return transport
    }
  }
}
