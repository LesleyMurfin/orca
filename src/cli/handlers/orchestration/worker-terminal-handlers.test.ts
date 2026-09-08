import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_WORKER_TERMINAL_HANDLERS } from './worker-terminal-handlers'

const callMock = vi.fn()

afterEach(() => {
  callMock.mockReset()
})

describe('orchestration worker-release --terminal-state reclaimable', () => {
  it('gives the bulk release RPC call an explicit timeout well beyond the client default', async () => {
    callMock.mockResolvedValue({
      result: {
        terminalState: 'reclaimable',
        requested: 0,
        released: 0,
        alreadyReleased: 0,
        retained: 0,
        failed: 0,
        releasePending: 0,
        outcomes: []
      }
    })

    await ORCHESTRATION_WORKER_TERMINAL_HANDLERS['orchestration worker-release']({
      flags: new Map<string, string | boolean>([
        ['terminal-state', 'reclaimable'],
        ['run', 'run_1']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledTimes(1)
    const [method, params, options] = callMock.mock.calls[0] as [string, unknown, unknown]
    expect(method).toBe('orchestration.workerReleaseBulk')
    expect(params).toEqual({ terminalState: 'reclaimable', run: 'run_1' })
    // RuntimeClient's own default (client.ts) is 60_000ms; a bulk release iterating hundreds of
    // dispatches (the motivating case hit 271) cannot reliably finish inside that window. The
    // handler must request an explicit timeout well past it rather than silently inheriting it.
    const timeoutOptions = options as { timeoutMs: number }
    expect(timeoutOptions.timeoutMs).toBeGreaterThan(60_000)
  })
})
