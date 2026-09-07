import { z } from 'zod'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod, type RpcContext, type RpcMethod } from '../../../core'
import { releaseFederatedWorker } from '../federation/federated-worker-release'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'
import { resolvePinnedFederatedServer } from './worker-observation'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  type WorkerReleaseReceipt
} from './worker-release-completion'
import {
  WorkerDispatchParams,
  WorkerListParams,
  WorkerReleaseBulkParams,
  WorkerRetainParams
} from './worker-release-schemas'
import { sweepSettledWorkerResumeFences } from '../../settled-worker-resume-fence-sweep'

export type WorkerReleaseBulkOutcome =
  | ({ ok: true } & WorkerReleaseReceipt)
  | { dispatchId: string; ok: false; error: string }

export type WorkerReleaseBulkReceipt = {
  terminalState: 'reclaimable'
  requested: number
  released: number
  alreadyReleased: number
  retained: number
  failed: number
  outcomes: WorkerReleaseBulkOutcome[]
}

// Named so `orchestration.workerReleaseBulk` can call the exact per-dispatch path a human driving
// `--dispatch <id>` in a loop already relies on. The bulk wrapper never reimplements or relaxes
// the safety checks this handler enforces (active/retained/user-owned terminals are untouched).
const WORKER_RELEASE_METHOD = defineMethod({
  name: 'orchestration.workerRelease',
  params: WorkerDispatchParams,
  handler: async (params, { runtime, orchestrationMutation }): Promise<WorkerReleaseReceipt> => {
    const db = runtime.getOrchestrationDb()
    const federated = db.getFederatedDispatch(params.dispatch)
    if (federated) {
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Remote worker-release requires a durable retry request.'
        )
      }
      return releaseFederatedWorker({
        runtime,
        server: resolvePinnedFederatedServer(runtime, federated),
        federated,
        dispatchId: params.dispatch,
        requestId: orchestrationMutation.requestId
      })
    }
    const requested = db.requestWorkerTerminalRelease(params.dispatch)
    if (requested.disposition === 'already_released') {
      return {
        dispatchId: params.dispatch,
        state: 'already_released',
        processAction: 'none',
        archive: archiveSummary(requested.resource)
      }
    }
    if (requested.disposition === 'retained') {
      const resource = requested.resource
      const processIncarnation = resource?.process_incarnation
      if (
        processIncarnation &&
        (await runtime.inspectTerminalProcessIncarnationLiveness(
          processIncarnation,
          resource.host_scope
        )) === 'exited'
      ) {
        const reconciled = db.settleDeadWorkerTerminalRelease({
          requestingDispatchId: params.dispatch,
          resourceId: resource.id,
          processIncarnation
        })
        if (reconciled.disposition === 'released') {
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
          return {
            dispatchId: params.dispatch,
            state: 'released',
            processAction: 'none',
            archive: archiveSummary(reconciled.resource)
          }
        }
      }
      return {
        dispatchId: params.dispatch,
        state: 'retained',
        reason: requested.reason,
        processAction: 'none',
        archive: archiveSummary(resource)
      }
    }
    return completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId: params.dispatch,
      resource: requested.resource
    })
  }
})

export const ORCHESTRATION_WORKER_RELEASE_METHODS: RpcMethod[] = [
  WORKER_RELEASE_METHOD,
  defineMethod({
    name: 'orchestration.workerReleaseBulk',
    params: WorkerReleaseBulkParams,
    // Convenience wrapper for the exact loop an operator otherwise runs by hand: enumerate the
    // reclaimable set via the same query `worker-list --terminal-state reclaimable` exposes, then
    // call `workerRelease` once per Dispatch. One Dispatch erroring (e.g. a transient terminal-
    // close timeout) never aborts the rest — every outcome lands in the receipt so partial
    // failures stay visible instead of silently dropped.
    handler: async (params, ctx: RpcContext): Promise<WorkerReleaseBulkReceipt> => {
      const outcomes: WorkerReleaseBulkOutcome[] = []
      let cursor: string | undefined
      do {
        const listParams = WorkerListParams.parse({
          run: params.run,
          terminalState: params.terminalState,
          ...(cursor ? { cursor } : {})
        })
        const page = (await ORCHESTRATION_WORKER_LIST_METHOD.handler(listParams, ctx)) as {
          workers: { dispatchId: string }[]
          page?: { hasMore: boolean; nextCursor: string | null }
        }
        for (const worker of page.workers) {
          try {
            const dispatchParams = WorkerDispatchParams.parse({ dispatch: worker.dispatchId })
            const receipt = (await WORKER_RELEASE_METHOD.handler(
              dispatchParams,
              ctx
            )) as WorkerReleaseReceipt
            outcomes.push({ ...receipt, ok: true })
          } catch (error) {
            outcomes.push({
              dispatchId: worker.dispatchId,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
        cursor = page.page?.hasMore ? (page.page.nextCursor ?? undefined) : undefined
      } while (cursor)
      return {
        terminalState: params.terminalState,
        requested: outcomes.length,
        released: outcomes.filter((o) => o.ok && o.state === 'released').length,
        alreadyReleased: outcomes.filter((o) => o.ok && o.state === 'already_released').length,
        retained: outcomes.filter((o) => o.ok && o.state === 'retained').length,
        failed: outcomes.filter((o) => !o.ok || o.state === 'release_unknown').length,
        outcomes
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerRetain',
    params: WorkerRetainParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const retained = db.retainWorkerTerminalResource(params.dispatch)
      if (retained.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released' as const,
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource)
        }
      }
      if (retained.disposition === 'no_owned_resource') {
        return {
          dispatchId: params.dispatch,
          state: 'retained' as const,
          reason: 'no_owned_resource' as const,
          processAction: 'none' as const,
          archive: null
        }
      }
      if (retained.disposition === 'release_committed') {
        const unknown = retained.resource.release_state === 'unknown'
        return {
          dispatchId: params.dispatch,
          state: unknown ? ('release_unknown' as const) : ('release_pending' as const),
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource),
          ...(retained.resource.release_error
            ? { lastError: retained.resource.release_error }
            : {}),
          recovery:
            'Terminal release was already committed and could not be changed to retained; inspect worker-show before taking further action.'
        }
      }
      return {
        dispatchId: params.dispatch,
        state: 'retained' as const,
        reason: 'user_requested' as const,
        processAction: 'none' as const,
        archive: archiveSummary(retained.resource)
      }
    }
  }),
  ORCHESTRATION_WORKER_LIST_METHOD,
  defineMethod({
    name: 'orchestration.workerTerminalUserInput',
    // `sessionId` addresses a worker that IS a structured agent session. Its pane key is a random
    // identity credential that never leaves main, so the caller names the session and the owning
    // runtime resolves it — a renderer echoing the pane key back would make it learnable.
    params: z
      .object({ paneKey: z.string().min(1).optional(), sessionId: z.string().min(1).optional() })
      .refine((value) => Boolean(value.paneKey ?? value.sessionId), 'Missing paneKey or sessionId'),
    // Real user keystrokes durably relinquish orchestration ownership on the owning runtime, so
    // restarts, SSH drops, remote viewing, and renderer remounts cannot erase the takeover.
    handler: (params, { runtime }) => {
      // A structured worker reports by session id; it has no pane of its own to name.
      const paneKey =
        params.paneKey ?? runtime.getStructuredWorkerPaneKeyForSession(params.sessionId!)
      const changed = paneKey
        ? runtime.getOrchestrationDb().markWorkerTerminalUserOwned(paneKey)
        : 0
      if (changed > 0) {
        // Only a real takeover retires the resource; ordinary panes report here too and must not
        // pay for a plan read on every keystroke window.
        sweepSettledWorkerResumeFences(runtime)
      }
      return { changed }
    }
  })
]
