import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dockerDir = join(repo, 'config/docker/orca-serve-systemd')
const docker =
  process.env.ORCA_DOCKER ??
  (existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker'
    : 'docker')
const dockerDirectory = dirname(docker)
const dockerEnv = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  ...(dockerDirectory !== '.'
    ? { PATH: `${dockerDirectory}${delimiter}${process.env.PATH ?? ''}` }
    : {})
}
const suffix = `${process.pid}-${Date.now()}`
const image = `orca-serve-systemd:${suffix}`
const container = `orca-serve-systemd-${suffix}`
const platform =
  process.env.ORCA_DOCKER_PLATFORM ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')
const temp = mkdtempSync(join(tmpdir(), 'orca-serve-systemd-'))

function runDocker(command, allowFailure = false) {
  const result = spawnSync(docker, command, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: dockerEnv
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`docker ${command[0]} failed with ${result.status}`)
  }
  return result
}

function generateUnitFile() {
  const generator = join(temp, 'generate-unit.mjs')
  writeFileSync(
    generator,
    `import { writeFileSync } from 'node:fs'
import { CORE_HANDLERS } from ${JSON.stringify(join(repo, 'src/cli/handlers/core.ts'))}
const chunks = []
const originalLog = console.log
console.log = (...args) => {
  chunks.push(args.map(String).join(' '))
}
await CORE_HANDLERS.serve({
  flags: new Map([
    ['generate-service', true],
    ['port', '6768'],
    ['pairing-address', '127.0.0.1']
  ]),
  client: null,
  cwd: ${JSON.stringify(repo)},
  json: false,
  rawArgs: []
})
console.log = originalLog
const unit = chunks.join('\\n').trim()
if (!unit.includes('KillMode=mixed')) {
  throw new Error('generate-service output missing KillMode=mixed')
}
if (!unit.includes('ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address 127.0.0.1')) {
  throw new Error('generate-service output missing expected ExecStart')
}
writeFileSync(process.argv[2], unit + '\\n')
`
  )
  const unitPath = join(temp, 'orca-serve.service')
  const result = spawnSync(process.execPath, ['--import', 'tsx', generator, unitPath], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: process.env
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`generate-service helper failed with ${result.status}`)
  }
  return unitPath
}

try {
  const unitPath = generateUnitFile()
  runDocker(['build', '--platform', platform, '-t', image, dockerDir])
  runDocker([
    'run',
    '--detach',
    '--name',
    container,
    '--platform',
    platform,
    '--privileged',
    '--cgroupns=host',
    '--security-opt',
    'label=disable',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '-e',
    'ORCA_BACKGROUND_LAUNCH=1',
    image
  ])
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const show = runDocker(
      ['exec', container, 'systemctl', 'show', '-p', 'SystemState', '--value'],
      true
    )
    if (['running', 'degraded', 'offline'].includes((show.stdout || '').trim())) {
      break
    }
    spawnSync('sleep', ['0.2'])
  }
  runDocker(['cp', unitPath, `${container}:/opt/orca-serve-systemd/orca-serve.service`])
  const result = runDocker(
    [
      'exec',
      container,
      'timeout',
      '--kill-after=5s',
      '90s',
      'node',
      '/opt/orca-serve-systemd/run-cases.cjs',
      '/opt/orca-serve-systemd/orca-serve.service'
    ],
    true
  )
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) {
    const status = runDocker(
      ['exec', container, 'systemctl', 'status', 'orca-serve.service', '--no-pager', '-l'],
      true
    )
    process.stdout.write(status.stdout ?? '')
    process.stderr.write(status.stderr ?? '')
    const journal = runDocker(
      ['exec', container, 'journalctl', '-u', 'orca-serve.service', '-n', '50', '--no-pager'],
      true
    )
    process.stdout.write(journal.stdout ?? '')
    process.stderr.write(journal.stderr ?? '')
    throw new Error(`orca-serve systemd KillMode=mixed oracle failed with ${result.status}`)
  }
  console.log(
    'Generated orca-serve.service loads under systemd and KillMode=mixed restart-cycle oracle passed.'
  )
} finally {
  runDocker(['rm', '--force', container], true)
  runDocker(['image', 'rm', '--force', image], true)
  rmSync(temp, { recursive: true, force: true })
}
