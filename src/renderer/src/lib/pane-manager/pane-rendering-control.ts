import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'
import { attachWebgl, disposeWebgl, markComplexScriptOutput } from './pane-webgl-renderer'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'

export function setPaneGpuRenderingState(
  panes: Map<number, ManagedPaneInternal>,
  paneId: number,
  enabled: boolean
): void {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  pane.gpuRenderingEnabled = enabled
  if (!enabled) {
    disposeWebgl(pane, { refreshDimensions: true })
    return
  }
  if (pane.webglAttachmentDeferred || pane.webglDisabledAfterContextLoss) {
    return
  }
  if (!pane.webglAddon) {
    attachWebgl(pane)
    safeFit(pane)
  }
}

/** Force a fresh WebGL atlas + canvas for a pane that already has the addon
 *  attached, using the project's dispose+reattach idiom (the same one
 *  pane-lifecycle uses for ligatures). attachWebgl re-runs
 *  refreshTerminalAfterWebglAttach, so the canvas repaints against the
 *  current buffer.
 *
 *  Why: remote-runtime panes attach WebGL synchronously against an empty
 *  buffer, then receive their buffered snapshot asynchronously — the GPU
 *  canvas never gets a valid post-content repaint and renders black. Rebuilding
 *  once the snapshot has landed fixes it. No-op for DOM panes (no webglAddon)
 *  and for panes whose GPU rendering is disabled/deferred/context-lost. */
export function rebuildPaneWebglState(
  panes: Map<number, ManagedPaneInternal>,
  paneId: number
): void {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (
    !pane.gpuRenderingEnabled ||
    !pane.webglAddon ||
    pane.webglAttachmentDeferred ||
    pane.webglDisabledAfterContextLoss
  ) {
    return
  }
  disposeWebgl(pane)
  attachWebgl(pane)
}

export function markPaneComplexScriptOutput(
  panes: Map<number, ManagedPaneInternal>,
  paneId: number
): void {
  const pane = panes.get(paneId)
  if (pane) {
    markComplexScriptOutput(pane)
  }
}

export function suspendPaneRendering(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    pane.webglAttachmentDeferred = true
    disposeWebgl(pane)
  }
}

export function resumePaneRendering(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    pane.webglAttachmentDeferred = false
    reattachWebglIfNeeded(pane)
  }
}
