import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

describe('countTasks', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  // Why: `orca serve stats` advertises live counts, and settled task rows stay in the table until an
  // explicit reset — so terminal rows must not inflate the count, while `blocked` (resumable) must.
  it('counts only non-terminal task rows', () => {
    db = new OrchestrationDb(':memory:')
    const statuses = ['pending', 'ready', 'dispatched', 'blocked', 'completed', 'failed'] as const
    for (const status of statuses) {
      const task = db.createTask({ spec: `task ${status}` })
      db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task.id)
    }

    expect(db.countTasks()).toBe(4)
  })

  it('returns 0 once every task has settled', () => {
    db = new OrchestrationDb(':memory:')
    const completed = db.createTask({ spec: 'settled ok' })
    const failed = db.createTask({ spec: 'settled bad' })
    db.updateTaskStatus(completed.id, 'completed')
    db.updateTaskStatus(failed.id, 'failed')

    expect(db.countTasks()).toBe(0)
  })
})
