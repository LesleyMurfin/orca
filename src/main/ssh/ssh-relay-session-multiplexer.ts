import type { SshConnection } from './ssh-connection'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { waitForSentinel } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { MUX_TARGET_TRANSPORT_COUNT } from './ssh-multiplexer-transports'

export type RelayMuxDeployEndpoints = {
  transport: MultiplexerTransport
  remoteRelayDir?: string
  nodePath?: string
  sockPath?: string
  credentialFile?: string
  hostPlatform?: RemoteHostPlatform | null
  /** Cap parallel connects (default = one per priority lane). */
  targetTransportCount?: number
}

/**
 * Build the session multiplexer from deploy result.
 * Opens additional relay `--connect` channels up to the priority-lane target
 * so work is spread by priority instead of dumped on one pipe.
 * Stops early on MaxSessions or connect failure and keeps whatever opened.
 */
export async function createRelaySessionMultiplexer(
  conn: SshConnection,
  endpoints: RelayMuxDeployEndpoints,
  signal?: AbortSignal
): Promise<SshChannelMultiplexer> {
  const { transport, remoteRelayDir, nodePath, sockPath, credentialFile, hostPlatform } = endpoints
  const targetCount = Math.max(
    1,
    Math.min(
      endpoints.targetTransportCount ?? MUX_TARGET_TRANSPORT_COUNT,
      MUX_TARGET_TRANSPORT_COUNT
    )
  )

  if (!remoteRelayDir || !nodePath || !sockPath || !credentialFile || targetCount <= 1) {
    return new SshChannelMultiplexer(transport)
  }

  const transports: MultiplexerTransport[] = [transport]
  const connectCmd = buildRelaySecondConnectCommand({
    remoteRelayDir,
    nodePath,
    sockPath,
    credentialFile,
    hostPlatform: hostPlatform ?? undefined
  })

  while (transports.length < targetCount) {
    signal?.throwIfAborted()
    try {
      const channel = await conn.exec(connectCmd, { signal })
      const next = await waitForSentinel(channel, signal)
      transports.push(next)
    } catch (err) {
      signal?.throwIfAborted()
      if (isSshSessionLimitError(err)) {
        console.warn(
          `[ssh-relay-session] multi-channel stop at ${transports.length} transport(s) (MaxSessions); priority lanes share remaining pipes`
        )
      } else {
        console.warn(
          `[ssh-relay-session] multi-channel stop at ${transports.length} transport(s):`,
          err instanceof Error ? err.message : String(err)
        )
      }
      break
    }
  }

  if (transports.length > 1) {
    console.warn(
      `[ssh-relay-session] priority mux: ${transports.length} transport(s) (target ${targetCount})`
    )
  }
  return new SshChannelMultiplexer(transports)
}

export function buildRelaySecondConnectCommand(opts: {
  remoteRelayDir: string
  nodePath: string
  sockPath: string
  credentialFile: string
  hostPlatform?: RemoteHostPlatform
}): string {
  const { remoteRelayDir, nodePath, sockPath, credentialFile, hostPlatform } = opts
  if (hostPlatform && isWindowsRemoteHost(hostPlatform)) {
    return powerShellCommand(
      `Set-Location -LiteralPath ${powerShellLiteral(remoteRelayDir)}; & ${powerShellLiteral(nodePath)} relay.js --connect --sock-path ${powerShellLiteral(sockPath)} --credential-file ${powerShellLiteral(credentialFile)}`
    )
  }
  return `cd ${shellEscape(remoteRelayDir)} && ${shellEscape(nodePath)} relay.js --connect --sock-path ${shellEscape(sockPath)} --credential-file ${shellEscape(credentialFile)}`
}
