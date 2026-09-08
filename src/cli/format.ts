import type { CliStatusResult, RuntimeServeStatsResult } from '../shared/runtime-types'
import { prepareComputerCliJsonResult } from './computer-format'
import type { RuntimeRpcSuccess } from './runtime-client'

export { formatCliError, reportCliError, type CliErrorContext } from './cli-error'

export {
  formatBrowserProfileList,
  formatScreenshot,
  formatSnapshot,
  formatTabList,
  formatTabListWithProfiles,
  formatTabProfileClone,
  formatTabProfileShow,
  formatTabShow
} from './browser-format'

export {
  formatComputerAction,
  formatGetAppState,
  formatListApps,
  formatListWindows
} from './computer-format'
export type { ComputerActionFollowUpTarget } from './computer-format'
export {
  formatProjectHostSetupCreateResult,
  formatProjectHostSetupDeleteResult,
  formatProjectHostSetupList,
  formatProjectHostSetupResult,
  formatProjectHostSetupUpdateResult,
  formatProjectList
} from './project-format'
export {
  formatTerminalClose,
  formatTerminalCreate,
  formatTerminalFocus,
  formatTerminalList,
  formatTerminalRead,
  formatTerminalRename,
  formatTerminalSend,
  formatTerminalShow,
  formatTerminalSplit,
  formatTerminalWait,
  terminalSendWarnings
} from './terminal-format'
export {
  formatAutomationList,
  formatAutomationRemoved,
  formatAutomationRun,
  formatAutomationRuns,
  formatAutomationShow
} from './automation-format'
export type { AutomationListPayload, AutomationShowPayload } from './automation-format'
export {
  formatEnvironment,
  formatEnvironmentList,
  formatMemorySnapshot,
  formatRepoList,
  formatRepoRefs,
  formatRepoShow,
  formatWorktreeList,
  formatWorktreePs,
  formatWorktreeShow
} from './workspace-format'

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(prepareComputerCliJsonResult(response), null, 2))
    return
  }
  console.log(formatter(response.result))
}

export type HostListEntry = {
  kind: 'local' | 'ssh' | 'environment'
  name: string
  id: string
  selector: string
  platform?: string
  connected?: boolean
  connectionStatus?: string
}

// Why: the selector column is the point of this command — the name alone is what callers already
// had, and passing it on the wrong axis is the mistake this output exists to prevent.
export function formatHostList(result: { hosts: HostListEntry[] }): string {
  const kindLabel: Record<HostListEntry['kind'], string> = {
    local: 'local',
    ssh: 'ssh target',
    environment: 'orca server'
  }
  return result.hosts
    .map(
      (host) =>
        `${kindLabel[host.kind].padEnd(11)} ${host.name}  ${host.platform ?? 'platform unknown'}  ${formatHostConnection(host)}  ->  ${host.selector}`
    )
    .join('\n')
}

function formatHostConnection(host: HostListEntry): string {
  if (host.kind !== 'ssh') {
    return ''
  }
  if (host.connected === undefined) {
    return `connection unknown${host.connectionStatus ? ` (${host.connectionStatus})` : ''}`
  }
  return host.connected
    ? `connected${host.connectionStatus ? ` (${host.connectionStatus})` : ''}`
    : `not connected${host.connectionStatus ? ` (${host.connectionStatus})` : ''}`
}

export function formatCliStatus(status: CliStatusResult): string {
  return [
    ...(status.target && status.target.kind === 'environment'
      ? [`target: environment ${status.target.environment}`]
      : []),
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `desktopWindowStatus: ${status.app.desktopWindowStatus ?? 'unknown'}`,
    `runtimeState: ${status.runtime.state}`,
    `runtimeReachable: ${status.runtime.reachable}`,
    `runtimeConnectionState: ${status.runtime.connectionState ?? 'unknown'}`,
    `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`
  ].join('\n')
}

export function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}

export function formatServeStats(stats: RuntimeServeStatsResult): string {
  return [
    `version: ${stats.version}`,
    `runtimeId: ${stats.runtimeId}`,
    `uptimeSeconds: ${stats.uptimeSeconds}`,
    `port: ${stats.port ?? 'none'}`,
    `agents: ${stats.counts.agents}`,
    `tasks: ${stats.counts.tasks}`,
    `terminals: ${stats.counts.terminals}`,
    `terminalsUnverifiable: ${stats.counts.terminalsUnverifiable}`,
    `worktrees: ${stats.counts.worktrees}`,
    `browserPages: ${stats.counts.browserPages}`,
    `browserPagesRetained: ${stats.counts.browserPagesRetained}`,
    `tasksByStatus: ${formatServeStatsHistogram(stats.counts.tasksByStatus)}`,
    `agentsByState: ${formatServeStatsHistogram(stats.counts.agentsByState)}`,
    `workersByTerminalState: ${formatServeStatsHistogram(stats.counts.workersByTerminalState)}`,
    // Host-wide readings, prefixed so nobody reads them as Orca's own usage. `n/a` is deliberate:
    // an unmeasurable metric rendered as 0 would read as an idle host (see RuntimeServeStatsHost).
    `host.loadAverage1m: ${formatServeStatsMeasurement(stats.host.loadAverage1m)}`,
    `host.cpuCoreCount: ${stats.host.cpuCoreCount}`,
    `host.memoryTotalBytes: ${stats.host.memoryTotalBytes}`,
    `host.memoryAvailableBytes: ${stats.host.memoryAvailableBytes}`,
    `host.memoryAvailableSource: ${stats.host.memoryAvailableSource}`,
    `host.swapUsedBytes: ${formatServeStatsMeasurement(stats.host.swapUsedBytes)}`,
    `health.eventLoopDelayP99Ms: ${formatServeStatsMeasurement(stats.health.eventLoopDelayP99Ms)}`
  ].join('\n')
}

// Why: null means "this platform/monitor cannot measure it", which must never print as a number a
// reader could mistake for a healthy zero.
function formatServeStatsMeasurement(value: number | null): string {
  return value === null ? 'n/a' : String(value)
}

// Why: one line per breakdown keeps `serve stats` scannable in a terminal, and the fixed key
// order (every key emitted, zeros included) means two runs diff cleanly.
function formatServeStatsHistogram(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, count]) => `${key}=${count}`)
    .join(' ')
}
