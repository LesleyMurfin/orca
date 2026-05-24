import { useEffect } from 'react'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { useAppStore } from '@/store'

const TOUR_SOURCES = {
  'right-sidebar': 'right_sidebar_visible',
  'workspace-board': 'workspace_board_visible',
  browser: 'browser_visible',
  tasks: 'tasks_open',
  automations: 'automations_open',
  'workspace-creation': 'workspace_creation_visible'
} satisfies Record<ContextualTourId, string>

export function useContextualTour(
  id: ContextualTourId,
  enabled: boolean,
  source: string = TOUR_SOURCES[id]
): void {
  const requestContextualTour = useAppStore((s) => s.requestContextualTour)
  const cancelContextualTour = useAppStore((s) => s.cancelContextualTour)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeModal = useAppStore((s) => s.activeModal)
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const activeContextualTourSource = useAppStore((s) => s.activeContextualTourSource)
  const contextualToursSeenIds = useAppStore((s) => s.contextualToursSeenIds)
  const contextualTourShownThisSession = useAppStore((s) => s.contextualTourShownThisSession)
  const contextualToursOnboardingVisible = useAppStore((s) => s.contextualToursOnboardingVisible)
  const contextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.contextualToursBlockingSurfaceVisible
  )

  useEffect(() => {
    // Why: a tour can be registered by multiple surfaces; an inactive sibling
    // must not cancel the instance started by the visible surface.
    if (!enabled && activeContextualTourId === id && activeContextualTourSource === source) {
      cancelContextualTour(id)
    }
  }, [
    activeContextualTourId,
    activeContextualTourSource,
    cancelContextualTour,
    enabled,
    id,
    source
  ])

  useEffect(() => {
    if (
      !enabled ||
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !persistedUIReady ||
      contextualToursOnboardingVisible ||
      contextualToursBlockingSurfaceVisible ||
      activeContextualTourId !== null ||
      contextualTourShownThisSession ||
      contextualToursSeenIds.includes(id)
    ) {
      return
    }

    let frame: number | null = null
    let attempts = 0
    const request = (): void => {
      if (frame !== null) {
        return
      }
      attempts += 1
      frame = window.requestAnimationFrame(() => {
        frame = null
        requestContextualTour(id, source)
      })
    }

    request()
    const timeout = window.setTimeout(request, 250)
    const observer =
      typeof MutationObserver === 'undefined' || !document.body
        ? null
        : new MutationObserver(request)
    observer?.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-contextual-tour-target', 'hidden', 'style']
    })
    // Why: native prompts and async surface hydration can pause or miss the
    // first target measurement; retry briefly without long-lived polling.
    const interval = window.setInterval(() => {
      if (attempts >= 20) {
        window.clearInterval(interval)
        return
      }
      request()
    }, 500)

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      window.clearTimeout(timeout)
      window.clearInterval(interval)
      observer?.disconnect()
    }
  }, [
    activeContextualTourId,
    contextualToursBlockingSurfaceVisible,
    activeModal,
    contextualTourShownThisSession,
    contextualToursOnboardingVisible,
    contextualToursSeenIds,
    enabled,
    id,
    persistedUIReady,
    requestContextualTour,
    source
  ])
}
