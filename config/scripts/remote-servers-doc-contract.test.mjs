import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
const docPath = path.join(projectDir, 'docs', 'site', 'content', 'docs', 'remote-servers.mdx')

// Why: the supervision guidance is the part operators copy verbatim. A silent edit that drops a
// directive leaves a unit that crash-loops or kills every agent child. Assertions run against the
// fenced unit block alone — a whole-file substring search passes on the surrounding prose that
// merely names the same directive, which is no proof the copyable unit still carries it.
function unitBlock(content) {
  const block = content
    .split(/^```/m)
    .find((section) => section.startsWith('ini') && section.includes('[Service]'))
  if (!block) {
    throw new Error('remote-servers.mdx no longer contains an ```ini systemd unit block')
  }
  return block
}

describe('remote servers doc', () => {
  it('documents the supervised systemd unit and its load-bearing directives', async () => {
    const unit = unitBlock(await readFile(docPath, 'utf8'))

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

    expect(content).toContain('systemd-run --user --scope')
    expect(content).toContain('sudo loginctl enable-linger orca')
    expect(content).toContain('orca skills install --skill orca-server')
  })
})
