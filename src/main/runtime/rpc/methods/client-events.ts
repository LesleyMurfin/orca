import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

let clientEventSubscriptionSeq = 0

const ClientEventsUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

export const CLIENT_EVENT_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'runtime.clientEvents.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId, clientId }, emit) => {
      await new Promise<void>((resolve) => {
        // Why: pass clientId so the runtime can self-exclude peers from an
        // origin-gated activateWorktree event (client view decoupling).
        const unsubscribe = runtime.onClientEvent((event) => {
          emit(event)
        }, clientId)

        const seq = ++clientEventSubscriptionSeq
        const subscriptionId = `runtime-client-events-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        emit({ type: 'ready', subscriptionId })
      })
    }
  }),
  defineMethod({
    name: 'runtime.clientEvents.unsubscribe',
    params: ClientEventsUnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      const expectedPrefix = `runtime-client-events-${connectionId ?? 'inproc'}-`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
