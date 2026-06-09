import { describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { rebuildPaneWebglState } from './pane-rendering-control'

// Mock the WebGL renderer module so we can observe dispose/attach calls without
// constructing a real xterm WebglAddon (which needs a live GL context). The
// "Why" the manager rebuilds at all is documented on rebuildPaneWebglState:
// remote-runtime panes attach WebGL against an empty buffer and only receive
// their snapshot asynchronously, so the GPU canvas needs a post-content rebuild
// (upstream #4941).
const { disposeWebgl, attachWebgl } = vi.hoisted(() => ({
  disposeWebgl: vi.fn(),
  attachWebgl: vi.fn()
}))

vi.mock('./pane-webgl-renderer', () => ({
  disposeWebgl,
  attachWebgl,
  markComplexScriptOutput: vi.fn()
}))

vi.mock('./pane-webgl-reattach', () => ({
  reattachWebglIfNeeded: vi.fn()
}))

vi.mock('./pane-tree-ops', () => ({
  safeFit: vi.fn()
}))

function createPane(overrides: Partial<ManagedPaneInternal> = {}): ManagedPaneInternal {
  return {
    id: 7,
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    webglAddon: { dispose: vi.fn() } as never,
    ...overrides
  } as ManagedPaneInternal
}

describe('rebuildPaneWebglState', () => {
  it('disposes then reattaches WebGL when the pane has a webglAddon', () => {
    disposeWebgl.mockClear()
    attachWebgl.mockClear()
    const pane = createPane()
    const panes = new Map([[pane.id, pane]])

    rebuildPaneWebglState(panes, pane.id)

    expect(disposeWebgl).toHaveBeenCalledTimes(1)
    expect(disposeWebgl).toHaveBeenCalledWith(pane)
    expect(attachWebgl).toHaveBeenCalledTimes(1)
    expect(attachWebgl).toHaveBeenCalledWith(pane)
  })

  it('is a no-op when the pane has no webglAddon (DOM renderer)', () => {
    disposeWebgl.mockClear()
    attachWebgl.mockClear()
    const pane = createPane({ webglAddon: null })
    const panes = new Map([[pane.id, pane]])

    rebuildPaneWebglState(panes, pane.id)

    expect(disposeWebgl).not.toHaveBeenCalled()
    expect(attachWebgl).not.toHaveBeenCalled()
  })

  it('is a no-op when GPU rendering is disabled for the pane', () => {
    disposeWebgl.mockClear()
    attachWebgl.mockClear()
    const pane = createPane({ gpuRenderingEnabled: false })
    const panes = new Map([[pane.id, pane]])

    rebuildPaneWebglState(panes, pane.id)

    expect(disposeWebgl).not.toHaveBeenCalled()
    expect(attachWebgl).not.toHaveBeenCalled()
  })

  it('is a no-op when WebGL is deferred or disabled after context loss', () => {
    disposeWebgl.mockClear()
    attachWebgl.mockClear()
    const deferred = createPane({ id: 1, webglAttachmentDeferred: true })
    const contextLost = createPane({ id: 2, webglDisabledAfterContextLoss: true })
    const panes = new Map([
      [deferred.id, deferred],
      [contextLost.id, contextLost]
    ])

    rebuildPaneWebglState(panes, deferred.id)
    rebuildPaneWebglState(panes, contextLost.id)

    expect(disposeWebgl).not.toHaveBeenCalled()
    expect(attachWebgl).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown pane id', () => {
    disposeWebgl.mockClear()
    attachWebgl.mockClear()
    const panes = new Map<number, ManagedPaneInternal>()

    rebuildPaneWebglState(panes, 999)

    expect(disposeWebgl).not.toHaveBeenCalled()
    expect(attachWebgl).not.toHaveBeenCalled()
  })
})
