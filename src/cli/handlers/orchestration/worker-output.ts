import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'
import { formatWorkerListScope, type WorkerListRunScope } from './worker-list-run-scope'

export type LegacyWorkerReadResult = {
  dispatchId: string
  terminal: RuntimeTerminalRead
}

export type WorkerStartReceipt = {
  mode?: { detail: string }
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
  warning?: string
  effects?: unknown[]
  residualResources?: unknown[]
  nextCommands?: string[]
}

export function formatWorkerStart(value: WorkerStartReceipt): string {
  const lines = [`Worker ${value.dispatchId} [${value.state}] for ${value.taskId}`]
  // Settings-driven rather than requested, so the human line always names the mode that ran: a
  // fallback from the user's structured default is never silent.
  if (value.mode) {
    lines.push(value.mode.detail)
  }
  if (value.lastError) {
    lines.push(`${value.failedStage ?? 'start'}: ${value.lastError}`)
  } else if (value.warning) {
    lines.push(`Warning: ${value.warning}`)
  }
  if (value.state !== 'ready' && (value.state === 'outcome_unknown' || value.effects?.length)) {
    lines.push(`Effects: ${JSON.stringify(value.effects ?? [])}`)
  }
  if (
    value.state !== 'ready' &&
    (value.state === 'outcome_unknown' || value.residualResources?.length)
  ) {
    lines.push(`Residual resources: ${JSON.stringify(value.residualResources ?? [])}`)
  }
  if (value.state !== 'ready') {
    lines.push(...(value.nextCommands ?? []).map((command) => `Next command: ${command}`))
  }
  return lines.join('\n')
}

export function formatWorkerRead(
  value: OrchestrationWorkerReadResult | LegacyWorkerReadResult
): string {
  if (!('source' in value)) {
    return value.terminal.tail.join('\n')
  }
  const details = formatWorkerReadDetails(value)
  const output =
    value.source === 'terminal'
      ? value.terminal.tail.join('\n')
      : value.transcript.messages.map(formatWorkerTranscriptMessage).join('\n\n')
  if (output) {
    return `${details}\n\n${output}`
  }
  const emptyMessage =
    value.source === 'transcript'
      ? 'No transcript messages returned. This exact transcript read did not request terminal evidence.'
      : 'No terminal output returned.'
  return `${details}\n\n${emptyMessage}`
}

function formatWorkerReadDetails(value: OrchestrationWorkerReadResult): string {
  const source =
    value.source === 'transcript'
      ? `Source: transcript (provider=${value.provider})`
      : 'Source: terminal'
  const lines = [source]
  // A released archive read otherwise prints identically to a live one.
  if (value.status?.worker) {
    lines.push(`Worker: ${value.status.worker}`)
  }
  lines.push(`Archived: ${value.archived === true}`)
  // Two different verdicts: status.liveness is the PTY's, the fleet projection is the agent's.
  if (value.status?.liveness) {
    lines.push(`Terminal liveness: ${value.status.liveness}`)
  }
  if (value.projection) {
    lines.push(`Agent liveness: ${value.projection.liveness.verdict}`)
  }
  if (value.sourceExact !== undefined) {
    lines.push(`Source exact: ${value.sourceExact}`)
  }
  if (value.fallbackReason) {
    lines.push(`Fallback reason: ${value.fallbackReason}`)
  }
  if (value.contentComplete !== undefined) {
    lines.push(`Content complete: ${value.contentComplete}`)
  }
  if (value.clipping?.length) {
    lines.push(`Clipping: ${value.clipping.join(', ')}`)
  }
  lines.push(
    value.cursor
      ? `Continuation cursor (opaque; pass unchanged to --cursor): ${value.cursor}`
      : 'Continuation cursor: unavailable'
  )
  lines.push(...(value.warnings ?? []).map((warning) => `Warning: ${warning}`))
  return lines.join('\n')
}

export type WorkerReleaseReceipt = {
  dispatchId: string
  state: string
  reason?: string
  processAction: string
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

export function formatWorkerRelease(value: WorkerReleaseReceipt): string {
  const head = `Worker ${value.dispatchId} terminal [${value.state}]`
  const lines = [
    `${head}${value.reason ? ` reason=${value.reason}` : ''} process=${value.processAction}`
  ]
  if (value.archive) {
    lines.push(`archive ${value.archive.source ?? 'none'} [${value.archive.status ?? 'unknown'}]`)
  }
  if (value.lastError) {
    lines.push(value.lastError)
  }
  if (value.recovery) {
    lines.push(value.recovery)
  }
  return lines.join('\n')
}

export type WorkerReleaseBulkOutcome =
  | ({ dispatchId: string; ok: true } & Omit<WorkerReleaseReceipt, 'dispatchId'>)
  | { dispatchId: string; ok: false; error: string }

export type WorkerReleaseBulkReceipt = {
  terminalState: string
  requested: number
  released: number
  alreadyReleased: number
  retained: number
  failed: number
  releasePending: number
  outcomes: WorkerReleaseBulkOutcome[]
  scope?: WorkerListRunScope
}

export function formatWorkerReleaseBulk(value: WorkerReleaseBulkReceipt): string {
  const rows =
    value.outcomes.length === 0
      ? 'No reclaimable workers found.'
      : value.outcomes
          .map((outcome) =>
            outcome.ok
              ? `${outcome.dispatchId} [${outcome.state}] process=${outcome.processAction}`
              : `${outcome.dispatchId} [error] ${outcome.error}`
          )
          .join('\n')
  const summary = `Bulk release (${value.terminalState}): requested=${value.requested} released=${value.released} already_released=${value.alreadyReleased} retained=${value.retained} failed=${value.failed} release_pending=${value.releasePending}`
  const scopeLine = value.scope ? `\n${formatWorkerListScope(value.scope)}` : ''
  return `${rows}\n${summary}${scopeLine}`
}
