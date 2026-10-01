import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { waitForSentinel } from './ssh-relay-deploy-helpers'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshTarget } from '../../shared/ssh-types'
import { relayArtifactFilenames } from '../../shared/relay-artifacts'

const RELAY_VERSION = '0.1.0+dualchannel'

function makeTarget(id = randomUUID()): SshTarget {
  return {
    id: `dual-chan-target-${id}`,
    label: 'Dual Channel System Target',
    configHost: 'dual-chan-host',
    host: 'ignored.example.com',
    port: 22,
    username: ''
  }
}

function writeFakeSsh(dir: string): string {
  const path = join(dir, 'fake-ssh')
  writeFileSync(
    path,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-J|-S) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
if [ "$#" -gt 0 ]; then
  shift
fi
cmd="$1"
if [ -z "$cmd" ]; then
  exit 0
fi
exec /bin/sh -c "$cmd"
`
  )
  chmodSync(path, 0o755)
  return path
}

function writeFakeRelay(dir: string): void {
  for (const filename of relayArtifactFilenames(false)) {
    if (filename !== 'relay.js') {
      writeFileSync(join(dir, filename), '')
    }
  }
  writeFileSync(
    join(dir, 'relay.js'),
    `
const fs = require('fs');
const net = require('net');
const sentinel = 'ORCA-RELAY v0.1.0 READY\\n';
const sockPath = process.argv[process.argv.indexOf('--sock-path') + 1];

function encode(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(13);
  header[0] = 1;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(0, 5);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

function serve(socket, onResolved) {
  socket.on('error', () => {});
  socket.write(sentinel);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 13) {
      const type = buffer[0];
      const length = buffer.readUInt32BE(9);
      if (buffer.length < 13 + length) return;
      const payload = buffer.subarray(13, 13 + length);
      buffer = buffer.subarray(13 + length);
      if (type !== 1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      if (message.method === 'session.resolveHome') {
        socket.write(
          encode({ jsonrpc: '2.0', id: message.id, result: process.env.HOME }),
          onResolved
        );
      } else if (message.method === 'pty.spawn') {
        socket.write(
          encode({ jsonrpc: '2.0', id: message.id, result: { id: 'pty-dual-1', cols: 80, rows: 24 } })
        );
      } else if (message.method === 'fs.listFiles') {
        socket.write(
          encode({ jsonrpc: '2.0', id: message.id, result: { files: ['src/index.ts', 'package.json'] } })
        );
      } else if (message.method === 'fs.heavyScan') {
        const largeData = 'A'.repeat(512 * 1024);
        socket.write(
          encode({ jsonrpc: '2.0', id: message.id, result: { data: largeData } })
        );
      }
    }
  });
}

if (process.argv.includes('--detached')) {
  try { fs.unlinkSync(sockPath); } catch {}
  const server = net.createServer((socket) => {
    serve(socket);
  });
  server.listen(sockPath);
} else if (process.argv.includes('--connect')) {
  const socket = net.createConnection(sockPath);
  socket.on('error', (error) => {
    process.stderr.write(error.message);
    process.exit(1);
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}
`
  )
}

function createRelayTree(root: string, remoteHome: string): void {
  const platforms = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64'
  ]
  for (const platform of platforms) {
    const localDir = join(root, platform)
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, '.version'), RELAY_VERSION)
    writeFakeRelay(localDir)
  }

  const remoteDir = join(remoteHome, '.orca-remote', `relay-${RELAY_VERSION}`)
  mkdirSync(join(remoteDir, 'node_modules', 'node-pty', 'lib'), { recursive: true })
  mkdirSync(join(remoteDir, 'node_modules', '@parcel', 'watcher'), { recursive: true })
  writeFileSync(join(remoteDir, 'node_modules', 'node-pty', 'index.js'), '')
  writeFileSync(
    join(remoteDir, 'node_modules', 'node-pty', 'lib', 'utils.js'),
    'exports.loadNativeModule = () => ({})\n'
  )
  writeFileSync(join(remoteDir, 'node_modules', '@parcel', 'watcher', 'index.js'), '')
  writeFileSync(join(remoteDir, '.install-complete'), '')
  writeFakeRelay(remoteDir)
}

describe('dual-channel system SSH transport end-to-end integration', () => {
  let tempDir: string
  let oldHome: string | undefined
  let oldRelayPath: string | undefined
  let oldSystemSshPath: string | undefined
  let oldForceSystemTransport: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join('/tmp', 'orca-ssh-dual-chan-e2e-'))
    oldHome = process.env.HOME
    oldRelayPath = process.env.ORCA_RELAY_PATH
    oldSystemSshPath = process.env.ORCA_SYSTEM_SSH_PATH
    oldForceSystemTransport = process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT

    const remoteHome = join(tempDir, 'remote-home')
    const relayRoot = join(tempDir, 'relay')
    mkdirSync(remoteHome, { recursive: true })
    createRelayTree(relayRoot, remoteHome)

    process.env.HOME = remoteHome
    process.env.ORCA_RELAY_PATH = relayRoot
    process.env.ORCA_SYSTEM_SSH_PATH = writeFakeSsh(tempDir)
    process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT = '1'
  })

  afterEach(() => {
    if (oldHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = oldHome
    }
    if (oldRelayPath === undefined) {
      delete process.env.ORCA_RELAY_PATH
    } else {
      process.env.ORCA_RELAY_PATH = oldRelayPath
    }
    if (oldSystemSshPath === undefined) {
      delete process.env.ORCA_SYSTEM_SSH_PATH
    } else {
      process.env.ORCA_SYSTEM_SSH_PATH = oldSystemSshPath
    }
    if (oldForceSystemTransport === undefined) {
      delete process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT
    } else {
      process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT = oldForceSystemTransport
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'deploys real detached relay daemon and drives parallel RPCs over two independent SSH exec channels',
    async () => {
      const target = makeTarget()
      const conn = new SshConnection(target, { onStateChange: vi.fn() })
      await conn.connect()
      expect(conn.usesSystemSshTransport()).toBe(true)

      // Step 1: Deploy and launch the detached relay daemon; returns first transport connected to socket
      const deployResult = await deployAndLaunchRelay(conn, vi.fn(), 60, target.id)
      expect(deployResult.sockPath).toBeTruthy()
      expect(deployResult.remoteRelayDir).toBeTruthy()

      // Step 2: Open second physical SSH exec channel to the same relay Unix socket
      const backgroundChannel = await conn.exec(
        `cd '${deployResult.remoteRelayDir}' && node relay.js --connect --sock-path '${deployResult.sockPath}' --credential-file '${deployResult.credentialFile}'`
      )
      const backgroundTransport = await waitForSentinel(backgroundChannel)

      // Step 3: Instantiate SshChannelMultiplexer with the two independent physical transports
      const mux = new SshChannelMultiplexer({
        interactive: deployResult.transport,
        background: backgroundTransport
      })

      try {
        // Step 4: Issue concurrent interactive (pty.*) and background (fs.* / session.*) RPCs
        const ptyPromise = mux.request('pty.spawn', { cols: 80, rows: 24 })
        const fsPromise = mux.request('fs.listFiles', { path: '/workspace' })
        const homePromise = mux.request('session.resolveHome', { path: '~' })

        // Step 5: Verify both channels resolve end-to-end through real processes and sockets
        const [ptyRes, fsRes, homeRes] = await Promise.all([ptyPromise, fsPromise, homePromise])

        expect(ptyRes).toEqual({ id: 'pty-dual-1', cols: 80, rows: 24 })
        expect(fsRes).toEqual({ files: ['src/index.ts', 'package.json'] })
        expect(homeRes).toBe(join(tempDir, 'remote-home'))

        // Step 6: Verify notifications route without blocking
        mux.notify('pty.data', { id: 'pty-dual-1', data: 'ls -la\n' })
      } finally {
        mux.dispose()
        await conn.disconnect()
      }
    },
    30_000
  )

  it.skipIf(process.platform === 'win32')(
    'guarantees interactive keystrokes resolve without head-of-line delay during a heavy background scan',
    async () => {
      const target = makeTarget()
      const conn = new SshConnection(target, { onStateChange: vi.fn() })
      await conn.connect()

      const deployResult = await deployAndLaunchRelay(conn, vi.fn(), 60, target.id)
      const backgroundChannel = await conn.exec(
        `cd '${deployResult.remoteRelayDir}' && node relay.js --connect --sock-path '${deployResult.sockPath}' --credential-file '${deployResult.credentialFile}'`
      )
      const backgroundTransport = await waitForSentinel(backgroundChannel)

      const mux = new SshChannelMultiplexer({
        interactive: deployResult.transport,
        background: backgroundTransport
      })

      try {
        // Start a 512KB bulk scan on the background channel
        const heavyBackgroundPromise = mux.request('fs.heavyScan')

        // Immediately issue interactive PTY keystroke RPC
        const interactiveStart = performance.now()
        const ptyRes = await mux.request('pty.spawn', { cols: 80, rows: 24 })
        const interactiveDurationMs = performance.now() - interactiveStart

        expect(ptyRes).toEqual({ id: 'pty-dual-1', cols: 80, rows: 24 })
        // Interactive RPC must complete in under 500ms despite the 512KB payload in flight
        expect(interactiveDurationMs).toBeLessThan(500)

        // Background scan finishes eventually
        const heavyRes = await heavyBackgroundPromise
        expect(typeof heavyRes).toBe('object')
        expect(heavyRes).not.toBeNull()
        if (typeof heavyRes === 'object' && heavyRes !== null && 'data' in heavyRes) {
          expect(typeof heavyRes.data).toBe('string')
          if (typeof heavyRes.data === 'string') {
            expect(heavyRes.data.length).toBe(512 * 1024)
          }
        }
      } finally {
        mux.dispose()
        await conn.disconnect()
      }
    },
    30_000
  )
})
