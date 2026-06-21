// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDetectedAgents } from './useDetectedAgents'

const detectRemoteAgents = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

function HookProbe({ connectionId }: { connectionId: string }): null {
  useDetectedAgents({ kind: 'ssh', connectionId })
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderProbe(connectionId: string): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { connectionId }))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  detectRemoteAgents.mockReset().mockResolvedValue([])
  globalThis.window.api = {
    preflight: { detectRemoteAgents }
  } as unknown as Window['api']
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
})

describe('useDetectedAgents (ssh call site)', () => {
  it('fires remote detection once on mount and does not thrash after an empty result', async () => {
    const root = await renderProbe('ssh-1')

    // The effect fires detection once; an empty [] is stored (not null), so the
    // detectedIds===null guard prevents a re-detect loop on the same surface.
    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().remoteDetectedAgentIds['ssh-1']).toEqual([])

    // Re-rendering the same connection must not trigger another probe.
    await act(async () => {
      root.render(createElement(HookProbe, { connectionId: 'ssh-1' }))
    })
    await flushEffects()

    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
  })
})
