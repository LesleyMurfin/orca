import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
const docPath = path.join(projectDir, 'docs', 'site', 'content', 'docs', 'remote-servers.mdx')
const skillGuidePath = path.join(projectDir, 'skill-guides', 'orca-server.md')
const supervisionPath = path.join(
  projectDir,
  'skill-guides',
  'orca-server',
  'references',
  'systemd-supervision.md'
)
const setupPromptPath = path.join(
  projectDir,
  'docs',
  'site',
  'public',
  'docs',
  'agent-setup',
  'prompt.md'
)

// Why: the supervision guidance is the part operators copy verbatim. A silent edit that drops a
// directive leaves a unit that crash-loops or kills every agent child. Assertions run against the
// fenced unit block alone — a whole-file substring search passes on the surrounding prose that
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

function unitBlock(content, label) {
  const [block] = unitBlocks(content)
  if (!block) {
    throw new Error(`${label} no longer contains an \`\`\`ini systemd unit block`)
  }
  return `\n${block}`
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

function criticalDirectives(block, keys = SERVICE_CRITICAL_DIRECTIVES) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .filter((line) => keys.includes(line.split('=', 1)[0]))
    .sort()
}

async function readUnitCopies(sources) {
  return await Promise.all(
    sources.map(async ({ label, file, index = 0 }) => {
      const blocks = unitBlocks(await readFile(file, 'utf8'))
      const block = blocks[index]
      if (!block) {
        throw new Error(`${label} no longer contains systemd unit block #${index + 1}`)
      }
      return { label, directives: criticalDirectives(block) }
    })
  )
}

describe('remote servers doc', () => {
  it('documents the supervised systemd unit and its load-bearing directives', async () => {
    const unit = unitBlock(await readFile(docPath, 'utf8'), 'remote-servers.mdx')

    for (const directive of [
      '# /etc/systemd/system/orca-serve.service',
      'Type=simple',
      'KillMode=mixed',
      'RestartPreventExitStatus=3 78',
      'ExecStart=/usr/bin/orca-ide serve'
    ]) {
      expect(unit, directive).toContain(`\n${directive}`)
    }
  })

  it('keeps the terminal-survival recipe and the server skill cross-link', async () => {
    const content = await readFile(docPath, 'utf8')

    // The daemon's own scope is legitimately named in prose; the operator-copyable job recipe is
    // not a scope. A whole-file `toContain('systemd-run --user --scope')` passes on that prose and
    // so pinned the stale `--scope -- tmux new-session` recipe, which silently runs the job in
    // whichever cgroup an already-running tmux server lives in.
    expect(content).toContain('`systemd-run --user --scope` as an `orca-daemon-<nonce>.scope` unit')

    const bashBlocks = [...content.matchAll(/^[ \t]*```bash[ \t]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)]
      .map((match) => match[1])
    const jobBlock = bashBlocks.find((block) => block.includes('orca-build-1'))
    expect(jobBlock, 'remote-servers.mdx no longer documents an orca-build-1 job recipe').toBeDefined()
    expect(jobBlock).toContain(
      'systemd-run --user --unit=orca-build-1 --collect --same-dir --property=TimeoutStopSec=5s -- pnpm build'
    )

    // tmux must get its own server, or the client request is answered by a tmux server already
    // running in another cgroup and the job never lands in the unit.
    const tmuxBlock = bashBlocks.find((block) => block.includes('tmux'))
    expect(tmuxBlock, 'remote-servers.mdx no longer documents a tmux recipe').toBeDefined()
    expect(tmuxBlock).toContain(
      "systemd-run --user --scope --unit=orca-build-1 -- tmux -L orca-build-1 new-session -d -s build 'pnpm build'"
    )
    expect(tmuxBlock).toContain('tmux -L orca-build-1 attach -t build')

    // Regression guard: the stale recipe must not come back anywhere in the file, in any block.
    expect(content).not.toMatch(/--scope[^\n]*--\s+tmux\s+new-session/)
    expect(content).not.toMatch(/^\s*tmux attach\b/m)

    expect(content).toContain('sudo loginctl enable-linger orca')
    expect(content).toContain('orca skills install --skill orca-server')
  })
})

// Why: the same unit ships in four normative places. Readers copy whichever they reach first, so a
// directive that drifts in one copy is a production defect in whichever page the operator trusted.
describe('systemd unit parity across normative copies', () => {
  const systemUnitSources = [
    { label: 'remote-servers.mdx', file: docPath },
    { label: 'skill-guides/orca-server.md', file: skillGuidePath },
    { label: 'references/systemd-supervision.md', file: supervisionPath },
    { label: 'agent-setup/prompt.md Path D', file: setupPromptPath, index: 0 }
  ]

  it('keeps every system-level copy identical in its service-critical directives', async () => {
    const copies = await readUnitCopies(systemUnitSources)
    const [reference, ...rest] = copies

    expect(reference.directives).toContain('Description=Orca runtime server')
    expect(reference.directives).toContain('TimeoutStopSec=45')
    expect(reference.directives).toContain('RestartPreventExitStatus=3 78')

    for (const copy of rest) {
      expect(copy.directives, `${copy.label} vs ${reference.label}`).toEqual(reference.directives)
    }
  })

  it('keeps the user-level copy aligned with the system unit on shared directives', async () => {
    const systemBlocks = unitBlocks(await readFile(supervisionPath, 'utf8'))
    const promptBlocks = unitBlocks(await readFile(setupPromptPath, 'utf8'))
    const userBlock = promptBlocks[1]
    if (!userBlock) {
      throw new Error('agent-setup/prompt.md no longer contains the Path D2 user-level unit')
    }

    expect(criticalDirectives(userBlock, CROSS_KIND_DIRECTIVES)).toEqual(
      criticalDirectives(systemBlocks[0], CROSS_KIND_DIRECTIVES)
    )
    expect(userBlock).toContain('Description=Orca runtime server (user)')
    expect(userBlock).toContain('WantedBy=default.target')
  })
})

// Why: the copy-prompt string the docs tell readers to paste ships in a React constant and in two
// quoted code blocks. A reworded component with stale quoted copies hands readers a prompt the
// product no longer makes. Parity is asserted between the copies, not against a pinned sentence,
// so the wording stays free to change in one commit across all three.
const copyPromptSources = [
  {
    label: 'CopyPromptButton.tsx DEFAULT_PROMPT',
    file: path.join(projectDir, 'docs', 'site', 'src', 'components', 'docs', 'CopyPromptButton.tsx'),
    extract: (content) => /const DEFAULT_PROMPT =\s*'([^']+)'/.exec(content)?.[1]
  },
  {
    label: 'remote-servers.mdx quoted prompt',
    file: docPath,
    extract: extractQuotedCopyPrompt
  },
  {
    label: 'ways-to-run.mdx quoted prompt',
    file: path.join(projectDir, 'docs', 'site', 'content', 'docs', 'ways-to-run.mdx'),
    extract: extractQuotedCopyPrompt
  }
]

// The quoted copy is the ```text fence that follows the <CopyPromptButton /> placement.
function extractQuotedCopyPrompt(content) {
  return /<CopyPromptButton\s*\/>[\s\S]*?```text\n([\s\S]*?)\n```/.exec(content)?.[1]?.trim()
}

describe('copy-prompt parity across the button and its quoted copies', () => {
  it('keeps all three copies byte-identical', async () => {
    const copies = await Promise.all(
      copyPromptSources.map(async ({ label, file, extract }) => ({
        label,
        text: extract(await readFile(file, 'utf8'))
      }))
    )

    for (const copy of copies) {
      expect(copy.text, `${copy.label} prompt not found`).toBeTruthy()
    }

    const [reference, ...rest] = copies
    for (const copy of rest) {
      expect(copy.text, `${copy.label} vs ${reference.label}`).toBe(reference.text)
    }
  })
})
