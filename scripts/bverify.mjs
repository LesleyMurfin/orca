#!/usr/bin/env node
/**
 * bverify — Behavioral Verification CLI and runner.
 *
 * Implements the nwparker behavioral verification standard as an executable
 * harness with five verbs:
 *
 *   plan    Compute git merge-base against the target branch, verify a clean
 *           three-way merge-tree (no resurrected/deleted file conflicts), and
 *           compute the changed test-spec blast radius.
 *   probe   Run a live runtime lifecycle smoke and assert the 0 -> 1 -> 0
 *           residual child-process / PTY transition.
 *   fault   Wrap a command with config/scripts/fault-injector.cjs using target
 *           latency or drop parameters.
 *   matrix  Run cgroup v2 hierarchical resolution checks and systemd user scope
 *           validation.
 *   report  Emit both a human-readable maintainer Markdown block and a
 *           machine-readable .verification-report.json.
 *
 * Zero external dependencies: pure Node.js built-ins only.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const FAULT_INJECTOR = join(
  REPO_ROOT,
  'config',
  'scripts',
  'fault-injector.cjs',
)

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const VERSION = '1.0.0'

const USAGE = `bverify — Behavioral Verification CLI and runner

USAGE
  bverify <verb> [options] [-- <args...>]

VERBS
  plan     Verify merge-base + merge-tree cleanliness and compute test-spec
           blast radius.
  probe    Runtime lifecycle smoke; assert 0 -> 1 -> 0 residual processes/PTYs.
  fault    Execute a command under config/scripts/fault-injector.cjs.
  matrix   cgroup v2 hierarchical limit resolution + systemd user scope checks.
  report   Write maintainer Markdown + .verification-report.json.

GLOBAL OPTIONS
  -h, --help         Show help (per-verb or global).
  -V, --version      Print version.

Run 'bverify <verb> --help' for verb-specific options.`

const HELP_PLAN = `bverify plan

Verifies that merging the current branch into the target produces a clean tree
(no resurrected or deleted file conflicts) and computes the changed test-spec
blast radius.

OPTIONS
  --target <ref>     Branch/ref to merge against. Default: origin/main
                     (falls back to upstream/main, then main).
  --base <sha>       Explicit merge-base override (skips merge-base detection).
  --json             Emit machine-readable JSON instead of the summary table.

OUTPUT
  merge_base, merge_tree_clean (bool), conflict_files[], blast_radius[],
  blast_radius_count.`

const HELP_PROBE = `bverify probe

Runs a live runtime lifecycle smoke with PID tracking before and after,
asserting the 0 -> 1 -> 0 transition: zero residual child processes and zero
residual PTYs once the command exits.

OPTIONS
  -c, --command <cm...>  Command to run (shell string or argv). Default:
                         node -e "setTimeout(() => {}, 250)".
  -t, --timeout <ms>     Kill the command after this many ms. Default: 10000.
  --pty                  Allocate a PTY for the command (via 'script') and
                         assert no residual PTYs remain.
  --json                 Emit machine-readable JSON.`

const HELP_FAULT = `bverify fault

Wraps the following command with config/scripts/fault-injector.cjs, injecting
the requested latency or drop parameters via environment variables and
NODE_OPTIONS.

OPTIONS
  --latency-ms <n>        BVERIFY_DELAY_MS — inject fs/http latency (ms).
  --delay-fs <path>       BVERIFY_DELAY_FS_PATH — delay reads of this path.
  --delay-http <url>      BVERIFY_DELAY_HTTP_URL — delay matched HTTP requests.
  --http-status <n>       BVERIFY_HTTP_STATUS — mock HTTP status code.
  --drop-port <n>         BVERIFY_DROP_SOCKET_PORT — drop connects to this port.
  --require <path>        Override fault-injector path.
  -- <args...>            Command + args to run under injection.

Environment contract consumed by fault-injector.cjs:
  BVERIFY_DELAY_FS_PATH, BVERIFY_DELAY_MS, BVERIFY_DROP_SOCKET_PORT,
  BVERIFY_DELAY_HTTP_URL, BVERIFY_HTTP_STATUS.`

const HELP_MATRIX = `bverify matrix

Runs cgroup v2 hierarchical limit resolution checks (walking from the leaf
cgroup up to the root and enforcing min() across ancestors) and validates the
systemd user scope for the current process.

OPTIONS
  --cgroup-root <dir>  Override cgroup root. Default: /sys/fs/cgroup.
  --json               Emit machine-readable JSON.`

const HELP_REPORT = `bverify report

Aggregates plan + matrix results and emits both a human-readable maintainer
Markdown block (stdout) and a machine-readable .verification-report.json.

OPTIONS
  --out <dir>          Directory for the report artifacts. Default: repo root.
  --filename <name>    JSON filename. Default: .verification-report.json.`

const HELP = {
  plan: HELP_PLAN,
  probe: HELP_PROBE,
  fault: HELP_FAULT,
  matrix: HELP_MATRIX,
  report: HELP_REPORT,
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Run a command synchronously, returning {status, stdout, stderr}. */
function run(cmd, args = [], opts = {}) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf-8',
      ...opts,
    })
    return {
      status: res.status ?? -1,
      stdout: (res.stdout ?? '').trimEnd(),
      stderr: (res.stderr ?? '').trimEnd(),
      error: res.error,
    }
  } catch (err) {
    return { status: -1, stdout: '', stderr: String(err), error: err }
  }
}

/** Print an error to stderr and exit non-zero. */
function fail(message, code = 1) {
  process.stderr.write(`bverify: ${message}\n`)
  process.exit(code)
}

/** Parse "--flag value" style options into a map, returning {flags, positional}. */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  // Everything after a bare `--` is passed through verbatim.
  let passThrough = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (passThrough) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      passThrough = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
          flags[key] = true
        } else {
          flags[key] = next
          i++
        }
      }
      continue
    }
    // Short flags
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
      continue
    }
    positional.push(arg)
  }
  return { flags, positional, passThrough }
}

function isTruthy(v) {
  if (v === undefined || v === null) return false
  if (v === false) return false
  if (v === 'false' || v === '0') return false
  return true
}

// ---------------------------------------------------------------------------
// cgroup v2 resolution (mirrors src/main/host/cgroups-v2-hierarchical-limits.ts)
// ---------------------------------------------------------------------------

function parseCgroupV2LimitValue(rawContent) {
  const trimmed = rawContent.trim()
  if (!trimmed || trimmed === 'max') return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function readCgroupFile(filePath) {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function resolveCgroupV2HierarchicalLimit(leafCgroupDir, filename, cgroupRoot) {
  const normalizedRoot = resolve(cgroupRoot ?? '/sys/fs/cgroup')
  let currentDir = resolve(leafCgroupDir)
  let effectiveLimit = null

  for (;;) {
    const content = readCgroupFile(join(currentDir, filename))
    if (content) {
      const parsed = parseCgroupV2LimitValue(content)
      if (parsed !== null) {
        if (effectiveLimit === null || parsed < effectiveLimit) {
          effectiveLimit = parsed
        }
      }
    }

    if (currentDir === normalizedRoot) break

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    if (normalizedRoot.startsWith(currentDir) && normalizedRoot !== currentDir) {
      break
    }
    currentDir = parentDir
  }

  return effectiveLimit
}

/** Parse /proc/self/cgroup into a list of {hierarchy, controllers, path}. */
function readOwnCgroup() {
  const raw = readCgroupFile('/proc/self/cgroup')
  const entries = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // v2 unified: "0::/path" ; v1: "hierarchy:controllers:path"
    const [hierarchy, controllers, path] = line.split(':')
    entries.push({
      hierarchy: hierarchy.trim(),
      controllers: controllers.trim(),
      path: path.trim(),
    })
  }
  return entries
}

/** Resolve the absolute cgroup directory for the current process. */
function ownCgroupDir(cgroupRoot) {
  const root = cgroupRoot ?? '/sys/fs/cgroup'
  const entries = readOwnCgroup()
  const v2 = entries.find((e) => e.controllers === '') ?? entries[0]
  if (!v2) return null
  // Strip the leading slash so join() treats it as relative to root.
  const rel = v2.path.replace(/^\/+/, '')
  return rel ? join(root, rel) : root
}

// ---------------------------------------------------------------------------
// Verb: plan
// ---------------------------------------------------------------------------

function detectMergeBase(target) {
  const candidates = [target, 'upstream/main', 'main']
  for (const ref of candidates) {
    const res = run('git', ['merge-base', 'HEAD', ref])
    if (res.status === 0 && res.stdout) {
      return { base: res.stdout.split('\n')[0], ref }
    }
  }
  return null
}

function computePlan(flags) {
  const json = isTruthy(flags.json)
  const target = flags.target || 'origin/main'

  const mergeBaseResult =
    flags.base || (detectMergeBase(target) ? detectMergeBase(target).base : null)

  let mergeBase = mergeBaseResult
  let resolvedRef = flags.base ? 'explicit' : target
  if (!mergeBase) {
    const detected = detectMergeBase(target)
    if (detected) {
      mergeBase = detected.base
      resolvedRef = detected.ref
    }
  }

  if (!mergeBase) {
    const result = {
      ok: false,
      error: `unable to resolve merge-base against '${target}'`,
    }
    return json ? result : result
  }

  // Clean three-way merge check. Modern `--write-tree` exits 0 for a clean
  // merge (printing only the resulting tree OID) and non-zero when there are
  // conflicts (resurrected/deleted files, content conflicts, etc.).
  const mergeTree = run('git', [
    'merge-tree',
    '--write-tree',
    '--name-only',
    'HEAD',
    target,
  ])
  const mergeTreeClean = mergeTree.status === 0
  // Filter out the tree OID (a 40-hex token emitted on success and as the
  // first line on some conflict layouts) so we surface only real path names.
  const OID_RE = /^[0-9a-f]{40}$/
  const conflictFiles = mergeTreeClean
    ? []
    : mergeTree.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !OID_RE.test(s))

  // Changed test-spec blast radius.
  const diffRes = run('git', ['diff', '--name-only', `${mergeBase}...HEAD`])
  const changed = diffRes.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const SPEC_RE =
    /\.(test|spec)\.[cm]?[jt]sx?$|\.test\.mjs$|\.spec\.mjs$|\.test\.cjs$/
  const blastRadius = changed.filter((f) => SPEC_RE.test(f))

  const result = {
    ok: mergeTreeClean,
    merge_base: mergeBase,
    target: resolvedRef,
    merge_tree_clean: mergeTreeClean,
    conflict_files: conflictFiles,
    changed_files: changed,
    blast_radius: blastRadius,
    blast_radius_count: blastRadius.length,
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`merge_base:       ${mergeBase}\n`)
    process.stdout.write(`target:           ${resolvedRef}\n`)
    process.stdout.write(
      `merge_tree_clean: ${mergeTreeClean ? 'yes' : 'NO (conflicts)'}\n`,
    )
    if (conflictFiles.length) {
      process.stdout.write(`conflict_files:\n`)
      for (const f of conflictFiles) process.stdout.write(`  - ${f}\n`)
    } else {
      process.stdout.write(`conflict_files:   (none)\n`)
    }
    process.stdout.write(`blast_radius:     ${blastRadius.length} test spec file(s)\n`)
    for (const f of blastRadius) process.stdout.write(`  - ${f}\n`)
  }

  return result
}

// ---------------------------------------------------------------------------
// Verb: probe
// ---------------------------------------------------------------------------

/** Count PTY slave devices under /dev/pts. */
function countPtys() {
  try {
    return readdirSync('/dev/pts').filter((e) => /^\d+$/.test(e)).length
  } catch {
    return -1
  }
}

/** Read the process-group id of a pid from /proc/<pid>/stat. */
function readPgrp(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // Format: pid (comm) state ppid pgrp ...  — comm may contain spaces/parens,
    // so parse from the last ')' forward.
    const idx = stat.lastIndexOf(')')
    const fields = stat.slice(idx + 2).trim().split(/\s+/)
    // fields[0] = state, fields[1] = ppid, fields[2] = pgrp
    return Number(fields[2])
  } catch {
    return null
  }
}

/** List live PIDs belonging to a process group (zombies excluded). */
function listPidsInPgid(pgid) {
  let pids = []
  try {
    pids = readdirSync('/proc').filter((e) => /^\d+$/.test(e))
  } catch {
    return []
  }
  const out = []
  for (const ent of pids) {
    const pid = Number(ent)
    if (readPgrp(pid) === pgid && pidAlive(pid)) out.push(pid)
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True while a pid exists and is not yet a zombie. */
function pidAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const idx = stat.lastIndexOf(')')
    const state = stat.slice(idx + 2, idx + 3)
    return state !== 'Z'
  } catch {
    return false
  }
}

async function computeProbe(flags) {
  const json = isTruthy(flags.json)
  const usePty = isTruthy(flags.pty)
  const timeout = Number(flags.t ?? flags.timeout ?? 10000)
  let command = flags.c ?? flags.command ?? null
  const positional = flags.__positional ?? []

  if (!command && positional.length) command = positional.join(' ')

  const shellCommand = command ?? 'node -e "setTimeout(() => {}, 250)"'
  const ptyBefore = usePty ? countPtys() : null

  // Spawn the command in its own process group (detached) so that tracking the
  // group yields the command tree and nothing else. The default smoke runs
  // `node` directly (exactly one process). A user-supplied command runs as a
  // shell string. With --pty we wrap via `script` for a controlling terminal.
  let spawnTarget
  let spawnArgs
  if (usePty) {
    spawnTarget = 'script'
    spawnArgs = ['-qec', shellCommand, '/dev/null']
  } else if (command) {
    spawnTarget = '/bin/sh'
    spawnArgs = ['-c', shellCommand]
  } else {
    spawnTarget = process.execPath
    spawnArgs = ['-e', 'setTimeout(() => {}, 250)']
  }

  const child = spawn(spawnTarget, spawnArgs, {
    stdio: 'ignore',
    detached: true,
  })
  const childPid = child.pid
  const startedAt = Date.now()

  // Give the command a brief launch window, then snapshot every process in its
  // process group. This is the "1" transition (the live command tree).
  await sleep(50)
  const duringPids = listPidsInPgid(childPid)
  const duringCount = duringPids.length

  // Wait for exit or timeout.
  const exitPromise = new Promise((resolve) => child.once('exit', resolve))
  const outcome = await Promise.race([
    exitPromise.then(() => 'exit'),
    sleep(timeout).then(() => 'timeout'),
  ])

  let timedOut = false
  if (outcome === 'timeout') {
    timedOut = true
    try {
      process.kill(-childPid, 'SIGKILL')
    } catch {
      /* ignore */
    }
    await exitPromise
  }

  // After a short grace period (reaping / reaping-delay), anything still alive
  // in the spawned process group is a residual leak.
  await sleep(20)
  const afterPids = listPidsInPgid(childPid)
  const ptyAfter = usePty ? countPtys() : null

  const residualProcesses = afterPids.length
  const residualPtys = usePty ? Math.max(0, ptyAfter - (ptyBefore ?? 0)) : 0
  const transitionOk =
    !timedOut && residualProcesses === 0 && residualPtys === 0

  const result = {
    ok: transitionOk,
    command: shellCommand,
    pty: usePty,
    timed_out: timedOut,
    transition: '0 -> ' + duringCount + ' -> ' + residualProcesses,
    residual_processes: residualProcesses,
    residual_ptys: residualPtys,
    during_pids: duringPids,
    after_pids: afterPids,
    elapsed_ms: Date.now() - startedAt,
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`command:            ${shellCommand}\n`)
    process.stdout.write(`pty:                ${usePty ? 'yes' : 'no'}\n`)
    process.stdout.write(`transition:         ${result.transition}\n`)
    process.stdout.write(
      `residual_processes: ${residualProcesses}${residualProcesses === 0 ? '' : ' (LEAK)'}\n`,
    )
    if (usePty) {
      process.stdout.write(
        `residual_ptys:      ${residualPtys}${residualPtys === 0 ? '' : ' (LEAK)'}\n`,
      )
    }
    process.stdout.write(`elapsed_ms:         ${result.elapsed_ms}\n`)
    process.stdout.write(
      `result:             ${transitionOk ? `PASS (${result.transition})` : 'FAIL'}\n`,
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Verb: fault
// ---------------------------------------------------------------------------

function computeFault(flags) {
  const injector = flags.require
    ? resolve(flags.require)
    : FAULT_INJECTOR

  if (!existsSync(injector)) {
    fail(`fault-injector not found at ${injector}`)
  }

  const cmd = flags.__positional ?? []
  if (!cmd.length) {
    fail('no command supplied; use `bverify fault -- <command...>`')
  }

  const env = { ...process.env }
  if (flags['latency-ms'] !== undefined) {
    env.BVERIFY_DELAY_MS = String(flags['latency-ms'])
  } else if (flags.latency !== undefined) {
    env.BVERIFY_DELAY_MS = String(flags.latency)
  }
  if (flags['delay-fs'] !== undefined) env.BVERIFY_DELAY_FS_PATH = String(flags['delay-fs'])
  if (flags['delay-http'] !== undefined) env.BVERIFY_DELAY_HTTP_URL = String(flags['delay-http'])
  if (flags['http-status'] !== undefined) env.BVERIFY_HTTP_STATUS = String(flags['http-status'])
  if (flags['drop-port'] !== undefined) env.BVERIFY_DROP_SOCKET_PORT = String(flags['drop-port'])

  const existing = env.NODE_OPTIONS || ''
  env.NODE_OPTIONS = `${existing} --require ${injector}`.trim()

  try {
    execFileSync(cmd[0], cmd.slice(1), {
      stdio: 'inherit',
      env,
    })
    return { ok: true, command: cmd.join(' '), injector }
  } catch (err) {
    const status = typeof err.status === 'number' ? err.status : 1
    process.exit(status)
  }
}

// ---------------------------------------------------------------------------
// Verb: matrix
// ---------------------------------------------------------------------------

function checkSystemdScope() {
  // systemctl --user may be unavailable (no D-Bus session). Report gracefully.
  const res = run('systemctl', ['--user', 'is-active', 'default.target'], {
    stdio: 'ignore',
  })
  if (res.status === 0) {
    return { available: true, active: res.stdout.trim() || 'active' }
  }
  // Fall back to checking the process's own cgroup path for a .scope/.service.
  const entries = readOwnCgroup()
  const path = entries.find((e) => e.controllers === '')?.path ?? entries[0]?.path ?? ''
  const inScope = /\.(scope|service)(\/|$)/.test(path)
  return {
    available: false,
    active: null,
    note: 'no user D-Bus session; inferred from cgroup path',
    path,
    in_managed_scope: inScope,
  }
}

function computeMatrix(flags) {
  const json = isTruthy(flags.json)
  const cgroupRoot = flags['cgroup-root'] || '/sys/fs/cgroup'

  const cgroupDir = ownCgroupDir(cgroupRoot)
  const limits = {
    'pids.max': cgroupDir
      ? resolveCgroupV2HierarchicalLimit(cgroupDir, 'pids.max', cgroupRoot)
      : null,
    'memory.max': cgroupDir
      ? resolveCgroupV2HierarchicalLimit(cgroupDir, 'memory.max', cgroupRoot)
      : null,
    'memory.high': cgroupDir
      ? resolveCgroupV2HierarchicalLimit(cgroupDir, 'memory.high', cgroupRoot)
      : null,
  }

  const scope = checkSystemdScope()

  const v2Present = readOwnCgroup().some((e) => e.controllers === '')
  const result = {
    ok: true,
    cgroup_v2: v2Present,
    cgroup_dir: cgroupDir,
    hierarchical_limits: limits,
    systemd_user_scope: scope,
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`cgroup_v2:          ${v2Present ? 'yes' : 'no'}\n`)
    process.stdout.write(`cgroup_dir:         ${cgroupDir ?? '(unresolved)'}\n`)
    for (const [k, v] of Object.entries(limits)) {
      process.stdout.write(
        `${k.padEnd(19)} ${v === null ? 'max (unconstrained)' : String(v)}\n`,
      )
    }
    process.stdout.write(`systemd_user_scope:\n`)
    process.stdout.write(`  available:        ${scope.available ? 'yes' : 'no'}\n`)
    if (scope.available) {
      process.stdout.write(`  active:           ${scope.active}\n`)
    } else {
      process.stdout.write(`  path:             ${scope.path ?? '(unknown)'}\n`)
      process.stdout.write(
        `  in_managed_scope: ${scope.in_managed_scope ? 'yes' : 'no'}\n`,
      )
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Verb: report
// ---------------------------------------------------------------------------

function computeReport(flags) {
  const outDir = resolve(flags.out || REPO_ROOT)
  const filename = flags.filename || '.verification-report.json'
  mkdirSync(outDir, { recursive: true })

  const plan = computePlan({ json: true })
  const matrix = computeMatrix({ json: true })

  const headRes = run('git', ['rev-parse', '--short', 'HEAD'])
  const branchRes = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const timestamp = new Date().toISOString()

  const report = {
    tool: 'bverify',
    version: VERSION,
    timestamp,
    branch: branchRes.stdout || '(unknown)',
    head: headRes.stdout || '(unknown)',
    plan,
    matrix,
    summary: {
      merge_tree_clean: plan.merge_tree_clean === true,
      blast_radius: Array.isArray(plan.blast_radius) ? plan.blast_radius.length : 0,
      cgroup_v2: matrix.cgroup_v2 === true,
    },
  }

  const jsonPath = join(outDir, filename)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)

  // Human-readable maintainer Markdown block (also written alongside the JSON).
  const lines = []
  lines.push('## Behavioral Verification Report')
  lines.push('')
  lines.push(`- **Tool:** bverify ${VERSION}`)
  lines.push(`- **Timestamp:** ${timestamp}`)
  lines.push(`- **Branch:** \`${report.branch}\``)
  lines.push(`- **HEAD:** \`${report.head}\``)
  lines.push('')
  lines.push(`| Check | Result |`)
  lines.push('| --- | --- |')
  lines.push(
    `| Merge-tree clean (no resurrected/deleted conflicts) | ${plan.merge_tree_clean ? '&#x2705; PASS' : '&#x274C; FAIL'} |`,
  )
  lines.push(`| Test-spec blast radius | \`${report.summary.blast_radius}\` file(s) |`)
  lines.push(`| cgroup v2 unified hierarchy | ${matrix.cgroup_v2 ? '&#x2705; present' : '&#x274C; absent'} |`)
  if (plan.conflict_files?.length) {
    lines.push('')
    lines.push('### Conflicts')
    for (const f of plan.conflict_files) lines.push(`- \`${f}\``)
  }
  if (matrix.hierarchical_limits) {
    lines.push('')
    lines.push('### cgroup v2 hierarchical limits')
    for (const [k, v] of Object.entries(matrix.hierarchical_limits)) {
      lines.push(`- \`${k}\`: ${v === null ? 'max' : v}`)
    }
  }
  lines.push('')

  const markdown = lines.join('\n')
  process.stdout.write(`${markdown}\n`)

  const mdPath = join(outDir, '.verification-report.md')
  writeFileSync(mdPath, `${markdown}\n`)

  return {
    ok: true,
    markdown,
    json: jsonPath,
    markdown_path: mdPath,
    report,
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)

  if (!argv.length) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }

  const verb = argv[0]

  if (verb === '-h' || verb === '--help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  if (verb === '-V' || verb === '--version') {
    process.stdout.write(`bverify ${VERSION}\n`)
    process.exit(0)
  }

  if (!HELP[verb]) {
    fail(`unknown verb '${verb}'. Run 'bverify --help' for usage.`)
  }

  const { flags, positional } = parseArgs(argv.slice(1))

  if (flags.h || flags.help) {
    process.stdout.write(`${HELP[verb]}\n`)
    process.exit(0)
  }

  flags.__positional = positional

  let result
  switch (verb) {
    case 'plan':
      result = computePlan(flags)
      break
    case 'probe':
      result = await computeProbe(flags)
      break
    case 'fault':
      result = computeFault(flags)
      break
    case 'matrix':
      result = computeMatrix(flags)
      break
    case 'report':
      result = computeReport(flags)
      break
    default:
      fail(`unhandled verb '${verb}'`)
  }

  const exitCode = result?.ok === false ? 1 : 0
  process.exit(exitCode)
}

main()