import { describe, expect, it } from 'vitest'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'
import { pickQuickWorkspaceAgent } from './quick-workspace-agent-selection'

describe('pickQuickWorkspaceAgent', () => {
  it('uses the first enabled catalog agent while detection is pending', () => {
    expect(pickQuickWorkspaceAgent(null, null, [])).toBe('claude')
    expect(pickQuickWorkspaceAgent(null, null, ['claude'])).toBe(TUI_AGENT_AUTO_PICK_ORDER[1])
  })

  it('respects blank and disabled preferred agents', () => {
    expect(pickQuickWorkspaceAgent('blank', null, [])).toBeNull()
    expect(pickQuickWorkspaceAgent('codex', null, ['codex'])).toBe('claude')
  })

  it('uses detected enabled agents after detection resolves', () => {
    expect(pickQuickWorkspaceAgent(null, ['codex'], ['claude'])).toBe('codex')
    expect(pickQuickWorkspaceAgent('codex', ['claude', 'codex'], ['codex'])).toBe('claude')
  })
})
