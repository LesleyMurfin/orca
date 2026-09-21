import { describe, expect, it, vi } from 'vitest'
import { WatcherSlidingDebouncer, type WatcherEvent } from './parcel-watcher-sliding-debouncer'

describe('WatcherSlidingDebouncer', () => {
  it('coalesces a high-frequency burst into a single batch within the sliding window', () => {
    vi.useFakeTimers()

    const emitBatch = vi.fn<(batch: WatcherEvent[]) => void>()
    const debouncer = new WatcherSlidingDebouncer(emitBatch, 100)

    const TOTAL_EVENTS = 5000
    const UNIQUE_FILES = 250
    const rawEvents: WatcherEvent[] = []
    for (let i = 0; i < TOTAL_EVENTS; i++) {
      const fileId = i % UNIQUE_FILES
      rawEvents.push({
        path: `/workspace/src/components/panel_${fileId}.tsx`,
        type: i < UNIQUE_FILES ? 'create' : 'update',
      })
    }

    debouncer.addEvents(rawEvents)
    expect(emitBatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)

    expect(emitBatch).toHaveBeenCalledTimes(1)
    const [emittedBatch] = emitBatch.mock.calls[0]
    expect(emittedBatch).toHaveLength(UNIQUE_FILES)
    for (const item of emittedBatch) {
      expect(item.type).toBe('create')
    }

    const stats = debouncer.getStats()
    expect(stats.totalEventsReceived).toBe(TOTAL_EVENTS)
    expect(stats.coalescedCount).toBe(TOTAL_EVENTS - UNIQUE_FILES)
    expect(stats.batchesDispatched).toBe(1)
    expect(stats.pendingCount).toBe(0)

    debouncer.destroy()
    vi.useRealTimers()
  })

  it('flushes synchronously on demand and clears state on destroy', () => {
    const emitBatch = vi.fn<(batch: WatcherEvent[]) => void>()
    const debouncer = new WatcherSlidingDebouncer(emitBatch, 500)

    debouncer.addEvents([
      { path: '/workspace/file1.ts', type: 'update' },
      { path: '/workspace/file2.ts', type: 'delete' },
      { path: '/workspace/file1.ts', type: 'update' },
    ])

    debouncer.flush()
    expect(emitBatch).toHaveBeenCalledTimes(1)
    expect(emitBatch.mock.calls[0][0]).toHaveLength(2)

    debouncer.destroy()
    expect(debouncer.getStats().pendingCount).toBe(0)
  })

  it('preserves create over a subsequent update within the same window', () => {
    const emitBatch = vi.fn<(batch: WatcherEvent[]) => void>()
    const debouncer = new WatcherSlidingDebouncer(emitBatch, 500)

    debouncer.addEvents([{ path: '/workspace/new-file.ts', type: 'create' }])
    debouncer.addEvents([{ path: '/workspace/new-file.ts', type: 'update' }])
    debouncer.flush()

    expect(emitBatch.mock.calls[0][0]).toEqual([{ path: '/workspace/new-file.ts', type: 'create' }])
    debouncer.destroy()
  })

  it('flush is a no-op when there are no pending events', () => {
    const emitBatch = vi.fn<(batch: WatcherEvent[]) => void>()
    const debouncer = new WatcherSlidingDebouncer(emitBatch, 500)

    debouncer.flush()
    expect(emitBatch).not.toHaveBeenCalled()
    debouncer.destroy()
  })
})
