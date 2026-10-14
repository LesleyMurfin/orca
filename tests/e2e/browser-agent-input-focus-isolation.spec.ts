/**
 * Agent browser input must reach its page without touching the user's keyboard focus (#20595).
 *
 * The user's stand-in is the focused terminal; the agent drives a background browser tab.
 * Chromium routes <webview> input by the window's focus, so the failure shows up as host
 * keydowns (agent keys landing in the terminal) or a host focus change.
 * See docs/reference/agent-browser-focus-isolation.md.
 */

import { createServer, type Server } from 'node:http'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Focus isolation probe</title></head>
  <body>
    <form id="form"><input id="probe" /></form>
    <button id="target" style="position:absolute;left:40px;top:80px;width:200px;height:60px">target</button>
    <script>
      window.__keys = []
      window.__submits = 0
      window.__clicks = 0
      addEventListener('keydown', (event) => window.__keys.push(event.key), true)
      document.getElementById('form').addEventListener('submit', (event) => {
        event.preventDefault()
        window.__submits += 1
      })
      document.getElementById('target').addEventListener('click', () => { window.__clicks += 1 })
    </script>
  </body>
</html>`

async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

function readProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

async function rpc(page: Page, method: string, params: Record<string, unknown>): Promise<unknown> {
  const response: unknown = await page.evaluate(
    ({ targetMethod, targetParams }) =>
      window.api.runtime.call({ method: targetMethod, params: targetParams }),
    { targetMethod: method, targetParams: params }
  )
  expect(
    readProperty(response, 'ok'),
    `${method} failed: ${JSON.stringify(readProperty(response, 'error'))}`
  ).toBe(true)
  return readProperty(response, 'result')
}

async function evalInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
  return readProperty(await rpc(page, 'browser.eval', { page: pageId, expression }), 'result')
}

/** Focuses the terminal and records every host keydown and focus move from here on. */
async function focusTerminalAndWatchHost(page: Page): Promise<void> {
  await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!textarea) {
      throw new Error('No terminal input to focus')
    }
    textarea.focus()
    // Why: kept on the document so the read side needs no untyped window property.
    const log: string[] = []
    const record = (entry: string): void => {
      log.push(entry)
      document.documentElement.dataset.agentFocusProbeLog = JSON.stringify(log)
    }
    document.documentElement.dataset.agentFocusProbeLog = '[]'
    window.addEventListener('keydown', (event) => record(`key:${event.key}`), true)
    window.addEventListener('focusin', (event) => {
      const target = event.target
      record(`focus:${target instanceof Element ? target.tagName : 'window'}`)
    })
  })
}

async function readHost(page: Page): Promise<{ log: string[]; terminalFocused: boolean }> {
  return page.evaluate(() => ({
    log: ((): string[] => {
      const parsed: unknown = JSON.parse(
        document.documentElement.dataset.agentFocusProbeLog ?? '[]'
      )
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : []
    })(),
    terminalFocused: document.activeElement?.classList.contains('xterm-helper-textarea') === true
  }))
}

test('agent keys and text reach the page without leaving the user’s terminal', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).toBeTruthy()
    const pageId = await orcaPage.evaluate(
      ({ targetWorktreeId, targetUrl }) =>
        window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
          title: 'Focus isolation probe',
          activate: false
        })?.activePageId ?? null,
      { targetWorktreeId: worktreeId!, targetUrl: server.url }
    )
    expect(pageId).toBeTruthy()
    await expect
      .poll(() => evalInPage(orcaPage, pageId!, 'document.title'), { timeout: 20_000 })
      .toBe('Focus isolation probe')
    await ensureTerminalVisible(orcaPage)

    await focusTerminalAndWatchHost(orcaPage)
    await evalInPage(orcaPage, pageId!, `document.getElementById('probe').focus()`)

    const probeValue = (): Promise<unknown> =>
      evalInPage(orcaPage, pageId!, `document.getElementById('probe').value`)
    await rpc(orcaPage, 'browser.keypress', { page: pageId, key: 'Z' })
    await rpc(orcaPage, 'browser.type', { page: pageId, input: 'qr' })
    await expect.poll(probeValue).toBe('Zqr')
    await rpc(orcaPage, 'browser.keypress', { page: pageId, key: 'Enter' })
    await rpc(orcaPage, 'browser.fill', { page: pageId, element: '#probe', value: 'filled' })
    await expect.poll(probeValue).toBe('filled')

    const host = await readHost(orcaPage)
    expect(host.log).toEqual([])
    expect(host.terminalFocused).toBe(true)
    await expect
      .poll(() =>
        evalInPage(
          orcaPage,
          pageId!,
          `JSON.stringify({ submits: window.__submits, keys: window.__keys })`
        )
      )
      // Why: `type` inserts text without key events, so only the keypresses log keydowns.
      .toBe(JSON.stringify({ submits: 1, keys: ['Z', 'Enter'] }))
  } finally {
    await server.close()
  }
})
