import { Client, type ClientChannel } from 'ssh2'
import { readFileSync } from 'node:fs'
import { SshDualChannelMultiplexer } from '../src/main/ssh/ssh-dual-channel-multiplexer'
import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../src/main/ssh/ssh-channel-multiplexer'

const KEY_PATH = '/data/home/svc_orca/.ssh/id_ed25519_orca'
const HOST = '10.200.0.2'
const USERNAME = 'lesley'

function getPrivateKey(): Buffer {
  return readFileSync(KEY_PATH)
}

function createSshClient(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => {
      resolve(conn)
    })
    conn.on('error', reject)
    conn.connect({
      host: HOST,
      port: 22,
      username: USERNAME,
      privateKey: getPrivateKey(),
      readyTimeout: 15_000
    })
  })
}

// Remote server script that echoes keystrokes on interactive channel and streams bulk data on background channel
const REMOTE_ECHO_SERVER_SCRIPT = `
const net = require("net");
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 13) {
      const type = buffer[0];
      const length = buffer.readUInt32BE(9);
      if (buffer.length < 13 + length) return;
      const payload = buffer.subarray(13, 13 + length);
      buffer = buffer.subarray(13 + length);
      if (type !== 1) continue;
      const msg = JSON.parse(payload.toString("utf8"));
      if (msg.method === "pty.key") {
        const resp = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.params.char } }));
        const header = Buffer.alloc(13);
        header[0] = 1;
        header.writeUInt32BE(1, 1);
        header.writeUInt32BE(0, 5);
        header.writeUInt32BE(resp.length, 9);
        socket.write(Buffer.concat([header, resp]));
      } else if (msg.method === "fs.heavyScan") {
        // Stream 5MB of background scan data
        const resp = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: "X".repeat(5 * 1024 * 1024) } }));
        const header = Buffer.alloc(13);
        header[0] = 1;
        header.writeUInt32BE(1, 1);
        header.writeUInt32BE(0, 5);
        header.writeUInt32BE(resp.length, 9);
        socket.write(Buffer.concat([header, resp]));
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write("READY:" + port + "\\n");
});
`

async function runBenchmark(): Promise<void> {
  console.log('[WAN-BENCHMARK] Starting Calgary <-> Montreal performance benchmark...')
  console.log('[WAN-BENCHMARK] Client Host: mtl-02-dev-001 (Montreal, 10.200.0.1)')
  console.log('[WAN-BENCHMARK] Remote Host: pc (Calgary, 10.200.0.2)')

  const conn = await createSshClient()
  console.log('[WAN-BENCHMARK] SSH connection established over WireGuard tunnel.')

  // Launch remote server process on Calgary PC
  let remotePort = 0
  const serverChannel = await new Promise<ClientChannel>((resolve, reject) => {
    conn.exec(`node -e '${REMOTE_ECHO_SERVER_SCRIPT.replaceAll("'", "'\\''")}'`, (err, stream) => {
      if (err) {
        return reject(err)
      }
      let output = ''
      stream.on('data', (d: Buffer) => {
        output += d.toString()
        if (output.includes('READY:')) {
          const match = output.match(/READY:(\d+)/)
          if (match) {
            remotePort = Number.parseInt(match[1], 10)
            resolve(stream)
          }
        }
      })
      stream.stderr.on('data', (d: Buffer) => {
        console.error('Remote err:', d.toString())
      })
    })
  })
  console.log(`[WAN-BENCHMARK] Remote test server listening on Calgary PC port ${remotePort}`)

  function openForwardedSocket(
    port: number
  ): Promise<{ transport: MultiplexerTransport; stream: ClientChannel }> {
    return new Promise((resolve, reject) => {
      conn.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, stream) => {
        if (err) {
          return reject(err)
        }
        const transport: MultiplexerTransport = {
          write: (data: Buffer) => {
            return stream.write(data)
          },
          onData: (cb: (data: Buffer) => void) => {
            stream.on('data', cb)
          },
          onClose: (cb: () => void) => {
            stream.on('close', cb)
          },
          close: () => {
            stream.end()
          }
        }
        resolve({ transport, stream })
      })
    })
  }

  // --- Phase 1: Baseline Idle Keystroke RTT ---
  console.log('\n--- Phase 1: Measuring Baseline Idle Keystroke RTT (Calgary <-> Montreal) ---')
  const { transport: idleTransport, stream: idleStream } = await openForwardedSocket(remotePort)
  const idleMux = new SshChannelMultiplexer(idleTransport)
  const idleLatencies: number[] = []
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now()
    await idleMux.request('pty.key', { char: String.fromCharCode(65 + i) })
    const rtt = performance.now() - t0
    idleLatencies.push(rtt)
    await new Promise((r) => setTimeout(r, 50))
  }
  idleMux.dispose()
  idleStream.end()
  const idleAvg = idleLatencies.reduce((a, b) => a + b, 0) / idleLatencies.length
  console.log(`Idle Keystroke Samples (ms): ${idleLatencies.map((n) => n.toFixed(1)).join(', ')}`)
  console.log(`Idle Average RTT: ${idleAvg.toFixed(2)} ms`)

  // --- Phase 2: Single Channel Under 5MB Background Saturation ---
  console.log('\n--- Phase 2: Single Channel Under 5MB Background Scan Saturation ---')
  const { transport: singleTransport, stream: singleStream } = await openForwardedSocket(remotePort)
  const singleMux = new SshChannelMultiplexer(singleTransport)

  // Start heavy background transfer
  console.log('Initiating 5MB background scan on single shared socket...')
  const singleBgPromise = singleMux.request('fs.heavyScan')

  // Measure keystroke latencies during the bulk transfer
  const singleSatLatencies: number[] = []
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now()
    await singleMux.request('pty.key', { char: String.fromCharCode(65 + i) })
    const rtt = performance.now() - t0
    singleSatLatencies.push(rtt)
    await new Promise((r) => setTimeout(r, 50))
  }
  await singleBgPromise
  singleMux.dispose()
  singleStream.end()

  const singleSatAvg = singleSatLatencies.reduce((a, b) => a + b, 0) / singleSatLatencies.length
  const singleSatMax = Math.max(...singleSatLatencies)
  console.log(
    `Single-Channel Saturated Keystroke Latencies (ms): ${singleSatLatencies.map((n) => n.toFixed(1)).join(', ')}`
  )
  console.log(
    `Single-Channel Average: ${singleSatAvg.toFixed(2)} ms, Max: ${singleSatMax.toFixed(2)} ms`
  )

  // --- Phase 3: Dual Channel Multiplexer Under 5MB Background Saturation ---
  console.log('\n--- Phase 3: SshDualChannelMultiplexer Under 5MB Background Scan Saturation ---')
  const { transport: interactiveTransport, stream: interactiveStream } =
    await openForwardedSocket(remotePort)
  const { transport: backgroundTransport, stream: backgroundStream } =
    await openForwardedSocket(remotePort)

  const dualMux = new SshDualChannelMultiplexer({
    interactive: interactiveTransport,
    background: backgroundTransport
  })

  // Start heavy background transfer on background channel
  console.log('Initiating 5MB background scan on background channel...')
  const dualBgPromise = dualMux.request('fs.heavyScan')

  // Concurrently measure keystrokes on interactive channel
  const dualSatLatencies: number[] = []
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now()
    await dualMux.request('pty.key', { char: String.fromCharCode(65 + i) })
    const rtt = performance.now() - t0
    dualSatLatencies.push(rtt)
    await new Promise((r) => setTimeout(r, 50))
  }
  await dualBgPromise
  dualMux.dispose()
  interactiveStream.end()
  backgroundStream.end()

  const dualSatAvg = dualSatLatencies.reduce((a, b) => a + b, 0) / dualSatLatencies.length
  const dualSatMax = Math.max(...dualSatLatencies)
  console.log(
    `Dual-Channel Saturated Keystroke Latencies (ms): ${dualSatLatencies.map((n) => n.toFixed(1)).join(', ')}`
  )
  console.log(`Dual-Channel Average: ${dualSatAvg.toFixed(2)} ms, Max: ${dualSatMax.toFixed(2)} ms`)

  // --- Summary Report ---
  console.log('\n===============================================================')
  console.log('      CALGARY <-> MONTREAL WAN BENCHMARK REPORT                ')
  console.log('===============================================================')
  console.log(`Physical Link: WireGuard Tunnel (10.200.0.1 <-> 10.200.0.2)`)
  console.log(`Baseline Idle WAN Keystroke RTT:        ${idleAvg.toFixed(2)} ms`)
  console.log(
    `Single-Channel (Legacy) Under 5MB Load: ${singleSatAvg.toFixed(2)} ms avg (Max: ${singleSatMax.toFixed(2)} ms)`
  )
  console.log(
    `Dual-Channel (PR #49) Under 5MB Load:   ${dualSatAvg.toFixed(2)} ms avg (Max: ${dualSatMax.toFixed(2)} ms)`
  )
  console.log(
    `Latency Improvement / Jitter Drop:      ${((1 - dualSatAvg / singleSatAvg) * 100).toFixed(1)}% reduction`
  )
  console.log('===============================================================')

  serverChannel.close()
  conn.end()
}

runBenchmark().catch((err) => {
  console.error('[WAN-BENCHMARK] Error:', err)
  process.exit(1)
})
