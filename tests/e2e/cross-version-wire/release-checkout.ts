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
const STABLE_DESKTOP_RELEASE_TAG = /^v\d+\.\d+\.\d+$/

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

function compareReleaseTags(a: string, b: string): number {
  const parts = (tag: string): number[] =>
    tag
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((value) => (Number.isFinite(value) ? value : 0))
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

/**
 * How far back the selector walks looking for a release this checkout can run. A
 * tree that matches none of the last {@link BASELINE_SCAN_DEPTH} releases is stale
 * enough to say so, instead of quietly pairing against a months-old build.
 */
const BASELINE_SCAN_DEPTH = 20

/**
 * The version point the harness pairs current code against. An explicit
 * {@link BASELINE_REF_ENV} wins; otherwise the newest stable desktop release whose
 * source this checkout can actually execute (see {@link runtimeDependencyMismatches}).
 *
 * Throws rather than skipping: a cross-version lane that quietly runs nothing is
 * the exact failure this harness exists to prevent.
 */
export function resolveBaselineReleaseRef(): string {
  const override = process.env[BASELINE_REF_ENV]?.trim()
  if (override) {
    return override
  }
  let tags: string[]
  try {
    tags = git(['tag', '--list', 'v[0-9]*']).split('\n').filter(Boolean)
  } catch (error) {
    throw new Error(
      `Cross-version harness could not list git tags in ${REPO_ROOT}: ${String(error)}. ` +
        `Run it inside a git checkout, or pin a ref with ${BASELINE_REF_ENV}.`
    )
  }
  const candidates = stableReleaseTagsNewestFirst(tags)
  if (candidates.length === 0) {
    throw new Error(
      `Cross-version harness found no stable desktop release tags matching vX.Y.Z (saw ${tags.length} tag(s) total). ` +
        'CI checkouts default to a shallow clone with no tags: use `actions/checkout` with `fetch-depth: 0`, ' +
        `or pin a ref with ${BASELINE_REF_ENV}.`
    )
  }
  const installed = declaredRuntimeDependencies(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  )
  const rejected: string[] = []
  for (const tag of candidates.slice(0, BASELINE_SCAN_DEPTH)) {
    let released: Record<string, string>
    try {
      released = declaredRuntimeDependencies(git(['show', `${tag}:package.json`]))
    } catch (error) {
      rejected.push(`${tag} (unreadable package.json: ${String(error)})`)
      continue
    }
    const mismatches = runtimeDependencyMismatches(installed, released)
    if (mismatches.length === 0) {
      return tag
    }
    rejected.push(`${tag} (${mismatches.join(', ')})`)
  }
  throw new Error(
    'Cross-version harness found no release whose runtime dependencies match this checkout, so no ' +
      `baseline could be imported without resolving the release's imports against packages it never ` +
      `declared. Rejected: ${rejected.join('; ')}. Rebase onto a newer main, or pin a ref with ` +
      `${BASELINE_REF_ENV}.`
  )
}

export function selectLatestStableReleaseTag(tags: string[]): string | null {
  return stableReleaseTagsNewestFirst(tags)[0] ?? null
}

function stableReleaseTagsNewestFirst(tags: string[]): string[] {
  return tags
    .filter((tag) => STABLE_DESKTOP_RELEASE_TAG.test(tag))
    .sort((a, b) => compareReleaseTags(b, a))
}

function declaredRuntimeDependencies(manifest: string): Record<string, string> {
  const parsed: unknown = JSON.parse(manifest)
  if (!parsed || typeof parsed !== 'object' || !('dependencies' in parsed)) {
    return {}
  }
  const dependencies = parsed.dependencies
  if (!dependencies || typeof dependencies !== 'object') {
    return {}
  }
  const ranges: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range === 'string') {
      ranges[name] = range
    }
  }
  return ranges
}

/**
 * Why baseline selection is gated on this: the harness imports a release's `src/`
 * but resolves that source's imports against THIS checkout's installed
 * `node_modules`. A release cut after the commit under test can pin a newer runtime
 * dependency and call an API this tree never installed — v1.4.197 moved to
 * `zod@~4.5.4` and started calling `zod.compile`, so the extracted host threw
 * before `emit({ type: 'ready' })` and every journey hung to the suite timeout
 * instead of reporting anything about the wire.
 *
 * Declared ranges are the comparison, not resolved versions: the installed tree
 * comes from this checkout's lockfile, so an identical range is the only evidence
 * available here that the release would have resolved to what is on disk.
 */
export function runtimeDependencyMismatches(
  installed: Record<string, string>,
  released: Record<string, string>
): string[] {
  const names = new Set([...Object.keys(installed), ...Object.keys(released)])
  return [...names].filter((name) => installed[name] !== released[name]).sort()
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
