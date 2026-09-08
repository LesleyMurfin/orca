import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

// Why: StatsCollector still reads its snapshot path from electron's `app` at
// construction (src/main/stats/collector.ts), so it needs this mock even though
// the runtime itself reads version through the AppEnvironment port. liveAgents
// (the agents count source) is never persisted, so a temp path reads nothing back.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { StatsCollector } from '../stats/collector'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'

const ZERO_TASK_STATUS_COUNTS = {
  pending: 0,
  ready: 0,
  dispatched: 0,
  completed: 0,
  failed: 0,
  blocked: 0
}
const ZERO_AGENT_STATE_COUNTS = { working: 0, permission: 0, idle: 0, unknown: 0 }
const ZERO_WORKER_TERMINAL_STATE_COUNTS = {
  active: 0,
  reclaimable: 0,
  retained: 0,
  release_pending: 0,
  release_unknown: 0,
  released: 0
}

describe('getServeStats', () => {
  let db: OrchestrationDb | null = null

  // Why: the global setup installs a fake with version 0.0.0-test; pin a
  // distinctive one so the assertion proves getServeStats reads the port
  // rather than matching a default by coincidence.
  beforeEach(() => {
    installFakeAppEnvironment({ getVersion: () => '9.9.9-test' })
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.clearAllMocks()
  })

  it('aggregates live runtime counts, version, port and uptime', async () => {
    const stats = new StatsCollector()
    stats.onAgentStart('pty-1', Date.now())
    stats.onAgentStart('pty-2', Date.now())

    const runtime = new OrcaRuntimeService(null, stats)
    db = new OrchestrationDb(':memory:')
    db.createTask({ spec: 'first task' })
    db.createTask({ spec: 'second task' })
    runtime.setOrchestrationDb(db)
    runtime.setServePort(6970)

    // Why: worktree counts come from listManagedWorktrees, which needs a store.
    // The store is orthogonal to this aggregation, so stub the count directly.
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [],
      totalCount: 3,
      truncated: false
    })

    const result = await runtime.getServeStats()

    expect(result).toEqual({
      version: '9.9.9-test',
      runtimeId: runtime.getRuntimeId(),
      uptimeSeconds: expect.any(Number),
      port: 6970,
      counts: {
        agents: 0,
        tasks: 2,
        terminals: 0,
        terminalsUnverifiable: 0,
        worktrees: 3,
        browserPages: 0,
        browserPagesRetained: 0,
        // Dependency-free tasks are admitted straight to `ready`.
        tasksByStatus: { ...ZERO_TASK_STATUS_COUNTS, ready: 2 },
        agentsByState: ZERO_AGENT_STATE_COUNTS,
        workersByTerminalState: ZERO_WORKER_TERMINAL_STATE_COUNTS
      }
    })
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it('reports a null port when no server has bound one', async () => {
    const runtime = new OrcaRuntimeService(null)
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })

    const result = await runtime.getServeStats()

    expect(result.port).toBeNull()
    expect(result.counts).toEqual({
      agents: 0,
      tasks: 0,
      terminals: 0,
      terminalsUnverifiable: 0,
      worktrees: 0,
      browserPages: 0,
      browserPagesRetained: 0,
      tasksByStatus: ZERO_TASK_STATUS_COUNTS,
      agentsByState: ZERO_AGENT_STATE_COUNTS,
      workersByTerminalState: ZERO_WORKER_TERMINAL_STATE_COUNTS
    })
  })

  it('counts a pty that lost host contact as unverifiable, never as a terminal', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state?: { connected?: boolean }
      ) => unknown
    }
    internals.recordPtyWorktree('pty-a', 'wt-a')

    expect((await runtime.getServeStats()).counts).toMatchObject({
      terminals: 1,
      terminalsUnverifiable: 0
    })

    internals.recordPtyWorktree('pty-a', 'wt-a', { connected: false })

    // The pty is still registered; only the evidence for it is gone.
    expect((await runtime.getServeStats()).counts).toMatchObject({
      terminals: 0,
      terminalsUnverifiable: 1
    })
  })

  it('counts every registered browser page, and the retained subset with no live host', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const leases = getBrowserHostLeaseRegistry(runtime)
    const quitting = attachBrowserHost(runtime, 'host-a')
    attachBrowserHost(runtime, 'host-b')
    publishClientPage(runtime, 'page-a', leases.placeClientPage('page-a', 'host-a'))
    publishClientPage(runtime, 'page-b', leases.placeClientPage('page-b', 'host-b'))

    expect((await runtime.getServeStats()).counts).toMatchObject({
      browserPages: 2,
      browserPagesRetained: 0
    })

    quitting.release()

    // The fenced page keeps its registry slot with no placement left to drive it.
    expect((await runtime.getServeStats()).counts).toMatchObject({
      browserPages: 2,
      browserPagesRetained: 1
    })
  })

  it('publishes every task status, including the settled rows counts.tasks drops', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const ready = db.createTask({ spec: 'ready work' })
    const dispatched = db.createTask({ spec: 'dispatched work' })
    const completed = db.createTask({ spec: 'finished work' })
    const failed = db.createTask({ spec: 'broken work' })
    // `dispatched` is gated on an active Dispatch; the histogram only reads the column.
    db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('dispatched', dispatched.id)
    db.updateTaskStatus(completed.id, 'completed')
    db.updateTaskStatus(failed.id, 'failed')

    const counts = (await runtime.getServeStats()).counts

    expect(counts.tasksByStatus).toEqual({
      ...ZERO_TASK_STATUS_COUNTS,
      ready: 1,
      dispatched: 1,
      completed: 1,
      failed: 1
    })
    // The histogram is the only place the settled pile is visible: counts.tasks excludes it.
    expect(counts.tasks).toBe(2)
    expect(ready.status).toBe('ready')
  })

  it('groups worker terminals by the state their release actually reached', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const reclaimable = seedFailedWorkerTerminal(db, 'term_reclaimable', true)
    const handleOnly = seedFailedWorkerTerminal(db, 'term_retained', false)
    const releasing = seedFailedWorkerTerminal(db, 'term_releasing', true)
    db.requestWorkerTerminalRelease(releasing)

    expect((await runtime.getServeStats()).counts.workersByTerminalState).toEqual({
      ...ZERO_WORKER_TERMINAL_STATE_COUNTS,
      // Settled work still holding an owned terminal — the #19388 pileup.
      reclaimable: 1,
      // A handle with no owned resource behind it can only be retained.
      retained: 1,
      release_pending: 1
    })

    const resource = db.getWorkerTerminalResourceByOwner(releasing)
    db.markWorkerTerminalReleaseUnknown(resource!.id, 'tab_not_found')

    // #18737: an unprovable release must read as release_unknown, never as released.
    expect((await runtime.getServeStats()).counts.workersByTerminalState).toEqual({
      ...ZERO_WORKER_TERMINAL_STATE_COUNTS,
      reclaimable: 1,
      retained: 1,
      release_unknown: 1
    })
    expect(handleOnly).not.toBe(reclaimable)
  })
})

function runtimeWithStubbedWorktrees(db: OrchestrationDb): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
    worktrees: [],
    totalCount: 0,
    truncated: false
  })
  return runtime
}

/**
 * Replays a start that created a terminal and then failed: with `adopt`, the dispatch keeps an
 * owned resource (reclaimable); without it, only the handle survives (retained).
 */
function seedFailedWorkerTerminal(db: OrchestrationDb, handle: string, adopt: boolean): string {
  const task = db.createTask({ spec: `worker for ${handle}` })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  const effects = [
    { kind: 'terminal', role: 'agent', action: 'created', id: handle, surface: 'visible' }
  ]
  db.recordWorkerStage({
    dispatchId: started.dispatch.id,
    stage: 'terminal_readying',
    worktreeId: 'repo::worktree',
    terminalHandle: handle,
    effects,
    residualResources: effects
  })
  db.failWorkerStart(
    started.dispatch.id,
    'agent_readiness',
    'Agent startup blocked',
    adopt
      ? {
          adoptResidualTerminal: {
            terminalHandle: handle,
            worktreeId: 'repo::worktree',
            paneKey: `tab_${handle}:leaf_${handle}`,
            processIncarnation: `runtime:pty-${handle}:1`,
            hostScope: null
          }
        }
      : undefined
  )
  return started.dispatch.id
}

function attachBrowserHost(runtime: OrcaRuntimeService, browserHostClientId: string) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId,
    connectionId: `connection-${browserHostClientId}`,
    pairedDeviceId: `device-${browserHostClientId}`,
    hostCapabilities: ['webview']
  })
}

function publishClientPage(
  runtime: OrcaRuntimeService,
  browserPageId: string,
  placement: RuntimeBrowserPlacement
): void {
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    url: 'https://example.internal/',
    loading: false,
    active: false
  })
}
