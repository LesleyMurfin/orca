import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeServeStatsResult } from '../../../../shared/runtime-types'

function makeRequest(method: string): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method }
}

describe('serve.stats RPC method', () => {
  it('is registered in the real RPC registry and dispatches to runtime.getServeStats', async () => {
    const stats: RuntimeServeStatsResult = {
      version: '9.9.9-test',
      runtimeId: 'test-runtime',
      uptimeSeconds: 42,
      port: 6970,
      counts: {
        agents: 1,
        tasks: 2,
        terminals: 3,
        terminalsUnverifiable: 1,
        worktrees: 4,
        browserPages: 5,
        browserPagesRetained: 2
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getServeStats: async () => stats
    } as unknown as OrcaRuntimeService

    // Why: no `methods` override — this dispatcher uses the default
    // ALL_RPC_METHODS registry (rpc/methods/index.ts), so a missing
    // `...SERVE_STATS_METHODS` spread there, or a method-name typo, fails
    // this test rather than only a scoped one.
    const dispatcher = new RpcDispatcher({ runtime })

    const response = await dispatcher.dispatch(makeRequest('serve.stats'))

    expect(response).toMatchObject({ ok: true, result: stats })
  })
})
