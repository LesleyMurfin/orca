import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useAppStore } from '@/store'
import { getContextualTour } from '../../../../shared/contextual-tours'
import {
  clampContextualTourPanelPosition,
  getContextualTourStepCopy,
  getContextualTourStepProgress,
  getMeasurableContextualTourTarget,
  getContextualTourPanelHost,
  getVisibleContextualTourStepIndexes,
  isContextualTourAllowedForModal
} from './contextual-tour-gate'
import {
  ContextualTourOverlaySurface,
  getContextualTourFocusableElements,
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'

const PANEL_FALLBACK_SIZE = { width: 304, height: 172 }

export function ContextualTourOverlay(): JSX.Element | null {
  const activeTourId = useAppStore((s) => s.activeContextualTourId)
  const activeStepIndex = useAppStore((s) => s.activeContextualTourStepIndex)
  const activeModal = useAppStore((s) => s.activeModal)
  const blockingSurfaceVisible = useAppStore((s) => s.contextualToursBlockingSurfaceVisible)
  const markContextualToursSeen = useAppStore((s) => s.markContextualToursSeen)
  const advanceContextualTour = useAppStore((s) => s.advanceContextualTour)
  const dismissContextualTour = useAppStore((s) => s.dismissContextualTour)
  const completeContextualTour = useAppStore((s) => s.completeContextualTour)
  const cancelContextualTour = useAppStore((s) => s.cancelContextualTour)
  const [renderState, setRenderState] = useState<ActiveTourRenderState | null>(null)
  const [measureVersion, setMeasureVersion] = useState(0)
  const panelRef = useRef<HTMLElement | null>(null)
  const markedTourIdRef = useRef<string | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusedStepRef = useRef<string | null>(null)

  const activeTour = useMemo(
    () => (activeTourId ? getContextualTour(activeTourId) : null),
    [activeTourId]
  )

  useEffect(() => {
    markedTourIdRef.current = null
    setRenderState(null)
  }, [activeTourId])

  useEffect(() => {
    if (!activeTour || !activeTourId) {
      return
    }
    if (blockingSurfaceVisible || !isContextualTourAllowedForModal(activeTour, activeModal)) {
      cancelContextualTour(activeTourId)
    }
  }, [activeModal, activeTour, activeTourId, blockingSurfaceVisible, cancelContextualTour])

  useEffect(() => {
    if (!activeTourId) {
      return
    }
    const scheduleMeasure = (): void => setMeasureVersion((version) => version + 1)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    const interval = window.setInterval(scheduleMeasure, 500)
    return () => {
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
      window.clearInterval(interval)
    }
  }, [activeTourId])

  useLayoutEffect(() => {
    if (!activeTour || activeTourId === null) {
      setRenderState(null)
      return
    }

    const targetExists = (selector: string): boolean =>
      getMeasurableContextualTourTarget(selector) !== null
    const visibleStepIndexes = getVisibleContextualTourStepIndexes(activeTour, targetExists)
    const activeStep = activeTour.steps[activeStepIndex]
    const target = activeStep ? getMeasurableContextualTourTarget(activeStep.targetSelector) : null
    const progress = getContextualTourStepProgress({
      visibleStepIndexes,
      stepIndex: activeStepIndex
    })

    if (visibleStepIndexes.length === 0) {
      if (markedTourIdRef.current === activeTourId) {
        completeContextualTour(activeTourId)
      } else {
        cancelContextualTour(activeTourId)
      }
      return
    }

    if (!activeStep || !target || !progress) {
      const hasLaterStep = visibleStepIndexes.some((index) => index > activeStepIndex)
      if (hasLaterStep) {
        advanceContextualTour()
      } else if (markedTourIdRef.current === activeTourId) {
        completeContextualTour(activeTourId)
      } else {
        cancelContextualTour(activeTourId)
      }
      return
    }

    setRenderState({
      rect: target.rect,
      targetElement: target.element,
      progress,
      title: activeStep.title,
      body: getContextualTourStepCopy(activeStep),
      isLastStep: progress.current === progress.total,
      panelHost: getContextualTourPanelHost(target.element)
    })
  }, [
    activeStepIndex,
    activeTour,
    activeTourId,
    advanceContextualTour,
    cancelContextualTour,
    completeContextualTour,
    dismissContextualTour,
    measureVersion
  ])

  useEffect(() => {
    if (!activeTourId || !renderState || markedTourIdRef.current === activeTourId) {
      return
    }
    // Why: a tour is considered seen only after its first measured target
    // paints, so missing or removed surfaces can retry on a later visit.
    markedTourIdRef.current = activeTourId
    markContextualToursSeen([activeTourId])
  }, [activeTourId, markContextualToursSeen, renderState])

  useEffect(() => {
    if (!activeTourId || !renderState) {
      return
    }
    const focusKey = `${activeTourId}:${activeStepIndex}`
    if (focusedStepRef.current === focusKey) {
      return
    }
    focusedStepRef.current = focusKey

    const currentFocus = document.activeElement
    if (
      !previousFocusRef.current &&
      currentFocus instanceof HTMLElement &&
      !panelRef.current?.contains(currentFocus)
    ) {
      previousFocusRef.current = currentFocus
    }

    const timeout = window.setTimeout(() => {
      const panel = panelRef.current
      const firstFocusable = panel ? getContextualTourFocusableElements(panel)[0] : null
      ;(firstFocusable ?? panel)?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [activeStepIndex, activeTourId, renderState])

  useEffect(() => {
    if (activeTourId) {
      return
    }
    focusedStepRef.current = null
    const previousFocus = previousFocusRef.current
    previousFocusRef.current = null
    if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true })
    }
  }, [activeTourId])

  useEffect(() => {
    const panelHost = renderState?.panelHost
    if (!activeTourId || !panelHost) {
      return
    }
    // Why: Radix dialog/sheet content owns focus and z-index; hosting controls
    // there avoids outside-focus dismissal and keeps them above the backdrop.
    const previousZIndex = panelHost.style.zIndex
    const targetElement =
      renderState?.targetElement instanceof HTMLElement ? renderState.targetElement : null
    const previousOutline = targetElement?.style.outline
    const previousOutlineOffset = targetElement?.style.outlineOffset
    const previousBoxShadow = targetElement?.style.boxShadow
    const previousBorderRadius = targetElement?.style.borderRadius
    panelHost.style.zIndex = '80'
    if (targetElement) {
      targetElement.style.outline = '2px solid var(--ring)'
      targetElement.style.outlineOffset = '4px'
      targetElement.style.boxShadow = '0 0 0 2px var(--ring)'
      targetElement.style.borderRadius ||= 'var(--radius-md)'
    }
    return () => {
      panelHost.style.zIndex = previousZIndex
      if (targetElement) {
        targetElement.style.outline = previousOutline ?? ''
        targetElement.style.outlineOffset = previousOutlineOffset ?? ''
        targetElement.style.boxShadow = previousBoxShadow ?? ''
        targetElement.style.borderRadius = previousBorderRadius ?? ''
      }
    }
  }, [activeTourId, renderState])

  if (!activeTourId || !renderState) {
    return null
  }

  const viewport = {
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight
  }
  const panelRect = panelRef.current?.getBoundingClientRect()
  const panel = panelRect
    ? { width: panelRect.width, height: panelRect.height }
    : PANEL_FALLBACK_SIZE
  const panelPosition = clampContextualTourPanelPosition({
    targetRect: renderState.rect,
    viewport,
    panel
  })
  const highlightStyle = {
    left: Math.max(8, renderState.rect.left - 4),
    top: Math.max(8, renderState.rect.top - 4),
    width: Math.max(0, Math.min(viewport.width - 16, renderState.rect.width + 8)),
    height: Math.max(0, Math.min(viewport.height - 16, renderState.rect.height + 8))
  }

  return (
    <ContextualTourOverlaySurface
      activeTourId={activeTourId}
      renderState={renderState}
      panelRef={panelRef}
      highlightStyle={highlightStyle}
      panelPosition={panelPosition}
      panelHost={renderState.panelHost}
      onSkip={dismissContextualTour}
      onNext={() => {
        if (renderState.isLastStep) {
          completeContextualTour(activeTourId)
        } else {
          advanceContextualTour()
        }
      }}
      onOverlayKeyDownCapture={handleContextualTourOverlayKeyDown}
    />
  )
}
