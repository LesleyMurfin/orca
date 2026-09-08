import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  orcaCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('terminal process receives the Orca-managed Codex home', async ({ orcaPage }) => {
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `__ORCA_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, orcaCodexHome: process.env.ORCA_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(orcaPage, ptyId, command)

    // Why: the poll records each read so the final assertion can use the last
    // probe — an outer `let` assigned only inside the callback stays typed null.
    const probeReads: (CodexHomeProbe | null)[] = []
    await expect
      .poll(
        async () => {
          const probe = readCodexHomeProbe(await getTerminalContent(orcaPage), marker)
          probeReads.push(probe)
          return Boolean(
            probe?.codexHome &&
            probe.orcaCodexHome &&
            probe.codexHome === probe.orcaCodexHome &&
            /[\\/]codex-runtime-home[\\/]home$/.test(probe.codexHome)
          )
        },
        { timeout: 15_000, message: 'Terminal did not expose Orca-managed Codex home env' }
      )
      .toBe(true)

    const probe = probeReads.at(-1) ?? null
    expect(probe?.codexHome).toBe(probe?.orcaCodexHome)
  })
})
