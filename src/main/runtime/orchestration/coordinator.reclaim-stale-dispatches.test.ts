import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { Coordinator, type CoordinatorRuntime } from './coordinator'

type DriftResult = {
  base: string
  behind: number
  recentSubjects: string[]
} | null

function createMockRuntime(): CoordinatorRuntime & {
  sentMessages: { handle: string; text: string }[]
  terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
  createdTerminals: string[]
  createdTerminalOptions: { title?: string }[]
  probeDriftCalls: string[]
  probeDriftResult: DriftResult
  cliCommand: 'orca' | 'orca-ide'
  setProbeDrift(result: DriftResult): void
  throwProbeDrift: Error | null
} {
  const mock = {
    sentMessages: [] as { handle: string; text: string }[],
    terminals: [] as {
      handle: string
      worktreeId: string
      connected: boolean
      writable: boolean
    }[],
    createdTerminals: [] as string[],
    createdTerminalOptions: [] as { title?: string }[],
    probeDriftCalls: [] as string[],
    probeDriftResult: null as DriftResult,
    cliCommand: 'orca' as 'orca' | 'orca-ide',
    throwProbeDrift: null as Error | null,
    setProbeDrift(result: DriftResult): void {
      mock.probeDriftResult = result
    },
    async sendTerminalAgentPrompt(handle: string, prompt: string) {
      mock.sentMessages.push({ handle, text: prompt })
      return { handle, accepted: true, bytesWritten: 0 }
    },
    async listTerminals() {
      return { terminals: mock.terminals }
    },
    async createTerminal(_worktree?: string, opts?: { title?: string }) {
      const handle = `term_worker_${mock.createdTerminals.length}`
      mock.createdTerminals.push(handle)
      mock.createdTerminalOptions.push(opts ?? {})
      mock.terminals.push({ handle, worktreeId: 'wt1', connected: true, writable: true })
      return { handle, worktreeId: 'wt1', title: opts?.title ?? '' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift(worktreeSelector: string): Promise<DriftResult> {
      mock.probeDriftCalls.push(worktreeSelector)
      if (mock.throwProbeDrift) {
        throw mock.throwProbeDrift
      }
      return mock.probeDriftResult
    },
    getTerminalOrchestrationCliCommand() {
      return mock.cliCommand
    }
  }
  return mock
}

describe('Coordinator reclaimStaleDispatches', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('reclaimStaleDispatches: true frees the slot of a silent worker', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const task = db.createTask({ spec: 'work' })
    const ctx = db.createDispatchContext(task.id, 'term_stale')

    const sqlite = (
      db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
    ).db
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString()
    sqlite
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?')
      .run(iso(60 * 60 * 1000), iso(30 * 60 * 1000), ctx.id)

    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      reclaimStaleDispatches: true,
      onLog: (m) => logs.push(m)
    })

    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise

    expect(logs.some((l) => /Reclaimed slot/.test(l) && l.includes(task.id))).toBe(true)
    expect(db.getTask(task.id)?.status).toBe('failed')
    // The slot is freed: no longer counted against maxConcurrent.
    expect(db.getStaleDispatches(new Date().toISOString()).some((c) => c.id === ctx.id)).toBe(false)
  })

  it('reclaimStaleDispatches does NOT touch a heartbeating worker (the R6 false positive)', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const task = db.createTask({ spec: 'work' })
    const ctx = db.createDispatchContext(task.id, 'term_slow')

    // A SLOW worker: dispatched an hour ago, still heartbeating 1 min ago. This is
    // exactly the case R6 protects. It must survive reclaim untouched.
    const sqlite = (
      db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
    ).db
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString()
    sqlite
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?')
      .run(iso(60 * 60 * 1000), iso(60 * 1000), ctx.id)

    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      reclaimStaleDispatches: true,
      onLog: (m) => logs.push(m)
    })

    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise

    expect(logs.some((l) => /Reclaimed slot/.test(l))).toBe(false)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })

  it('reclaimStaleDispatches does NOT touch a just-dispatched worker (grace window)', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const task = db.createTask({ spec: 'work' })
    db.createDispatchContext(task.id, 'term_new')
    // dispatched_at = now, last_heartbeat_at = NULL: never heartbeated, but young.

    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      reclaimStaleDispatches: true,
      onLog: (m) => logs.push(m)
    })

    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise

    expect(logs.some((l) => /Reclaimed slot/.test(l))).toBe(false)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })
})
