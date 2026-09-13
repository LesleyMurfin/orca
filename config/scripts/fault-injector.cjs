/**
 * Zero-dependency, non-invasive Node.js preload hook for behavioral fault injection.
 * Loaded via: NODE_OPTIONS="--require ./config/scripts/fault-injector.cjs"
 *
 * Capabilities:
 * 1. Filesystem latency injection:
 *    - BVERIFY_DELAY_FS_PATH: path substring/pattern to match (e.g. '.git/worktrees')
 *    - BVERIFY_DELAY_MS: milliseconds to delay (e.g. 3700)
 *    - Intercepts fs.readdir, fs.readdirSync, fs.promises.readdir, fs.stat, fs.statSync, fs.promises.stat
 *
 * 2. Network / Socket fault injection:
 *    - BVERIFY_DROP_SOCKET_PORT: comma-separated port numbers where net.Socket connection drops/errors
 *    - BVERIFY_DELAY_HTTP_URL: URL substring to match for HTTP/HTTPS requests
 *    - BVERIFY_HTTP_DELAY_MS: delay for matching HTTP requests (defaults to BVERIFY_DELAY_MS if unset)
 *    - BVERIFY_HTTP_STATUS: mock status code (e.g. 429 or 503) to simulate immediately without reaching backend
 *    - Intercepts http.request, https.request, net.Socket.prototype.connect
 *
 * 3. Cgroup v2 emulation:
 *    - BVERIFY_MOCK_CGROUP_ROOT: path to mock directory hierarchy simulating /sys/fs/cgroup/...
 *    - Redirects reads targeting /sys/fs/cgroup/ to the mock root directory
 *
 * 4. Clean logging:
 *    - Structured diagnostic messages prefixed with [bverify:fault-injector]
 */

'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');

const TAG = '[bverify:fault-injector]';

function log(msg) {
  process.stderr.write(`${TAG} ${msg}\n`);
}

// Configuration from environment
const delayFsPath = process.env.BVERIFY_DELAY_FS_PATH || null;
const delayMs = parseInt(process.env.BVERIFY_DELAY_MS || '0', 10);

const dropSocketPorts = (process.env.BVERIFY_DROP_SOCKET_PORT || '')
  .split(',')
  .map(p => parseInt(p.trim(), 10))
  .filter(p => !isNaN(p) && p > 0);

const delayHttpUrl = process.env.BVERIFY_DELAY_HTTP_URL || null;
const httpDelayMs = parseInt(process.env.BVERIFY_HTTP_DELAY_MS || String(delayMs || 0), 10);
const httpMockStatus = process.env.BVERIFY_HTTP_STATUS ? parseInt(process.env.BVERIFY_HTTP_STATUS, 10) : null;

const mockCgroupRoot = process.env.BVERIFY_MOCK_CGROUP_ROOT || null;

// Synchronous sleep helper using Atomics.wait if possible, or busy wait fallback
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch (_e) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function sleepAsync(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function matchesPath(filePath, targetPattern) {
  if (!filePath || !targetPattern) return false;
  const str = String(filePath);
  return str.includes(targetPattern);
}

function redirectCgroupPath(originalPath) {
  if (!mockCgroupRoot || typeof originalPath !== 'string') {
    return originalPath;
  }
  const CGROUP_PREFIX = '/sys/fs/cgroup';
  if (originalPath === CGROUP_PREFIX || originalPath.startsWith(CGROUP_PREFIX + '/') || originalPath.startsWith(CGROUP_PREFIX + '\\')) {
    const sub = originalPath.slice(CGROUP_PREFIX.length).replace(/^[/\\]+/, '');
    const redirected = path.join(mockCgroupRoot, sub);
    log(`Redirected cgroup read from ${originalPath} -> ${redirected}`);
    return redirected;
  }
  return originalPath;
}

// ==========================================
// 1. Filesystem latency injection & cgroup redirection
// ==========================================
if (delayFsPath && delayMs > 0 || mockCgroupRoot) {
  const origReaddir = fs.readdir;
  const origReaddirSync = fs.readdirSync;
  const origStat = fs.stat;
  const origStatSync = fs.statSync;
  const origReadFile = fs.readFile;
  const origReadFileSync = fs.readFileSync;

  // Intercept fs.readdirSync
  fs.readdirSync = function (p, options) {
    const effectivePath = redirectCgroupPath(p);
    if (delayFsPath && delayMs > 0 && matchesPath(effectivePath, delayFsPath)) {
      log(`Injecting ${delayMs}ms delay in fs.readdirSync("${effectivePath}")`);
      sleepSync(delayMs);
    }
    return origReaddirSync.call(fs, effectivePath, options);
  };

  // Intercept fs.readdir (callback)
  fs.readdir = function (p, options, maybeCb) {
    const cb = typeof options === 'function' ? options : maybeCb;
    const opt = typeof options === 'function' ? undefined : options;
    const effectivePath = redirectCgroupPath(p);

    if (delayFsPath && delayMs > 0 && matchesPath(effectivePath, delayFsPath)) {
      log(`Injecting ${delayMs}ms delay in fs.readdir("${effectivePath}")`);
      return setTimeout(() => {
        origReaddir.call(fs, effectivePath, opt, cb);
      }, delayMs);
    }
    return origReaddir.call(fs, effectivePath, options, maybeCb);
  };

  // Intercept fs.statSync
  fs.statSync = function (p, options) {
    const effectivePath = redirectCgroupPath(p);
    if (delayFsPath && delayMs > 0 && matchesPath(effectivePath, delayFsPath)) {
      log(`Injecting ${delayMs}ms delay in fs.statSync("${effectivePath}")`);
      sleepSync(delayMs);
    }
    return origStatSync.call(fs, effectivePath, options);
  };

  // Intercept fs.stat (callback)
  fs.stat = function (p, options, maybeCb) {
    const cb = typeof options === 'function' ? options : maybeCb;
    const opt = typeof options === 'function' ? undefined : options;
    const effectivePath = redirectCgroupPath(p);

    if (delayFsPath && delayMs > 0 && matchesPath(effectivePath, delayFsPath)) {
      log(`Injecting ${delayMs}ms delay in fs.stat("${effectivePath}")`);
      return setTimeout(() => {
        origStat.call(fs, effectivePath, opt, cb);
      }, delayMs);
    }
    return origStat.call(fs, effectivePath, options, maybeCb);
  };

  // Intercept fs.readFileSync & fs.readFile for cgroup redirection
  fs.readFileSync = function (p, options) {
    const effectivePath = redirectCgroupPath(p);
    return origReadFileSync.call(fs, effectivePath, options);
  };

  fs.readFile = function (p, options, maybeCb) {
    const cb = typeof options === 'function' ? options : maybeCb;
    const opt = typeof options === 'function' ? undefined : options;
    const effectivePath = redirectCgroupPath(p);
    return origReadFile.call(fs, effectivePath, opt, cb);
  };

  // Intercept fs.promises
  if (fs.promises) {
    const origPromisesReaddir = fs.promises.readdir;
    const origPromisesStat = fs.promises.stat;
    const origPromisesReadFile = fs.promises.readFile;

    fs.promises.readdir = async function (p, options) {
      const effectivePath = redirectCgroupPath(p);
      if (delayFsPath && delayMs > 0 && matchesPath(effectivePath, delayFsPath)) {
        log(`Injecting ${delayMs}ms delay in fs.promises.readdir("${effectivePath}")`);
        await sleepAsync(delayMs);
      }
      return origPromisesReaddir.call(fs.promises, effectivePath, options);
    };

    fs.promises.stat = async function (p, options) {
      const effectivePath = redirectCgroupPath(p);
      if (delayFsPath && delayMs > 0 && matchesPath(effectivePath, delayFsPath)) {
        log(`Injecting ${delayMs}ms delay in fs.promises.stat("${effectivePath}")`);
        await sleepAsync(delayMs);
      }
      return origPromisesStat.call(fs.promises, effectivePath, options);
    };

    fs.promises.readFile = async function (p, options) {
      const effectivePath = redirectCgroupPath(p);
      return origPromisesReadFile.call(fs.promises, effectivePath, options);
    };
  }
}

// ==========================================
// 2. Network / Socket fault injection
// ==========================================

// 2a. Intercept net.Socket.prototype.connect
if (dropSocketPorts.length > 0) {
  const origSocketConnect = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function (...args) {
    let port = null;
    let host = null;

    if (typeof args[0] === 'object' && args[0] !== null) {
      port = args[0].port;
      host = args[0].host;
    } else if (typeof args[0] === 'number' || !isNaN(parseInt(args[0], 10))) {
      port = parseInt(args[0], 10);
      if (typeof args[1] === 'string') {
        host = args[1];
      }
    }

    if (port && dropSocketPorts.includes(port)) {
      log(`Dropping net.Socket connection to port ${port} (${host || 'localhost'})`);
      const err = new Error(`connect ECONNREFUSED ${host || '127.0.0.1'}:${port} [fault-injector]`);
      err.code = 'ECONNREFUSED';
      err.port = port;
      err.address = host || '127.0.0.1';
      process.nextTick(() => {
        this.emit('error', err);
        this.destroy(err);
      });
      return this;
    }

    return origSocketConnect.apply(this, args);
  };
}

// 2b. Intercept http.request and https.request
if (delayHttpUrl || httpMockStatus) {
  function patchHttpModule(mod, protocolName) {
    const origRequest = mod.request;

    mod.request = function (...args) {
      let urlStr = '';
      let cb = null;

      if (typeof args[0] === 'string' || (args[0] && args[0] instanceof URL)) {
        urlStr = args[0].toString();
        if (typeof args[1] === 'function') {
          cb = args[1];
        } else if (typeof args[2] === 'function') {
          cb = args[2];
        }
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        const opts = args[0];
        const h = opts.hostname || opts.host || 'localhost';
        const p = opts.port ? `:${opts.port}` : '';
        const path = opts.path || '/';
        urlStr = `${protocolName}://${h}${p}${path}`;
        if (typeof args[1] === 'function') {
          cb = args[1];
        }
      }

      const matchesUrl = delayHttpUrl ? urlStr.includes(delayHttpUrl) : true;

      // Case A: Mock HTTP status (e.g. 429, 503)
      if (httpMockStatus && matchesUrl) {
        log(`Intercepting ${protocolName.toUpperCase()} request to ${urlStr} -> Mocking HTTP ${httpMockStatus}`);
        const { PassThrough } = require('stream');
        const req = new PassThrough();
        req.abort = () => {};
        req.destroy = () => {};
        req.setTimeout = () => req;

        process.nextTick(() => {
          const res = new PassThrough();
          res.statusCode = httpMockStatus;
          res.statusMessage = httpMockStatus === 429 ? 'Too Many Requests' : 'Service Unavailable';
          res.headers = {
            'content-type': 'text/plain',
            'retry-after': '5'
          };
          if (cb) cb(res);
          req.emit('response', res);
          res.end(`[bverify:fault-injector] Simulated HTTP ${httpMockStatus}\n`);
        });

        return req;
      }

      // Case B: Delay HTTP request
      if (delayHttpUrl && matchesUrl && httpDelayMs > 0) {
        log(`Injecting ${httpDelayMs}ms delay in ${protocolName.toUpperCase()} request to ${urlStr}`);
        const { PassThrough } = require('stream');
        const proxyReq = new PassThrough();
        let realReq = null;
        let isAborted = false;

        proxyReq.abort = () => {
          isAborted = true;
          if (realReq) realReq.abort();
        };

        const timer = setTimeout(() => {
          if (isAborted) return;
          realReq = origRequest.apply(mod, args);
          proxyReq.pipe(realReq);
          realReq.on('response', res => proxyReq.emit('response', res));
          realReq.on('error', err => proxyReq.emit('error', err));
        }, httpDelayMs);

        proxyReq.on('close', () => clearTimeout(timer));
        return proxyReq;
      }

      return origRequest.apply(mod, args);
    };
  }

  patchHttpModule(http, 'http');
  patchHttpModule(https, 'https');
}

log('Initialized active fault injection hook');
