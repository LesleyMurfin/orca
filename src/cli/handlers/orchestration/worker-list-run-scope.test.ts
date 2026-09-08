import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'

type Call = { name: string; params: Record<string, unknown> }

/** The runtime half of this seam (`runCurrent` from a coordinator handle, `workerList` filtered by
 *  `run`) is proven in `rpc/methods/orchestration/worker/worker-list-run-scope-rpc.test.ts`; this
 *  half proves the handler asks exactly those two questions and reports what it decided. */
describe('orchestration worker-list Run scope (CLI handler)', () => {
  const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
  let calls: Call[]
  let logged: string[]
  let boundRun: string | null

  const client = {
    call: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      if (name === 'orchestration.runCurrent') {
        return { result: { run: boundRun ? { id: boundRun } : null } }
      }
      if (name === 'orchestration.workerList') {
        return {
          result: { workers: [], counts: {}, page: { hasMore: false, nextCursor: null, total: 0 } }
        }
      }
      throw new Error(`unexpected call ${name}`)
    }
  }

  beforeEach(() => {
    calls = []
    logged = []
    boundRun = null
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  async function list(flags = new Map<string, string | boolean>(), json = true) {
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags,
      client,
      cwd: '/tmp/repo',
      json
    } as never)
    const listCall = calls.find((call) => call.name === 'orchestration.workerList')
    return { listCall, receipt: json ? JSON.parse(logged.at(-1)!).result : null }
  }

  it('defaults an unscoped list to the Run bound to the calling terminal', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    const { listCall, receipt } = await list()

    expect(calls[0]).toEqual({ name: 'orchestration.runCurrent', params: { from: 'term_coord' } })
    expect(listCall?.params.run).toBe('run_bound')
    expect(receipt.scope).toEqual({ run: 'run_bound', source: 'bound' })
  })

  it('keeps --run as the override and never asks for the binding', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    const { listCall, receipt } = await list(new Map([['run', 'run_other']]))

    expect(calls.map((call) => call.name)).not.toContain('orchestration.runCurrent')
    expect(listCall?.params.run).toBe('run_other')
    expect(receipt.scope).toEqual({ run: 'run_other', source: 'flag' })
  })

  it('still lists every Run when the caller has no bound Run', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_unbound_shell'
    boundRun = null

    const { listCall, receipt } = await list()

    expect(listCall?.params.run).toBeUndefined()
    expect(receipt.scope).toEqual({ source: 'all' })
  })

  it('names the scope in the human-readable receipt', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    await list(new Map(), false)

    expect(logged.at(-1)).toContain('Scope: Run run_bound (bound to this terminal)')
  })
})

/** Mirrors the worker-list Run scope contract above: bulk `worker-release --terminal-state
 *  reclaimable` can act across every Run in the database from a non-coordinator terminal, so it
 *  owes the caller the same blast-radius disclosure worker-list already gives for reads. */
describe('orchestration worker-release bulk Run scope (CLI handler)', () => {
  const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
  let calls: Call[]
  let logged: string[]
  let boundRun: string | null

  const client = {
    call: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      if (name === 'orchestration.runCurrent') {
        return { result: { run: boundRun ? { id: boundRun } : null } }
      }
      if (name === 'orchestration.workerReleaseBulk') {
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
      throw new Error(`unexpected call ${name}`)
    }
  }

  beforeEach(() => {
    calls = []
    logged = []
    boundRun = null
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  async function release(
    flags = new Map<string, string | boolean>([['terminal-state', 'reclaimable']]),
    json = true
  ) {
    await ORCHESTRATION_HANDLERS['orchestration worker-release']({
      flags,
      client,
      cwd: '/tmp/repo',
      json
    } as never)
    const releaseCall = calls.find((call) => call.name === 'orchestration.workerReleaseBulk')
    return { releaseCall, receipt: json ? JSON.parse(logged.at(-1)!).result : null }
  }

  it('reports the Run bound to the calling terminal in the JSON receipt', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    const { releaseCall, receipt } = await release()

    expect(releaseCall?.params.run).toBe('run_bound')
    expect(receipt.scope).toEqual({ run: 'run_bound', source: 'bound' })
  })

  it('reports an explicit --run override as the scope source', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    const { releaseCall, receipt } = await release(
      new Map([
        ['terminal-state', 'reclaimable'],
        ['run', 'run_other']
      ])
    )

    expect(calls.map((call) => call.name)).not.toContain('orchestration.runCurrent')
    expect(releaseCall?.params.run).toBe('run_other')
    expect(receipt.scope).toEqual({ run: 'run_other', source: 'flag' })
  })

  it('reports an unscoped bulk release as targeting every Run when no Run is bound', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_unbound_shell'
    boundRun = null

    const { releaseCall, receipt } = await release()

    expect(releaseCall?.params.run).toBeUndefined()
    expect(receipt.scope).toEqual({ source: 'all' })
  })

  it('names the scope in the human-readable summary', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    await release(new Map([['terminal-state', 'reclaimable']]), false)

    expect(logged.at(-1)).toContain('Scope: Run run_bound (bound to this terminal)')
  })
})
