import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '..', '..')

const SYSTEM_SSOT = 'config/systemd/orca-serve.service'
const USER_SSOT = 'config/systemd/orca-serve.user.service'

// Keys that must stay aligned across the SSOT unit templates and every consumer copy.
const LOAD_BEARING_PREFIXES = [
  'Type=',
  'KillMode=',
  'RestartPreventExitStatus=',
  'KillSignal=',
  'TimeoutStopSec=',
  'WantedBy=',
  'Environment=XDG_RUNTIME_DIR=',
  'ExecStart='
]

const SYSTEM_CONSUMERS = [
  'docs/site/content/docs/remote-servers.mdx',
  'docs/site/public/docs/agent-setup/prompt.md',
  'skill-guides/orca-server.md',
  'skill-guides/orca-server/references/systemd-supervision.md'
]

const USER_CONSUMERS = ['docs/site/public/docs/agent-setup/prompt.md']

const SKILL_GUIDE_CONSUMERS = new Set([
  'skill-guides/orca-server.md',
  'skill-guides/orca-server/references/systemd-supervision.md'
])

const DOCKER_RUNNER = 'config/scripts/run-orca-serve-systemd-docker.mjs'

function read(relativePath) {
  return readFileSync(path.join(projectDir, relativePath), 'utf8')
}

function extractLoadBearingLines(unitText) {
  return unitText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => LOAD_BEARING_PREFIXES.some((prefix) => line.startsWith(prefix)))
}

/**
 * Skill guides may use `ORCA` in ExecStart as a path placeholder; everything else
 * must match the SSOT line-for-line for load-bearing keys.
 */
function normalizeConsumer(text, relativePath) {
  if (!SKILL_GUIDE_CONSUMERS.has(relativePath)) {
    return text
  }
  return text.replaceAll('ExecStart=ORCA ', 'ExecStart=/usr/bin/orca-ide ')
}

describe('orca-serve unit template sync', () => {
  const systemUnit = read(SYSTEM_SSOT)
  const userUnit = read(USER_SSOT)
  const systemLoadBearing = extractLoadBearingLines(systemUnit)
  const userLoadBearing = extractLoadBearingLines(userUnit)

  it('keeps load-bearing keys in the system SSOT unit', () => {
    expect(systemLoadBearing).toEqual(
      expect.arrayContaining([
        'Type=simple',
        'KillMode=mixed',
        'RestartPreventExitStatus=3 78',
        'KillSignal=SIGTERM',
        'TimeoutStopSec=45',
        'WantedBy=multi-user.target',
        'Environment=XDG_RUNTIME_DIR=/run/user/<uid>'
      ])
    )
  })

  it('keeps load-bearing keys in the user SSOT unit', () => {
    expect(userLoadBearing).toEqual(
      expect.arrayContaining([
        'Type=simple',
        'KillMode=mixed',
        'RestartPreventExitStatus=3 78',
        'KillSignal=SIGTERM',
        'TimeoutStopSec=45',
        'WantedBy=default.target'
      ])
    )
    expect(userLoadBearing.some((line) => line.startsWith('Environment=XDG_RUNTIME_DIR='))).toBe(
      false
    )
  })

  it.each(SYSTEM_CONSUMERS)('embeds system SSOT load-bearing lines in %s', (relativePath) => {
    const consumer = normalizeConsumer(read(relativePath), relativePath)
    for (const line of systemLoadBearing) {
      expect(consumer, `${relativePath} missing system load-bearing line: ${line}`).toContain(line)
    }
  })

  it.each(USER_CONSUMERS)('embeds user SSOT load-bearing lines in %s', (relativePath) => {
    const consumer = read(relativePath)
    for (const line of userLoadBearing) {
      expect(consumer, `${relativePath} missing user load-bearing line: ${line}`).toContain(line)
    }
  })

  it.each(SYSTEM_CONSUMERS)('embeds full system SSOT unit body in %s', (relativePath) => {
    const consumer = normalizeConsumer(read(relativePath), relativePath)
    expect(consumer, `${relativePath} missing full system SSOT unit`).toContain(systemUnit.trim())
  })

  it.each(USER_CONSUMERS)('embeds full user SSOT unit body in %s', (relativePath) => {
    const consumer = read(relativePath)
    expect(consumer, `${relativePath} missing full user SSOT unit`).toContain(userUnit.trim())
  })

  it('materializes the system SSOT from disk in the docker systemd runner', () => {
    const runner = read(DOCKER_RUNNER)
    expect(runner).toContain('config/systemd/orca-serve.service')
    expect(runner).toContain("replaceAll('<uid>', '1001')")
    expect(runner).toContain("replaceAll('<server-tailscale-ip-or-hostname>', '127.0.0.1')")
  })
})
