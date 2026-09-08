import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const CACHE_ROOT = join(REPO_ROOT, 'tests', 'e2e', '.cross-version-checkouts')

// Bump when extraction or the alias rewrite changes so cached trees are rebuilt.
const CHECKOUT_FORMAT = 1

// Why: the wire endpoints only need the runtime RPC host, the renderer client, and
// the shared codec. Skipping cli/relay keeps a cold CI extraction a few seconds.
const ARCHIVE_PATHS = ['src/main', 'src/shared', 'src/preload', 'src/renderer', 'src/types']

const BASELINE_REF_ENV = 'ORCA_CROSS_VERSION_BASELINE_REF'

export type ReleaseCheckout = {
  /** The ref as requested, e.g. `v1.4.169`. */
  ref: string
  /** Resolved commit the tree was extracted from. */
  commit: string
  /** Directory name under the cache root; also the dynamic-import path segment. */
  label: string
  /** Absolute path to the extracted checkout root (contains `src/`). */
  root: string
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/**
 * How far back the selector walks looking for a release this checkout can run.
 * A tree that can run none of its last {@link BASELINE_SCAN_DEPTH} releases is
 * stale enough to say so, instead of quietly pairing against a months-old build.
 */
const BASELINE_SCAN_DEPTH = 20

export type BaselineRelease = {
  /** The released version, e.g. `v1.4.163`. */
  version: string
  /** The commit the release was cut from; the ref the checkout is extracted at. */
  commit: string
}

/**
 * Release points come from commit subjects, not tags. Why: a fork's clone only
 * carries the tags that existed when it was forked — `LesleyMurfin/orca` stops at
 * v1.4.35 — so tag selection paired a 1.4.178 checkout against a wire from 160
 * releases earlier. That pairing fails for reasons that say nothing about today's
 * protocol (`terminal.serializeBuffer` did not exist yet), and no dependency rule
 * can rescue it. Release commits are part of the history every clone already
 * fetches with `fetch-depth: 0`.
 *
 * Walking from HEAD also means only releases this commit descends from are
 * eligible, which is what keeps a verdict independent of releases published after
 * it: v1.4.197 bumped `zod` past what this tree installs, so its extracted host
 * threw inside `terminal.multiplex` before `emit({ type: 'ready' })` and the lane
 * burned the whole suite timeout without reporting anything about the wire.
 */
const RELEASE_COMMIT_SUBJECT = '^release: (v[0-9]+\\.[0-9]+\\.[0-9]+)$'

/**
 * The version point the harness pairs current code against. An explicit
 * {@link BASELINE_REF_ENV} wins; otherwise the newest release this commit
 * descends from whose runtime dependencies this checkout installed (see
 * {@link unsatisfiedRuntimeDependencies}).
 *
 * Throws rather than skipping: a cross-version lane that quietly runs nothing is
 * the exact failure this harness exists to prevent.
 */
export function resolveBaselineRelease(): BaselineRelease {
  const override = process.env[BASELINE_REF_ENV]?.trim()
  if (override) {
    return { version: override, commit: resolveCommit(override) }
  }
  let log: string
  try {
    log = git([
      'log',
      `--max-count=${BASELINE_SCAN_DEPTH}`,
      '--extended-regexp',
      `--grep=${RELEASE_COMMIT_SUBJECT}`,
      '--format=%H%x09%s',
      'HEAD'
    ])
  } catch (error) {
    throw new Error(
      `Cross-version harness could not read git history in ${REPO_ROOT}: ${String(error)}. ` +
        `Run it inside a git checkout, or pin a ref with ${BASELINE_REF_ENV}.`
    )
  }
  const candidates = parseReleaseCommits(log)
  if (candidates.length === 0) {
    throw new Error(
      'Cross-version harness found no `release: vX.Y.Z` commit reachable from HEAD. ' +
        'CI checkouts default to a shallow clone that stops short of the last release: use ' +
        `\`actions/checkout\` with \`fetch-depth: 0\`, or pin a ref with ${BASELINE_REF_ENV}.`
    )
  }
  const rejected: string[] = []
  for (const candidate of candidates) {
    let manifest: ReleaseManifest
    try {
      manifest = readManifest(git(['show', `${candidate.commit}:package.json`]))
    } catch (error) {
      rejected.push(`${candidate.version} (unreadable package.json: ${String(error)})`)
      continue
    }
    if (`v${manifest.version}` !== candidate.version) {
      // A reverted or cherry-picked release subject is not a release point: the
      // manifest at that commit is the only thing that says what was published.
      rejected.push(`${candidate.version} (manifest declares ${manifest.version})`)
      continue
    }
    const unsatisfied = unsatisfiedRuntimeDependencies(
      manifest.dependencies,
      installedPackageVersion
    )
    if (unsatisfied.length === 0) {
      return candidate
    }
    rejected.push(`${candidate.version} (${unsatisfied.join(', ')})`)
  }
  throw new Error(
    'Cross-version harness found no release this checkout can execute, so no baseline could be ' +
      `imported without resolving the release's imports against packages it never installed. ` +
      `Rejected: ${rejected.join('; ')}. Reinstall dependencies from the lockfile, rebase onto a ` +
      `newer main, or pin a ref with ${BASELINE_REF_ENV}.`
  )
}

/** Parse `git log --format=%H%x09%s` output into release points, newest first. */
export function parseReleaseCommits(log: string): BaselineRelease[] {
  const subject = new RegExp(RELEASE_COMMIT_SUBJECT)
  const releases: BaselineRelease[] = []
  for (const line of log.split('\n')) {
    const separator = line.indexOf('\t')
    if (separator === -1) {
      continue
    }
    const version = subject.exec(line.slice(separator + 1))?.[1]
    if (version) {
      releases.push({ version, commit: line.slice(0, separator) })
    }
  }
  return releases
}

type ReleaseManifest = { version: string; dependencies: Record<string, string> }

function readManifest(manifest: string): ReleaseManifest {
  const parsed: unknown = JSON.parse(manifest)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('package.json did not parse to an object')
  }
  const version = 'version' in parsed && typeof parsed.version === 'string' ? parsed.version : ''
  const dependencies: Record<string, string> = {}
  if ('dependencies' in parsed && parsed.dependencies && typeof parsed.dependencies === 'object') {
    for (const [name, range] of Object.entries(parsed.dependencies)) {
      if (typeof range === 'string') {
        dependencies[name] = range
      }
    }
  }
  return { version, dependencies }
}

/**
 * Why baseline selection is gated on this: the harness imports a release's `src/`
 * but resolves that source's imports against THIS checkout's installed
 * `node_modules`. A package the release needs and this tree does not install — or
 * installs at a major the release predates — makes the extracted host throw
 * inside `terminal.multiplex` before `emit({ type: 'ready' })`, and the journey
 * hangs to the suite timeout instead of reporting anything about the wire.
 *
 * Why installed reality and not declared ranges: the check this replaces compared
 * the union of both manifests and rejected a candidate when any range string
 * differed, a bar no two releases of this repo clear. `dependencies` gained `psl`
 * after v1.4.163 — a release cut before it is not thereby unrunnable — and
 * releases that still listed today's dev-only UI packages as runtime dependencies
 * (v1.4.35: @tiptap/*, @dnd-kit/*, mermaid, katex, …) were rejected over packages
 * the wire path never imports. CI failed with "no release whose runtime
 * dependencies match this checkout" on every candidate it scanned (#28). What
 * decides whether the release can execute here is narrower: each package it
 * declares has to be on disk, at a version its own range would have accepted.
 */
export function unsatisfiedRuntimeDependencies(
  released: Record<string, string>,
  installedVersion: (name: string) => string | null
): string[] {
  const unsatisfied: string[] = []
  for (const [name, range] of Object.entries(released)) {
    const installed = installedVersion(name)
    if (installed === null) {
      unsatisfied.push(`${name} (declared ${range}, not installed)`)
      continue
    }
    if (!sameBreakingVersionLine(range, installed)) {
      unsatisfied.push(`${name} (declared ${range}, installed ${installed})`)
    }
  }
  return unsatisfied.sort()
}

/**
 * Semver's breaking boundary: the major, or the minor while the major is 0. Drift
 * inside one line is what a range like `^8.21.0` already accepts, so it is not
 * evidence the release cannot run against what is installed.
 */
function sameBreakingVersionLine(range: string, installed: string): boolean {
  const declared = versionLine(range)
  const present = versionLine(installed)
  if (!declared || !present) {
    // An exotic range (`*`, a disjunction, a git URL) says nothing about breakage;
    // let the import decide rather than reject a release over an unparsed string.
    return true
  }
  return declared[0] === present[0] && (declared[0] !== 0 || declared[1] === present[1])
}

function versionLine(value: string): [number, number] | null {
  const match = /(\d+)\.(\d+)/.exec(value)
  if (!match) {
    return null
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)]
}

function installedPackageVersion(name: string): string | null {
  let manifest: unknown
  try {
    manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8')
    )
  } catch {
    return null
  }
  if (manifest && typeof manifest === 'object' && 'version' in manifest) {
    return typeof manifest.version === 'string' ? manifest.version : null
  }
  return null
}

function resolveCommit(ref: string): string {
  try {
    return git(['rev-parse', `${ref}^{commit}`])
  } catch (error) {
    throw new Error(
      `Cross-version harness could not resolve ref "${ref}" to a commit: ${String(error)}. ` +
        'The ref must exist locally; a shallow CI clone needs `fetch-depth: 0`.'
    )
  }
}

function isRewritableSource(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.tsx')
}

function isTestSource(name: string): boolean {
  return /\.(test|bench|spec)\.(ts|tsx)$/.test(name)
}

const ALIAS_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])@(renderer)?\/([^'"]+)\2/g

/**
 * The extracted tree is imported directly, so `@/…` must resolve inside that tree.
 * Vite's alias is global and points at the working tree, which would silently run
 * current renderer code inside the "old" client. Rewrite to relative paths instead.
 */
function rewriteRendererAliases(file: string, rendererRoot: string): boolean {
  const source = readFileSync(file, 'utf8')
  if (!source.includes("'@/") && !source.includes('"@/') && !source.includes('@renderer/')) {
    return false
  }
  const rewritten = source.replace(
    ALIAS_SPECIFIER,
    (_match, keyword: string, quote: string, _renderer: string | undefined, target: string) => {
      const absolute = join(rendererRoot, target)
      let relativePath = relative(dirname(file), absolute).split('\\').join('/')
      if (!relativePath.startsWith('.')) {
        relativePath = `./${relativePath}`
      }
      return `${keyword}${quote}${relativePath}${quote}`
    }
  )
  if (rewritten === source) {
    return false
  }
  writeFileSync(file, rewritten)
  return true
}

function prepareExtractedTree(root: string): { rewritten: number; pruned: number } {
  const rendererRoot = join(root, 'src', 'renderer', 'src')
  let rewritten = 0
  let pruned = 0
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      // Why: the old tree is imported, never collected. Dropping its tests keeps the
      // cache small and keeps stale specs out of every repo-wide tool's file walk.
      if (isTestSource(entry.name)) {
        rmSync(full)
        pruned++
        continue
      }
      if (isRewritableSource(entry.name) && rewriteRendererAliases(full, rendererRoot)) {
        rewritten++
      }
    }
  }
  walk(join(root, 'src'))
  return { rewritten, pruned }
}

type CheckoutStamp = { commit: string; format: number }

function readStamp(root: string): CheckoutStamp | null {
  try {
    return JSON.parse(readFileSync(join(root, 'checkout-stamp.json'), 'utf8')) as CheckoutStamp
  } catch {
    return null
  }
}

/**
 * Extract `src/` at `ref` into a cached, gitignored checkout the test can import.
 * Cached by resolved commit, so a moved tag or a bumped rewrite format re-extracts.
 */
export function materializeReleaseCheckout(ref: string): ReleaseCheckout {
  const commit = resolveCommit(ref)
  const label = ref.replace(/[^A-Za-z0-9._-]/g, '_')
  const root = join(CACHE_ROOT, label)
  const stamp = readStamp(root)
  if (stamp?.commit === commit && stamp.format === CHECKOUT_FORMAT) {
    return { ref, commit, label, root }
  }

  mkdirSync(CACHE_ROOT, { recursive: true })
  const staging = join(CACHE_ROOT, `.staging-${label}-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    // `git archive | tar -x` keeps the extraction independent of the working tree,
    // so an injected violation in the working tree cannot leak into the old side.
    execFileSync(
      'sh',
      ['-c', `git archive ${commit} ${ARCHIVE_PATHS.join(' ')} | tar -x -C "${staging}"`],
      { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    prepareExtractedTree(staging)
    writeFileSync(
      join(staging, 'checkout-stamp.json'),
      `${JSON.stringify({ commit, format: CHECKOUT_FORMAT } satisfies CheckoutStamp, null, 2)}\n`
    )
    rmSync(root, { recursive: true, force: true })
    renameSync(staging, root)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (readStamp(root)?.commit === commit) {
      return { ref, commit, label, root }
    }
    throw new Error(`Cross-version harness failed to extract ${ref} (${commit}): ${String(error)}`)
  }

  if (!existsSync(join(root, 'src', 'shared', 'terminal-stream-protocol.ts'))) {
    throw new Error(
      `Cross-version checkout for ${ref} is missing the terminal stream protocol; ` +
        'the wire surface moved and the harness needs updating.'
    )
  }
  return { ref, commit, label, root }
}
