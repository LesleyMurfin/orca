// In-worker sliding debounce window for @parcel/watcher event batches.
//
// Why: rapid git churn or `npm install` can emit thousands of raw filesystem
// events in a single burst. Forwarding each one individually across the
// worker -> host IPC boundary starves the main-thread event loop (this is
// the root cause behind the status-probe timeouts fixed in PR #20095).
// Coalescing events inside a short sliding window collapses that burst into
// a single batch before it ever crosses the process boundary.

export interface WatcherEvent {
  path: string
  type: 'create' | 'update' | 'delete'
}

export interface WatcherDebouncerStats {
  totalEventsReceived: number
  coalescedCount: number
  batchesDispatched: number
  pendingCount: number
}

const DEFAULT_WINDOW_MS = 100

export class WatcherSlidingDebouncer {
  private pending = new Map<string, { type: WatcherEvent['type']; timestamp: number }>()
  private timer: NodeJS.Timeout | null = null
  private totalReceived = 0
  private totalEmitted = 0
  private batchesCount = 0

  constructor(
    private readonly emitBatch: (batch: WatcherEvent[]) => void,
    private readonly windowMs = DEFAULT_WINDOW_MS
  ) {}

  addEvents(events: WatcherEvent[]): void {
    const now = Date.now()
    this.totalReceived += events.length

    for (const ev of events) {
      const existing = this.pending.get(ev.path)
      // Coalescing semantics: preserve 'create' if immediately followed by 'update'
      const targetType = existing && existing.type === 'create' && ev.type === 'update' ? 'create' : ev.type
      this.pending.set(ev.path, { type: targetType, timestamp: now })
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.size === 0) {
      return
    }

    const batch: WatcherEvent[] = Array.from(this.pending.entries()).map(([path, data]) => ({
      path,
      type: data.type,
    }))

    this.totalEmitted += batch.length
    this.pending.clear()
    this.batchesCount++
    this.emitBatch(batch)
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }

  getStats(): WatcherDebouncerStats {
    const coalesced = Math.max(0, this.totalReceived - this.totalEmitted - this.pending.size)
    return {
      totalEventsReceived: this.totalReceived,
      coalescedCount: coalesced,
      batchesDispatched: this.batchesCount,
      pendingCount: this.pending.size,
    }
  }
}
