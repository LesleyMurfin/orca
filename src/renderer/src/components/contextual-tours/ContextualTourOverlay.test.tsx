import { Children, isValidElement, type ReactElement, type ReactNode, type RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import {
  ContextualTourOverlaySurface,
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'
import { getContextualTourPanelHost } from './contextual-tour-gate'

type ClickableElementProps = {
  children?: ReactNode
  onClick?: () => void
}

const baseRenderState: ActiveTourRenderState = {
  rect: {
    left: 10,
    top: 20,
    right: 110,
    bottom: 80,
    width: 100,
    height: 60
  } as DOMRect,
  targetElement: {
    closest: () => null
  } as unknown as Element,
  progress: { current: 1, total: 3 },
  title: 'Choose the work source',
  body: 'Switch between connected providers and project filters without changing pages.',
  isLastStep: false,
  panelHost: null
}

function renderSurface(
  overrides: Partial<ActiveTourRenderState> = {},
  callbacks: { onSkip?: (id: ContextualTourId) => void; onNext?: () => void } = {}
): ReactElement {
  return ContextualTourOverlaySurface({
    activeTourId: 'tasks',
    renderState: { ...baseRenderState, ...overrides },
    panelRef: { current: null } as RefObject<HTMLElement | null>,
    highlightStyle: { left: 6, top: 16, width: 108, height: 68 },
    panelPosition: { left: 130, top: 20 },
    panelHost: null,
    onSkip: callbacks.onSkip ?? vi.fn(),
    onNext: callbacks.onNext ?? vi.fn(),
    onOverlayKeyDownCapture: handleContextualTourOverlayKeyDown
  })
}

function findElementByText(
  node: ReactNode,
  text: string
): ReactElement<ClickableElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByText(child, text)
      if (match) {
        return match
      }
    }
    return null
  }

  if (!isValidElement(node)) {
    return null
  }

  const props = node.props as ClickableElementProps
  if (props.children === text) {
    return node as ReactElement<ClickableElementProps>
  }

  for (const child of Children.toArray(props.children)) {
    const match = findElementByText(child, text)
    if (match) {
      return match
    }
  }
  return null
}

describe('ContextualTourOverlaySurface', () => {
  it('renders visible progress and step copy', () => {
    const markup = renderToStaticMarkup(renderSurface())

    expect(markup).toContain('1/3')
    expect(markup).toContain('Choose the work source')
    expect(markup).toContain('Switch between connected providers')
    expect(markup).toContain('Skip')
    expect(markup).toContain('Next')
  })

  it('renders later progress and Done on the final visible step', () => {
    const markup = renderToStaticMarkup(
      renderSurface({
        progress: { current: 2, total: 2 },
        title: 'Start from tracked work',
        isLastStep: true
      })
    )

    expect(markup).toContain('2/2')
    expect(markup).toContain('Start from tracked work')
    expect(markup).toContain('Done')
  })

  it('wires Skip and Next callbacks', () => {
    const onSkip = vi.fn()
    const onNext = vi.fn()
    const element = renderSurface({}, { onSkip, onNext })

    findElementByText(element, 'Skip')?.props.onClick?.()
    findElementByText(element, 'Next')?.props.onClick?.()

    expect(onSkip).toHaveBeenCalledWith('tasks')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('handles Escape by clicking Skip before page-level handlers see it', () => {
    const click = vi.fn()
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    handleContextualTourOverlayKeyDown({
      key: 'Escape',
      preventDefault,
      stopPropagation,
      currentTarget: {
        querySelector: () => ({ click })
      }
    } as unknown as Parameters<typeof handleContextualTourOverlayKeyDown>[0])

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
  })
})

describe('getContextualTourPanelHost', () => {
  it('hosts controls inside Radix dialog and sheet content', () => {
    const dialogHost = {} as HTMLElement
    const sheetHost = {} as HTMLElement
    const dialogTarget = { closest: vi.fn(() => dialogHost) } as unknown as Element
    const sheetTarget = { closest: vi.fn(() => sheetHost) } as unknown as Element
    const pageTarget = { closest: vi.fn(() => null) } as unknown as Element

    expect(getContextualTourPanelHost(dialogTarget)).toBe(dialogHost)
    expect(getContextualTourPanelHost(sheetTarget)).toBe(sheetHost)
    expect(getContextualTourPanelHost(pageTarget)).toBeNull()
    expect(dialogTarget.closest).toHaveBeenCalledWith(
      '[data-slot="dialog-content"], [data-slot="sheet-content"]'
    )
  })
})
