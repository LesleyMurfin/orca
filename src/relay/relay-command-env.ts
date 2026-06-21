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
// interactive ~/.bashrc, so per-user package-manager bins (npm global prefix,
// cargo, bun, go, deno, pnpm) — frequently only added to PATH in the interactive
// rc — are invisible to detection even though the user can run those agents.
// Resolve them from $HOME so the relay sees what PTY sessions do; honor
// npm_config_prefix for users who relocated npm's global prefix.
function getPosixUserInstallBinFallbacks(baseEnv: NodeJS.ProcessEnv): string[] {
  const home = baseEnv.HOME || homedir()
  if (!home) {
    return []
  }
  const bins = [
    posix.join(home, '.local', 'bin'),
    posix.join(home, '.npm-global', 'bin'),
    posix.join(home, '.cargo', 'bin'),
    posix.join(home, '.bun', 'bin'),
    posix.join(home, 'go', 'bin'),
    posix.join(home, '.deno', 'bin'),
    posix.join(home, '.local', 'share', 'pnpm')
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
