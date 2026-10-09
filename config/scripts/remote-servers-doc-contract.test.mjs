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
const triagePath = path.join(
  projectDir,
  'skill-guides',
  'orca-server',
  'references',
  'server-triage.md'
)

// Why: the supervision guidance is the part operators copy verbatim. A silent edit that drops a
// directive leaves a unit that crash-loops or kills every agent child. Assertions run against the
// fenced unit block alone — a whole-file substring search passes on the surrounding prose that
// merely names the same directive, which is no proof the copyable unit still carries it.
// Fences are matched at any indentation.
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

// Why pinned literals rather than equality alone: the same system unit also ships in
// docs/site/public/docs/agent-setup/prompt.md, which lives in its own change. That copy pins the
// identical list in docs/site/tests/agent-setup-prompt-contract.test.mjs, so a directive that
// drifts on either side fails on that side instead of going unnoticed.
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

// Why: the same unit ships in several normative places. Readers copy whichever they reach first,
// so a directive that drifts in one copy is a production defect in whichever page the operator
// trusted.
describe('systemd unit parity across normative copies', () => {
  const systemUnitSources = [
    { label: 'remote-servers.mdx', file: docPath },
    { label: 'skill-guides/orca-server.md', file: skillGuidePath },
    { label: 'references/systemd-supervision.md', file: supervisionPath }
  ]

  it('keeps every system-level copy identical in its service-critical directives', async () => {
    const copies = await readUnitCopies(systemUnitSources)
    const [reference, ...rest] = copies

    expect(reference.directives).toEqual(SYSTEM_UNIT_DIRECTIVES)

    for (const copy of rest) {
      expect(copy.directives, `${copy.label} vs ${reference.label}`).toEqual(reference.directives)
    }
  })
})

// Why: the operator resolves the binary instead of trusting a hardcoded path. A deb/rpm install
// symlinks /usr/bin/orca-ide, an AppImage registers ~/.local/bin/orca-ide, and a bare `orca` on
// Linux is the GNOME Orca screen reader, so a pinned path sends AppImage hosts into a unit that
// cannot start.
describe('binary path resolution guidance', () => {
  it('tells the reader to resolve orca-ide rather than assume /usr/bin', async () => {
    for (const file of [supervisionPath, triagePath]) {
      const content = await readFile(file, 'utf8')
      expect(content, file).toMatch(/readlink -f "\$\(command -v orca-ide\)"/)
    }
  })
})
