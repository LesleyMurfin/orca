import { createPortal } from 'react-dom'
import { type CSSProperties, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { ContextualTourId } from '../../../../shared/contextual-tours'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ActiveTourRenderState = {
  rect: DOMRect
  targetElement: Element
  progress: { current: number; total: number }
  title: string
  body: string
  isLastStep: boolean
  panelHost: HTMLElement | null
}

type ContextualTourOverlaySurfaceProps = {
  activeTourId: ContextualTourId
  renderState: ActiveTourRenderState
  panelRef: RefObject<HTMLElement | null>
  highlightStyle: CSSProperties
  panelPosition: CSSProperties
  panelHost: HTMLElement | null
  onSkip: (id: ContextualTourId) => void
  onNext: () => void
  onOverlayKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void
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

export function ContextualTourOverlaySurface({
  activeTourId,
  renderState,
  panelRef,
  highlightStyle,
  panelPosition,
  panelHost,
  onSkip,
  onNext,
  onOverlayKeyDownCapture
}: ContextualTourOverlaySurfaceProps): JSX.Element {
  const panelHostSlot = panelHost?.getAttribute('data-slot')
  const hostedPanelClass =
    panelHostSlot === 'sheet-content'
      ? 'absolute left-3 top-[3.75rem] z-[80] w-[min(20rem,calc(100%-1.5rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]'
      : 'relative z-[80] ml-3 mb-3 mt-1 w-[min(20rem,calc(100%-1.5rem))] shrink-0 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]'
  const panel = (
    <section
      ref={panelRef}
      aria-live="polite"
      aria-modal="true"
      aria-label={renderState.title}
      data-contextual-tour-panel=""
      role="dialog"
      tabIndex={-1}
      className={
        panelHost
          ? hostedPanelClass
          : 'fixed w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]'
      }
      style={panelHost ? undefined : panelPosition}
    >
      <div className="text-[11px] font-medium text-muted-foreground">
        {renderState.progress.current}/{renderState.progress.total}
      </div>
      <h2 className="mt-1 text-sm font-semibold">{renderState.title}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{renderState.body}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => onSkip(activeTourId)}
        >
          Skip
        </Button>
        <Button type="button" size="sm" className="h-8" onClick={onNext}>
          {renderState.isLastStep ? 'Done' : 'Next'}
        </Button>
      </div>
    </section>
  )

  return (
    <div
      className={`fixed inset-0 z-[70] ${panelHost ? 'pointer-events-none' : 'pointer-events-auto'}`}
      data-contextual-tour-overlay=""
      role="presentation"
      onKeyDownCapture={onOverlayKeyDownCapture}
    >
      <div className="absolute inset-0 bg-background/55" />
      {panelHost ? null : (
        <div
          aria-hidden="true"
          className="fixed rounded-md border border-ring ring-2 ring-ring shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          style={highlightStyle}
        />
      )}
      {panelHost ? createPortal(panel, panelHost) : panel}
    </div>
  )
}

export function handleContextualTourOverlayKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    const skipButton = event.currentTarget.querySelector<HTMLButtonElement>('button')
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
    useAppStore.getState().dismissContextualTour(activeTourId)
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
