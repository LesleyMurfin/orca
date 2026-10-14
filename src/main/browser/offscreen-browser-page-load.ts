import type { BrowserWindow } from 'electron'

const LOAD_TIMEOUT_MS = 30_000

/** Navigate an offscreen window; main-frame failures reject, aborted loads resolve. */
export async function loadOffscreenBrowserUrl(win: BrowserWindow, url: string): Promise<void> {
  const wc = win.webContents
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      // Why: about:blank and slow pages can resolve via timeout without a
      // did-finish-load; treat that as success so the tab is still operable.
      resolve()
    }, LOAD_TIMEOUT_MS)

    const onFinish = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const onFail = (
      _e: unknown,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean
    ): void => {
      // Why: subframe/iframe (e.g. ad/tracker) load failures also fire
      // did-fail-load. Only the main frame failing means the page itself
      // failed; ignore the rest or an otherwise-usable page gets rejected.
      if (!isMainFrame) {
        return
      }
      if (settled) {
        return
      }
      settled = true
      cleanup()
      // Why: aborted loads (-3) happen on redirects/SPA navigations and are not
      // real failures; the page is still usable.
      if (errorCode === -3) {
        resolve()
        return
      }
      reject(new Error(`${errorDescription} (${errorCode})`))
    }
    const onDestroyed = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      wc.removeListener('did-finish-load', onFinish)
      wc.removeListener('did-fail-load', onFail)
      wc.removeListener('destroyed', onDestroyed)
    }

    wc.on('did-finish-load', onFinish)
    wc.on('did-fail-load', onFail)
    wc.once('destroyed', onDestroyed)
    void wc.loadURL(url).catch(() => {
      // loadURL rejects on aborted navigations; did-fail-load handles the rest.
    })
  })
}
