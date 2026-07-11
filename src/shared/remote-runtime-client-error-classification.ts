import { TERMINAL_QUERY_REPLAY_OVERFLOW_ERROR } from './terminal-stream-protocol'

export type RemoteRuntimeClientErrorLike = { code: string; message: string }

export function isRecoverableRemoteRuntimeConnectionError(
  error: RemoteRuntimeClientErrorLike
): boolean {
  return (
    error.code === 'remote_runtime_unavailable' ||
    error.code === 'runtime_timeout' ||
    error.code === TERMINAL_QUERY_REPLAY_OVERFLOW_ERROR.code
  )
}
