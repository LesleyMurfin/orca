import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { buildRelayCommandEnv } from './relay-command-env'

// homedir() is the fallback when the relay env carries no HOME; mock it so the
// fallback path is deterministic and the "no resolvable home" branch is reachable.
vi.mock('os', () => ({ homedir: vi.fn(() => '/home/fallback') }))

describe('buildRelayCommandEnv', () => {
  it('adds POSIX git locations when the relay starts with an empty PATH', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '' }, 'linux')

    expect(env.PATH?.split(':')).toEqual(
      expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin'])
    )
    expect(env.HOME).toBe('/home/me')
  })

  it('preserves Windows Path casing and adds Git install locations', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools' }, 'win32')

    expect(env.PATH).toBeUndefined()
    expect(env.Path?.split(';')).toEqual(
      expect.arrayContaining(['C:\\Tools', 'C:\\Program Files\\Git\\cmd'])
    )
  })

  it('adds per-user package-manager bins resolved from HOME on POSIX', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toEqual(
      expect.arrayContaining([
        '/home/me/.local/bin',
        '/home/me/.npm-global/bin',
        '/home/me/.cargo/bin',
        '/home/me/.bun/bin',
        '/home/me/go/bin',
        '/home/me/.deno/bin',
        '/home/me/.local/share/pnpm'
      ])
    )
  })

  it('honors a relocated npm global prefix via npm_config_prefix', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', npm_config_prefix: '/opt/npm' },
      'linux'
    )

    expect(env.PATH?.split(':')).toContain('/opt/npm/bin')
  })

  it('honors PNPM_HOME on POSIX', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', PNPM_HOME: '/custom/pnpm' },
      'linux'
    )

    expect(env.PATH?.split(':')).toContain('/custom/pnpm')
  })

  it('adds the macOS pnpm home for Darwin relay envs', () => {
    const env = buildRelayCommandEnv({ HOME: '/Users/me', PATH: '' }, 'darwin')

    expect(env.PATH?.split(':')).toContain('/Users/me/Library/pnpm')
  })

  it('does not leak POSIX user bins into a Windows relay env', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools', HOME: '/home/me' }, 'win32')

    expect(env.Path).not.toContain('/home/me/.local/bin')
    expect(env.Path).not.toContain('.npm-global')
  })

  it('adds Windows user package-manager bins to a Windows relay env', () => {
    const env = buildRelayCommandEnv(
      {
        Path: 'C:\\Tools',
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\me',
        PNPM_HOME: 'C:\\Users\\me\\AppData\\Local\\pnpm-home'
      },
      'win32'
    )
    const segments = env.Path?.split(';') ?? []

    expect(segments).toEqual(
      expect.arrayContaining([
        'C:\\Users\\me\\AppData\\Roaming\\npm',
        'C:\\Users\\me\\AppData\\Local\\pnpm',
        'C:\\Users\\me\\.cargo\\bin',
        'C:\\Users\\me\\.bun\\bin',
        'C:\\Users\\me\\go\\bin',
        'C:\\Users\\me\\.deno\\bin',
        'C:\\Users\\me\\AppData\\Local\\pnpm-home'
      ])
    )
  })

  it('deduplicates a user bin already present in the inherited PATH', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/home/me/.local/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.filter((s) => s === '/home/me/.local/bin')).toHaveLength(1)
  })

  it('falls back to homedir() for user bins when the relay env carries no HOME', () => {
    const env = buildRelayCommandEnv({ PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toContain('/home/fallback/.local/bin')
    expect(env.PATH).not.toContain('undefined')
  })

  it('adds only POSIX fallbacks when no home directory can be resolved', () => {
    vi.mocked(homedir).mockReturnValueOnce('')
    const env = buildRelayCommandEnv({ PATH: '' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toEqual(expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin']))
    expect(segments.some((s) => s.includes('.local/bin'))).toBe(false)
  })

  it('keeps inherited PATH entries ahead of the appended fallbacks', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/custom/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/custom/bin')).toBeLessThan(segments.indexOf('/usr/bin'))
  })

  it('orders the static POSIX fallbacks ahead of the resolved user bins', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/usr/bin')).toBeLessThan(segments.indexOf('/home/me/.local/bin'))
  })

  it('treats an empty-string HOME as absent and falls back to homedir()', () => {
    const env = buildRelayCommandEnv({ HOME: '', PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toContain('/home/fallback/.local/bin')
  })
})
