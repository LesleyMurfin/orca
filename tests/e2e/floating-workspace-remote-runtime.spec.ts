/**
 * E2E coverage for Bug B: with the client connected to a remote runtime,
 * creating a terminal in the floating workspace must yield a LIVE PTY — no
 * `selector_not_found` rejection, no black/empty pane.
 *
 * Root cause + fix: the floating workspace is a repo-less synthetic session
 * (id `global-floating-terminal`, no entry in the worktree catalog). When a
 * remote client pairs to an `orca serve`, the serve's `resolveWorktreeSelector`
 * (src/main/runtime/orca-runtime.ts) used to throw `selector_not_found` for the
 * floating sentinel, leaving the floating terminal a black pane. The fix
 * synthesizes a virtual ResolvedWorktree rooted at the serve user's home so the
 * PTY spawns in a real, existing dir. Co-located unit coverage in
 * src/main/runtime/orca-runtime.test.ts ("resolves the floating-terminal
 * sentinel to a virtual repo-less session at home").
 *
 * Why these assertions target the DOM (per tests/e2e/AGENTS.md): a black pane
 * is a render-layer failure. We open the real floating panel, drive a marker
 * command through the live PTY, and assert the marker echoes back into the
 * visible xterm surface — that is the user-observable proof the PTY is alive,
 * not just that the store created a tab.
 *
 * Harness fit: the headless suite launches a single local Electron app, so it
 * cannot pair a separate desktop client to a separate `orca serve` process.
 * Pointing `activeRuntimeEnvironmentId` at a synthetic id does NOT simulate the
 * fix faithfully — it routes the floating PTY to a runtime environment that does
 * not exist in this local app, so the PTY genuinely never spawns (a dead pane
 * for an unrelated reason, not the resolver bug the fix targets). What the local
 * harness CAN exercise is the same `resolveWorktreeSelector` floating-sentinel
 * code path the fix touches: the floating workspace is a repo-less synthetic
 * `global-floating-terminal` session that the main process must resolve to a
 * live PTY. The first test below guards that resolver path locally; the true
 * remote-pairing variant is left as `test.fixme` with the missing serve-pairing
 * fixture documented.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal } from './helpers/terminal'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts. E2e
// specs avoid importing renderer/shared modules into the Playwright runner, so
// the floating-workspace WebGL recovery spec hard-codes the same id.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'

// Why: the floating panel toggles via this window event
// (src/renderer/src/lib/floating-terminal.ts); dispatching it exercises the
// same code path as the status bar button and the keyboard shortcut.
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'

async function enableFloatingWorkspace(page: Page): Promise<void> {
  await page.evaluate((worktreeId) => {
    const store = window.__store
    const state = store?.getState()
    if (!store || !state?.settings) {
      throw new Error('Store unavailable')
    }
    store.setState({
      settings: {
        ...state.settings,
        floatingTerminalEnabled: true
      }
    })
    const tabs = store.getState().tabsByWorktree[worktreeId] ?? []
    if (tabs.length === 0) {
      const tab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false
      })
      store.getState().activateTab(tab.id)
    }
  }, FLOATING_WORKTREE_ID)
  // Why: the toggle event listener closes over floatingTerminalEnabled; wait for
  // the (lazy) panel to mount so React has committed the enabled state before
  // the toggle event is dispatched, otherwise the event is dropped. Mirrors the
  // WebGL-recovery floating spec.
  await page.waitForFunction(
    (panelSelector) => Boolean(document.querySelector(panelSelector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
}

async function toggleFloatingPanel(page: Page, open: boolean): Promise<void> {
  await page.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName))
  }, TOGGLE_EVENT)
  await (open
    ? expect(page.locator(PANEL_SELECTOR)).toBeVisible()
    : expect(page.locator(PANEL_SELECTOR)).toBeHidden())
}

// Why: the floating tab is not the active worktree's tab, so the shared
// helpers/terminal.ts resolvers (keyed on activeWorktreeId) do not target it.
// Read the floating tab's pane PTY id directly, the same way the floating
// WebGL-recovery spec does.
async function waitForFloatingPanePtyId(page: Page): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const state = window.__store?.getState()
          const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
          const manager = tab ? window.__paneManagers?.get(tab.id) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container?.dataset?.ptyId ?? null
        }, FLOATING_WORKTREE_ID),
      {
        timeout: 15_000,
        message:
          'Floating terminal pane did not receive a PTY binding (selector_not_found / black pane?)'
      }
    )
    .not.toBeNull()
  const ptyId = await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
    const manager = tab ? window.__paneManagers?.get(tab.id) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.container?.dataset?.ptyId ?? null
  }, FLOATING_WORKTREE_ID)
  if (!ptyId) {
    throw new Error('Floating terminal pane has no PTY binding')
  }
  return ptyId
}

// Why: PTY liveness must be proven by real output, not just a bound id. Read the
// floating pane's serialized xterm buffer (the same SerializeAddon path
// helpers/terminal.ts uses) and wait for a marker the command echoes back.
async function waitForFloatingTerminalOutput(
  page: Page,
  expected: string,
  timeoutMs = 15_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const state = window.__store?.getState()
          const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
          const manager = tab ? window.__paneManagers?.get(tab.id) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.serializeAddon?.serialize?.() ?? ''
        }, FLOATING_WORKTREE_ID),
      {
        timeout: timeoutMs,
        message: `Floating terminal buffer never contained "${expected}" — PTY may be dead/black`
      }
    )
    .toContain(expected)
}

test.describe('floating workspace terminal on a remote runtime', () => {
  test('the repo-less floating-terminal sentinel resolves to a live PTY (no selector_not_found / black pane)', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    // The floating workspace is the synthetic, repo-less `global-floating-terminal`
    // session that has no entry in the worktree catalog. Opening it drives the
    // main process's resolveWorktreeSelector floating-sentinel branch the fix
    // changed: it must resolve (rooted at home) and spawn a PTY instead of
    // rejecting with selector_not_found and leaving a black pane.
    await enableFloatingWorkspace(orcaPage)
    await toggleFloatingPanel(orcaPage, true)

    // A bound PTY id is the first liveness signal — the synthetic floating
    // worktree must resolve instead of throwing selector_not_found.
    const ptyId = await waitForFloatingPanePtyId(orcaPage)

    // Definitive liveness: drive a marker through the PTY and prove it echoes
    // back into the floating pane's serialized buffer. A dead PTY (the black-pane
    // bug) never echoes. Hidden-window E2E mode keeps xterm DOM visibility false
    // (see helpers/terminal.ts), so the buffer — not CSS visibility — is the
    // user-observable oracle the rest of the terminal suite relies on.
    const marker = `ORCA_E2E_FLOATING_RESOLVE_${Date.now()}`
    await sendToTerminal(orcaPage, ptyId, `echo ${marker}\r`)
    await waitForFloatingTerminalOutput(orcaPage, marker)
  })

  // Why fixme: the true end-to-end variant pairs a separate desktop/web client
  // to a separate `orca serve` process over the network and creates the floating
  // terminal from the client. The headless harness launches a single local
  // Electron app (helpers/orca-app.ts) with no fixture to stand up a second
  // `orca serve` runtime or to pair to it, so the cross-process PTY-over-runtime
  // path cannot be driven here. Pointing `activeRuntimeEnvironmentId` at a
  // synthetic id is NOT a substitute — it routes the floating PTY to a
  // non-existent runtime and produces a dead pane for an unrelated reason, which
  // would assert a false negative. The server-side resolution the fix changes is
  // covered by the co-located unit test (src/main/runtime/orca-runtime.test.ts).
  // Unskip if a serve-pairing e2e fixture is added.
  test.fixme('a client paired to a separate orca serve creates a live floating terminal end-to-end', async () => {
    // Requires a serve-pairing fixture (second runtime process + pairing) —
    // see comment above.
  })
})
