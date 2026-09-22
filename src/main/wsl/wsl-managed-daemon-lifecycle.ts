// Readiness/lifecycle contract for a native Linux `orcad` daemon spawned
// inside WSL2 (the "Native Managed WSL2 Daemon" path).
//
// Why: cross-OS execution today routes every filesystem and PTY operation
// through the WSL 9P bridge from wsl-runner.ts, at 40-90 MB/s and with
// unreliable ConPTY signal propagation. Spawning a real Linux `orcad`
// process *inside* WSL2 and speaking to it over a localhost loopback RPC
// gets 100% POSIX-native openpty(3) semantics and ext4-speed disk I/O for
// the 95% of Windows developers who already use WSL2 as their real
// workspace, without touching the ConPTY/FFI path wsl-runner.ts covers.

export type WslDaemonState = 'starting' | 'ready' | 'stopped' | 'failed'

export interface WslDaemonHandle {
  readonly distro: string
  readonly socketPath: string
  state: WslDaemonState
}

export interface WslDaemonSpawnOptions {
  distro: string
  socketPath: string
  /** Spawns the process; resolves once the child has launched, not once it is ready. */
  spawn: (distro: string, socketPath: string) => Promise<{ kill: () => void }>
  /** Polls for the daemon's readiness sentinel (e.g. a socket connect probe). */
  probeReady: (socketPath: string) => Promise<boolean>
  pollIntervalMs?: number
  timeoutMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Starts a managed WSL2 `orcad` daemon and resolves once it reports ready,
 * or rejects on timeout. The returned handle's `state` is mutated in place
 * so callers holding a reference always observe the current lifecycle
 * state without re-polling.
 */
export async function startManagedWslDaemon(options: WslDaemonSpawnOptions): Promise<WslDaemonHandle> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const handle: WslDaemonHandle = {
    distro: options.distro,
    socketPath: options.socketPath,
    state: 'starting',
  }

  const child = await options.spawn(options.distro, options.socketPath)
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      if (await options.probeReady(options.socketPath)) {
        handle.state = 'ready'
        return handle
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, pollIntervalMs)
      await promise
    }
  } catch (error) {
    handle.state = 'failed'
    child.kill()
    throw error
  }

  handle.state = 'failed'
  child.kill()
  throw new Error(`WSL daemon on '${options.distro}' did not become ready within ${timeoutMs}ms`)
}
