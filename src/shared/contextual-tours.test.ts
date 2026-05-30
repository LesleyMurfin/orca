import { describe, expect, it } from 'vitest'
import {
  CONTEXTUAL_TOURS,
  normalizeContextualTourIds,
  type ContextualTour,
  type ContextualTourId
} from './contextual-tours'

describe('contextual tour definitions', () => {
  it('defines the required tours with concise visible steps', () => {
    const expectedIds: ContextualTourId[] = [
      'workspace-board',
      'workspace-agent-sessions',
      'browser',
      'tasks',
      'automations',
      'workspace-creation'
    ]

    expect(CONTEXTUAL_TOURS.map((tour) => tour.id)).toEqual(expectedIds)
    for (const tour of CONTEXTUAL_TOURS) {
      expect(tour.steps[0]?.requiredForStart).toBe(true)
      if (tour.steps.length === 1) {
        expect(tour.steps[0]?.advanceOnFeatureInteraction).toBeTruthy()
      } else {
        expect(tour.steps.length).toBeGreaterThanOrEqual(2)
      }
      expect(tour.steps.length).toBeLessThanOrEqual(3)
      for (const step of tour.steps) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.body.length).toBeGreaterThan(0)
        expect(step.body.length).toBeLessThanOrEqual(140)
        expect(step.targetSelector).toContain('data-contextual-tour-target')
      }
    }
  })

  it('allows only workspace creation over its workspace composer modal', () => {
    const modalTours = (CONTEXTUAL_TOURS as readonly ContextualTour[]).filter(
      (tour) => tour.allowedActiveModals?.length
    )

    expect(modalTours.map((tour) => tour.id)).toEqual(['workspace-creation'])
    expect(modalTours[0]?.allowedActiveModals).toEqual(['new-workspace-composer'])
  })

  it('normalizes persisted ids by removing unknowns and duplicates', () => {
    expect(
      normalizeContextualTourIds([
        'tasks',
        'unknown',
        'workspace-agent-sessions',
        'browser',
        'tasks',
        null,
        'workspace-creation'
      ])
    ).toEqual(['tasks', 'workspace-agent-sessions', 'browser', 'workspace-creation'])
  })
})
