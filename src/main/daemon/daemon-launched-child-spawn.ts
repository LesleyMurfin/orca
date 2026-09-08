import { fork, spawn, type ChildProcess } from 'node:child_process'
import { getAppEnvironment } from '../../shared/app-environment'
import { buildDurableDaemonScopeCommand } from './daemon-cgroup-scope'
import { daemonLogArgs } from './daemon-launch-paths'

export type DaemonChildSpawnOptions = {
  entryPath: string
  forkEntryPath: string
  relocatedExecPath?: string
  userDataPath: string
  socketPath: string
  tokenPath: string
  pidPath: string
  launchNonce: string
  macosLoginSessionWatch: boolean
}

function buildDaemonScriptArgs(options: DaemonChildSpawnOptions): string[] {
  const { socketPath, tokenPath, pidPath, launchNonce, entryPath, macosLoginSessionWatch } = options
  return [
    '--socket',
    socketPath,
    '--token',
    tokenPath,
    '--pid-record',
    pidPath,
    '--launch-nonce',
    launchNonce,
    '--entry-path',
    entryPath,
    '--app-version',
    getAppEnvironment().getVersion(),
    '--spawner-exec-path',
    process.execPath,
    ...(macosLoginSessionWatch ? ['--login-session-watch'] : []),
    ...daemonLogArgs()
  ]
}

/**
 * The two ways the daemon's actual OS process comes into being. `useDurableScope: false` is the
 * long-standing direct `fork()` (own POSIX process group, same systemd cgroup as the caller).
 * `useDurableScope: true` wraps the identical command line in `systemd-run --user --scope` (see
 * daemon-cgroup-scope.ts) so the resulting process lands in a cgroup that is a sibling of the
 * caller's, not a descendant — spawned via `spawn()` rather than `fork()` because the launched
 * binary is `systemd-run`, not a Node script; `spawn()` supports the same `'ipc'` stdio contract
 * `fork()` does, and the process the wrapper execs into inherits it and completes the daemon's
 * normal readiness handshake unchanged. Do not read the daemon's PID off this child: it is only
 * the daemon's because systemd-run happens to `exec` in scope mode — the daemon reports its own
 * PID in that handshake (see daemon-ready-identity.ts).
 */
export function spawnDaemonChildProcess(
  options: DaemonChildSpawnOptions,
  useDurableScope: boolean
): ChildProcess {
  const { forkEntryPath, relocatedExecPath, userDataPath, launchNonce } = options
  const scriptArgs = buildDaemonScriptArgs(options)
  // Why: detached daemons outlive dev worktrees; userData keeps process.cwd() valid after a repo/worktree is deleted.
  // Why: detached+unref outlives Electron; stdout 'ignore' (else blocks exit), stderr 'pipe' captures startup crashes lost in v1.4.129-rc.1.
  // Why: run as plain Node so Electron's GPU/display init can't interfere with node-pty's posix_spawn of the spawn-helper.
  const daemonEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Why: the detached plain-Node daemon has no AppEnvironment, but shell rcfiles must live outside swept tmp.
    ORCA_USER_DATA_PATH: userDataPath
  }
  if (!useDurableScope) {
    return fork(forkEntryPath, scriptArgs, {
      cwd: userDataPath,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // Why: run the byte-identical relocated Orca.exe so the image path sits outside the updater's kill zone.
      ...(relocatedExecPath ? { execPath: relocatedExecPath } : {}),
      env: daemonEnv
    })
  }
  const scoped = buildDurableDaemonScopeCommand(
    relocatedExecPath ?? process.execPath,
    [forkEntryPath, ...scriptArgs],
    launchNonce,
    daemonEnv
  )
  return spawn(scoped.command, scoped.args, {
    cwd: userDataPath,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: scoped.env
  })
}
