import { z } from 'zod'
import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../../shared/orchestration-fleet-projection'
import { WORKER_RELEASE_BULK_TERMINAL_STATES } from '../../../../../../shared/orchestration-worker-output'
import { requiredString } from '../../../schemas'

export const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })
export const WorkerRetainParams = WorkerDispatchParams.strict()

export const WorkerReleaseBulkParams = z.object({
  terminalState: z.enum(WORKER_RELEASE_BULK_TERMINAL_STATES),
  run: z.string().min(1).optional()
})

export const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

export const WorkerListParams = z.object({
  run: z.string().min(1).optional(),
  terminalState: z.enum(WORKER_TERMINAL_LIST_STATES).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(ORCHESTRATION_FLEET_PAGE_MAX).optional(),
  includeRemote: z.boolean().optional(),
  paginate: z.boolean().optional()
})
