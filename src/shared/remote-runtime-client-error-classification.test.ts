import { describe, expect, it } from 'vitest'
import { TERMINAL_QUERY_REPLAY_OVERFLOW_ERROR } from './terminal-stream-protocol'
import { isRecoverableRemoteRuntimeConnectionError } from './remote-runtime-client-error-classification'

describe('isRecoverableRemoteRuntimeConnectionError', () => {
  it('classifies transient connection and bounded replay errors as recoverable', () => {
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'remote_runtime_unavailable',
        message: 'offline'
      })
    ).toBe(true)
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'runtime_timeout',
        message: 'timeout'
      })
    ).toBe(true)
    expect(isRecoverableRemoteRuntimeConnectionError(TERMINAL_QUERY_REPLAY_OVERFLOW_ERROR)).toBe(
      true
    )

    for (const code of [
      'unauthorized',
      'invalid_argument',
      'invalid_runtime_response',
      'runtime_error'
    ]) {
      expect(isRecoverableRemoteRuntimeConnectionError({ code, message: code })).toBe(false)
    }
  })
})
