import { useEffect, useRef } from 'react'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { hasFeatureInteraction } from '../../../../shared/feature-interactions'
import { useAppStore } from '@/store'

const TOUR_SOURCES = {
  'workspace-board': 'workspace_board_visible',
  'workspace-agent-sessions': 'workspace_agent_sessions_visible',
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
  const suppressContextualTour = useAppStore((s) => s.suppressContextualTour)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeModal = useAppStore((s) => s.activeModal)
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const activeContextualTourSource = useAppStore((s) => s.activeContextualTourSource)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const contextualToursSeenIds = useAppStore((s) => s.contextualToursSeenIds)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const contextualTourShownThisSession = useAppStore((s) => s.contextualTourShownThisSession)
  const contextualToursOnboardingVisible = useAppStore((s) => s.contextualToursOnboardingVisible)
  const contextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.contextualToursBlockingSurfaceVisible
  )
  const enabledInteractionSnapshotRef = useRef<{
    id: ContextualTourId
    source: string
    wasPreviouslyInteracted: boolean
  } | null>(null)

  useEffect(() => {
    if (!enabled || !persistedUIReady) {
      enabledInteractionSnapshotRef.current = null
      return
    }
    if (
      enabledInteractionSnapshotRef.current?.id === id &&
      enabledInteractionSnapshotRef.current.source === source
    ) {
      return
    }
    enabledInteractionSnapshotRef.current = {
      id,
      source,
      // Why: recording writes featureInteractions; subscribing here would retrigger
      // this effect and repeatedly persist the same enabled source.
      wasPreviouslyInteracted: hasFeatureInteraction(useAppStore.getState().featureInteractions, id)
    }
    recordFeatureInteraction(id)
  }, [enabled, id, persistedUIReady, recordFeatureInteraction, source])

  useEffect(() => {
    // Why: source disable should end through the overlay so a shown tour gets
    // a cancellation outcome; the store flag also lets pre-render attempts retry.
    if (!enabled && activeContextualTourId === id && activeContextualTourSource === source) {
      suppressContextualTour(id, source)
    }
  }, [
    activeContextualTourId,
    activeContextualTourSource,
    enabled,
    id,
    source,
    suppressContextualTour
  ])

  useEffect(() => {
    return () => {
      const state = useAppStore.getState()
      // Why: surfaces like sheets can unmount without rendering an `enabled=false`
      // pass, so suppress their active tour during cleanup too.
      if (state.activeContextualTourId === id && state.activeContextualTourSource === source) {
        state.suppressContextualTour(id, source)
      }
    }
  }, [id, source])

  useEffect(() => {
    if (
      !enabled ||
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !persistedUIReady ||
      contextualToursAutoEligible !== true ||
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
        const snapshot = enabledInteractionSnapshotRef.current
        requestContextualTour(
          id,
          source,
          snapshot?.id === id && snapshot.source === source
            ? snapshot.wasPreviouslyInteracted
            : hasFeatureInteraction(featureInteractions, id)
        )
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
    contextualToursAutoEligible,
    contextualTourShownThisSession,
    contextualToursOnboardingVisible,
    contextualToursSeenIds,
    enabled,
    featureInteractions,
    id,
    persistedUIReady,
    requestContextualTour,
    source
  ])
}
