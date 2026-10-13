'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { execFileSync, spawnSync } = require('node:child_process')

const unitSource = process.argv[2] || '/opt/orca-serve-systemd/orca-serve.service'
const stateDir = process.env.ORCA_SERVE_FIXTURE_STATE || '/tmp/orca-serve-fixture'
const unitPath = '/etc/systemd/system/orca-serve.service'
const fixtureSource = '/opt/orca-serve-systemd/serve-fixture.cjs'
const fixtureBin = '/usr/bin/orca-ide'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sh(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    ...opts
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !opts.allowFailure) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${detail}`)
  }
  return result
}

function systemctl(...args) {
  return sh('systemctl', args)
}

function show(property) {
  return execFileSync(
    'systemctl',
    ['show', 'orca-serve.service', `--property=${property}`, '--value'],
    {
      encoding: 'utf8'
    }
  ).trim()
}

function live(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1).trim()[0] !== 'Z'
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function until(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  const suffix = lastError ? ` (${lastError.message})` : ''
  throw new Error(`${message}${suffix}`)
}

function readOptional(path) {
  try {
    return fs.readFileSync(path, 'utf8').trim()
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function installFixture() {
  const nodeBin = fs.existsSync('/usr/local/bin/node') ? '/usr/local/bin/node' : '/usr/bin/node'
  // Preserve systemd Environment= overrides for contrast units.
  const wrapper = `${[
    '#!/bin/sh',
    `ORCA_SERVE_FIXTURE_STATE="\${ORCA_SERVE_FIXTURE_STATE:-${stateDir}}"`,
    'export ORCA_SERVE_FIXTURE_STATE',
    `exec ${nodeBin} ${fixtureSource} "$@"`
  ].join('\n')}\n`
  fs.writeFileSync(fixtureBin, wrapper, { mode: 0o755 })
}

function installUnit() {
  const unit = fs.readFileSync(unitSource, 'utf8')
  assert.match(unit, /KillMode=mixed/, 'generated unit missing KillMode=mixed')
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/orca-ide serve/,
    'generated unit missing orca-ide ExecStart'
  )
  fs.writeFileSync(unitPath, unit)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.mkdirSync(stateDir, { recursive: true })
  // Match the unit's XDG_RUNTIME_DIR claim for the service user.
  fs.mkdirSync('/run/user/1001', { recursive: true })
  sh('chown', ['-R', 'orca:orca', '/run/user/1001', stateDir])
  systemctl('daemon-reload')
}

async function waitActive() {
  await until(() => show('ActiveState') === 'active', 'orca-serve.service did not become active')
}

async function waitGeneration(previous) {
  await until(() => {
    const generation = readOptional(`${stateDir}/generation`)
    const mainPid = Number(readOptional(`${stateDir}/main.pid`) || 0)
    const childPid = Number(readOptional(`${stateDir}/child.pid`) || 0)
    return Boolean(
      generation &&
      generation !== previous &&
      mainPid > 1 &&
      childPid > 1 &&
      live(mainPid) &&
      live(childPid)
    )
  }, 'fixture main/child did not publish a live generation')
  return {
    generation: readOptional(`${stateDir}/generation`),
    mainPid: Number(readOptional(`${stateDir}/main.pid`)),
    childPid: Number(readOptional(`${stateDir}/child.pid`))
  }
}

async function main() {
  installFixture()
  installUnit()

  // Prove systemd accepts the generated unit file.
  const cat = systemctl('cat', 'orca-serve.service')
  assert.match(cat.stdout, /KillMode=mixed/)
  assert.equal(show('LoadState'), 'loaded', `LoadState=${show('LoadState')}`)
  assert.equal(show('KillMode'), 'mixed', `KillMode=${show('KillMode')}`)

  const verify = sh('systemd-analyze', ['verify', unitPath], { allowFailure: true })
  const verifyText = `${verify.stdout || ''}${verify.stderr || ''}`
  // verify may warn about missing binaries before fixture install path resolution; fail only on hard errors about KillMode/unit syntax.
  if (verify.status !== 0 && /orca-serve\.service:\s*[^W].*error/i.test(verifyText)) {
    throw new Error(`systemd-analyze verify failed:\n${verifyText}`)
  }

  systemctl('start', 'orca-serve.service')
  await waitActive()
  const first = await waitGeneration(null)
  assert.equal(show('MainPID'), String(first.mainPid), 'MainPID must track fixture main')

  console.log(
    JSON.stringify({
      phase: 'started',
      loadState: show('LoadState'),
      activeState: show('ActiveState'),
      killMode: show('KillMode'),
      mainPid: first.mainPid,
      childPid: first.childPid,
      generation: first.generation
    })
  )

  systemctl('restart', 'orca-serve.service')
  await waitActive()
  const second = await waitGeneration(first.generation)

  await until(() => !live(first.mainPid), 'pre-restart main still alive after restart')
  await until(
    () => !live(first.childPid),
    'pre-restart child still alive after mixed cgroup cleanup'
  )

  const mainSignals = readOptional(`${stateDir}/main.signals`) || ''
  const childSignals = readOptional(`${stateDir}/child-${first.generation}.signals`) || ''

  assert.match(mainSignals, /SIGTERM/, 'main must receive SIGTERM under KillMode=mixed restart')
  assert.doesNotMatch(
    childSignals,
    /SIGTERM/,
    `child must not receive SIGTERM under KillMode=mixed (got: ${JSON.stringify(childSignals)})`
  )
  assert.notEqual(second.mainPid, first.mainPid, 'restart must spawn a new main PID')
  assert.notEqual(second.childPid, first.childPid, 'restart must spawn a new child PID')
  assert.equal(show('ActiveState'), 'active')
  assert.equal(show('KillMode'), 'mixed')
  assert.equal(show('MainPID'), String(second.mainPid))

  // Contrast: the same unit with KillMode=control-group must TERM the child.
  const controlUnit = fs
    .readFileSync(unitPath, 'utf8')
    .replace('KillMode=mixed', 'KillMode=control-group')
    .replace(
      'Description=Orca runtime server',
      'Description=Orca runtime server control-group contrast'
    )
  fs.writeFileSync('/etc/systemd/system/orca-serve-control.service', controlUnit)
  systemctl('daemon-reload')
  const controlState = '/tmp/orca-serve-control-fixture'
  fs.rmSync(controlState, { recursive: true, force: true })
  fs.mkdirSync(controlState, { recursive: true })
  sh('chown', ['-R', 'orca:orca', controlState])
  // Rewrite wrapper env for the contrast unit via drop-in.
  fs.mkdirSync('/etc/systemd/system/orca-serve-control.service.d', { recursive: true })
  fs.writeFileSync(
    '/etc/systemd/system/orca-serve-control.service.d/override.conf',
    `[Service]\nEnvironment=ORCA_SERVE_FIXTURE_STATE=${controlState}\n`
  )
  systemctl('daemon-reload')
  systemctl('start', 'orca-serve-control.service')
  await until(() => {
    return (
      execFileSync(
        'systemctl',
        ['show', 'orca-serve-control.service', '--property=ActiveState', '--value'],
        {
          encoding: 'utf8'
        }
      ).trim() === 'active'
    )
  }, 'control-group unit did not become active')
  await until(
    () => {
      const generation = readOptional(`${controlState}/generation`)
      const childPid = Number(readOptional(`${controlState}/child.pid`) || 0)
      return Boolean(generation && childPid > 1 && live(childPid))
    },
    `control-group fixture child did not start (state=${fs.readdirSync(controlState).join(',') || 'empty'}; active=${execFileSync('systemctl', ['show', 'orca-serve-control.service', '--property=ActiveState,MainPID,ExecMainStatus', '--no-pager'], { encoding: 'utf8' }).trim()})`
  )
  const controlGeneration = readOptional(`${controlState}/generation`)
  const controlChildPid = Number(readOptional(`${controlState}/child.pid`))
  systemctl('stop', 'orca-serve-control.service')
  await until(() => !live(controlChildPid), 'control-group child did not exit')
  const controlChildSignals =
    readOptional(`${controlState}/child-${controlGeneration}.signals`) || ''
  assert.match(
    controlChildSignals,
    /SIGTERM/,
    `control-group contrast must TERM the child (got: ${JSON.stringify(controlChildSignals)})`
  )

  console.log(
    JSON.stringify({
      phase: 'restart-cycle',
      killMode: 'mixed',
      mainReceivedTerm: true,
      childReceivedTerm: false,
      oldMainAlive: live(first.mainPid),
      oldChildAlive: live(first.childPid),
      newMainPid: second.mainPid,
      newChildPid: second.childPid,
      activeState: show('ActiveState'),
      controlGroupChildReceivedTerm: true
    })
  )
  console.log('orca-serve systemd KillMode=mixed restart-cycle oracle passed')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  try {
    process.stderr.write(systemctl('status', 'orca-serve.service', '--no-pager', '-l').stdout || '')
  } catch {}
  process.exitCode = 1
})
