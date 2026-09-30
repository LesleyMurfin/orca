import { describe, expect, it, vi } from 'vitest'
import { startManagedWslDaemon } from './wsl-managed-daemon-lifecycle'

describe('startManagedWslDaemon', () => {
  it('resolves with a ready handle once probeReady returns true', async () => {
    const kill = vi.fn()
    const spawn = vi.fn().mockResolvedValue({ kill })
    let probeCount = 0
    const probeReady = vi.fn().mockImplementation(async () => {
      probeCount++
      return probeCount >= 2
    })

    const handle = await startManagedWslDaemon({
      distro: 'Ubuntu',
      socketPath: '/tmp/orcad.sock',
      spawn,
      probeReady,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    })

    expect(handle.state).toBe('ready')
    expect(handle.distro).toBe('Ubuntu')
    expect(handle.socketPath).toBe('/tmp/orcad.sock')
    expect(spawn).toHaveBeenCalledWith('Ubuntu', '/tmp/orcad.sock')
    expect(probeReady).toHaveBeenCalledTimes(2)
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills the child and rejects on timeout when readiness never arrives', async () => {
    const kill = vi.fn()
    const spawn = vi.fn().mockResolvedValue({ kill })
    const probeReady = vi.fn().mockResolvedValue(false)

    await expect(
      startManagedWslDaemon({
        distro: 'Ubuntu',
        socketPath: '/tmp/orcad.sock',
        spawn,
        probeReady,
        pollIntervalMs: 1,
        timeoutMs: 10,
      })
    ).rejects.toThrow(/did not become ready within 10ms/)

    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('kills the child and rethrows when probeReady itself throws', async () => {
    const kill = vi.fn()
    const spawn = vi.fn().mockResolvedValue({ kill })
    const probeError = new Error('socket connect refused')
    const probeReady = vi.fn().mockRejectedValue(probeError)

    await expect(
      startManagedWslDaemon({
        distro: 'Ubuntu',
        socketPath: '/tmp/orcad.sock',
        spawn,
        probeReady,
        pollIntervalMs: 1,
        timeoutMs: 1000,
      })
    ).rejects.toBe(probeError)

    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('passes the distro and socket path through to spawn exactly once', async () => {
    const spawn = vi.fn().mockResolvedValue({ kill: vi.fn() })
    const probeReady = vi.fn().mockResolvedValue(true)

    await startManagedWslDaemon({
      distro: 'Debian',
      socketPath: '/tmp/other.sock',
      spawn,
      probeReady,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('Debian', '/tmp/other.sock')
  })
})
