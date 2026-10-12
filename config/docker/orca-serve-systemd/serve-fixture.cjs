'use strict'

const fs = require('node:fs')
const { spawn } = require('node:child_process')

const stateDir = process.env.ORCA_SERVE_FIXTURE_STATE || '/tmp/orca-serve-fixture'
const role = process.argv[2] === 'child' ? 'child' : 'main'

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true })
}

function append(path, line) {
  fs.appendFileSync(path, `${line}\n`)
}

if (role === 'child') {
  ensureStateDir()
  const generation = process.argv[3] || 'unknown'
  const signalLog = `${stateDir}/child-${generation}.signals`
  fs.writeFileSync(`${stateDir}/child.pid`, String(process.pid))
  fs.writeFileSync(`${stateDir}/child.generation`, generation)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      append(signalLog, signal)
      // Stay alive on TERM so KillMode=control-group leaves a TERM record
      // while mixed only SIGKILLs after the main process exits.
    })
  }
  setInterval(() => {}, 60_000)
} else {
  // Installed as /usr/bin/orca-ide: argv looks like [node, script, 'serve', ...]
  const serveIndex = process.argv.findIndex((arg) => arg === 'serve')
  if (serveIndex < 0) {
    process.stderr.write('serve-fixture: expected serve argv\n')
    process.exit(78)
  }

  ensureStateDir()
  const generation = `${Date.now()}-${process.pid}`
  fs.writeFileSync(`${stateDir}/main.pid`, String(process.pid))
  fs.writeFileSync(`${stateDir}/generation`, generation)
  fs.writeFileSync(`${stateDir}/main.argv`, process.argv.slice(serveIndex).join(' '))

  spawn(process.execPath, [__filename, 'child', generation], {
    stdio: 'ignore',
    detached: false,
    env: process.env
  })

  process.on('SIGTERM', () => {
    append(`${stateDir}/main.signals`, 'SIGTERM')
    // Graceful stop leaves the child alone — matching serve's daemon retention intent.
    process.exit(0)
  })

  setInterval(() => {}, 60_000)
}
