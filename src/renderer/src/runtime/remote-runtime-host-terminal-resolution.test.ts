import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import { resolveRemoteRuntimeHostTerminal } from './remote-runtime-host-terminal-resolution'

function terminal(
  overrides: Partial<RuntimeMobileSessionTerminalClientTab> = {}
): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: 'pane:1',
    title: 'Terminal',
    parentTabId: 'tab-1',
    leafId: 'pane:1',
    isActive: false,
    status: 'ready',
    terminal: 'terminal-1',
    ...overrides
  } as RuntimeMobileSessionTerminalClientTab
}

function snapshot(tabs: RuntimeMobileSessionClientTab[]): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

describe('resolveRemoteRuntimeHostTerminal', () => {
  it('selects the requested terminal leaf', () => {
    const result = resolveRemoteRuntimeHostTerminal(
      snapshot([
        terminal({ id: 'pane:other', leafId: 'pane:other', terminal: 'other' }),
        terminal({ id: 'pane:1', leafId: 'pane:1', terminal: 'requested' })
      ]),
      { hostTabId: 'tab-1', leafId: 'pane:1' }
    )

    expect(result).toEqual({ kind: 'ready', handle: 'requested' })
  })

  it('prefers the active ready surface and otherwise the first ready surface', () => {
    const tabs = [
      terminal({ id: 'pane:1', terminal: 'first' }),
      terminal({ id: 'pane:2', leafId: 'pane:2', terminal: 'active', isActive: true })
    ]

    expect(resolveRemoteRuntimeHostTerminal(snapshot(tabs), { hostTabId: 'tab-1' })).toEqual({
      kind: 'ready',
      handle: 'active'
    })
    expect(
      resolveRemoteRuntimeHostTerminal(snapshot([tabs[0], { ...tabs[1], isActive: false }]), {
        hostTabId: 'tab-1',
        leafId: null
      })
    ).toEqual({ kind: 'ready', handle: 'first' })
  })

  it('returns pending when the matching terminal surface has no handle yet', () => {
    expect(
      resolveRemoteRuntimeHostTerminal(
        snapshot([terminal({ status: 'pending-handle', terminal: null })]),
        { hostTabId: 'tab-1', leafId: 'pane:1' }
      )
    ).toEqual({ kind: 'pending' })
  })

  it('returns gone when the requested surface is absent', () => {
    expect(
      resolveRemoteRuntimeHostTerminal(
        snapshot([terminal({ parentTabId: 'tab-2', id: 'pane:2', leafId: 'pane:2' })]),
        { hostTabId: 'tab-1' }
      )
    ).toEqual({ kind: 'gone' })
  })

  it('does not count a non-terminal tab as a pending terminal surface', () => {
    expect(
      resolveRemoteRuntimeHostTerminal(
        snapshot([
          {
            type: 'markdown',
            id: 'tab-1',
            title: 'Notes',
            filePath: '/tmp/notes.md',
            relativePath: 'notes.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: 'file-1',
            sourceFilePath: '/tmp/notes.md',
            sourceRelativePath: 'notes.md',
            documentVersion: '1'
          }
        ]),
        { hostTabId: 'tab-1' }
      )
    ).toEqual({ kind: 'gone' })
  })
})
