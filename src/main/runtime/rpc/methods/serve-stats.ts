import { defineMethod } from '../core'

export const SERVE_STATS_METHODS = [
  defineMethod({
    name: 'serve.stats',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => runtime.getServeStats()
  })
]
