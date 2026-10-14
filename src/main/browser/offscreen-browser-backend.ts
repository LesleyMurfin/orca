import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { BrowserBackend, BrowserBackendCreateTab } from './browser-backend'
import type { BrowserManager } from './browser-manager'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { browserSessionRegistry } from './browser-session-registry'
import { BrowserError } from './browser-error'
import {
  offscreenBrowserTabCapacityMessage,
  OFFSCREEN_BROWSER_TAB_CAPACITY_CODE,
  resolveOffscreenBrowserTabCap
} from './offscreen-browser-tab-capacity'
import { loadOffscreenBrowserUrl } from './offscreen-browser-page-load'
import {
  type OffscreenRendererIdentity,
  OffscreenRendererIdentityBook,
  probeRendererStartTimeMs
} from './offscreen-renderer-identity'
import {
  nodeRendererProcessControl,
  reclaimRendererProcess,
  type RendererProcessControl
} from './offscreen-renderer-process-reclaim'

export type OffscreenBrowserManager = Pick<
  BrowserManager,
  'registerOffscreenGuest' | 'unregisterGuest'
>

// Why: headless orca serve has no renderer window to host a <webview>, so each
// browser page is backed by a main-process offscreen BrowserWindow. The window
// is never shown — it exists only so its WebContents can be driven over CDP and
// streamed via the existing screencast path. Verified on macOS and on headless
// Linux under Xvfb (Electron --headless segfaults; a virtual display is
// required there — provisioned in the serve image, not by this code).

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const OWNER_RETIREMENT_CONCURRENCY = 4
// Why bounded: retirement drives the agent-browser helper through the page's own renderer, and
// #14552 hit pages whose renderer had stopped answering. The teardown below must not hang behind
// a wait that will never return.
const DEFAULT_OWNER_RETIREMENT_TIMEOUT_MS = 5_000

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly windowsByPageId = new Map<string, BrowserWindow>()
  private readonly closingPageIds = new Set<string>()
  // Why capture while live: webContents.destroyed fires after the contents stop answering,
  // so close-time pid/start-time probes cannot recover the pair for an unexpected crash.
  private readonly rendererIdentities = new OffscreenRendererIdentityBook()
  // Shutdown is terminal for this backend; rejecting creates closes the race
  // where destroyAll snapshots ownership and a new page appears afterward.
  private shutdownStarted = false
  private readonly pendingOwnerRetirements = new Set<Promise<void>>()

  private readonly maxTabs: number
  private readonly retirementTimeoutMs: number
  private readonly rendererProcessControl: RendererProcessControl

  constructor(
    private readonly browserManager: OffscreenBrowserManager,
    private readonly options: {
      getAgentBrowserBridge?: () => Pick<AgentBrowserBridge, 'onPageClosed'> | null
      /** Per-host override; production resolves the cap from the environment. */
      maxTabs?: number
      ownerRetirementTimeoutMs?: number
      rendererProcessControl?: RendererProcessControl
    } = {}
  ) {
    this.maxTabs = options.maxTabs ?? resolveOffscreenBrowserTabCap()
    this.retirementTimeoutMs =
      options.ownerRetirementTimeoutMs ?? DEFAULT_OWNER_RETIREMENT_TIMEOUT_MS
    this.rendererProcessControl = options.rendererProcessControl ?? nodeRendererProcessControl
  }

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    if (this.shutdownStarted) {
      throw new Error('Offscreen browser backend is shutting down')
    }
    const browserPageId = params.browserPageId ?? randomUUID()
    if (this.windowsByPageId.has(browserPageId)) {
      throw new Error(`Browser page ${browserPageId} already exists`)
    }
    // Why refuse instead of evicting the oldest tab: an open offscreen page is a measurement an
    // agent is in the middle of, and closing it out from under the agent would lose page state it
    // cannot recover — a refusal names the tab it must close and leaves the choice with the caller.
    const currentCount = this.windowsByPageId.size + this.closingPageIds.size
    if (currentCount >= this.maxTabs) {
      throw new BrowserError(
        OFFSCREEN_BROWSER_TAB_CAPACITY_CODE,
        offscreenBrowserTabCapacityMessage(currentCount, this.maxTabs)
      )
    }
    // Why: profiles map to Electron partitions; using the profile's partition
    // makes cookies/storage persist in the same SQLite DB the desktop path uses.
    const profile = params.profileId
      ? browserSessionRegistry.getProfile(params.profileId)
      : browserSessionRegistry.getDefaultProfile()
    const partition = profile?.partition ?? ORCA_BROWSER_PARTITION

    const win = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      webPreferences: {
        // Why: offscreen pages are the SSH/headless browser backend; keep their
        // HTML fullscreen behavior aligned with desktop <webview> guests.
        ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.windowsByPageId.set(browserPageId, win)
    // Best-effort identity while the contents still answer; finished before most crashes.
    void this.rendererIdentities.capture(
      browserPageId,
      win,
      this.rendererProcessControl,
      () => this.windowsByPageId.get(browserPageId) === win
    )

    // Why: register the guest and return immediately so the new tab appears
    // without waiting for the page to finish loading. Previously createTab
    // awaited the full navigation, so clicking "New Browser Tab" did nothing for
    // up to a second on real URLs. The page loads asynchronously and streams
    // once it paints; a failed load leaves the (usable) tab open, matching how a
    // normal browser tab survives a failed navigation.
    const registered = this.browserManager.registerOffscreenGuest({
      browserPageId,
      worktreeId: params.worktreeId,
      sessionProfileId: profile?.id ?? null,
      webContentsId: win.webContents.id
    })
    if (!registered) {
      // Why destroy rather than carry on: the window already exists but carries none of the guest
      // policies registration installs, so leaving it would navigate an unvalidated URL with no
      // policy on it and hand back a page id nothing can drive. The renderer door aborts its mount
      // the same way; this is that abort.
      this.windowsByPageId.delete(browserPageId)
      this.rendererIdentities.delete(browserPageId)
      win.destroy()
      throw new Error(`Browser page ${browserPageId} was refused`)
    }

    // Why only once registration took: this teardown unregisters the page id, and a refused id is
    // one the other authority may own — cancelling its work would be the confusion we just refused.
    // Why at all: if the window dies out from under us (crash, app teardown), drop the registry
    // entry so commands fail cleanly instead of resolving a dead WebContents.
    win.webContents.once('destroyed', () => {
      // Explicit close removes the page first and performs awaited cleanup;
      // only an unexpected destruction still owns retirement + reclaim here.
      if (this.windowsByPageId.get(browserPageId) !== win) {
        return
      }
      // Single-flight with closeTab: claim the closing slot before any await.
      if (this.closingPageIds.has(browserPageId)) {
        return
      }
      this.windowsByPageId.delete(browserPageId)
      this.closingPageIds.add(browserPageId)
      this.browserManager.unregisterGuest(browserPageId)
      const identity = this.rendererIdentities.takeForUnexpectedDestroy(browserPageId, win)
      const teardown = this.finishUnexpectedTeardown(browserPageId, identity)
      this.pendingOwnerRetirements.add(teardown)
      void teardown.finally(() => this.pendingOwnerRetirements.delete(teardown))
    })

    const url = params.url || 'about:blank'
    void loadOffscreenBrowserUrl(win, url).catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })

    return { browserPageId }
  }

  async closeTab(browserPageId: string): Promise<void> {
    const win = this.windowsByPageId.get(browserPageId)
    if (!win) {
      return
    }
    // Claim ownership before any await so the destroyed handler cannot double-reclaim.
    if (this.closingPageIds.has(browserPageId)) {
      return
    }
    this.windowsByPageId.delete(browserPageId)
    this.closingPageIds.add(browserPageId)
    this.browserManager.unregisterGuest(browserPageId)
    // Why read the pid and start time before teardown: WebContents stops answering once it is
    // destroyed, and the pid+startTime pair binds reclamation to that exact process instance.
    const identity = await this.rendererIdentities.takeForClose(
      browserPageId,
      win,
      this.rendererProcessControl
    )
    try {
      await this.retirePageOwner(browserPageId)
      if (!win.isDestroyed()) {
        win.destroy()
      }
      // Hold the tab slot through grace/kill so create cannot oversubscribe mid-reclaim.
      if (identity && identity.osProcessId > 0) {
        await reclaimRendererProcess(identity.osProcessId, {
          control: this.rendererProcessControl,
          expectedStartTimeMs: identity.expectedStartTimeMs
        })
      }
    } finally {
      this.closingPageIds.delete(browserPageId)
      this.rendererIdentities.delete(browserPageId)
    }
  }

  getWebContentsId(browserPageId: string): number | null {
    const win = this.windowsByPageId.get(browserPageId)
    return win && !win.isDestroyed() ? win.webContents.id : null
  }

  async destroyAll(): Promise<void> {
    this.shutdownStarted = true
    const pageIds = [...this.windowsByPageId.keys()]
    await mapSettledWithConcurrency(pageIds, OWNER_RETIREMENT_CONCURRENCY, (pageId) =>
      this.closeTab(pageId)
    )
    await Promise.all(this.pendingOwnerRetirements)
  }

  private retirePageOwner(browserPageId: string): Promise<void> {
    const bridge = this.options.getAgentBrowserBridge?.()
    if (!bridge) {
      return Promise.resolve()
    }
    const settled = Promise.withResolvers<void>()
    const timer = setTimeout(settled.resolve, this.retirementTimeoutMs)
    timer.unref?.()
    const retirement = bridge
      .onPageClosed(browserPageId)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        settled.resolve()
      })
    this.pendingOwnerRetirements.add(settled.promise)
    void retirement.finally(() => this.pendingOwnerRetirements.delete(settled.promise))
    return settled.promise
  }

  private async finishUnexpectedTeardown(
    browserPageId: string,
    identity: OffscreenRendererIdentity | null
  ): Promise<void> {
    try {
      await this.retirePageOwner(browserPageId)
      if (identity && identity.osProcessId > 0) {
        let expectedStartTimeMs = identity.expectedStartTimeMs
        // Window contents are gone; a wedged renderer may still own the pid. One last probe
        // binds reclaim to that live process when create-time capture had not finished.
        if (expectedStartTimeMs === null) {
          expectedStartTimeMs = await probeRendererStartTimeMs(
            identity.osProcessId,
            this.rendererProcessControl
          )
        }
        await reclaimRendererProcess(identity.osProcessId, {
          control: this.rendererProcessControl,
          expectedStartTimeMs
        })
      }
    } finally {
      this.closingPageIds.delete(browserPageId)
      this.rendererIdentities.delete(browserPageId)
    }
  }
}
