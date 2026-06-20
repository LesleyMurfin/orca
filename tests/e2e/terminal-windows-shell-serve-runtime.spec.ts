/**
 * E2E coverage for Bug A: a Windows desktop client paired to a non-Windows
 * (Linux `orca serve`) runtime must NOT offer the local Windows shell submenu
 * (PowerShell / CMD Prompt / WSL). Those choices are meaningless on a Linux
 * serve host; the plain "New Terminal" already opens the runtime's default
 * shell (bash). Fix lives in src/renderer/src/components/tab-bar/TabBar.tsx
 * (`runtimeHostIsNonWindows`), co-located unit coverage in
 * src/renderer/src/components/tab-bar/TabBar.windows-shell-launch.test.ts.
 *
 * Why these assertions target the DOM (per tests/e2e/AGENTS.md): the bug is a
 * render-layer one — the menu either renders the Windows shell rows or it does
 * not. We open the real "+" / Ctrl+T dropdown and assert on the menu items the
 * user actually sees, mirroring tabs.spec.ts's `getByRole('menuitem', …)`.
 *
 * Harness fit: this headless suite launches a local Electron app whose main
 * process reports `hostPlatform` from `process.platform`. On the Linux CI /
 * dev host that is `'linux'` (non-win32), which is exactly the serve-host
 * platform the fix keys on — so setting `activeRuntimeEnvironmentId` makes the
 * renderer treat the active worktree as runtime-owned and probe a non-Windows
 * host, reproducing the real serve-paired scenario without a real serve.
 *
 * The win32 regression branch (#5519: a LOCAL Windows-WSL project runtime,
 * hostPlatform === 'win32', keeps its shell menu) cannot be exercised here: it
 * needs `runtime.getStatus()` to return 'win32', i.e. a real Windows main
 * process. That case is covered by the co-located unit test (the sibling cases
 * that mock `hostPlatform: 'win32'`) and is left as `test.fixme` below with the
 * exact missing harness capability documented.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const SERVE_RUNTIME_ENVIRONMENT_ID = 'serve-env-e2e'

// Why: mirrors how onboarding.spec.ts (line 417) marks the session as
// runtime-owned. getRuntimeEnvironmentIdForWorktree() falls back to
// settings.activeRuntimeEnvironmentId when the active worktree has no explicit
// execution-host owner, which is the lever that makes the TabBar probe the
// runtime host instead of the local desktop platform.
async function markActiveWorktreeAsServeRuntime(page: Page): Promise<void> {
  await page.evaluate(async (environmentId) => {
    await window.__store?.getState().updateSettings({
      activeRuntimeEnvironmentId: environmentId
    })
  }, SERVE_RUNTIME_ENVIRONMENT_ID)
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__store?.getState().settings?.activeRuntimeEnvironmentId),
      { timeout: 5_000, message: 'activeRuntimeEnvironmentId did not persist' }
    )
    .toBe(SERVE_RUNTIME_ENVIRONMENT_ID)
}

// Why: the probed runtime host platform must settle to a non-win32 value before
// the suppression assertion is meaningful — `runtimeHostIsNonWindows` gates on
// `!windowsTerminalCapabilities.isLoading`. The local main process reports
// process.platform; assert it is non-win32 so the spec self-documents the host
// it actually exercised.
async function getHostPlatform(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const status = await window.api.runtime.getStatus()
    return status.hostPlatform ?? 'unknown'
  })
}

async function openNewTabMenu(page: Page): Promise<void> {
  // Why: hidden-window Electron can keep the animated terminal surface
  // invalidating Playwright's actionability check; tabs.spec.ts uses the same
  // force-click to open the "+" dropdown reliably.
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
}

test.describe('Windows shell menu suppression on a non-Windows serve runtime', () => {
  test('the "+" menu hides PowerShell/CMD/WSL and keeps a working "New Terminal" on a Linux serve runtime', async ({
    orcaPage
  }) => {
    // Why: the fix keys on the probed runtime host being non-Windows. This
    // headless host must itself be non-win32 for the local capabilities probe
    // to stand in for a Linux serve host. A Windows runner would instead need a
    // real Linux serve to pair to (see the fixme below), so skip there.
    test.skip(
      process.platform === 'win32',
      'serve-host suppression needs a non-Windows local host to stand in for the Linux serve runtime'
    )

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    const hostPlatform = await getHostPlatform(orcaPage)
    expect(hostPlatform, 'local main process should report a non-win32 host').not.toBe('win32')

    await markActiveWorktreeAsServeRuntime(orcaPage)

    await openNewTabMenu(orcaPage)

    // The plain "New Terminal" entry must remain — it opens the serve's default
    // (bash) shell. Matched exactly so it is not confused with "New Terminal: …".
    const plainNewTerminal = orcaPage.getByRole('menuitem', { name: 'New Terminal' })
    await expect(plainNewTerminal).toBeVisible()

    // The local Windows shell rows must NOT be offered on a non-Windows runtime.
    await expect(orcaPage.getByRole('menuitem', { name: /New Terminal: PowerShell/i })).toHaveCount(
      0
    )
    await expect(orcaPage.getByRole('menuitem', { name: /New Terminal: CMD Prompt/i })).toHaveCount(
      0
    )
    await expect(orcaPage.getByRole('menuitem', { name: /New Terminal: WSL/i })).toHaveCount(0)
    await expect(orcaPage.getByRole('menuitem', { name: /New Terminal: Git Bash/i })).toHaveCount(0)
  })

  test('plain "New Terminal" on a Linux serve runtime opens a working bash PTY', async ({
    orcaPage
  }) => {
    test.skip(
      process.platform === 'win32',
      'serve-host suppression needs a non-Windows local host to stand in for the Linux serve runtime'
    )

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    const hostPlatform = await getHostPlatform(orcaPage)
    expect(hostPlatform).not.toBe('win32')

    await markActiveWorktreeAsServeRuntime(orcaPage)

    const tabsBefore = await orcaPage.locator('[data-testid="sortable-tab"]').count()

    await openNewTabMenu(orcaPage)
    const plainNewTerminal = orcaPage.getByRole('menuitem', { name: 'New Terminal' })
    await expect(plainNewTerminal).toBeVisible()
    await plainNewTerminal.click({ force: true })
    await expect(plainNewTerminal).toBeHidden({ timeout: 3_000 })

    // A new terminal tab must actually render — the suppression must not have
    // broken the default-shell path the fix relies on as the fallback.
    await expect
      .poll(() => orcaPage.locator('[data-testid="sortable-tab"]').count(), {
        timeout: 5_000,
        message: 'plain "New Terminal" on a serve runtime did not render a new tab'
      })
      .toBeGreaterThan(tabsBefore)

    // The newly created tab must be a working bash PTY. Hidden-window E2E mode
    // keeps xterm DOM visibility signals false (see helpers/terminal.ts), so the
    // suite proves PTY liveness via the pane manager's bound PTY + real echoed
    // output rather than CSS visibility — the same pattern as the paste-ownership
    // specs. Live output into the rendered buffer is the user-observable proof.
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `ORCA_E2E_SERVE_BASH_${Date.now()}`
    await sendToTerminal(orcaPage, ptyId, `echo ${marker}\r`)
    await waitForTerminalOutput(orcaPage, marker, 15_000)
  })

  // Why fixme: the #5519 regression guard — a LOCAL Windows-WSL project runtime
  // (hostPlatform === 'win32') must KEEP its shell menu — needs the Electron
  // main process to report `process.platform === 'win32'`. The headless harness
  // launches one local Electron app and reads `process.platform`; there is no
  // fixture to spawn a win32 main process or to inject a synthetic
  // `runtime.getStatus()` host platform from the renderer. This branch is fully
  // covered by the co-located unit test
  // (src/renderer/src/components/tab-bar/TabBar.windows-shell-launch.test.ts —
  // "shows only the WSL terminal row for local WSL-runtime projects" and the
  // "uses the active remote host platform …" cases that mock hostPlatform:
  // 'win32'). Unskip this if/when a win32 e2e runner or a getStatus host-platform
  // override fixture exists.
  test.fixme('a local Windows-WSL project runtime (hostPlatform win32) keeps its shell menu', async () => {
    // Requires a win32 Electron main process (or an injectable
    // runtime.getStatus host platform) — see comment above.
  })
})
