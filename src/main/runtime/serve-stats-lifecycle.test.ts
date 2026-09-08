import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { OrchestrationDb } from './orchestration/db'
import { StatsCollector } from '../stats/collector'
import { AgentSessionTransitionRecorder } from '../stats/agent-session-transition-recorder'

const structuredHost = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => structuredHost.current
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const roots: string[] = []
afterEach(() => {
  structuredHost.current = null
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function runtimeWithDb() {
  const stats = new StatsCollector()
  const runtime = new OrcaRuntimeService(null, stats)
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  return { runtime, db, stats }
}

describe('serve stats lifecycle', () => {
  it('counts native live sessions without counting readable or terminal-owned sessions twice', async () => {
    const { runtime, db } = runtimeWithDb()
    structuredHost.current = {
      listSessionTabs: () => ['live', 'restored', 'terminal'].map((sessionId) => ({ sessionId })),
      hasSession: () => true,
      deps: {
        store: {
          getRecord: (id: string) => ({
            lease: {
              runtimeKind: id === 'terminal' ? 'tui' : 'native',
              claimStatus: id === 'restored' ? 'recovering' : 'live'
            }
          })
        }
      }
    }
    try {
      expect((await runtime.getServeStats()).counts).toMatchObject({ agents: 1, terminals: 0 })
    } finally {
      db.close()
    }
  })

  it('clears the advertised port after the server stops', async () => {
    const { runtime, db } = runtimeWithDb()
    const root = mkdtempSync(join(tmpdir(), 'serve-stats-review-'))
    roots.push(root)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: root,
      enableWebSocket: true,
      wsPort: 0
    })
    try {
      await server.start()
      expect((await runtime.getServeStats()).port).toBeGreaterThan(0)
      await server.stop()
      expect((await runtime.getServeStats()).port).toBeNull()
    } finally {
      await server.stop()
      db.close()
    }
  })

  it('counts a live headless terminal created without a renderer graph', async () => {
    const { runtime, db, stats } = runtimeWithDb()
    const recorder = new AgentSessionTransitionRecorder(stats)
    const event = {
      paneKey: 'tab-review::11111111-1111-4111-8111-111111111111',
      connectionId: null,
      stateStartedAt: Date.now(),
      payload: { state: 'working' as const }
    }
    try {
      await createHeadlessTerminal(runtime)
      expect((await runtime.getServeStats()).counts.terminals).toBe(1)
      recorder.onStatus(event)
      expect((await runtime.getServeStats()).counts.agents).toBe(1)
      recorder.onStatus({ ...event, payload: { state: 'waiting' } })
      expect((await runtime.getServeStats()).counts.agents).toBe(1)
      runtime.onPtyExit('pty-review', 0)
      expect((await runtime.getServeStats()).counts.terminals).toBe(0)
    } finally {
      db.close()
    }
  })

  it('moves an agent between turn-state buckets, and admits when it cannot prove one', async () => {
    const { runtime, db } = runtimeWithDb()
    const internals = runtime as unknown as {
      ptysById: Map<string, { paneKey: string | null }>
      retainAgentRowSnapshot: (
        ptyId: string,
        paneKey: string,
        worktreeId: string | undefined,
        tabId: string | undefined,
        connectionId: string | null,
        payload: { state: 'working' | 'blocked' | 'waiting' | 'done' }
      ) => boolean
    }
    try {
      await createHeadlessTerminal(runtime)
      const paneKey = internals.ptysById.get('pty-review')?.paneKey ?? ''
      expect(paneKey).not.toBe('')

      // The pane resolves an agent identity, but nothing has reported a turn yet: `unknown` is
      // the honest answer, never `idle`.
      expect((await runtime.getServeStats()).counts).toMatchObject({
        agents: 1,
        agentsByState: { working: 0, permission: 0, idle: 0, unknown: 1 }
      })

      const retain = (state: 'working' | 'blocked' | 'done'): void => {
        internals.retainAgentRowSnapshot('pty-review', paneKey, 'wt-review', 'tab-review', null, {
          state
        })
      }

      retain('working')
      expect((await runtime.getServeStats()).counts.agentsByState).toEqual({
        working: 1,
        permission: 0,
        idle: 0,
        unknown: 0
      })

      retain('blocked')
      expect((await runtime.getServeStats()).counts.agentsByState).toEqual({
        working: 0,
        permission: 1,
        idle: 0,
        unknown: 0
      })

      retain('done')
      expect((await runtime.getServeStats()).counts.agentsByState).toEqual({
        working: 0,
        permission: 0,
        idle: 1,
        unknown: 0
      })
    } finally {
      db.close()
    }
  })
})

/** A pty with no renderer leaf behind it: the shape `orca serve` runs headless. */
async function createHeadlessTerminal(runtime: OrcaRuntimeService): Promise<void> {
  const scope = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(scope, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-review',
    path: tmpdir(),
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-review' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal('id:wt-review', {
    tabId: 'tab-review',
    leafId: '11111111-1111-4111-8111-111111111111',
    title: 'Review',
    launchAgent: 'claude'
  })
}
