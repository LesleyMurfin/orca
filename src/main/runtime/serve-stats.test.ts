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
      uptimeSeconds: expect.any(Number),
      port: 6970,
      counts: {
        agents: 0,
        tasks: 2,
        terminals: 0,
        worktrees: 3
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
    expect(result.counts).toEqual({ agents: 0, tasks: 0, terminals: 0, worktrees: 0 })
  })
})
