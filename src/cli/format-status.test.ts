import { describe, expect, it } from 'vitest'
import { formatCliStatus } from './format'
import type { CliStatusResult } from '../shared/runtime-types'

const base = (over: Partial<CliStatusResult> = {}): CliStatusResult => ({
  app: { running: false, pid: null },
  runtime: { state: 'ready', reachable: true, runtimeId: 'r-1' },
  graph: { state: 'ready' },
  ...over
}) as CliStatusResult

const appRunning = (s: CliStatusResult) =>
  formatCliStatus(s).split('\n')[0].replace('appRunning: ', '')

describe('formatCliStatus / appRunning', () => {
  it('reports `serve` for a healthy headless serve (no app, runtime ready+reachable)', () => {
    // The regression this guards: `false` here reads as "Orca is down", and humans and
    // agents restart a healthy serve on the strength of it — dropping every live session.
    expect(appRunning(base())).toBe('serve')
  })

  it('reports `true` when the desktop app is running', () => {
    expect(appRunning(base({ app: { running: true, pid: 123 } }))).toBe('true')
  })

  it('reports `false` when the runtime is unreachable', () => {
    expect(appRunning(base({ runtime: { state: 'ready', reachable: false, runtimeId: null } }))).toBe('false')
  })

  it('reports `false` when the runtime is reachable but not ready', () => {
    expect(appRunning(base({ runtime: { state: 'starting', reachable: true, runtimeId: 'r-1' } }))).toBe('false')
  })

  it('leaves the other status lines untouched', () => {
    const out = formatCliStatus(base({ app: { running: false, pid: null } }))
    expect(out).toContain('pid: none')
    expect(out).toContain('runtimeState: ready')
    expect(out).toContain('runtimeReachable: true')
    expect(out).toContain('runtimeId: r-1')
    expect(out).toContain('graphState: ready')
  })
})
