import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function createDispatcher(): {
  runtime: Pick<OrcaRuntimeService, 'openMobileFile' | 'openMobileDiff'>
  dispatcher: RpcDispatcher
} {
  const opened = { worktree: 'wt-1', relativePath: 'a.ts', kind: 'text', opened: true }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    openMobileFile: vi.fn().mockResolvedValue(opened),
    openMobileDiff: vi.fn().mockResolvedValue(opened)
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FILE_METHODS open handlers only read the stubbed members.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: FILE_METHODS
  })
  return { runtime, dispatcher }
}

describe('file open RPC navigation', () => {
  it('passes an explicit navigation target through file and diff opens', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', navigation: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('files.openDiff', {
        worktree: 'id:wt-1',
        relativePath: 'a.ts',
        navigation: 'host'
      })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.ts', 'all')
    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'a.ts', false, 'host')
  })

  it('leaves navigation absent for callers that send none (phones, older CLIs)', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts' })
    )
    await dispatcher.dispatch(
      makeRequest('files.openDiff', { worktree: 'id:wt-1', relativePath: 'a.ts', staged: true })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.ts', undefined)
    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'a.ts', true, undefined)
  })

  it('forwards optional positions, leaving diffs unchanged', async () => {
    const { runtime, dispatcher } = createDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', line: 42, column: 7 })
    )
    expect(response).toMatchObject({ ok: true })
    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.ts', undefined, {
      line: 42,
      column: 7
    })
    await dispatcher.dispatch(
      makeRequest('files.openDiff', { worktree: 'id:wt-1', relativePath: 'a.ts', line: 42 })
    )
    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'a.ts', false, undefined)
  })

  it('rejects a column without a line', async () => {
    const { runtime, dispatcher } = createDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', column: 7 })
    )
    expect(response).toMatchObject({ ok: false })
    expect(runtime.openMobileFile).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, '12', Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid RPC positions %j',
    async (line) => {
      const { runtime, dispatcher } = createDispatcher()
      const response = await dispatcher.dispatch(
        makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', line })
      )
      expect(response).toMatchObject({ ok: false })
      expect(runtime.openMobileFile).not.toHaveBeenCalled()
    }
  )

  it('rejects an unknown navigation target on file opens', async () => {
    const { runtime, dispatcher } = createDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('files.open', {
        worktree: 'id:wt-1',
        relativePath: 'a.ts',
        navigation: 'everyone'
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.openMobileFile).not.toHaveBeenCalled()
  })
})
