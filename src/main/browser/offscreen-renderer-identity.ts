import type { BrowserWindow } from 'electron'
import { resolveWithTimeout } from './browser-manager-types'
import type { RendererProcessControl } from './offscreen-renderer-process-reclaim'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

/** Pid + start-time pair that binds reclaim to one OS process instance. */
export type OffscreenRendererIdentity = {
  osProcessId: number
  expectedStartTimeMs: number | null
}

// Why bounded: a hung start-time probe must not block tab close or reclaim.
export const START_TIME_PROBE_TIMEOUT_MS = 1_000

export async function probeRendererStartTimeMs(
  osProcessId: number,
  control: RendererProcessControl
): Promise<number | null> {
  return (
    await resolveWithTimeout(
      (control.readStartTimeMs ?? readProcessStartTimeMs)(osProcessId),
      START_TIME_PROBE_TIMEOUT_MS,
      null
    ).catch(() => ({ value: null, timedOut: false }))
  ).value
}

/**
 * Live pid/start-time book for offscreen pages. Capture while contents still answer;
 * unexpected destroy cannot re-probe a dead WebContents.
 */
export class OffscreenRendererIdentityBook {
  private readonly byPageId = new Map<string, OffscreenRendererIdentity>()

  get(browserPageId: string): OffscreenRendererIdentity | undefined {
    return this.byPageId.get(browserPageId)
  }

  delete(browserPageId: string): void {
    this.byPageId.delete(browserPageId)
  }

  /** Best-effort capture; pid first, start-time when the probe lands. */
  async capture(
    browserPageId: string,
    win: BrowserWindow,
    control: RendererProcessControl,
    isStillOwner: () => boolean
  ): Promise<void> {
    if (win.isDestroyed() || !isStillOwner()) {
      return
    }
    const osProcessId = win.webContents.getOSProcessId()
    if (osProcessId <= 0) {
      return
    }
    // Pid first so an unexpected destroy mid-probe still has a process number; start-time
    // stays null until the probe lands — reclaim refuses SIGKILL without it.
    const prior = this.byPageId.get(browserPageId)
    if (!prior || prior.osProcessId !== osProcessId) {
      this.byPageId.set(browserPageId, { osProcessId, expectedStartTimeMs: null })
    }
    const expectedStartTimeMs = await probeRendererStartTimeMs(osProcessId, control)
    if (win.isDestroyed() || !isStillOwner()) {
      return
    }
    const current = this.byPageId.get(browserPageId)
    if (current?.osProcessId === osProcessId) {
      this.byPageId.set(browserPageId, { osProcessId, expectedStartTimeMs })
    }
  }

  /**
   * Identity for close: prefer a live pid probe; fall back to the stored pair when
   * contents are already gone.
   */
  async takeForClose(
    browserPageId: string,
    win: BrowserWindow,
    control: RendererProcessControl
  ): Promise<OffscreenRendererIdentity | null> {
    const liveOsProcessId = win.isDestroyed() ? 0 : win.webContents.getOSProcessId()
    const stored = this.byPageId.get(browserPageId)
    this.byPageId.delete(browserPageId)
    const osProcessId = liveOsProcessId > 0 ? liveOsProcessId : (stored?.osProcessId ?? 0)
    if (osProcessId <= 0) {
      return null
    }
    let expectedStartTimeMs =
      stored?.osProcessId === osProcessId ? stored.expectedStartTimeMs : null
    if (liveOsProcessId > 0) {
      expectedStartTimeMs = await probeRendererStartTimeMs(liveOsProcessId, control)
    }
    return { osProcessId, expectedStartTimeMs }
  }

  /** Last-chance pid when destroy fired before create-time capture finished. */
  takeForUnexpectedDestroy(
    browserPageId: string,
    win: BrowserWindow
  ): OffscreenRendererIdentity | null {
    let identity = this.byPageId.get(browserPageId) ?? null
    this.byPageId.delete(browserPageId)
    if (!identity && !win.isDestroyed()) {
      try {
        const osProcessId = win.webContents.getOSProcessId()
        if (osProcessId > 0) {
          identity = { osProcessId, expectedStartTimeMs: null }
        }
      } catch {
        // Contents already gone between the event and the probe.
      }
    }
    return identity
  }
}
