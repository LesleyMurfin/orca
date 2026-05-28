import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX
} from 'react'
import { useAppStore } from '@/store'
import { getContextualTour, type ContextualTourId } from '../../../../shared/contextual-tours'
import type { ContextualTourOutcome } from '../../../../shared/feature-education-telemetry'
import {
  trackContextualTourOutcome,
  trackContextualTourShown
} from '@/lib/feature-education-telemetry'
import {
  getContextualTourStepCopy,
  getContextualTourStepProgress,
  getContextualTourOutcomeStepTotal,
  getMeasurableContextualTourTarget,
  getContextualTourPanelHost,
  getVisibleContextualTourStepIndexes,
  isContextualTourAllowedForModal
} from './contextual-tour-gate'
import {
  clampContextualTourPanelPosition,
  getContextualTourPanelCssPosition
} from './contextual-tour-panel-position'
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
  const activeTourSource = useAppStore((s) => s.activeContextualTourSource)
  const wasFeaturePreviouslyInteracted = useAppStore(
    (s) => s.activeContextualTourWasFeaturePreviouslyInteracted
  )
  const activeModal = useAppStore((s) => s.activeModal)
  const onboardingVisible = useAppStore((s) => s.contextualToursOnboardingVisible)
  const blockingSurfaceVisible = useAppStore((s) => s.contextualToursBlockingSurfaceVisible)
  const activeTourSuppressed = useAppStore((s) => s.activeContextualTourSuppressed)
  const markContextualToursSeen = useAppStore((s) => s.markContextualToursSeen)
  const advanceContextualTour = useAppStore((s) => s.advanceContextualTour)
  const regressContextualTour = useAppStore((s) => s.regressContextualTour)
  const dismissContextualTour = useAppStore((s) => s.dismissContextualTour)
  const completeContextualTour = useAppStore((s) => s.completeContextualTour)
  const cancelContextualTour = useAppStore((s) => s.cancelContextualTour)
  const [renderState, setRenderState] = useState<ActiveTourRenderState | null>(null)
  const [measureVersion, setMeasureVersion] = useState(0)
  const panelRef = useRef<HTMLElement | null>(null)
  const markedTourIdRef = useRef<string | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusedStepRef = useRef<string | null>(null)
  const telemetryTourIdRef = useRef<ContextualTourId | null>(null)
  const telemetryOutcomeSentRef = useRef(false)
  const telemetryStepsSeenRef = useRef<Set<number>>(new Set())
  const telemetryTotalStepsRef = useRef(1)

  const activeTour = useMemo(
    () => (activeTourId ? getContextualTour(activeTourId) : null),
    [activeTourId]
  )

  const emitContextualTourOutcome = useCallback(
    (outcome: ContextualTourOutcome): void => {
      if (
        !activeTourId ||
        telemetryOutcomeSentRef.current ||
        telemetryTourIdRef.current !== activeTourId
      ) {
        return
      }
      telemetryOutcomeSentRef.current = true
      trackContextualTourOutcome({
        tourId: activeTourId,
        source: activeTourSource,
        outcome,
        stepsSeen: telemetryStepsSeenRef.current.size,
        totalSteps: telemetryTotalStepsRef.current
      })
    },
    [activeTourId, activeTourSource]
  )

  useLayoutEffect(() => {
    // Why: reset before the measurement layout effect below, otherwise the
    // first passive effect can hide a freshly measured tour until the next tick.
    markedTourIdRef.current = null
    telemetryTourIdRef.current = null
    telemetryOutcomeSentRef.current = false
    telemetryStepsSeenRef.current = new Set()
    telemetryTotalStepsRef.current = 1
    setRenderState(null)
  }, [activeTourId])

  useEffect(() => {
    if (!activeTour || !activeTourId) {
      return
    }
    if (
      onboardingVisible ||
      blockingSurfaceVisible ||
      activeTourSuppressed ||
      !isContextualTourAllowedForModal(activeTour, activeModal)
    ) {
      emitContextualTourOutcome('cancelled')
      cancelContextualTour(activeTourId)
    }
  }, [
    activeModal,
    activeTourSuppressed,
    activeTour,
    activeTourId,
    blockingSurfaceVisible,
    cancelContextualTour,
    emitContextualTourOutcome,
    onboardingVisible
  ])

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
    telemetryTotalStepsRef.current = Math.max(
      telemetryTotalStepsRef.current,
      getContextualTourOutcomeStepTotal(visibleStepIndexes)
    )
    const activeStep = activeTour.steps[activeStepIndex]
    const target = activeStep ? getMeasurableContextualTourTarget(activeStep.targetSelector) : null
    const progress = getContextualTourStepProgress({
      visibleStepIndexes,
      stepIndex: activeStepIndex
    })

    if (visibleStepIndexes.length === 0) {
      emitContextualTourOutcome('cancelled')
      cancelContextualTour(activeTourId)
      return
    }

    if (!activeStep || !target || !progress) {
      const hasLaterStep = visibleStepIndexes.some((index) => index > activeStepIndex)
      if (hasLaterStep) {
        advanceContextualTour()
      } else {
        emitContextualTourOutcome('cancelled')
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
      control: activeStep.control,
      isLastStep: progress.current === progress.total,
      isFirstStep: progress.current === 1,
      panelHost: getContextualTourPanelHost(target.element)
    })
  }, [
    activeStepIndex,
    activeTour,
    activeTourId,
    advanceContextualTour,
    cancelContextualTour,
    emitContextualTourOutcome,
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
    if (!activeTourId || !renderState || telemetryTourIdRef.current === activeTourId) {
      return
    }
    telemetryTourIdRef.current = activeTourId
    telemetryStepsSeenRef.current.add(activeStepIndex)
    trackContextualTourShown({
      tourId: activeTourId,
      source: activeTourSource,
      wasFeaturePreviouslyInteracted
    })
  }, [activeStepIndex, activeTourId, activeTourSource, renderState, wasFeaturePreviouslyInteracted])

  useEffect(() => {
    if (!activeTourId || !renderState) {
      return
    }
    telemetryStepsSeenRef.current.add(activeStepIndex)
  }, [activeStepIndex, activeTourId, renderState])

  useEffect(() => {
    if (!activeTourId) {
      return
    }

    const emitPendingCancellation = (): void => {
      emitContextualTourOutcome('cancelled')
    }

    window.addEventListener('beforeunload', emitPendingCancellation)
    return () => {
      window.removeEventListener('beforeunload', emitPendingCancellation)
      // Why: analytics expects every shown tour to have an outcome, even when
      // the renderer closes or unmounts before the user presses Skip/Done.
      emitPendingCancellation()
    }
  }, [activeTourId, emitContextualTourOutcome])

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
  const clamped = clampContextualTourPanelPosition({
    targetRect: renderState.rect,
    viewport,
    panel
  })
  const panelHostRect = renderState.panelHost?.getBoundingClientRect()
  const cssPosition = getContextualTourPanelCssPosition({
    position: clamped,
    panelHostRect
  })
  const panelPosition: CSSProperties & { '--contextual-tour-arrow-offset'?: string } = {
    left: cssPosition.left,
    top: cssPosition.top,
    '--contextual-tour-arrow-offset': `${cssPosition.arrowOffset}px`
  }

  return (
    <ContextualTourOverlaySurface
      activeTourId={activeTourId}
      renderState={renderState}
      panelRef={panelRef}
      panelPosition={panelPosition}
      panelPlacement={clamped.placement}
      panelHost={renderState.panelHost}
      onSkip={(id) => {
        emitContextualTourOutcome('skipped')
        dismissContextualTour(id)
      }}
      onBack={regressContextualTour}
      onNext={() => {
        if (renderState.isLastStep) {
          emitContextualTourOutcome('completed')
          completeContextualTour(activeTourId)
        } else {
          advanceContextualTour()
        }
      }}
      onOverlayKeyDownCapture={handleContextualTourOverlayKeyDown}
    />
  )
}
