import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
const originalCliCommand = process.env.ORCA_CLI_COMMAND

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

// The reviewer noted `orchestration-worker-cli.test.ts` tests the worker-start family at this
// layer, but the bulk `worker-release --terminal-state reclaimable` branch had zero coverage
// here. This file closes that gap. The per-dispatch RPC behavior itself (release/retain/already-
// released/release_pending/release_unknown outcomes, Run-scope enumeration) is proven against the
// real handler in `rpc/methods/orchestration/worker/worker-release-bulk.test.ts`; this file proves
// only what the CLI handler itself decides: flag validation, RPC call shape, and exit code.
describe('orchestration worker-release CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
    delete process.env.ORCA_CLI_COMMAND
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    delete process.env.ORCA_TERMINAL_HANDLE
    if (originalCliCommand === undefined) {
      delete process.env.ORCA_CLI_COMMAND
    } else {
      process.env.ORCA_CLI_COMMAND = originalCliCommand
    }
  })

  const invokeWorkerRelease = (flags: Map<string, string | boolean>, json = true) =>
    ORCHESTRATION_HANDLERS['orchestration worker-release']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json
    } as never)

  it('rejects --dispatch and --terminal-state together', async () => {
    await expect(
      invokeWorkerRelease(
        new Map<string, string | boolean>([
          ['dispatch', 'ctx_1'],
          ['terminal-state', 'reclaimable']
        ])
      )
    ).rejects.toThrow('worker-release accepts either --dispatch or --terminal-state, not both')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid --terminal-state value, listing the allowed states', async () => {
    await expect(
      invokeWorkerRelease(new Map<string, string | boolean>([['terminal-state', 'released']]))
    ).rejects.toThrow("invalid --terminal-state 'released', expected one of: reclaimable")
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects --run without --terminal-state instead of silently discarding it', async () => {
    await expect(
      invokeWorkerRelease(
        new Map<string, string | boolean>([
          ['dispatch', 'ctx_1'],
          ['run', 'run_1']
        ])
      )
    ).rejects.toThrow('--run is only valid with --terminal-state.')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('resolves the implicit Run scope and forwards it to the bulk RPC call', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    callMock.mockImplementation(async (method: string) => {
      if (method === 'orchestration.runCurrent') {
        return { result: { run: { id: 'run_bound' } } }
      }
      if (method === 'orchestration.workerReleaseBulk') {
        return {
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
        }
      }
      throw new Error(`unexpected call ${method}`)
    })

    await invokeWorkerRelease(
      new Map<string, string | boolean>([['terminal-state', 'reclaimable']])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.runCurrent', { from: 'term_coord' })
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerReleaseBulk',
      { terminalState: 'reclaimable', run: 'run_bound' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('sets process.exitCode = 1 when the bulk receipt reports a failure', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'orchestration.runCurrent') {
        return { result: { run: null } }
      }
      return {
        result: {
          terminalState: 'reclaimable',
          requested: 2,
          released: 1,
          alreadyReleased: 0,
          retained: 0,
          failed: 1,
          releasePending: 0,
          outcomes: [
            {
              dispatchId: 'ctx_1',
              ok: true,
              state: 'released',
              processAction: 'closed_agent_terminal',
              archive: null
            },
            { dispatchId: 'ctx_2', ok: false, error: 'boom' }
          ]
        }
      }
    })

    await invokeWorkerRelease(
      new Map<string, string | boolean>([['terminal-state', 'reclaimable']])
    )

    expect(process.exitCode).toBe(1)
  })

  it('leaves process.exitCode unset when a bulk release has zero failures, even with release_pending outcomes', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'orchestration.runCurrent') {
        return { result: { run: null } }
      }
      return {
        result: {
          terminalState: 'reclaimable',
          requested: 1,
          released: 0,
          alreadyReleased: 0,
          retained: 0,
          failed: 0,
          releasePending: 1,
          outcomes: [
            {
              dispatchId: 'ctx_1',
              ok: true,
              state: 'release_pending',
              processAction: 'none',
              archive: null
            }
          ]
        }
      }
    })

    await invokeWorkerRelease(
      new Map<string, string | boolean>([['terminal-state', 'reclaimable']])
    )

    expect(process.exitCode).toBeUndefined()
  })
})
