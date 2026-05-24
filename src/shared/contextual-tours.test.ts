import { describe, expect, it } from 'vitest'
import {
  CONTEXTUAL_TOURS,
  normalizeContextualTourIds,
  type ContextualTour,
  type ContextualTourId
} from './contextual-tours'

describe('contextual tour definitions', () => {
  it('defines the required tours with three concise steps each', () => {
    const expectedIds: ContextualTourId[] = [
      'right-sidebar',
      'workspace-board',
      'browser',
      'tasks',
      'automations',
      'workspace-creation'
    ]

    expect(CONTEXTUAL_TOURS.map((tour) => tour.id)).toEqual(expectedIds)
    for (const tour of CONTEXTUAL_TOURS) {
      expect(tour.steps).toHaveLength(3)
      expect(tour.steps[0]?.requiredForStart).toBe(true)
      for (const step of tour.steps) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.body.length).toBeGreaterThan(0)
        expect(step.body.length).toBeLessThanOrEqual(140)
        expect(step.targetSelector).toContain('data-contextual-tour-target')
      }
    }
  })

  it('keeps workspace creation as the only modal-allowed tour', () => {
    const modalTours = (CONTEXTUAL_TOURS as readonly ContextualTour[]).filter(
      (tour) => tour.allowedActiveModals?.length
    )

    expect(modalTours.map((tour) => tour.id)).toEqual(['workspace-creation'])
    expect(modalTours[0]?.allowedActiveModals).toEqual(['new-workspace-composer', 'add-repo'])
  })

  it('normalizes persisted ids by removing unknowns and duplicates', () => {
    expect(
      normalizeContextualTourIds([
        'tasks',
        'unknown',
        'browser',
        'tasks',
        null,
        'workspace-creation'
      ])
    ).toEqual(['tasks', 'browser', 'workspace-creation'])
  })
})
