import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HostAvailableMemorySource } from '../../shared/process-stats-types'
import type { RuntimeServeStatsHost } from '../../shared/runtime-types'
import { parseLinuxAvailableMemory } from '../memory/host-memory'

// Why: `serve stats` must stay cheap enough to poll, so this reader is deliberately NOT
// `collectMemorySnapshot` (which sweeps the whole process table via `ps`) and never spawns a
// subprocess. It is `node:os` syscalls plus, on Linux only, one read of the memory-backed
// `/proc/meminfo` — a ~1.5 KiB procfs read with no disk I/O behind it, which is why it is
// synchronous rather than an await the caller has to sequence.

const KIB = 1024

/** Injection seam so the Windows-shaped (unmeasurable) path is testable on a Linux host. */
export type ServeStatsHostSources = {
  platform?: NodeJS.Platform
  loadAverage?: () => readonly number[]
  cpuCoreCount?: () => number
  totalMemoryBytes?: () => number
  freeMemoryBytes?: () => number
  /** Raw `/proc/meminfo` text, or null when procfs is unreadable here. */
  readMeminfo?: () => string | null
}

export function collectServeStatsHost(sources: ServeStatsHostSources = {}): RuntimeServeStatsHost {
  const platform = sources.platform ?? process.platform
  const total = nonNegativeNumber((sources.totalMemoryBytes ?? os.totalmem)())
  const free = Math.min(total, nonNegativeNumber((sources.freeMemoryBytes ?? os.freemem)()))
  const meminfo = platform === 'linux' ? readMeminfo(sources.readMeminfo) : null
  const available = meminfo === null ? null : parseLinuxAvailableMemory(meminfo)
  // A MemAvailable below MemFree would be nonsense, and neither can exceed physical RAM.
  const availableBytes =
    available === null ? free : Math.min(total, Math.max(free, nonNegativeNumber(available)))
  const availableSource: HostAvailableMemorySource =
    available === null ? 'free-memory' : 'proc-meminfo'

  return {
    loadAverage1m: readLoadAverage1m(platform, sources.loadAverage ?? os.loadavg),
    cpuCoreCount: sources.cpuCoreCount ? sources.cpuCoreCount() : os.cpus().length,
    memoryTotalBytes: total,
    memoryAvailableBytes: availableBytes,
    memoryAvailableSource: availableSource,
    swapUsedBytes: meminfo === null ? null : parseLinuxSwapUsed(meminfo)
  }
}

/**
 * `SwapTotal - SwapFree` in bytes, or null when either line is missing.
 *
 * A host with swap disabled reports `SwapTotal: 0 kB`, which is a real measurement of zero — only
 * an unreadable or absent line is null.
 */
export function parseLinuxSwapUsed(meminfo: string): number | null {
  const total = matchMeminfoKiB(meminfo, 'SwapTotal')
  const free = matchMeminfoKiB(meminfo, 'SwapFree')
  if (total === null || free === null) {
    return null
  }
  return Math.max(0, total - free)
}

function matchMeminfoKiB(meminfo: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s*(\\d+)\\s+kB$`, 'm').exec(meminfo)
  if (!match) {
    return null
  }
  const kib = Number(match[1])
  return Number.isFinite(kib) ? kib * KIB : null
}

// Windows has no load average: Node returns [0, 0, 0] there, and reporting that would read as an
// idle host rather than as "not measurable".
function readLoadAverage1m(
  platform: NodeJS.Platform,
  loadAverage: () => readonly number[]
): number | null {
  if (platform === 'win32') {
    return null
  }
  const value = loadAverage()[0]
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

function readMeminfo(reader: (() => string | null) | undefined): string | null {
  if (reader) {
    return reader()
  }
  try {
    return readFileSync(path.join(path.sep, 'proc', 'meminfo'), 'utf8')
  } catch {
    // A container without procfs must yield nulls, never fail `serve stats`.
    return null
  }
}

// Three readings need the same "unusable value reads as 0 bytes" floor, mirroring
// src/main/memory/host-memory.ts.
function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
