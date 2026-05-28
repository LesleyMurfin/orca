import { describe, expect, it } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import {
  getContextualTourRequestDecision,
  getContextualTourStepProgress,
  getContextualTourOutcomeStepTotal,
  getMeasurableContextualTourTarget,
  getNextVisibleContextualTourStepIndex,
  getPreviousVisibleContextualTourStepIndex,
  getVisibleContextualTourStepIndexes,
  isContextualTourAllowedForModal
} from './contextual-tour-gate'
import {
  clampContextualTourPanelPosition,
  getContextualTourPanelCssPosition
} from './contextual-tour-panel-position'

describe('contextual tour gate', () => {
  it('allows only workspace creation over its workspace composer modal', () => {
    const workspaceCreation = getContextualTour('workspace-creation')
    const tasks = getContextualTour('tasks')

    expect(isContextualTourAllowedForModal(workspaceCreation, 'new-workspace-composer')).toBe(true)
    expect(isContextualTourAllowedForModal(workspaceCreation, 'add-repo')).toBe(false)
    expect(isContextualTourAllowedForModal(tasks, 'none')).toBe(true)
    expect(isContextualTourAllowedForModal(tasks, 'new-workspace-composer')).toBe(false)
    expect(isContextualTourAllowedForModal(tasks, 'add-repo')).toBe(false)
  })

  it('does not start when the required first target is missing', () => {
    const decision = getContextualTourRequestDecision({
      tour: getContextualTour('tasks'),
      persistedUIReady: true,
      autoEligible: true,
      onboardingVisible: false,
      seenIds: [],
      sessionConsumed: false,
      activeTourId: null,
      activeModal: 'none',
      blockingSurfaceVisible: false,
      targetExists: () => false
    })

    expect(decision).toEqual({ kind: 'blocked', reason: 'missing-start-target' })
  })

  it('returns null when selector lookup or measurement throws', () => {
    expect(
      getMeasurableContextualTourTarget('[', {
        querySelector: () => {
          throw new Error('bad selector')
        }
      } as unknown as ParentNode)
    ).toBeNull()

    expect(
      getMeasurableContextualTourTarget('[data-contextual-tour-target="tasks-source-filters"]', {
        querySelector: () => ({
          getBoundingClientRect: () => {
            throw new Error('detached element')
          }
        })
      } as unknown as ParentNode)
    ).toBeNull()
  })

  it('returns null when the target is inside a hidden subtree', () => {
    expect(
      getMeasurableContextualTourTarget('[data-contextual-tour-target="browser-address"]', {
        querySelector: () => ({
          closest: (selector: string) => (selector.includes('aria-hidden') ? {} : null),
          getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 120,
            bottom: 32,
            width: 120,
            height: 32
          })
        })
      } as unknown as ParentNode)
    ).toBeNull()
  })

  it('uses the first visible measurable target when hidden mounted copies exist first', () => {
    const hiddenElement = {
      closest: (selector: string) => (selector.includes('aria-hidden') ? {} : null),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 120,
        bottom: 32,
        width: 120,
        height: 32
      })
    }
    const visibleElement = {
      closest: () => null,
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        right: 210,
        bottom: 64,
        width: 200,
        height: 44
      })
    }

    const target = getMeasurableContextualTourTarget(
      '[data-contextual-tour-target="browser-address"]',
      {
        querySelectorAll: () => [hiddenElement, visibleElement]
      } as unknown as ParentNode
    )

    expect(target?.element).toBe(visibleElement)
    expect(target?.rect.width).toBe(200)
  })

  it('starts an unseen tour only when global gates pass', () => {
    const tour = getContextualTour('tasks')
    const hasFirstTarget = (selector: string): boolean => selector === tour.steps[0]?.targetSelector

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'start', stepIndex: 0 })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: false,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'persisted-ui-not-ready' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: false,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'auto-disabled' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: true,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'onboarding' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: ['tasks'],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'seen' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: true,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'blocking-surface' })
  })

  it('skips missing later steps and keeps progress relative to visible steps', () => {
    const tour = getContextualTour('browser')
    const visibleSelectors = new Set([tour.steps[0]!.targetSelector, tour.steps[2]!.targetSelector])
    const targetExists = (selector: string): boolean => visibleSelectors.has(selector)
    const visibleStepIndexes = getVisibleContextualTourStepIndexes(tour, targetExists)

    expect(visibleStepIndexes).toEqual([0, 2])
    expect(
      getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists
      })
    ).toBe(2)
    expect(
      getPreviousVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 2,
        targetExists
      })
    ).toBe(0)
    expect(
      getPreviousVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists
      })
    ).toBeNull()
    expect(getContextualTourStepProgress({ visibleStepIndexes, stepIndex: 2 })).toEqual({
      current: 2,
      total: 2
    })
    expect(getContextualTourOutcomeStepTotal(visibleStepIndexes)).toBe(2)
    expect(getContextualTourOutcomeStepTotal([])).toBe(1)
  })

  it('clamps the panel inside narrow viewports', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: {
        left: 20,
        right: 140,
        top: 40,
        bottom: 100,
        width: 120,
        height: 60
      },
      viewport: { width: 320, height: 220 },
      panel: { width: 304, height: 160 }
    })

    expect(position.left).toBeGreaterThanOrEqual(12)
    expect(position.top).toBeGreaterThanOrEqual(12)
    expect(position.left).toBeLessThanOrEqual(12)
    expect(position.top).toBeLessThanOrEqual(48)
  })

  it('places the panel to the right when room allows and aims the arrow at target center', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: { left: 100, right: 200, top: 200, bottom: 240, width: 100, height: 40 },
      viewport: { width: 1024, height: 768 },
      panel: { width: 320, height: 180 }
    })

    expect(position.placement).toBe('right')
    // panel is positioned to the right of the target, vertically centered;
    // arrow should sit near the panel's vertical center pointing at the target's center
    expect(position.left).toBe(212)
    expect(position.arrowOffset).toBeGreaterThan(60)
    expect(position.arrowOffset).toBeLessThan(120)
  })

  it('converts viewport panel coordinates into hosted dialog coordinates', () => {
    const position = {
      left: 838,
      top: 168,
      placement: 'right' as const,
      arrowOffset: 64
    }

    expect(
      getContextualTourPanelCssPosition({
        position,
        panelHostRect: { left: 500, top: 80 }
      })
    ).toEqual({ left: 338, top: 88, arrowOffset: 64 })
    expect(getContextualTourPanelCssPosition({ position })).toEqual({
      left: 838,
      top: 168,
      arrowOffset: 64
    })
  })

  it('flips below the target when neither side has horizontal room', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: { left: 60, right: 260, top: 40, bottom: 80, width: 200, height: 40 },
      viewport: { width: 320, height: 600 },
      panel: { width: 304, height: 160 }
    })

    expect(position.placement).toBe('bottom')
    expect(position.top).toBeGreaterThanOrEqual(80 + 12)
  })
})
