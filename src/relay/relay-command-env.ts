import { homedir } from 'os'
import { posix } from 'path'

const POSIX_RELAY_PATH_FALLBACKS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
const WINDOWS_RELAY_PATH_FALLBACKS = [
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Git\\bin',
  'C:\\Windows\\System32',
  'C:\\Windows'
]

// Why: the login-shell probe (`/bin/sh -lc`) sources ~/.profile but not the
// interactive ~/.bashrc, so per-user package-manager bins are invisible to
// detection even though the user can run those agents. Add them to PATH so the
// relay sees what interactive PTY sessions do — and, like the remote-node probe
// in ssh-remote-node-resolution.ts honoring NVM_DIR, prefer each tool's
// documented relocation env var over the $HOME default so relocated installs
// stay covered.
function getPosixUserInstallBinFallbacks(baseEnv: NodeJS.ProcessEnv): string[] {
  const home = baseEnv.HOME || homedir()
  if (!home) {
    return []
  }
  // GOBIN is the bin dir itself; otherwise go installs into $GOPATH/bin (default ~/go/bin).
  const goBin = baseEnv.GOBIN || posix.join(baseEnv.GOPATH || posix.join(home, 'go'), 'bin')
  // pnpm/PNPM_HOME point at the global-bin dir directly; the default lives under
  // XDG_DATA_HOME (default ~/.local/share).
  const pnpmHome =
    baseEnv.PNPM_HOME ||
    posix.join(baseEnv.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'pnpm')
  const bins = [
    posix.join(home, '.local', 'bin'),
    posix.join(home, '.npm-global', 'bin'),
    posix.join(baseEnv.CARGO_HOME || posix.join(home, '.cargo'), 'bin'),
    posix.join(baseEnv.BUN_INSTALL || posix.join(home, '.bun'), 'bin'),
    posix.join(baseEnv.DENO_INSTALL || posix.join(home, '.deno'), 'bin'),
    goBin,
    pnpmHome
  ]
  const npmPrefix = baseEnv.npm_config_prefix
  if (npmPrefix) {
    bins.push(posix.join(npmPrefix, 'bin'))
  }
  return bins
}

function getPathKey(env: NodeJS.ProcessEnv): 'PATH' | 'Path' {
  return env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH'
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function getFallbackSegments(platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return WINDOWS_RELAY_PATH_FALLBACKS
  }
  return [...POSIX_RELAY_PATH_FALLBACKS, ...getPosixUserInstallBinFallbacks(baseEnv)]
}

export function buildRelayCommandEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const key = getPathKey(baseEnv)
  const delimiter = getPathDelimiter(platform)
  const segments = new Set((baseEnv[key] ?? '').split(delimiter).filter(Boolean))

  for (const segment of getFallbackSegments(platform, baseEnv)) {
    segments.add(segment)
  }

  return {
    ...baseEnv,
    [key]: [...segments].join(delimiter)
  }
}
