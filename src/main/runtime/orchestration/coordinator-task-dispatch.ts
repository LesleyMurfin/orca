/** Picking worker terminals, sending a task's dispatch preamble, and warning about hung dispatches. */
import type { OrchestrationDb } from './db'
import type { DispatchContextRow, TaskRow } from './types'
import { buildDispatchPreamble } from './preamble'
import type { CoordinatorRuntime, WorktreeDrift } from './coordinator-runtime-contract'
import {
  DISPATCH_STALE_THRESHOLD,
  parseAllowStaleBaseFromSpec
} from './coordinator-stale-base-flag'
import { isAgentPromptStalledError } from '../agent-prompt-submission-verification'

/** `dispatched-unobserved`: the preamble landed but the worker's turn start was never observed. */
export type TaskDispatchResult = 'dispatched' | 'dispatched-unobserved' | 'stale-base-refused'

// Why: 10 min = documented heartbeat cadence (5 min) × 2, so one missed heartbeat is the earliest a dispatch can look stale.
const HUNG_THRESHOLD_MS = 10 * 60 * 1000

// Why: warn only by DEFAULT, never auto-fail — a false positive (slow but correct worker) costs more than a false negative (hung worker holding a slot); see R6 of DESIGN_DOC_PREAMBLE_FIX.md.
// `reclaim` opts into acting on the same signal, for coordinators where "until a human notices" is not a real backstop; see reclaimStaleDispatches for why the false positive cannot fire.
export function warnStaleDispatches(
  db: OrchestrationDb,
  onLog: (msg: string) => void,
  reclaim: boolean
): void {
  const thresholdIso = new Date(Date.now() - HUNG_THRESHOLD_MS).toISOString()
  const stale = db.getStaleDispatches(thresholdIso)
  const minutes = Math.round(HUNG_THRESHOLD_MS / 60000)
  for (const ctx of stale) {
    onLog(
      `Warning: worker ${ctx.assignee_handle ?? '<unknown>'} on task ${ctx.task_id} has not sent a heartbeat in ~${minutes} min (dispatch ${ctx.id})`
    )
  }
  if (!reclaim) {
    return
  }
  reclaimStaleDispatches(db, onLog, stale, minutes)
}

/**
 * Fail a dispatch that has gone silent, freeing its terminal slot.
 *
 * WHY THIS IS SAFE — the R6 false positive ("a slow worker producing correct
 * output") cannot be triggered by this detector. getStaleDispatches is not
 * age-based: it requires status = 'dispatched' (finished work excluded), a
 * dispatched_at past the grace window, and silence for 2x the heartbeat cadence.
 * A slow-but-live worker heartbeats and is never selected — the preamble requires
 * it ("Send heartbeat messages during long active work") and HUNG_THRESHOLD_MS is
 * already 2x that cadence, so a single missed beat is not enough. Selection means
 * the worker has said nothing for two full heartbeat intervals, not that it is slow.
 *
 * WHY IT MATTERS — without reclaim, a worker that ends its turn without worker_done
 * holds its slot forever, and dispatchReadyTasks stops dispatching once
 * maxConcurrent - dispatched.length <= 0. Leaked slots accumulate one per silent
 * worker until the coordinator starves PERMANENTLY while reporting healthy. Observed
 * on an unsupervised host: 19 leaked -> 3 - 19 = -16 -> 29 tasks ready, 0 dispatched,
 * indefinitely. Clearing them by hand restored dispatch on the next poll. "Until a
 * human notices" is a sound backstop for a supervised session and no backstop at all
 * for a scheduled or headless one.
 *
 * The task is failed, not re-queued: re-dispatching a task whose worker may still be
 * alive risks duplicate side effects. Freeing the slot is reversible and observable;
 * silent starvation is neither.
 */
function reclaimStaleDispatches(
  db: OrchestrationDb,
  onLog: (msg: string) => void,
  stale: DispatchContextRow[],
  minutes: number
): void {
  for (const ctx of stale) {
    const reason = `stale dispatch reclaimed: no heartbeat in ~${minutes} min`
    db.failDispatch(ctx.id, reason)
    db.updateTaskStatus(ctx.task_id, 'failed', JSON.stringify({ error: reason }))
    onLog(
      `Reclaimed slot from ${ctx.assignee_handle ?? '<unknown>'} on task ${ctx.task_id} (dispatch ${ctx.id}) — ${reason}`
    )
  }
}

export async function listAvailableWorkerTerminals(
  db: OrchestrationDb,
  runtime: CoordinatorRuntime,
  coordinatorHandle: string,
  worktree: string | undefined
): Promise<string[]> {
  try {
    const result = await runtime.listTerminals(worktree, undefined, {
      includeVisualLayouts: false
    })
    const dispatched = db.listTasks({ status: 'dispatched' })
    const busyHandles = new Set<string>()

    for (const task of dispatched) {
      const ctx = db.getDispatchContext(task.id)
      if (ctx?.assignee_handle) {
        busyHandles.add(ctx.assignee_handle)
      }
    }

    // Why: createDispatchContext's dispatch-lock guarantees correctness; this filter is only an optimization to skip busy/disconnected terminals.
    return result.terminals
      .filter(
        (t) =>
          t.handle !== coordinatorHandle && !busyHandles.has(t.handle) && t.connected && t.writable
      )
      .map((t) => t.handle)
  } catch {
    return []
  }
}

export async function dispatchTaskToWorker(params: {
  db: OrchestrationDb
  runtime: CoordinatorRuntime
  task: TaskRow
  targetHandle: string
  baseDrift: WorktreeDrift
  coordinatorHandle: string
  worktree: string | undefined
  onLog: (msg: string) => void
  // Why: the coordinator owns the failed-task list, so a circuit break is reported back instead of mutated here.
  onCircuitBroken: (taskId: string) => void
  nestedWorkerMaxDepth: number
}): Promise<TaskDispatchResult> {
  const { db, runtime, task, targetHandle, baseDrift, onLog } = params
  // Why (§3.1): drift check runs before createDispatchContext so a refusal doesn't bump failure_count (carried forward as MAX in db.ts:301-306) and burn the circuit-breaker budget; the task stays `ready` and retries next tick.
  const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(task.spec)

  if (!params.worktree) {
    // Why (§7.4): worktree is optional; with none we can't probe drift, so log that the guard is inert and proceed.
    onLog(`stale-base guard inert for ${task.id}: coordinator has no worktree selector`)
  } else if (baseDrift && baseDrift.behind > DISPATCH_STALE_THRESHOLD && !allowStale) {
    // Why (§3.1): silent-return, not failDispatch — failing a recoverable stale-base here would burn the circuit-breaker budget.
    onLog(
      `Skipping dispatch of ${task.id}: worktree is ${baseDrift.behind} commits ` +
        `behind ${baseDrift.base}. Pull/rebase the worktree, recreate it with ` +
        `--base-branch ${baseDrift.base}, or include 'allow-stale-base: true' ` +
        `in the task spec to override. Task remains in 'ready'; coordinator ` +
        `will retry on the next tick.`
    )
    return 'stale-base-refused'
  }

  const dispatchAuthority = runtime.getOrchestrationDispatchAuthority?.(targetHandle)
  const assigneePaneKey =
    dispatchAuthority?.paneKey ?? runtime.getTerminalPaneKey?.(targetHandle) ?? undefined
  const processIncarnation =
    dispatchAuthority?.paneKey && dispatchAuthority.processIncarnation
      ? dispatchAuthority.processIncarnation
      : undefined
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: targetHandle,
    assigneePaneKey,
    launchTokenHash: dispatchAuthority?.launchTokenHash ?? undefined,
    processIncarnation,
    // Why system: the automatic loop is host-local Orca code driven by
    // coordinator_runs, not a CLI caller, so it is a root by construction.
    creator: { kind: 'system' },
    maxDepth: params.nestedWorkerMaxDepth
  })

  // Why: dispatched agents use orca-dev in dev mode to reach the dev runtime's socket, not production (Section 6.4).
  const preamble = buildDispatchPreamble({
    taskId: task.id,
    dispatchId: dispatch.id,
    canDispatchSubWorkers: dispatch.depth < params.nestedWorkerMaxDepth,
    // Why (§3.4): strippedSpec drops the allow-stale-base line so the worker doesn't read the infra flag as an instruction.
    taskSpec: strippedSpec,
    coordinatorHandle: params.coordinatorHandle,
    workerHandle: targetHandle,
    devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev'),
    ...(runtime.getTerminalOrchestrationCliCommand
      ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(targetHandle) }
      : {}),
    // Why (§3.2): pass baseDrift unconditionally — the preamble builder itself gates the drift section on behind > 0.
    ...(baseDrift ? { baseDrift } : {})
  })

  // Why: surface a since-resolved decision gate's outcome to the worker via the preamble.
  const gates = db.listGates({ taskId: task.id, status: 'resolved' })
  let gateContext = ''
  if (gates.length > 0) {
    const latest = gates.at(-1)!
    gateContext = `\n\n--- DECISION GATE RESOLVED ---\nQuestion: ${latest.question}\nResolution: ${latest.resolution}\n\n---\n`
  }

  try {
    await runtime.sendTerminalAgentPrompt(targetHandle, preamble + gateContext, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: dispatch.id
    })
  } catch (err) {
    // Why (#16095): Enter is written before submission is verified, so a stall is only ever an
    // unobserved turn start — never proof the preamble is missing. Failing here would reset the
    // task to 'ready' and paste the whole preamble a second time into a worker already running it,
    // and would revoke the capability its worker_done needs.
    if (isAgentPromptStalledError(err)) {
      onLog(
        `Dispatched task ${task.id} to ${targetHandle}; turn start was not observed. ` +
          `The preamble is already in the pane, so the dispatch stays active instead of being resent.`
      )
      return 'dispatched-unobserved'
    }
    const updated = db.failDispatch(dispatch.id, err instanceof Error ? err.message : String(err))
    if (updated?.status === 'circuit_broken') {
      params.onCircuitBroken(task.id)
    }
    throw err
  }

  onLog(`Dispatched task ${task.id} to ${targetHandle}`)
  return 'dispatched'
}
