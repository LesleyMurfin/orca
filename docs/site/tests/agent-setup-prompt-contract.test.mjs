import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const siteRoot = path.resolve(import.meta.dirname, '..')
const promptPath = path.join(siteRoot, 'public', 'docs', 'agent-setup', 'prompt.md')
const buttonPath = path.join(siteRoot, 'src', 'components', 'docs', 'CopyPromptButton.tsx')
const remoteServersPath = path.join(siteRoot, 'content', 'docs', 'remote-servers.mdx')
const waysToRunPath = path.join(siteRoot, 'content', 'docs', 'ways-to-run.mdx')

// Why: the setup prompt is the part operators hand to an agent verbatim. A silent edit that drops
// a directive leaves a unit that crash-loops or kills every agent child. Assertions run against
// the fenced unit block alone — a whole-file substring search passes on the surrounding prose that
// merely names the same directive, which is no proof the copyable unit still carries it.
// Fences are matched at any indentation because the setup prompt nests one unit inside a list.
function unitBlocks(content) {
  const blocks = []
  const fence = /^([ \t]*)```ini[ \t]*\n([\s\S]*?)^\1```[ \t]*$/gm
  for (const match of content.matchAll(fence)) {
    const indent = match[1]
    const body = match[2]
      .split('\n')
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join('\n')
    if (body.includes('[Service]')) {
      blocks.push(body)
    }
  }
  return blocks
}

// Service-critical directives: the ones whose value decides whether a restart loop, a killed agent
// tree, or a truncated shutdown happens. Every copy of a unit kind must agree on all of them.
const SERVICE_CRITICAL_DIRECTIVES = [
  'Description',
  'Type',
  'ExecStart',
  'Restart',
  'RestartSec',
  'RestartPreventExitStatus',
  'KillMode',
  'KillSignal',
  'TimeoutStopSec',
  'StartLimitIntervalSec',
  'StartLimitBurst',
  'Environment',
  'WorkingDirectory',
  'User',
  'Group'
]

// Directives shared across unit kinds: a user-level unit has no User=/Group= and a different
// Description=, but its failure handling must not drift from the system unit's.
const CROSS_KIND_DIRECTIVES = [
  'Type',
  'Restart',
  'RestartSec',
  'RestartPreventExitStatus',
  'KillMode',
  'KillSignal',
  'TimeoutStopSec',
  'StartLimitIntervalSec',
  'StartLimitBurst'
]

// Why pinned literals rather than a cross-file comparison: the same system unit also ships in
// skill-guides/orca-server.md, skill-guides/orca-server/references/systemd-supervision.md, and
// docs/site/content/docs/remote-servers.mdx, which live outside this package's test scope.
// Those copies pin the identical list in config/scripts/remote-servers-doc-contract.test.mjs, so
// a directive that drifts on either side fails on that side instead of going unnoticed.
const SYSTEM_UNIT_DIRECTIVES = [
  'Description=Orca runtime server',
  'Environment=HOME=/home/orca',
  'Environment=XDG_RUNTIME_DIR=/run/user/1001',
  'ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address <server-tailscale-ip-or-hostname>',
  'Group=orca',
  'KillMode=mixed',
  'KillSignal=SIGTERM',
  'Restart=on-failure',
  'RestartPreventExitStatus=3 78',
  'RestartSec=5',
  'StartLimitBurst=5',
  'StartLimitIntervalSec=300',
  'TimeoutStopSec=45',
  'Type=simple',
  'User=orca',
  'WorkingDirectory=/home/orca'
]

function criticalDirectives(block, keys = SERVICE_CRITICAL_DIRECTIVES) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .filter((line) => keys.includes(line.split('=', 1)[0]))
    .sort()
}

async function promptUnitBlocks() {
  const blocks = unitBlocks(await readFile(promptPath, 'utf8'))
  assert.ok(blocks[0], 'agent-setup/prompt.md no longer contains the Path D system-level unit')
  assert.ok(blocks[1], 'agent-setup/prompt.md no longer contains the Path D2 user-level unit')
  return blocks
}

test('the Path D system unit keeps every service-critical directive', async () => {
  const [systemBlock] = await promptUnitBlocks()

  assert.deepEqual(criticalDirectives(systemBlock), SYSTEM_UNIT_DIRECTIVES)
})

test('the Path D2 user unit stays aligned with the Path D system unit', async () => {
  const [systemBlock, userBlock] = await promptUnitBlocks()

  assert.deepEqual(
    criticalDirectives(userBlock, CROSS_KIND_DIRECTIVES),
    criticalDirectives(systemBlock, CROSS_KIND_DIRECTIVES)
  )
  assert.match(userBlock, /\nDescription=Orca runtime server \(user\)\n/)
  assert.match(userBlock, /\nWantedBy=default\.target\n/)
})

// Why: the copy-prompt string the docs tell readers to paste ships in a React constant and in two
// quoted code blocks. A reworded component with stale quoted copies hands readers a prompt the
// product no longer makes. Parity is asserted between the copies, not against a pinned sentence,
// so the wording stays free to change in one commit across all three.

// The quoted copy is the ```text fence that follows the <CopyPromptButton /> placement.
function extractQuotedCopyPrompt(content) {
  return /<CopyPromptButton\s*\/>[\s\S]*?```text\n([\s\S]*?)\n```/.exec(content)?.[1]?.trim()
}

const copyPromptSources = [
  {
    label: 'CopyPromptButton.tsx DEFAULT_PROMPT',
    file: buttonPath,
    extract: (content) => /const DEFAULT_PROMPT =\s*'([^']+)'/.exec(content)?.[1]
  },
  {
    label: 'remote-servers.mdx quoted prompt',
    file: remoteServersPath,
    extract: extractQuotedCopyPrompt
  },
  {
    label: 'ways-to-run.mdx quoted prompt',
    file: waysToRunPath,
    extract: extractQuotedCopyPrompt
  }
]

test('the copy-prompt button and its quoted copies stay byte-identical', async () => {
  const copies = await Promise.all(
    copyPromptSources.map(async ({ label, file, extract }) => ({
      label,
      text: extract(await readFile(file, 'utf8'))
    }))
  )

  for (const copy of copies) {
    assert.ok(copy.text, `${copy.label} prompt not found`)
  }

  const [reference, ...rest] = copies
  for (const copy of rest) {
    assert.equal(copy.text, reference.text, `${copy.label} vs ${reference.label}`)
  }
})

// Why: the prompt tells the agent to resolve the binary itself. A hardcoded /usr/bin/orca-ide in
// the instruction text sends AppImage hosts — where the binary is ~/.local/bin/orca-ide — into a
// unit that cannot start, and a bare `orca` on Linux is the GNOME Orca screen reader.
test('the prompt tells the agent to resolve the orca-ide path instead of hardcoding it', async () => {
  const content = await readFile(promptPath, 'utf8')

  assert.match(content, /readlink -f "\$\(command -v orca-ide\)"/)
})
