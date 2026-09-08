import { afterEach, describe, expect, it } from 'vitest'
import { collectServeStatsHost } from './serve-stats-host'
import {
  disableServeStatsEventLoopDelayMonitorForTest,
  enableServeStatsEventLoopDelayMonitor,
  readServeStatsEventLoopDelayP99Ms
} from './serve-stats-event-loop-delay'
import { setTimeout } from 'node:timers/promises'

const KIB = 1024
const GIB = 1024 ** 3

const LINUX_MEMINFO = [
  'MemTotal:       16777216 kB',
  'MemFree:          262144 kB',
  'MemAvailable:    4194304 kB',
  'SwapTotal:       8388608 kB',
  'SwapFree:        5888608 kB',
  ''
].join('\n')

function sources(overrides: Parameters<typeof collectServeStatsHost>[0] = {}) {
  return {
    platform: 'linux' as NodeJS.Platform,
    loadAverage: () => [6.85, 4.2, 3.1],
    cpuCoreCount: () => 4,
    totalMemoryBytes: () => 16 * GIB,
    freeMemoryBytes: () => 256 * 1024 * KIB,
    readMeminfo: () => LINUX_MEMINFO,
    ...overrides
  }
}

describe('collectServeStatsHost', () => {
  it('prefers Linux MemAvailable over freemem and reports swap in use', () => {
    const host = collectServeStatsHost(sources())

    expect(host).toEqual({
      loadAverage1m: 6.85,
      cpuCoreCount: 4,
      memoryTotalBytes: 16 * GIB,
      // MemAvailable (4 GiB), not MemFree (256 MiB): freemem excludes reclaimable page cache and
      // so understates what the host can actually hand out.
      memoryAvailableBytes: 4 * GIB,
      memoryAvailableSource: 'proc-meminfo',
      // #14552's "Swap in use 2.5 GB" — SwapTotal minus SwapFree.
      swapUsedBytes: 2_500_000 * KIB
    })
  })

  it('reports null, never zero, for everything a Windows host cannot measure', () => {
    // Node returns [0, 0, 0] from os.loadavg() on Windows, and a 0 here would read as an idle host
    // while the machine is saturated (#19312).
    const host = collectServeStatsHost(
      sources({
        platform: 'win32',
        loadAverage: () => [0, 0, 0],
        readMeminfo: () => {
          throw new Error('no procfs on win32')
        }
      })
    )

    expect(host.loadAverage1m).toBeNull()
    expect(host.swapUsedBytes).toBeNull()
    // Still measurable through node:os, so these stay numbers.
    expect(host.cpuCoreCount).toBe(4)
    expect(host.memoryTotalBytes).toBe(16 * GIB)
    expect(host.memoryAvailableBytes).toBe(256 * 1024 * KIB)
    expect(host.memoryAvailableSource).toBe('free-memory')
  })

  it('falls back to freemem and null swap when procfs is unreadable', () => {
    const host = collectServeStatsHost(sources({ readMeminfo: () => null }))

    expect(host.memoryAvailableSource).toBe('free-memory')
    expect(host.memoryAvailableBytes).toBe(256 * 1024 * KIB)
    expect(host.swapUsedBytes).toBeNull()
    // A missing metric must never fail the command.
    expect(host.loadAverage1m).toBe(6.85)
  })

  it('separates swap disabled (a measured zero) from swap unreadable (null)', () => {
    const swapless = collectServeStatsHost(
      sources({ readMeminfo: () => 'MemAvailable: 4194304 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' })
    )
    const unreported = collectServeStatsHost(
      sources({ readMeminfo: () => 'MemAvailable: 4194304 kB\n' })
    )

    expect(swapless.swapUsedBytes).toBe(0)
    expect(unreported.swapUsedBytes).toBeNull()
    // The memory reading still lands even when the swap lines are absent.
    expect(unreported.memoryAvailableSource).toBe('proc-meminfo')
  })

  it('keeps available memory inside physical RAM and never below freemem', () => {
    const host = collectServeStatsHost(
      sources({
        totalMemoryBytes: () => 2 * GIB,
        freeMemoryBytes: () => GIB,
        readMeminfo: () => `MemAvailable: ${99 * 1024 * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`
      })
    )

    expect(host.memoryAvailableBytes).toBe(2 * GIB)
  })
})

describe('serve stats event loop delay monitor', () => {
  afterEach(() => {
    disableServeStatsEventLoopDelayMonitorForTest()
  })

  it('reads null until the monitor is enabled and has a sample', () => {
    disableServeStatsEventLoopDelayMonitorForTest()

    expect(readServeStatsEventLoopDelayP99Ms()).toBeNull()

    enableServeStatsEventLoopDelayMonitor()

    // Enabled but nothing sampled yet is still unmeasured, never a healthy-looking 0.
    expect(readServeStatsEventLoopDelayP99Ms()).toBeNull()
  })

  it('reports a number once sampled and resets the window on read', async () => {
    disableServeStatsEventLoopDelayMonitorForTest()
    enableServeStatsEventLoopDelayMonitor()
    // Real elapsed time, deliberately: libuv samples this histogram itself, so a virtual clock
    // advances no ticks and produces no samples at all. Polls the awaited condition (a recorded
    // sample) instead of guessing one fixed sleep, so it costs one 20ms tick in the normal case.
    const first = await pollForEventLoopDelaySample()

    expect(typeof first).toBe('number')
    expect(first).toBeGreaterThanOrEqual(0)
    // Reset-on-read: the window just consumed is gone, so the next read has no sample of its own
    // rather than re-reporting a stale percentile for the rest of the runtime's life (#19312).
    expect(readServeStatsEventLoopDelayP99Ms()).toBeNull()
  })
})

async function pollForEventLoopDelaySample(): Promise<number | null> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await setTimeout(25)
    const reading = readServeStatsEventLoopDelayP99Ms()
    if (reading !== null) {
      return reading
    }
  }
  return null
}
