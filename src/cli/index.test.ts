/* eslint-disable max-lines -- Why: CLI parser tests share one mocked runtime client and fixture queue; splitting this file would duplicate setup and make command coverage harder to audit. */
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import {
  buildCurrentWorktreeSelector,
  COMMAND_SPECS,
  main,
  normalizeWorktreeSelector
} from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'

describe('COMMAND_SPECS collision check', () => {
  it('has no duplicate command paths', () => {
    const seen = new Set<string>()
    for (const spec of COMMAND_SPECS) {
      const key = spec.path.join(' ')
      expect(seen.has(key), `Duplicate COMMAND_SPECS path: "${key}"`).toBe(false)
      seen.add(key)
    }
  })
})

describe('orca cli worktree awareness', () => {
  const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
  const originalUserDataPath = process.env.ORCA_USER_DATA_PATH

  beforeEach(() => {
    callMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
    if (originalUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = originalUserDataPath
    }
  })

  it('builds the current worktree selector from cwd', () => {
    expect(buildCurrentWorktreeSelector('/tmp/repo/feature')).toBe(
      `path:${path.resolve('/tmp/repo/feature')}`
    )
  })

  it('normalizes active/current worktree selectors to cwd', () => {
    const resolved = path.resolve('/tmp/repo/feature')
    expect(normalizeWorktreeSelector('active', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('current', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('branch:feature/foo', '/tmp/repo/feature')).toBe(
      'branch:feature/foo'
    )
  })

  it('shows the enclosing worktree for `worktree current`', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_1', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature'
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('uses cwd when active is passed to worktree.set', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([
        buildWorktree('/tmp/repo', 'main', 'aaa'),
        buildWorktree('/tmp/repo/feature', 'feature/foo')
      ]),
      okFixture('req_1', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature',
          comment: 'hello'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'active', '--comment', 'hello', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'hello',
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('passes parent lineage through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: 'repo::/tmp/repo/parent',
          childWorktreeIds: [],
          lineage: {
            worktreeId: 'repo::/tmp/repo/child',
            worktreeInstanceId: 'child-instance',
            parentWorktreeId: 'repo::/tmp/repo/parent',
            parentWorktreeInstanceId: 'parent-instance',
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'id:repo::/tmp/repo/parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      parentWorktree: 'id:repo::/tmp/repo/parent',
      noParent: false
    })
  })

  it('passes parent removal through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_clear_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      parentWorktree: undefined,
      noParent: true
    })
  })

  it('passes explicit activation through worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'feature', '--activate', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: true,
      parentWorktree: `path:${path.resolve('/tmp/repo')}`,
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('passes an explicit parent through worktree.create without cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          parentWorktreeId: 'repo-1::/tmp/repo/parent',
          lineage: {
            worktreeId: 'repo-1::/tmp/repo/child',
            worktreeInstanceId: 'child-instance',
            parentWorktreeId: 'repo-1::/tmp/repo/parent',
            parentWorktreeInstanceId: 'parent-instance',
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          }
        },
        lineage: {
          worktreeId: 'repo-1::/tmp/repo/child',
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: 'repo-1::/tmp/repo/parent',
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        },
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        'id:repo-1::/tmp/repo/parent',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'id:repo-1::/tmp/repo/parent',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('passes no-parent through worktree.create and skips cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent', '--json'],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined
    })
  })

  it('passes caller terminal handle through worktree.create instead of cwd inference', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_parent'
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: false,
      callerTerminalHandle: 'term_parent'
    })
  })

  it('opts into setup and activation when worktree.create runs hooks', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'feature', '--run-hooks', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: true,
      activate: true,
      parentWorktree: `path:${path.resolve('/tmp/repo')}`,
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('passes explicit focus through terminal.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'RUNNER'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'RUNNER',
        '--focus',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: undefined,
      title: 'RUNNER',
      focus: true
    })
  })

  it('uses the resolved enclosing worktree for other worktree consumers', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_show', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'show', '--worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('formats group orchestration sends in text mode', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    callMock.mockResolvedValueOnce({
      id: 'req_send',
      ok: true,
      result: {
        messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
        recipients: 2
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'send', '--to', '@all', '--subject', 'hello'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_sender',
      to: '@all',
      subject: 'hello',
      body: undefined,
      type: undefined,
      priority: undefined,
      threadId: undefined,
      payload: undefined,
      devMode: false
    })
    expect(logSpy).toHaveBeenCalledWith('Sent 2 messages to 2 recipients')
  })

  it('rejects unknown task-update status with an enum-aware error', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['orchestration', 'task-update', '--id', 'task_x', '--status', 'complete'],
      '/tmp/repo'
    )

    const output = [...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n')
    expect(output).toContain("invalid status 'complete'")
    expect(output).toContain('pending, ready, dispatched, completed, failed, blocked')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)

    // Reset exitCode so subsequent tests don't inherit the failure.
    process.exitCode = priorExitCode
    errSpy.mockRestore()
  })

  it('passes the caller terminal handle through orchestration task-create', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockResolvedValueOnce({
      id: 'req_task_create',
      ok: true,
      result: {
        task: { id: 'task_1', status: 'ready' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'task-create', '--spec', 'spawn child workspace'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.taskCreate', {
      spec: 'spawn child workspace',
      deps: undefined,
      parent: undefined,
      callerTerminalHandle: 'term_creator'
    })
  })

  it('passes dev mode to injected orchestration dispatches', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-dev'
    callMock.mockResolvedValueOnce({
      id: 'req_dispatch',
      ok: true,
      result: {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['orchestration', 'dispatch', '--task', 'task_1', '--to', 'term_worker', '--inject'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.dispatch', {
      task: 'task_1',
      to: 'term_worker',
      from: 'term_sender',
      inject: true,
      devMode: true
    })
  })

  it('uses the resolved enclosing worktree for terminal consumers', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', { terminals: [], totalCount: 0, truncated: false })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.list', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
      limit: undefined
    })
  })
})
