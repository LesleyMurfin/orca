/**
 * Comprehensive verification test for fault-injector.cjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const hookPath = path.resolve('config/scripts/fault-injector.cjs');

describe('fault-injector.cjs unit verification', () => {
  it('loads cleanly without errors when no env vars are set', () => {
    const res = spawnSync('node', ['-e', 'console.log("HELLO_OK")'], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${hookPath}`,
      },
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0);
    assert(res.stderr.includes('[bverify:fault-injector] Initialized active fault injection hook'));
    assert(res.stdout.includes('HELLO_OK'));
  });

  it('injects filesystem latency when BVERIFY_DELAY_FS_PATH and BVERIFY_DELAY_MS are set', () => {
    const testCode = `
      const fs = require('fs');
      const startSync = Date.now();
      fs.readdirSync('config');
      const durationSync = Date.now() - startSync;

      fs.promises.readdir('config').then(() => {
        const durationAsync = Date.now() - startSync;
        console.log(JSON.stringify({ durationSync, durationAsync }));
      });
    `;

    const res = spawnSync('node', ['-e', testCode], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${hookPath}`,
        BVERIFY_DELAY_FS_PATH: 'config',
        BVERIFY_DELAY_MS: '150',
      },
      encoding: 'utf8',
    });

    assert.strictEqual(res.status, 0, res.stderr);
    assert(res.stderr.includes('[bverify:fault-injector] Injecting 150ms delay in fs.readdirSync'));
    assert(res.stderr.includes('[bverify:fault-injector] Injecting 150ms delay in fs.promises.readdir'));
    const parsed = JSON.parse(res.stdout.trim());
    assert(parsed.durationSync >= 140, `Sync duration was ${parsed.durationSync}`);
    assert(parsed.durationAsync >= 280, `Async duration was ${parsed.durationAsync}`);
  });

  it('drops socket connections when BVERIFY_DROP_SOCKET_PORT matches', () => {
    const testCode = `
      const net = require('net');
      const client = new net.Socket();
      client.connect(9999, '127.0.0.1', () => {
        console.log('CONNECTED_UNEXPECTED');
      });
      client.on('error', (err) => {
        console.log('CAUGHT_ERROR:' + err.code);
      });
    `;

    const res = spawnSync('node', ['-e', testCode], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${hookPath}`,
        BVERIFY_DROP_SOCKET_PORT: '9999',
      },
      encoding: 'utf8',
    });

    assert.strictEqual(res.status, 0);
    assert(res.stderr.includes('[bverify:fault-injector] Dropping net.Socket connection to port 9999'));
    assert(res.stdout.includes('CAUGHT_ERROR:ECONNREFUSED'));
  });

  it('intercepts and returns mock HTTP 429 status when BVERIFY_HTTP_STATUS is set', () => {
    const testCode = `
      const http = require('http');
      const req = http.request('http://localhost:12345/api/test', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log(JSON.stringify({
            status: res.statusCode,
            retryAfter: res.headers['retry-after'],
            body: body.trim()
          }));
        });
      });
      req.end();
    `;

    const res = spawnSync('node', ['-e', testCode], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${hookPath}`,
        BVERIFY_DELAY_HTTP_URL: '/api/test',
        BVERIFY_HTTP_STATUS: '429',
      },
      encoding: 'utf8',
    });

    assert.strictEqual(res.status, 0, res.stderr);
    assert(res.stderr.includes('[bverify:fault-injector] Intercepting HTTP request to http://localhost:12345/api/test -> Mocking HTTP 429'));
    const parsed = JSON.parse(res.stdout.trim());
    assert.strictEqual(parsed.status, 429);
    assert.strictEqual(parsed.retryAfter, '5');
    assert(parsed.body.includes('[bverify:fault-injector] Simulated HTTP 429'));
  });

  it('redirects cgroup reads when BVERIFY_MOCK_CGROUP_ROOT is set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-mock-'));
    fs.writeFileSync(path.join(tmpDir, 'memory.max'), '1073741824\n');

    const testCode = `
      const fs = require('fs');
      const contentSync = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8');
      fs.promises.readFile('/sys/fs/cgroup/memory.max', 'utf8').then(contentAsync => {
        console.log(JSON.stringify({ contentSync: contentSync.trim(), contentAsync: contentAsync.trim() }));
      });
    `;

    const res = spawnSync('node', ['-e', testCode], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${hookPath}`,
        BVERIFY_MOCK_CGROUP_ROOT: tmpDir,
      },
      encoding: 'utf8',
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    assert.strictEqual(res.status, 0, res.stderr);
    assert(res.stderr.includes('[bverify:fault-injector] Redirected cgroup read from /sys/fs/cgroup/memory.max'));
    const parsed = JSON.parse(res.stdout.trim());
    assert.strictEqual(parsed.contentSync, '1073741824');
    assert.strictEqual(parsed.contentAsync, '1073741824');
  });
});
