const REMOTE_RUNTIME_TERMINAL_GONE_CODES = [
  'terminal_handle_stale',
  'terminal_exited',
  'terminal_gone',
  'no_connected_pty'
] as const

type RemoteRuntimeTerminalGoneCode = (typeof REMOTE_RUNTIME_TERMINAL_GONE_CODES)[number]

export function findEmbeddedRemoteRuntimeTerminalGoneCode(
  message: string
): RemoteRuntimeTerminalGoneCode | null {
  return REMOTE_RUNTIME_TERMINAL_GONE_CODES.find((code) => message.includes(code)) ?? null
}

export function parseExactRemoteRuntimeTerminalGoneCode(
  message: string
): RemoteRuntimeTerminalGoneCode | null {
  const normalized = message.trim()
  return REMOTE_RUNTIME_TERMINAL_GONE_CODES.find((code) => code === normalized) ?? null
}
