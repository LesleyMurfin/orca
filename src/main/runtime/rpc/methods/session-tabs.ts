import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

const WorktreeTabSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const ActivateTab = WorktreeTabSelector.extend({
  tabId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing tab id'))
})

const SaveMarkdownTab = ActivateTab.extend({
  baseVersion: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing base version')),
  content: z.string()
})

export const SESSION_TAB_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelector,
    handler: async (params, { runtime }) => runtime.listMobileSessionTabs(params.worktree)
  }),
  defineMethod({
    name: 'session.tabs.activate',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.activateMobileSessionTab(params.worktree, params.tabId)
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribe',
    params: WorktreeTabSelector,
    handler: async (params, { runtime, connectionId }, emit) => {
      const initial = await runtime.listMobileSessionTabs(params.worktree)
      emit({ type: 'snapshot', ...initial })

      const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        if (snapshot.worktree === initial.worktree) {
          emit({ type: 'updated', ...snapshot })
        }
      })
      const subscriptionId = `session.tabs:${connectionId ?? 'local'}:${initial.worktree}`
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          unsubscribe()
        },
        connectionId
      )
    }
  }),
  defineMethod({
    name: 'markdown.readTab',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.readMobileMarkdownTab(params.worktree, params.tabId)
  }),
  defineMethod({
    name: 'markdown.saveTab',
    params: SaveMarkdownTab,
    handler: async (params, { runtime }) =>
      runtime.saveMobileMarkdownTab(
        params.worktree,
        params.tabId,
        params.baseVersion,
        params.content
      )
  })
]
