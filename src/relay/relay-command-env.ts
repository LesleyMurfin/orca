import { homedir } from 'os'
import { posix, win32 } from 'path'

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
function getPosixUserInstallBinFallbacks(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const home = baseEnv.HOME || homedir()
  const bins = baseEnv.PNPM_HOME ? [baseEnv.PNPM_HOME] : []
  if (home) {
    bins.push(
      posix.join(home, '.local', 'bin'),
      posix.join(home, '.npm-global', 'bin'),
      posix.join(home, '.cargo', 'bin'),
      posix.join(home, '.bun', 'bin'),
      posix.join(home, 'go', 'bin'),
      posix.join(home, '.deno', 'bin'),
      posix.join(home, '.local', 'share', 'pnpm')
    )
    if (platform === 'darwin') {
      bins.push(posix.join(home, 'Library', 'pnpm'))
    }
  }
  const npmPrefix = baseEnv.npm_config_prefix
  if (npmPrefix) {
    bins.push(posix.join(npmPrefix, 'bin'))
  }
  return bins
}

function getWindowsUserInstallBinFallbacks(baseEnv: NodeJS.ProcessEnv): string[] {
  const bins = baseEnv.PNPM_HOME ? [baseEnv.PNPM_HOME] : []
  if (baseEnv.APPDATA) {
    bins.push(win32.join(baseEnv.APPDATA, 'npm'))
  }
  if (baseEnv.LOCALAPPDATA) {
    bins.push(win32.join(baseEnv.LOCALAPPDATA, 'pnpm'))
  }
  if (baseEnv.USERPROFILE) {
    bins.push(
      win32.join(baseEnv.USERPROFILE, '.cargo', 'bin'),
      win32.join(baseEnv.USERPROFILE, '.bun', 'bin'),
      win32.join(baseEnv.USERPROFILE, 'go', 'bin'),
      win32.join(baseEnv.USERPROFILE, '.deno', 'bin')
    )
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
    return [...WINDOWS_RELAY_PATH_FALLBACKS, ...getWindowsUserInstallBinFallbacks(baseEnv)]
  }
  return [...POSIX_RELAY_PATH_FALLBACKS, ...getPosixUserInstallBinFallbacks(baseEnv, platform)]
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
