#!/usr/bin/env node
/**
 * riley pr-check — Behavior-first author and maintainer PR check gate.
 *
 * Slice 1: Author-side gate.
 *
 * Verbs:
 *   plan   Verify merge-base + merge-tree against target branch.
 *          Exit 0 on clean tree, 1 on conflicts, 2 on git error / cannot compute merge-base.
 *   check  Run plan first (fail-closed), optional aislop scan (warn-only),
 *          targeted tests via detected test runner (fail-closed, exit 2 if no runner).
 *
 * Zero external dependencies: pure Node.js built-ins only.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const VERSION = '0.1.0'

const USAGE = `riley pr-check — Behavior-first author and maintainer PR check gate

USAGE
  riley pr-check --help
  riley pr-check plan [--target <ref>] [--cwd <dir>] [--json]
  riley pr-check check [--target <ref>] [--cwd <dir>] [--skip-aislop] [--json]

COMMANDS
  plan     Verify merge-base and three-way merge-tree against target.
           Detects content conflicts and resurrected or deleted file issues.
           Exit 0: clean merge tree
           Exit 1: dirty merge tree (conflicts detected)
           Exit 2: MANUAL_REVIEW (missing git, cannot compute merge-base)

  check    Run the author-side gate:
           1. Merge plan (clean merge-tree check, fail-closed)
           2. Required aislop compose step (fail-closed, unless --skip-aislop)
           3. Targeted test execution using detected test runner (fail-closed)
           Exit 0: VERIFIED_PASS
           Exit 1: FAIL (dirty merge-tree, aislop slop findings, or failing tests)
           Exit 2: MANUAL_REVIEW (cannot compute merge-base, aislop execution error/withhold, no test runner, or skipped tests)

OPTIONS
  --target <ref>     Target branch or ref to merge against (default: origin/main).
  --cwd <dir>        Target repository directory (default: current working directory).
  --skip-aislop      Skip required aislop scanner step.
  --json             Emit output in machine-readable JSON format.
  -h, --help         Show this help message.
  -v, --version      Show version.
`

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

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--') || next.startsWith('-')) {
          flags[key] = true
        } else {
          flags[key] = next
          i++
        }
      }
      continue
    }
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
  return { flags, positional }
}

function resolveRepoCwd(flags) {
  if (flags.cwd) {
    return isAbsolute(flags.cwd) ? flags.cwd : resolve(process.cwd(), flags.cwd)
  }
  return process.cwd()
}

function detectMergeBase(target, cwd) {
  // If explicit target provided (different from default origin/main), test it specifically
  if (target) {
    const res = run('git', ['merge-base', 'HEAD', target], { cwd })
    if (res.status === 0 && res.stdout) {
      const baseSha = res.stdout.split('\n')[0].trim()
      if (baseSha) {
        return { base: baseSha, ref: target }
      }
    }
    // If target was specifically passed via --target and failed, don't fall back to random branches
    return null
  }

  const fallbackCandidates = ['origin/main', 'upstream/main', 'main']
  for (const ref of fallbackCandidates) {
    const res = run('git', ['merge-base', 'HEAD', ref], { cwd })
    if (res.status === 0 && res.stdout) {
      const baseSha = res.stdout.split('\n')[0].trim()
      if (baseSha) {
        return { base: baseSha, ref }
      }
    }
  }
  return null
}

function resolveTargetRef(flags) {
  return flags.target || null
}

function executePlan(flags, cwd) {
  const explicitTarget = flags.target || null
  const target = explicitTarget || 'origin/main'

  // 1. Check if git is available
  const gitVersion = run('git', ['--version'], { cwd })
  if (gitVersion.status !== 0) {
    return {
      exitCode: 2,
      status: 'MANUAL_REVIEW',
      error: 'Git is not installed or not found in PATH.',
      target,
    }
  }

  // Check if cwd is a git repository
  const gitRevParse = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
  if (gitRevParse.status !== 0 || gitRevParse.stdout !== 'true') {
    return {
      exitCode: 2,
      status: 'MANUAL_REVIEW',
      error: `Directory '${cwd}' is not inside a git repository.`,
      target,
    }
  }

  // 2. Compute merge-base
  const mergeBaseInfo = detectMergeBase(explicitTarget, cwd)
  if (!mergeBaseInfo) {
    return {
      exitCode: 2,
      status: 'MANUAL_REVIEW',
      error: `Cannot compute merge-base against target ref '${target}'. Check that target ref exists.`,
      target,
    }
  }

  const { base: mergeBase, ref: resolvedTarget } = mergeBaseInfo

  // 3. Perform git merge-tree
  // Try modern --write-tree first
  let mergeTreeRes = run('git', ['merge-tree', '--write-tree', '--name-only', 'HEAD', resolvedTarget], { cwd })
  let usedFallback = false

  if (mergeTreeRes.status !== 0 && mergeTreeRes.stderr.includes('unknown option `write-tree`')) {
    // Old git fallback
    usedFallback = true
    mergeTreeRes = run('git', ['merge-tree', mergeBase, 'HEAD', resolvedTarget], { cwd })
  }

  const OID_RE = /^[0-9a-f]{40}$/
  let isClean = false
  let conflictFiles = []

  if (!usedFallback) {
    if (mergeTreeRes.status === 0) {
      isClean = true
    } else {
      isClean = false
      conflictFiles = mergeTreeRes.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !OID_RE.test(s))
    }
  } else {
    // Old merge-tree outputs diff with conflict markers if there are conflicts
    if (mergeTreeRes.stdout.includes('<<<<') || mergeTreeRes.stdout.includes('====') || mergeTreeRes.stdout.includes('merged with conflict')) {
      isClean = false
      conflictFiles = ['(conflicts detected via git merge-tree fallback)']
    } else {
      isClean = true
    }
  }

  // Also check for changed files between mergeBase and HEAD (and any staged/untracked changes if relevant)
  const diffRes = run('git', ['diff', '--name-only', `${mergeBase}...HEAD`], { cwd })
  const committedChanged = diffRes.status === 0
    ? diffRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : []

  // Check working tree status for staged/unstaged changes
  const statusRes = run('git', ['status', '--porcelain'], { cwd })
  const workingFiles = statusRes.status === 0
    ? statusRes.stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    : []

  const allChangedFiles = [...new Set([...committedChanged, ...workingFiles])]

  let bootstrapMap = null
  try {
    bootstrapMap = bootstrapRileyContext(cwd)
  } catch {
    // Bootstrap best-effort, does not fail plan
  }

  if (!isClean) {
    return {
      exitCode: 1,
      status: 'FAIL',
      target: resolvedTarget,
      mergeBase,
      isClean: false,
      conflictFiles,
      changedFiles: allChangedFiles,
      error: `Dirty merge-tree: ${conflictFiles.length} conflict file(s) detected.`,
      map: bootstrapMap,
    }
  }

  return {
    exitCode: 0,
    status: 'PASS',
    target: resolvedTarget,
    mergeBase,
    isClean: true,
    conflictFiles: [],
    changedFiles: allChangedFiles,
    map: bootstrapMap,
  }
}

function detectManifests(cwd) {
  const candidates = ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml']
  return candidates.filter((f) => existsSync(join(cwd, f)))
}

function detectTestRunnerSummary(cwd) {
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const scripts = pkg.scripts || {}
      if (scripts.test && !scripts.test.includes('no test specified')) {
        return { type: 'npm-script', script: 'test', command: 'npm test --' }
      }
      if (scripts['test:ci']) {
        return { type: 'npm-script', script: 'test:ci', command: 'npm run test:ci --' }
      }
      if (scripts.vitest) {
        return { type: 'npm-script', script: 'vitest', command: 'npm run vitest --' }
      }
      const devDeps = pkg.devDependencies || {}
      const deps = pkg.dependencies || {}
      if (devDeps.vitest || deps.vitest) {
        return { type: 'vitest', command: 'npx vitest run' }
      }
      if (devDeps.jest || deps.jest) {
        return { type: 'jest', command: 'npx jest' }
      }
      if (devDeps.mocha || deps.mocha) {
        return { type: 'mocha', command: 'npx mocha' }
      }
    } catch {
      // ignore parse error
    }
  }

  if (existsSync(join(cwd, 'go.mod'))) {
    return { type: 'go-test', command: 'go test ./...' }
  }

  return null
}

function collectCorePaths(cwd, maxFiles = 20) {
  const candidates = ['src', 'lib', 'app', 'cmd', 'internal']
  const found = []
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor', 'build', 'coverage', '.riley'])

  for (const dirName of candidates) {
    const dirPath = join(cwd, dirName)
    if (!existsSync(dirPath)) continue

    // BFS traversal preferring shallow files
    const queue = [dirPath]
    while (queue.length > 0 && found.length < maxFiles) {
      const current = queue.shift()
      let entries = []
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }

      // Separate files and subdirs to add files first (shallow preference)
      const files = []
      const subdirs = []
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.isFile()) {
          files.push(entry.name)
        } else if (entry.isDirectory()) {
          subdirs.push(entry.name)
        }
      }

      files.sort()
      for (const file of files) {
        if (found.length >= maxFiles) break
        const rel = relative(cwd, join(current, file))
        found.push(rel)
      }

      subdirs.sort()
      for (const subdir of subdirs) {
        queue.push(join(current, subdir))
      }
    }
  }

  return found
}

function getRecentHistory(cwd, count = 20) {
  const logRes = run('git', ['log', `-n`, String(count), '--name-only', '--pretty=format:%H\t%s'], { cwd })
  if (logRes.status !== 0 || !logRes.stdout.trim()) {
    return []
  }

  const commits = []
  const raw = logRes.stdout.trim()
  const lines = raw.split('\n')
  let currentCommit = null

  for (const line of lines) {
    if (!line) continue
    if (line.includes('\t')) {
      const tabIdx = line.indexOf('\t')
      const sha = line.slice(0, tabIdx)
      const subject = line.slice(tabIdx + 1)
      // Check if sha is a git sha (40 hex chars or similar)
      if (/^[0-9a-f]{7,40}$/i.test(sha)) {
        currentCommit = { sha, subject, files: [] }
        commits.push(currentCommit)
        continue
      }
    }

    if (currentCommit) {
      currentCommit.files.push(line.trim())
    }
  }

  return commits
}

function detectStandards(cwd) {
  const found = []

  // Root-level exact matches
  if (existsSync(join(cwd, 'AGENTS.md'))) {
    found.push('AGENTS.md')
  }
  if (existsSync(join(cwd, '.editorconfig'))) {
    found.push('.editorconfig')
  }

  // Root-level pattern matches for STYLEGUIDE* and CONTRIBUTING*
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('STYLEGUIDE') || name.startsWith('styleguide')) {
        if (!found.includes(name)) found.push(name)
      }
      if (name.startsWith('CONTRIBUTING') || name.startsWith('contributing')) {
        if (!found.includes(name)) found.push(name)
      }
    }
  } catch {
    // ignore read errors
  }

  return found.sort()
}

function dumpYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  let out = ''

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      out += `${pad}${key}: null\n`
    } else if (typeof val === 'boolean') {
      out += `${pad}${key}: ${val ? 'true' : 'false'}\n`
    } else if (typeof val === 'number') {
      out += `${pad}${key}: ${val}\n`
    } else if (typeof val === 'string') {
      const safe = val.includes(':') || val.includes('#') || val.includes('\n') || val.trim() !== val || val === ''
        ? JSON.stringify(val)
        : val
      out += `${pad}${key}: ${safe}\n`
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        out += `${pad}${key}: []\n`
      } else {
        out += `${pad}${key}:\n`
        for (const item of val) {
          if (typeof item === 'object' && item !== null) {
            const itemLines = dumpYaml(item, indent + 2).split('\n').filter(Boolean)
            if (itemLines.length > 0) {
              out += `${pad}  - ${itemLines[0].trimStart()}\n`
              for (let i = 1; i < itemLines.length; i++) {
                out += `${itemLines[i]}\n`
              }
            }
          } else if (typeof item === 'string') {
            const safe = item.includes(':') || item.includes('#') || item.includes('\n') || item.trim() !== item || item === ''
              ? JSON.stringify(item)
              : item
            out += `${pad}  - ${safe}\n`
          } else {
            out += `${pad}  - ${item}\n`
          }
        }
      }
    } else if (typeof val === 'object') {
      out += `${pad}${key}:\n`
      out += dumpYaml(val, indent + 1)
    }
  }
  return out
}

function bootstrapRileyContext(cwd) {
  const rileyDir = join(cwd, '.riley')
  if (!existsSync(rileyDir)) {
    mkdirSync(rileyDir, { recursive: true })
  }

  const manifests = detectManifests(cwd)
  const testRunner = detectTestRunnerSummary(cwd)
  const corePaths = collectCorePaths(cwd, 20)
  const recent = getRecentHistory(cwd, 20)
  const standards = detectStandards(cwd)
  const inferred = standards.length === 0

  const mapData = {
    manifests,
    test_runner: testRunner ? testRunner.command : null,
    core_paths: corePaths,
    recent: recent.map((r) => ({
      sha: r.sha,
      subject: r.subject,
      files: r.files,
    })),
    standards,
    inferred,
  }

  const mapYaml = dumpYaml(mapData)
  writeFileSync(join(rileyDir, 'map.yml'), mapYaml, 'utf-8')

  const contextFile = join(rileyDir, 'context.md')
  if (!existsSync(contextFile)) {
    const stub = `# Repository Context\n\n## Current State\nunconfirmed; inferred from sample; not repo law.\n`
    writeFileSync(contextFile, stub, 'utf-8')
  }

  return mapData
}

function isTestFile(file) {
  const SPEC_RE = /\.(test|spec)\.[cm]?[jt]sx?$|\.test\.[a-zA-Z0-9]+$|\.spec\.[a-zA-Z0-9]+$|([/_]tests?[/_])/i
  return SPEC_RE.test(file)
}

function detectTestRunner(cwd) {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) {
    return null
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const scripts = pkg.scripts || {}
    const devDeps = pkg.devDependencies || {}
    const deps = pkg.dependencies || {}

    // Check if test script exists and isn't the generic placeholder
    if (scripts.test) {
      if (scripts.test.includes('no test specified')) {
        return null
      }
      return { type: 'npm-script', script: 'test', command: 'npm test --' }
    }

    if (devDeps.vitest || deps.vitest) {
      return { type: 'vitest', command: 'npx vitest run' }
    }

    if (devDeps.jest || deps.jest) {
      return { type: 'jest', command: 'npx jest' }
    }

    if (devDeps.mocha || deps.mocha) {
      return { type: 'mocha', command: 'npx mocha' }
    }

    return null
  } catch {
    return null
  }
}

function isScoreWithheld(output) {
  if (!output || typeof output !== 'string') return false
  const lower = output.toLowerCase()
  if (lower.includes('score withheld') || lower.includes('unsupported language') || lower.includes('unsupported file type') || lower.includes('no scored files') || lower.includes('unable to score')) {
    return true
  }
  // Check if output is valid JSON but with no score / empty
  try {
    const parsed = JSON.parse(output.trim())
    if (Array.isArray(parsed) && parsed.length === 0) return true
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.score === undefined && parsed.findings === undefined && parsed.filesScored === 0) {
        return true
      }
      if (parsed.status === 'withheld' || parsed.withheld === true) {
        return true
      }
    }
  } catch {
    // Not JSON
  }
  return false
}

function runAislopStep(cwd, target) {
  process.stdout.write('\n[riley pr-check] Running aislop check...\n')

  let cmdRes
  if (process.env.RILEY_PR_CHECK_AISLOP_CMD) {
    const fullCmd = process.env.RILEY_PR_CHECK_AISLOP_CMD
    cmdRes = run('sh', ['-c', fullCmd], { cwd })
  } else {
    const npxCheck = run('which', ['npx'], { cwd })
    if (npxCheck.status !== 0) {
      return {
        exitCode: 2,
        status: 'MANUAL_REVIEW',
        error: 'npx not found in PATH',
        summary: 'Cannot run aislop. Do not open the PR.',
      }
    }

    // Try primary command: npx --yes aislop@latest ci --changes --base <target>
    cmdRes = run('npx', ['--yes', 'aislop@latest', 'ci', '--changes', '--base', target], { cwd })

    // Fallback if ci is unavailable
    if (cmdRes.status !== 0 && (cmdRes.stderr.includes('unknown command') || cmdRes.stderr.includes('ci'))) {
      cmdRes = run('npx', ['--yes', 'aislop@latest', 'scan', '--changes', '--base', target, '--json'], { cwd })
    }
  }

  const combinedOutput = `${cmdRes.stdout || ''}\n${cmdRes.stderr || ''}`.trim()

  if (cmdRes.status === 0) {
    if (isScoreWithheld(combinedOutput)) {
      if (combinedOutput) process.stdout.write(`${combinedOutput}\n`)
      return {
        exitCode: 2,
        status: 'MANUAL_REVIEW',
        output: cmdRes.stdout,
        stderr: cmdRes.stderr,
        summary: 'aislop did not score this change. Do not treat that as a pass.',
      }
    }
    process.stdout.write('aislop: Clean (passed).\n')
    return {
      exitCode: 0,
      status: 'PASS',
      output: cmdRes.stdout,
    }
  }

  if (cmdRes.status === 1) {
    if (cmdRes.stdout) process.stdout.write(`${cmdRes.stdout}\n`)
    if (cmdRes.stderr) process.stdout.write(`${cmdRes.stderr}\n`)
    return {
      exitCode: 1,
      status: 'FAIL',
      output: cmdRes.stdout,
      stderr: cmdRes.stderr,
      summary: 'aislop found leftover AI slop. Do not open the PR.',
    }
  }

  // Crash, missing binary, or abnormal exit code (> 1 or < 0)
  if (cmdRes.stdout) process.stdout.write(`${cmdRes.stdout}\n`)
  if (cmdRes.stderr) process.stdout.write(`${cmdRes.stderr}\n`)
  return {
    exitCode: 2,
    status: 'MANUAL_REVIEW',
    output: cmdRes.stdout,
    stderr: cmdRes.stderr,
    summary: 'Cannot run aislop. Do not open the PR.',
  }
}

function executeCheck(flags, cwd) {
  const planResult = executePlan(flags, cwd)

  // Fail-closed on plan
  if (planResult.exitCode !== 0) {
    return {
      exitCode: planResult.exitCode,
      status: planResult.status,
      plan: planResult,
      aislop: null,
      tests: null,
      summary: `Merge plan failed (${planResult.status}). ${planResult.error || 'Resolve conflicts before checking.'}`,
    }
  }

  // Required aislop compose step (fail-closed unless --skip-aislop)
  let aislopResult = null
  if (!flags['skip-aislop']) {
    const target = planResult.target || flags.target || 'origin/main'
    aislopResult = runAislopStep(cwd, target)
    if (aislopResult.exitCode !== 0) {
      return {
        exitCode: aislopResult.exitCode,
        status: aislopResult.status,
        plan: planResult,
        aislop: aislopResult,
        tests: null,
        summary: aislopResult.summary,
      }
    }
  }
  // Detect test runner
  const testRunner = detectTestRunner(cwd)
  if (!testRunner) {
    return {
      exitCode: 2,
      status: 'MANUAL_REVIEW',
      plan: planResult,
      aislop: aislopResult,
      tests: null,
      summary: 'Cannot prove tests fail. Do not open the PR. (No test runner detected in repository)',
    }
  }

  // Check changed files for test files vs production files
  const changedFiles = planResult.changedFiles || []
  const testFiles = changedFiles.filter(isTestFile)
  const prodFiles = changedFiles.filter((f) => !isTestFile(f))

  let testWarning = null
  if (prodFiles.length > 0 && testFiles.length === 0) {
    testWarning = 'Production files changed but zero matching test files found in diff.'
    process.stdout.write(`\n[riley pr-check] WARNING: ${testWarning}\n`)
  }

  // Run targeted tests or the test suite
  let testCmd = []
  if (testRunner.type === 'npm-script') {
    // If npm test, pass testFiles if we have any
    testCmd = ['npm', 'test']
    if (testFiles.length > 0) {
      testCmd.push('--', ...testFiles)
    }
  } else if (testRunner.type === 'vitest') {
    testCmd = ['npx', 'vitest', 'run', ...testFiles]
  } else if (testRunner.type === 'jest') {
    testCmd = ['npx', 'jest', ...testFiles]
  } else if (testRunner.type === 'mocha') {
    testCmd = ['npx', 'mocha', ...testFiles]
  }

  process.stdout.write(`\n[riley pr-check] Running tests via: ${testCmd.join(' ')}\n`)
  const testRun = run(testCmd[0], testCmd.slice(1), { cwd })

  if (testRun.stdout) {
    process.stdout.write(`${testRun.stdout}\n`)
  }
  if (testRun.stderr && testRun.status !== 0) {
    process.stdout.write(`${testRun.stderr}\n`)
  }

  if (testRun.status !== 0) {
    return {
      exitCode: 1,
      status: 'FAIL',
      plan: planResult,
      aislop: aislopResult,
      tests: {
        ran: true,
        passed: false,
        command: testCmd.join(' '),
        output: testRun.stdout,
        error: testRun.stderr,
      },
      summary: 'Targeted tests failed. Tests must pass before opening PR.',
    }
  }

  return {
    exitCode: 0,
    status: 'VERIFIED_PASS',
    plan: planResult,
    aislop: aislopResult,
    tests: {
      ran: true,
      passed: true,
      command: testCmd.join(' '),
      testWarning,
    },
    summary: 'Merge-tree is clean and tests ran and passed.',
  }
}

// ---------------------------------------------------------------------------
// Main CLI Entry
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  const { flags, positional } = parseArgs(argv)

  if (flags.help || flags.h || (positional.length === 0 && !flags.version && !flags.v)) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  if (flags.version || flags.v) {
    process.stdout.write(`riley pr-check v${VERSION}\n`)
    process.exit(0)
  }

  const verb = positional[0]
  const cwd = resolveRepoCwd(flags)

  if (verb === 'plan') {
    const res = executePlan(flags, cwd)
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      process.stdout.write('=== riley pr-check: plan ===\n')
      process.stdout.write(`Status:          ${res.status}\n`)
      process.stdout.write(`Target ref:      ${res.target}\n`)
      if (res.mergeBase) {
        process.stdout.write(`Merge base:      ${res.mergeBase}\n`)
      }
      process.stdout.write(`Merge-tree:      ${res.isClean ? 'CLEAN' : 'DIRTY (conflicts detected)'}\n`)
      if (res.conflictFiles && res.conflictFiles.length > 0) {
        process.stdout.write('Conflict files:\n')
        for (const file of res.conflictFiles) {
          process.stdout.write(`  - ${file}\n`)
        }
      }
      if (res.error) {
        process.stdout.write(`Details:         ${res.error}\n`)
      }
      if (res.status === 'PASS') {
        process.stdout.write('\nResult: Merge is clean. Ready for verification check.\n')
      } else if (res.status === 'FAIL') {
        process.stdout.write('\nResult: Merge conflicts detected. Resolve conflicts before opening PR.\n')
      } else {
        process.stdout.write('\nResult: MANUAL_REVIEW required. Cannot proceed with automatic check.\n')
      }
    }
    process.exit(res.exitCode)
  }

  if (verb === 'check') {
    const res = executeCheck(flags, cwd)
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      process.stdout.write('\n=== riley pr-check: summary ===\n')
      process.stdout.write(`Verdict:         ${res.status}\n`)
      process.stdout.write(`Details:         ${res.summary}\n`)
      if (res.status === 'VERIFIED_PASS') {
        process.stdout.write('Author check passed: merge-tree is clean and tests passed.\n')
      } else if (res.status === 'FAIL') {
        process.stdout.write('Author check failed: issues must be resolved before opening PR.\n')
      } else {
        process.stdout.write('Author check blocked: MANUAL_REVIEW. Do not open the PR.\n')
      }
    }
    process.exit(res.exitCode)
  }

  process.stderr.write(`Unknown command: '${verb}'. Run 'riley pr-check --help' for usage.\n`)
  process.exit(1)
}

main()
