import { describe, expect, it } from 'vitest'
import { toRuntimeActivateWorktreeEvent } from './runtime-client-events'

describe('toRuntimeActivateWorktreeEvent', () => {
  it('omits originClientId when it is not provided', () => {
    const event = toRuntimeActivateWorktreeEvent('repo-1', 'wt-1')

    expect(event).toEqual({ type: 'activateWorktree', repoId: 'repo-1', worktreeId: 'wt-1' })
    expect(event).not.toHaveProperty('originClientId')
  })

  it('includes originClientId only when provided so peers can be self-excluded', () => {
    const event = toRuntimeActivateWorktreeEvent(
      'repo-1',
      'wt-1',
      undefined,
      undefined,
      undefined,
      'device-A'
    )

    expect(event).toMatchObject({
      type: 'activateWorktree',
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      originClientId: 'device-A'
    })
  })
})
