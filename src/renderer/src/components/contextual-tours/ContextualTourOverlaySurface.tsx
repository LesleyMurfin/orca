import { createPortal } from 'react-dom'
import { type CSSProperties, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import type { ContextualTourPanelPlacement } from './contextual-tour-gate'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const SKIP_BUTTON_SELECTOR = 'button[aria-label^="Skip"], button[aria-label="Dismiss tour"]'

export type ActiveTourRenderState = {
  rect: DOMRect
  targetElement: Element
  progress: { current: number; total: number }
  title: string
  body: string
  isLastStep: boolean
  isFirstStep: boolean
  panelHost: HTMLElement | null
}

type PanelPositionStyle = CSSProperties & {
  '--contextual-tour-arrow-offset'?: string
}

type ContextualTourOverlaySurfaceProps = {
  activeTourId: ContextualTourId
  renderState: ActiveTourRenderState
  panelRef: RefObject<HTMLElement | null>
  spotlightRect: SpotlightRect
  spotlightHostRect: SpotlightRect | null
  panelPosition: PanelPositionStyle
  panelPlacement: ContextualTourPanelPlacement | null
  panelHost: HTMLElement | null
  onSkip: (id: ContextualTourId) => void
  onBack: () => void
  onNext: () => void
  onOverlayKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void
}

export type SpotlightRect = {
  top: number
  left: number
  width: number
  height: number
  radius: number
}

if (typeof window !== 'undefined') {
  const guardedWindow = window as Window & {
    __orcaContextualTourGlobalKeyGuardInstalled?: boolean
  }
  if (!guardedWindow.__orcaContextualTourGlobalKeyGuardInstalled) {
    guardedWindow.__orcaContextualTourGlobalKeyGuardInstalled = true
    window.addEventListener('keydown', handleContextualTourGlobalKeyDown, true)
  }
}

const PANEL_BASE_CLASSES =
  'rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] backdrop-blur-[2px]'

const PANEL_ANIMATION_CLASSES = 'animate-in fade-in-0 zoom-in-95 duration-200 ease-out'

export function ContextualTourOverlaySurface({
  activeTourId,
  renderState,
  panelRef,
  spotlightRect,
  spotlightHostRect,
  panelPosition,
  panelPlacement,
  panelHost,
  onSkip,
  onBack,
  onNext,
  onOverlayKeyDownCapture
}: ContextualTourOverlaySurfaceProps): JSX.Element {
  const panelHostSlot = panelHost?.getAttribute('data-slot')
  const hostedPanelClass = cn(
    PANEL_BASE_CLASSES,
    PANEL_ANIMATION_CLASSES,
    panelHostSlot === 'sheet-content'
      ? 'absolute z-[80] w-[min(20rem,calc(100%-1.5rem))]'
      : 'absolute z-[80] w-[min(20rem,calc(100%-2rem))]'
  )
  const floatingPanelClass = cn(
    PANEL_BASE_CLASSES,
    PANEL_ANIMATION_CLASSES,
    'fixed w-[min(20rem,calc(100vw-1.5rem))]'
  )

  const stepKey = `${activeTourId}-${renderState.progress.current}`

  const panel = (
    <section
      ref={panelRef}
      aria-live="polite"
      aria-modal="true"
      aria-label={renderState.title}
      data-contextual-tour-panel=""
      data-placement={panelPlacement ?? undefined}
      role="dialog"
      tabIndex={-1}
      className={panelHost ? hostedPanelClass : floatingPanelClass}
      style={panelPosition}
    >
      {panelPlacement ? <ContextualTourArrow placement={panelPlacement} /> : null}
      <div key={stepKey} className="animate-in fade-in-0 duration-150 ease-out p-4">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          {renderState.title}
        </h2>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{renderState.body}</p>
        <div className="mt-3.5 flex items-center justify-between gap-3">
          <ContextualTourProgressDots
            current={renderState.progress.current}
            total={renderState.progress.total}
          />
          <div className="flex items-center gap-1.5">
            {!renderState.isFirstStep ? (
              <Button type="button" variant="ghost" size="xs" aria-label="Back" onClick={onBack}>
                <ArrowLeft />
                Back
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={renderState.isLastStep ? 'Dismiss tour' : 'Skip tour'}
              onClick={() => onSkip(activeTourId)}
            >
              {renderState.isLastStep ? 'Dismiss' : 'Skip'}
            </Button>
            <Button type="button" size="xs" onClick={onNext}>
              {renderState.isLastStep ? 'Done' : 'Next'}
              {!renderState.isLastStep ? <ArrowRight /> : null}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )

  const spotlight = panelHost ? (
    spotlightHostRect ? (
      <ContextualTourSpotlight rect={spotlightHostRect} hosted />
    ) : null
  ) : (
    <ContextualTourSpotlight rect={spotlightRect} hosted={false} />
  )

  return (
    <div
      className={cn(
        // Why: the overlay must let pointer events reach the highlighted
        // surface so the user can still notice the target while reading.
        // Only the panel itself captures interaction.
        'fixed inset-0 z-[70] pointer-events-none'
      )}
      data-contextual-tour-overlay=""
      role="presentation"
      onKeyDownCapture={onOverlayKeyDownCapture}
    >
      {panelHost ? null : spotlight}
      <div className="pointer-events-auto">
        {panelHost
          ? createPortal(
              <>
                {spotlight}
                {panel}
              </>,
              panelHost
            )
          : panel}
      </div>
    </div>
  )
}

function ContextualTourSpotlight({
  rect,
  hosted
}: {
  rect: SpotlightRect
  hosted: boolean
}): JSX.Element {
  if (hosted) {
    return (
      <div
        aria-hidden="true"
        data-contextual-tour-spotlight=""
        data-contextual-tour-spotlight-hosted="true"
        className="contextual-tour-hosted-scrim absolute"
      />
    )
  }

  // Why: an SVG mask scrim cuts a rounded-rect hole that follows the
  // target's border-radius, so curved buttons don't leave un-dimmed
  // corners between the target's curve and the cutout edge.
  const maskId = 'contextual-tour-spotlight-mask-fixed'
  return (
    <div
      aria-hidden="true"
      data-contextual-tour-spotlight=""
      className="contextual-tour-spotlight fixed"
    >
      <svg className="contextual-tour-spotlight-svg" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={rect.left}
              y={rect.top}
              width={rect.width}
              height={rect.height}
              rx={rect.radius}
              ry={rect.radius}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          className="contextual-tour-spotlight-fill"
          mask={`url(#${maskId})`}
        />
      </svg>
    </div>
  )
}

function ContextualTourProgressDots({
  current,
  total
}: {
  current: number
  total: number
}): JSX.Element {
  if (total <= 1) {
    return <span className="text-[11px] font-medium text-muted-foreground">Step {current}</span>
  }
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-label={`Step ${current} of ${total}`}
    >
      {Array.from({ length: total }).map((_, index) => {
        const isActive = index + 1 === current
        const isComplete = index + 1 < current
        return (
          <span
            key={index}
            aria-hidden="true"
            className={cn(
              'block h-1.5 rounded-full transition-all duration-200 ease-out',
              isActive
                ? 'w-4 bg-foreground'
                : isComplete
                  ? 'w-1.5 bg-foreground/55'
                  : 'w-1.5 bg-foreground/20'
            )}
          />
        )
      })}
    </div>
  )
}

function ContextualTourArrow({
  placement
}: {
  placement: ContextualTourPanelPlacement
}): JSX.Element {
  // Why: a small triangle pointing at the target makes the panel/target
  // relationship readable when the highlight isn't directly adjacent (e.g.
  // clamped into a corner) or when the user's eye starts on the panel.
  const offsetCss = 'var(--contextual-tour-arrow-offset, 50%)'
  const horizontal = placement === 'top' || placement === 'bottom'
  const longSide = 12
  const shortSide = 6
  const wrapperStyle: CSSProperties = horizontal
    ? {
        width: longSide,
        height: shortSide,
        left: offsetCss,
        transform: 'translateX(-50%)',
        ...(placement === 'top' ? { top: '100%' } : { bottom: '100%' })
      }
    : {
        width: shortSide,
        height: longSide,
        top: offsetCss,
        transform: 'translateY(-50%)',
        ...(placement === 'left' ? { left: '100%' } : { right: '100%' })
      }
  const path =
    placement === 'top'
      ? 'M0 0 L6 6 L12 0'
      : placement === 'bottom'
        ? 'M0 6 L6 0 L12 6'
        : placement === 'left'
          ? 'M0 0 L6 6 L0 12'
          : 'M6 0 L0 6 L6 12'
  const maskPath =
    placement === 'top'
      ? 'M0 0 L12 0'
      : placement === 'bottom'
        ? 'M0 6 L12 6'
        : placement === 'left'
          ? 'M0 0 L0 12'
          : 'M6 0 L6 12'
  return (
    <span aria-hidden="true" className="absolute block" style={wrapperStyle}>
      <svg
        viewBox={horizontal ? '0 0 12 6' : '0 0 6 12'}
        width={horizontal ? longSide : shortSide}
        height={horizontal ? shortSide : longSide}
        className="overflow-visible"
        preserveAspectRatio="none"
      >
        <path
          d={path}
          className="fill-popover stroke-border"
          strokeWidth={1}
          strokeLinejoin="round"
        />
        {/* Why: hide the join with the panel border so the panel edge
            reads as continuous across the arrow's base. */}
        <path d={maskPath} className="stroke-popover" strokeWidth={1.5} fill="none" />
      </svg>
    </span>
  )
}

export function handleContextualTourOverlayKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    const skipButton = event.currentTarget.querySelector<HTMLButtonElement>(SKIP_BUTTON_SELECTOR)
    skipButton?.click()
    return
  }

  if (event.key !== 'Tab') {
    return
  }

  const focusRoot =
    document.querySelector<HTMLElement>('[data-contextual-tour-panel]') ?? event.currentTarget
  const focusableElements = getContextualTourFocusableElements(focusRoot)
  if (focusableElements.length === 0) {
    event.preventDefault()
    return
  }

  const activeElement = document.activeElement
  const activeIndex =
    activeElement instanceof HTMLElement ? focusableElements.indexOf(activeElement) : -1
  const nextIndex = event.shiftKey
    ? activeIndex <= 0
      ? focusableElements.length - 1
      : activeIndex - 1
    : activeIndex === -1 || activeIndex === focusableElements.length - 1
      ? 0
      : activeIndex + 1

  event.preventDefault()
  event.stopPropagation()
  focusableElements[nextIndex]?.focus({ preventScroll: true })
}

export function handleContextualTourGlobalKeyDown(event: globalThis.KeyboardEvent): void {
  const activeTourId = useAppStore.getState().activeContextualTourId
  if (!activeTourId || (event.key !== 'Escape' && event.key !== 'Tab')) {
    return
  }

  const overlay = document.querySelector<HTMLElement>('[data-contextual-tour-overlay]')
  const focusRoot = document.querySelector<HTMLElement>('[data-contextual-tour-panel]') ?? overlay
  if (!overlay || !focusRoot) {
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const skipButton = focusRoot.querySelector<HTMLButtonElement>(SKIP_BUTTON_SELECTOR)
    if (skipButton) {
      skipButton.click()
    }
    return
  }

  const focusableElements = getContextualTourFocusableElements(focusRoot)
  if (focusableElements.length === 0) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }

  const activeElement = document.activeElement
  const activeIndex =
    activeElement instanceof HTMLElement ? focusableElements.indexOf(activeElement) : -1
  const nextIndex = event.shiftKey
    ? activeIndex <= 0
      ? focusableElements.length - 1
      : activeIndex - 1
    : activeIndex === -1 || activeIndex === focusableElements.length - 1
      ? 0
      : activeIndex + 1

  event.preventDefault()
  event.stopImmediatePropagation()
  focusableElements[nextIndex]?.focus({ preventScroll: true })
}

export function getContextualTourFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0 || element === document.activeElement
  )
}
