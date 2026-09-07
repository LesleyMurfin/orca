import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

type BulkOutcome =
  | { dispatchId: string; ok: true; state: string }
  | { dispatchId: string; ok: false; error: string }

type BulkReceipt = {
  terminalState: string
  requested: number
  released: number
  alreadyReleased: number
  retained: number
  failed: number
  outcomes: BulkOutcome[]
}

const WORKER_HANDLE_PREFIX = 'term_worker_'

describe('orchestration worker release bulk', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  // The harness's default mocks model exactly one live agent-owned worker terminal at a time
  // (`createTerminal` always returns the same fixed handle, so a second `startWorker` call
  // transfers ownership of that same identity instead of creating an independent resource). A
  // bulk-release fixture needs several independently *owned* worker terminals alive together, so
  // this widens the same identity mocks to mint and recognize a fresh handle per agent launch.
  function armIndependentWorkerTerminals(): void {
    let counter = 0
    vi.spyOn(h.runtime, 'createTerminal').mockImplementation(async () => {
      counter += 1
      const handle = `${WORKER_HANDLE_PREFIX}${counter}`
      return { handle, worktreeId: 'repo::worktree', title: 'worker' }
    })
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? h.coordinatorPaneKey
        : handle.startsWith(WORKER_HANDLE_PREFIX)
          ? `pane:${handle}`
          : null
    )
    vi.spyOn(h.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle.startsWith(WORKER_HANDLE_PREFIX) ? `runtime_test:${handle}:1` : null
    )
    vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle.startsWith(WORKER_HANDLE_PREFIX)
        ? ({
            terminalHandle: handle,
            paneKey: `pane:${handle}`,
            processIncarnation: `runtime_test:${handle}:1`,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
  }

  it('releases every currently reclaimable dispatch and never touches an active one', async () => {
    h.setup()
    armIndependentWorkerTerminals()
    const a = await h.startSettledWorker('succeeded')
    const b = await h.startSettledWorker('succeeded')
    const c = await h.startSettledWorker('failed')
    const live = await h.startWorker()

    const receipt = (await h.call('orchestration.workerReleaseBulk', {
      terminalState: 'reclaimable'
    })) as BulkReceipt

    expect(receipt.terminalState).toBe('reclaimable')
    expect(receipt.requested).toBe(3)
    expect(receipt.released).toBe(3)
    expect(receipt.failed).toBe(0)
    expect(receipt.outcomes.map((outcome) => outcome.dispatchId).sort()).toEqual(
      [a.dispatchId, b.dispatchId, c.dispatchId].sort()
    )

    for (const dispatchId of [a.dispatchId, b.dispatchId, c.dispatchId]) {
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    }
    // Exactly the three reclaimable terminals closed; the still-active worker's terminal is
    // never among them — the per-dispatch safety contract survives the bulk wrapper untouched.
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(3)
    const liveResource = h.db.getWorkerTerminalResourceByOwner(live.dispatchId)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalledWith(liveResource?.terminal_handle)
    expect(liveResource?.release_state).toBe('not_requested')

    const list = (await h.call('orchestration.workerList', { run: h.activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null }[]
    }
    expect(
      list.workers.find((worker) => worker.dispatchId === live.dispatchId)?.terminalState
    ).toBe('active')
  })

  it('reports empty results without error when nothing is reclaimable', async () => {
    h.setup()
    armIndependentWorkerTerminals()
    await h.startWorker()

    const receipt = (await h.call('orchestration.workerReleaseBulk', {
      terminalState: 'reclaimable'
    })) as BulkReceipt

    expect(receipt).toMatchObject({ requested: 0, released: 0, failed: 0, outcomes: [] })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does not abort the batch when one dispatch release throws', async () => {
    h.setup()
    armIndependentWorkerTerminals()
    const a = await h.startSettledWorker('succeeded')
    const b = await h.startSettledWorker('succeeded')
    const c = await h.startSettledWorker('succeeded')

    // Simulates the real-world transient failure (e.g. a request timeout) that hit 26/271
    // dispatches in production: one Dispatch's release call rejects outright.
    const originalRequest = h.db.requestWorkerTerminalRelease.bind(h.db)
    vi.spyOn(h.db, 'requestWorkerTerminalRelease').mockImplementation((dispatchId: string) => {
      if (dispatchId === b.dispatchId) {
        throw new Error('simulated transient release failure')
      }
      return originalRequest(dispatchId)
    })

    const receipt = (await h.call('orchestration.workerReleaseBulk', {
      terminalState: 'reclaimable'
    })) as BulkReceipt

    expect(receipt.requested).toBe(3)
    expect(receipt.released).toBe(2)
    expect(receipt.failed).toBe(1)
    const failedOutcome = receipt.outcomes.find((outcome) => outcome.dispatchId === b.dispatchId)
    expect(failedOutcome).toMatchObject({ ok: false, error: 'simulated transient release failure' })

    // The two unaffected Dispatches still completed despite the one failure alongside them.
    expect(h.db.getWorkerTerminalResourceByOwner(a.dispatchId)?.release_state).toBe('released')
    expect(h.db.getWorkerTerminalResourceByOwner(c.dispatchId)?.release_state).toBe('released')
    // The failed Dispatch's own release attempt never committed, so it stays exactly as it was
    // before the batch ran — retryable, not half-released.
    expect(h.db.getWorkerTerminalResourceByOwner(b.dispatchId)?.release_state).toBe('not_requested')
  })

  it('reports a release_unknown terminal-close failure as a batch failure without throwing', async () => {
    h.setup()
    armIndependentWorkerTerminals()
    const a = await h.startSettledWorker('succeeded')
    const b = await h.startSettledWorker('succeeded')
    const bResource = h.db.getWorkerTerminalResourceByOwner(b.dispatchId)

    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      if (handle === bResource?.terminal_handle) {
        throw new Error('simulated terminal close timeout')
      }
      return { handle, tabId: 'tab-worker', ptyKilled: true } as never
    })

    const receipt = (await h.call('orchestration.workerReleaseBulk', {
      terminalState: 'reclaimable'
    })) as BulkReceipt

    expect(receipt.released).toBe(1)
    expect(receipt.failed).toBe(1)
    const aOutcome = receipt.outcomes.find((outcome) => outcome.dispatchId === a.dispatchId)
    const bOutcome = receipt.outcomes.find((outcome) => outcome.dispatchId === b.dispatchId)
    expect(aOutcome).toMatchObject({ ok: true, state: 'released' })
    expect(bOutcome).toMatchObject({ ok: true, state: 'release_unknown' })
  })

  it('scopes enumeration to --run the same way worker-list does', async () => {
    h.setup()
    armIndependentWorkerTerminals()
    const inScope = await h.startSettledWorker('succeeded')
    const otherRun = h.db.createRun({
      objective: 'Other Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey
    }).id
    const otherTask = h.db.createTask({ spec: 'other run task', runId: otherRun })
    const outOfScopeStart = (await h.call('orchestration.workerStart', {
      task: otherTask.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { dispatchId: string }
    h.settle(otherTask.id, outOfScopeStart.dispatchId, 'succeeded')

    const receipt = (await h.call('orchestration.workerReleaseBulk', {
      terminalState: 'reclaimable',
      run: h.activeRunId
    })) as BulkReceipt

    expect(receipt.requested).toBe(1)
    expect(receipt.outcomes[0]?.dispatchId).toBe(inScope.dispatchId)
    expect(h.db.getWorkerTerminalResourceByOwner(outOfScopeStart.dispatchId)?.release_state).toBe(
      'not_requested'
    )
  })
})
