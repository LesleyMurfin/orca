import type { SshConnection } from './ssh-connection'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { waitForSentinel } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

export type RelayMuxDeployEndpoints = {
  transport: MultiplexerTransport
  remoteRelayDir?: string
  nodePath?: string
  sockPath?: string
  credentialFile?: string
  hostPlatform?: RemoteHostPlatform | null
}

/**
 * Build the session multiplexer from deploy result.
 * Tries a second relay `--connect` when sock/dir/node/credential are known;
 * falls back to the primary transport alone on MaxSessions or any second-channel failure.
 */
export async function createRelaySessionMultiplexer(
  conn: SshConnection,
  endpoints: RelayMuxDeployEndpoints,
  signal?: AbortSignal
): Promise<SshChannelMultiplexer> {
  const { transport, remoteRelayDir, nodePath, sockPath, credentialFile, hostPlatform } = endpoints
  if (!remoteRelayDir || !nodePath || !sockPath || !credentialFile) {
    return new SshChannelMultiplexer(transport)
  }

  signal?.throwIfAborted()
  try {
    const connectCmd = buildRelaySecondConnectCommand({
      remoteRelayDir,
      nodePath,
      sockPath,
      credentialFile,
      hostPlatform: hostPlatform ?? undefined
    })
    const channel = await conn.exec(connectCmd, { signal })
    const background = await waitForSentinel(channel, signal)
    console.warn(
      '[ssh-relay-session] multi-channel mux: interactive + background transports established'
    )
    return new SshChannelMultiplexer([transport, background])
  } catch (err) {
    signal?.throwIfAborted()
    if (isSshSessionLimitError(err)) {
      console.warn(
        '[ssh-relay-session] multi-channel unavailable (MaxSessions); using single transport'
      )
    } else {
      console.warn(
        '[ssh-relay-session] multi-channel second connect failed; using single transport:',
        err instanceof Error ? err.message : String(err)
      )
    }
    return new SshChannelMultiplexer(transport)
  }
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
