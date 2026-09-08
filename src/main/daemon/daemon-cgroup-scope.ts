/**
 * Escaping the service cgroup for the detached PTY daemon.
 *
 * `daemon-launched-child.ts` forks the daemon with `detached: true`, which gives it its own
 * POSIX process group (setsid) so it survives its parent's process-group signals. That is not
 * cgroup isolation: under a combined systemd unit (`orca-serve.service` / `orca-serve@<slot>`),
 * the daemon and every PTY it owns remain in the unit's cgroup. `KillMode=mixed` sends the
 * graceful stop signal only to the unit's main process, but at the stop timeout it falls back to
 * `SIGKILL`-ing every process still in the cgroup — the daemon and its PTYs included.
 * `KillMode=control-group` is worse: the whole cgroup is signalled immediately. Either way, a
 * `systemctl stop`/`restart` of the combined unit destroys every live terminal, even though the
 * daemon is otherwise built to survive its parent (see `daemon-launched-child.ts`,
 * `daemon-provider-init.ts`'s "adopt, don't replace" logic, and `orcad-entry.ts`'s
 * `refreshRestoredOrchestrationAuthority`/`reconcileLegacyWorkerTerminals` re-adoption path).
 *
 * The fix is to put the daemon in a cgroup that is a *sibling* of the service unit's cgroup, not
 * a descendant of it, so systemd's unit-scoped kill (whichever `KillMode`) never reaches it.
 * `systemd-run --user --scope` does exactly this: it registers a transient scope unit under the
 * invoking OS user's own systemd user manager and execs the target command into it. The daemon
 * keeps running after the transient scope's `--collect` flag lets systemd forget the unit once it
 * exits, so this does not accumulate unit-table state over time.
 *
 * This only works when there is a systemd instance to ask: PID 1 must be systemd (so a restart of
 * *some* unit is even a meaningful concept), and the OS user must have a reachable `--user`
 * manager (an active login session, or `loginctl enable-linger <user>` for a service account with
 * no interactive session). Every other platform, and every Linux host without that user manager
 * reachable, must fall back to the existing direct-fork behavior unchanged — this module always
 * fails closed to "not supported" rather than guessing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SYSTEMD_RUN_BINARY = 'systemd-run'
const UNIT_NAME_PREFIX = 'orca-daemon-'

/** systemd unit names are restricted to `[A-Za-z0-9:_.\-@]`; sanitize defensively even though
 *  `launchNonce` is already a UUID (hyphens and hex digits only). */
export function daemonScopeUnitName(launchNonce: string): string {
  return `${UNIT_NAME_PREFIX}${launchNonce.replace(/[^A-Za-z0-9:_.-]/g, '-')}`
}

/** The conventional per-UID runtime dir that `loginctl enable-linger <user>` (and every normal
 *  login session) provisions, computed independently of any environment variable. `canonicalDir`
 *  parameters elsewhere default to calling this so production always uses the real value; tests
 *  inject a fake path instead. */
function canonicalUserRuntimeDir(): string | null {
  if (typeof process.getuid !== 'function') {
    return null
  }
  try {
    return `/run/user/${process.getuid()}`
  } catch {
    return null
  }
}

/** Why `statSync(...).isSocket()` instead of `existsSync`: a stale regular file or leftover
 *  directory left behind at `bus` would pass an `existsSync` check but can never be dialed as a
 *  D-Bus socket. This is the cheapest side-effect-free approximation of "connectable" available
 *  without actually opening a D-Bus connection (this probe must stay side-effect-free). */
function hasReachableBus(runtimeDir: string): boolean {
  try {
    return statSync(join(runtimeDir, 'bus')).isSocket()
  } catch {
    return false
  }
}

/**
 * Resolves the `XDG_RUNTIME_DIR` that actually hosts this OS user's systemd `--user` bus.
 *
 * Deliberately does NOT start from the current process's own `XDG_RUNTIME_DIR` env var. Ground
 * truth from mtl-02: `orca-serve@factory.service` sets `RuntimeDirectory=factory`, a hardening
 * directive that makes systemd export `XDG_RUNTIME_DIR=/run/orca_serve/factory` into the unit's
 * own process — a private scratch directory that shares the env var's name but has nothing to do
 * with the user session bus. `/proc/<pid>/environ` on that host showed exactly that path and
 * `DBUS_SESSION_BUS_ADDRESS=disabled:`, while the real bus was reachable the whole time under
 * `/run/user/985` (confirmed via `systemctl --user is-system-running` with that dir exported by
 * hand). Trusting the process's own env var here made the probe report "unsupported" on every
 * host hardened this way, even though a real per-UID bus was one directory away. So the
 * conventional per-UID path is always tried first; the process's own `XDG_RUNTIME_DIR` is only a
 * fallback for hosts that legitimately have no `/run/user/<uid>` at all (non-standard runtime
 * layouts) but do have a working bus wherever their own environment happens to point.
 *
 * `canonicalDir` is injectable for tests; production callers let it default to the real
 * `/run/user/<uid>` computed from this process's own `getuid()`.
 */
function resolveUserRuntimeDir(
  env: NodeJS.ProcessEnv,
  canonicalDir: string | null = canonicalUserRuntimeDir()
): string | null {
  if (canonicalDir && hasReachableBus(canonicalDir)) {
    return canonicalDir
  }
  if (env.XDG_RUNTIME_DIR && hasReachableBus(env.XDG_RUNTIME_DIR)) {
    return env.XDG_RUNTIME_DIR
  }
  return null
}

/**
 * Best-effort, side-effect-free capability probe. Never throws; any uncertainty resolves to
 * "not supported" so the caller falls back to the existing, already-proven direct-fork launch.
 */
export function isDurableDaemonScopeSupported(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  canonicalRuntimeDir: string | null = canonicalUserRuntimeDir()
): boolean {
  if (platform !== 'linux') {
    return false
  }
  if (!existsSync('/run/systemd/system')) {
    // Not booted under systemd (e.g. a plain container without systemd as PID 1) — a unit
    // restart isn't the failure mode there, and systemd-run has nothing to talk to anyway.
    return false
  }
  if (!resolveUserRuntimeDir(env, canonicalRuntimeDir)) {
    // No reachable user bus/session at the real per-UID path or the process's own env var —
    // systemd-run --user would just fail to connect.
    return false
  }
  try {
    execFileSync(SYSTEMD_RUN_BINARY, ['--version'], { stdio: 'ignore', timeout: 2_000 })
  } catch {
    return false
  }
  return true
}

export type DurableDaemonScopeCommand = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Wraps the daemon's real command line in `systemd-run --user --scope`, so the process that
 * ultimately execs into `execPath forkEntryPath ...scriptArgs` lands in its own transient scope
 * cgroup instead of inheriting the caller's.
 */
export function buildDurableDaemonScopeCommand(
  execPath: string,
  scriptArgs: string[],
  launchNonce: string,
  env: NodeJS.ProcessEnv,
  canonicalRuntimeDir: string | null = canonicalUserRuntimeDir()
): DurableDaemonScopeCommand {
  const runtimeDir = resolveUserRuntimeDir(env, canonicalRuntimeDir)
  return {
    command: SYSTEMD_RUN_BINARY,
    args: [
      '--user',
      '--scope',
      `--unit=${daemonScopeUnitName(launchNonce)}`,
      '--collect',
      '--quiet',
      '--',
      execPath,
      ...scriptArgs
    ],
    // Explicit, not inherited: the daemon must land in the same user manager the resolution
    // above just confirmed is reachable, regardless of what this spread `env`'s own
    // `XDG_RUNTIME_DIR` says (see `resolveUserRuntimeDir` for why that value can be wrong).
    env: runtimeDir ? { ...env, XDG_RUNTIME_DIR: runtimeDir } : { ...env }
  }
}

/**
 * Ground truth, read from the process's own cgroup membership rather than trusted from the
 * launcher's intent — a daemon that fell back (or was adopted from before this fix existed)
 * must not misreport isolation it does not actually have. Returns the owning unit name (e.g.
 * `orca-daemon-<nonce>.scope`) when isolated, or `null` when running in the parent's service
 * unit, on a non-Linux platform, or when cgroup membership cannot be determined.
 */
export function detectOwnCgroupScopeUnit(
  platform: NodeJS.Platform = process.platform,
  cgroupPath = '/proc/self/cgroup'
): string | null {
  if (platform !== 'linux') {
    return null
  }
  let contents: string
  try {
    contents = readFileSync(cgroupPath, 'utf8')
  } catch {
    return null
  }
  for (const line of contents.split('\n')) {
    // cgroup v2 unified hierarchy: "0::/user.slice/.../orca-daemon-<nonce>.scope"
    // cgroup v1 systemd controller: "1:name=systemd:/user.slice/.../orca-daemon-<nonce>.scope"
    const segments = line.split('/')
    const last = segments.at(-1)?.trim()
    if (last && last.startsWith(UNIT_NAME_PREFIX) && last.endsWith('.scope')) {
      return last
    }
  }
  return null
}
