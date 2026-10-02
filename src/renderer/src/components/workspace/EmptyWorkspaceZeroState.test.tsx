// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EmptyWorkspaceZeroState from './EmptyWorkspaceZeroState'

describe('EmptyWorkspaceZeroState', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('renders workspace title / repo info and action buttons', async () => {
    await act(async () => {
      root.render(
        <EmptyWorkspaceZeroState
          workspaceTitle="my-feature-branch"
          repositoryName="my-org/my-repo"
          onNewTerminal={vi.fn()}
          onNewAgent={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('my-feature-branch')
    expect(container.textContent).toContain('my-org/my-repo')

    const buttons = Array.from(container.querySelectorAll('button'))
    const buttonTexts = buttons.map((b) => b.textContent?.trim() || '')

    expect(buttonTexts.some((text) => text.includes('New Terminal'))).toBe(true)
    expect(
      buttonTexts.some((text) => text.includes('New Agent') || text.includes('Start AI Chat'))
    ).toBe(true)
    expect(buttonTexts.some((text) => text.includes('Open File'))).toBe(true)
  })

  it('renders fallback title when workspace title is not provided', async () => {
    await act(async () => {
      root.render(
        <EmptyWorkspaceZeroState
          onNewTerminal={vi.fn()}
          onNewAgent={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )
    })

    expect(container.textContent).toMatch(/No open tabs/i)
  })

  it('calls onNewTerminal when clicking "New Terminal"', async () => {
    const onNewTerminal = vi.fn()

    await act(async () => {
      root.render(
        <EmptyWorkspaceZeroState
          onNewTerminal={onNewTerminal}
          onNewAgent={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const terminalButton = buttons.find((b) => b.textContent?.includes('New Terminal'))
    expect(terminalButton).toBeDefined()

    await act(async () => {
      terminalButton?.click()
    })

    expect(onNewTerminal).toHaveBeenCalledTimes(1)
  })

  it('calls onNewAgent when clicking "New Agent" (or "Start AI Chat")', async () => {
    const onNewAgent = vi.fn()

    await act(async () => {
      root.render(
        <EmptyWorkspaceZeroState
          onNewTerminal={vi.fn()}
          onNewAgent={onNewAgent}
          onOpenFile={vi.fn()}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const agentButton = buttons.find(
      (b) => b.textContent?.includes('New Agent') || b.textContent?.includes('Start AI Chat')
    )
    expect(agentButton).toBeDefined()

    await act(async () => {
      agentButton?.click()
    })

    expect(onNewAgent).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenFile when clicking "Open File"', async () => {
    const onOpenFile = vi.fn()

    await act(async () => {
      root.render(
        <EmptyWorkspaceZeroState
          onNewTerminal={vi.fn()}
          onNewAgent={vi.fn()}
          onOpenFile={onOpenFile}
        />
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const fileButton = buttons.find((b) => b.textContent?.includes('Open File'))
    expect(fileButton).toBeDefined()

    await act(async () => {
      fileButton?.click()
    })

    expect(onOpenFile).toHaveBeenCalledTimes(1)
  })

  it('renders keyboard shortcuts when provided', async () => {
    await act(async () => {
      root.render(
        <EmptyWorkspaceZeroState
          onNewTerminal={vi.fn()}
          onNewAgent={vi.fn()}
          onOpenFile={vi.fn()}
          shortcuts={{
            newTerminal: 'Ctrl+`',
            newAgent: 'Ctrl+Shift+A',
            openFile: 'Ctrl+P'
          }}
        />
      )
    })

    expect(container.textContent).toContain('Ctrl+`')
    expect(container.textContent).toContain('Ctrl+Shift+A')
    expect(container.textContent).toContain('Ctrl+P')
  })
})
