import { describe, expect, it } from 'vitest'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from './agent-status-identity'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'

const NOW = 1_700_000_000_000

function existing(
  overrides: {
    agentType?: AgentType
    state?: AgentStatusState
    updatedAt?: number
    restoredUnconfirmed?: boolean
  } = {}
): {
  agentType: AgentType
  state: AgentStatusState
  updatedAt: number
  restoredUnconfirmed?: boolean
} {
  return {
    agentType: 'codex',
    state: 'working',
    updatedAt: NOW - 1000,
    ...overrides
  }
}

describe('resolveAgentStatusIdentity', () => {
  it('lets a live OMP hook replace a still-fresh Codex row on the same pane (#24854)', () => {
    // Closing Codex often never emits `done`, so the row stays "live" for 30 min.
    // A later top-level TUI harness in that pane is reuse, not a nested child.
    expect(
      resolveAgentStatusIdentity({
        existing: existing(),
        incoming: 'omp',
        now: NOW
      })
    ).toEqual({ agentType: 'omp', inheritedFromActivePane: false })
  })

  it('lets OMP replace a hydrated unconfirmed Codex row', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: existing({ restoredUnconfirmed: true }),
        incoming: 'omp',
        now: NOW
      })
    ).toEqual({ agentType: 'omp', inheritedFromActivePane: false })
  })

  it('keeps Codex when the incoming hook names no agent', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: existing(),
        incoming: 'unknown',
        now: NOW
      })
    ).toEqual({ agentType: 'codex', inheritedFromActivePane: false })
    expect(
      resolveAgentStatusIdentity({
        existing: existing(),
        incoming: undefined,
        now: NOW
      })
    ).toEqual({ agentType: 'codex', inheritedFromActivePane: false })
  })

  it('keeps the parent Claude identity when a nested non-TUI child hook inherits the pane key', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: existing({ agentType: 'claude' }),
        incoming: 'general',
        now: NOW
      })
    ).toEqual({ agentType: 'claude', inheritedFromActivePane: true })
  })

  it('lets OMP take over after Claude reports done', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: existing({ agentType: 'claude', state: 'done' }),
        incoming: 'omp',
        now: NOW
      })
    ).toEqual({ agentType: 'omp', inheritedFromActivePane: false })
  })

  it('lets OMP replace a still-live Claude row on the same pane', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: existing({ agentType: 'claude', state: 'working' }),
        incoming: 'omp',
        now: NOW
      })
    ).toEqual({ agentType: 'omp', inheritedFromActivePane: false })
  })

  it('lets OMP take over a Codex row older than the freshness window', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: existing({ updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }),
        incoming: 'omp',
        now: NOW
      })
    ).toEqual({ agentType: 'omp', inheritedFromActivePane: false })
  })
})

describe('shouldSuppressInheritedTerminalStatus', () => {
  it('still suppresses a nested child Stop so it cannot complete the parent', () => {
    expect(
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: true,
        incomingState: 'done'
      })
    ).toBe(true)
  })
})
