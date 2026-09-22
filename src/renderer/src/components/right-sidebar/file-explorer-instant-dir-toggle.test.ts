// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import type { TreeNode } from './file-explorer-types'

vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved',
  requireMatchingFileExplorerOperationRoute: () => ({ settings: {} })
}))

const directoryNode: TreeNode = {
  name: 'components',
  path: '/repo/src/components',
  relativePath: 'src/components',
  isDirectory: true,
  depth: 1
}

const fileNode: TreeNode = {
  name: 'index.ts',
  path: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 1
}

function renderHandlers(toggleDir: (worktreeId: string, dirPath: string) => void) {
  const openFile = vi.fn()
  const setSelectedPath = vi.fn()
  const hook = renderHook(() =>
    useFileExplorerHandlers({
      activeWorktreeId: 'wt-1',
      openFile,
      makePreviewFilePermanent: vi.fn(),
      toggleDir,
      loadDir: vi.fn().mockResolvedValue(true),
      statPath: vi.fn().mockResolvedValue({ isDirectory: true }),
      authorizeExternalPath: vi.fn(),
      markPathAsDirectory: vi.fn(),
      setSelectedPath,
      scrollRef: createRef<HTMLDivElement>()
    })
  )
  return { ...hook, openFile, setSelectedPath }
}

describe('instant directory toggle', () => {
  afterEach(() => cleanup())

  it('toggles immediately when the click missed the rename hotspot', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'immediate')
      await Promise.resolve()
    })

    expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)
  })

  it('toggles a filename click immediately, without waiting out the double-click window', async () => {
    vi.useFakeTimers()
    try {
      const toggleDir = vi.fn()
      const { result } = renderHandlers(toggleDir)

      await act(async () => {
        result.current.handleClick(directoryNode)
        await Promise.resolve()
      })

      // Why: no timer may be involved — a delay here is what read as lag on the folder name.
      expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops only the second click of a double-click rename so the folder does not flip back', async () => {
    const toggleDir = vi.fn()
    const { result, setSelectedPath } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'immediate')
      await Promise.resolve()
    })
    await act(async () => {
      result.current.handleClick(directoryNode, 'skip')
      await Promise.resolve()
    })

    expect(toggleDir).toHaveBeenCalledTimes(1)
    // Why: the rename about to start still needs the row selected.
    expect(setSelectedPath).toHaveBeenLastCalledWith(directoryNode.path)
  })

  it('keeps opening files on the second click, which is not a directory toggle', async () => {
    const toggleDir = vi.fn()
    const { result, openFile } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(fileNode, 'skip')
      await Promise.resolve()
    })

    expect(toggleDir).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledTimes(1)
  })
})
