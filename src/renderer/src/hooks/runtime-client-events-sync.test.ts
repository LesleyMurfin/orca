import { describe, it, expect, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  createRuntimeClientEventsSync,
  type RuntimeClientEventSubscriptionHandle
} from './runtime-client-events-sync'

type SubscribeRecord = {
  environmentId: string
  resolveWith: () => void
  unsubscribe: ReturnType<typeof vi.fn>
  onError: (error: unknown) => void
}

function makeHarness(
  initialDesired: string[],
  opts: { retryDelayMs?: number; random?: () => number } = {}
) {
  let desired = initialDesired
  const records: SubscribeRecord[] = []
  const subscribe = vi.fn(
    (
      environmentId: string,
      _onEvent: (event: RuntimeClientEvent) => void,
      onError: (error: unknown) => void
    ): Promise<RuntimeClientEventSubscriptionHandle> => {
      const unsubscribe = vi.fn()
      let resolveFn!: (handle: RuntimeClientEventSubscriptionHandle) => void
      const promise = new Promise<RuntimeClientEventSubscriptionHandle>((resolve) => {
        resolveFn = resolve
      })
      records.push({
        environmentId,
        resolveWith: () => resolveFn({ unsubscribe }),
        unsubscribe,
        onError
      })
      return promise
    }
  )
  const sync = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: () => desired,
    subscribe,
    onEvent: vi.fn(),
    retryDelayMs: opts.retryDelayMs,
    random: opts.random
  })
  return {
    sync,
    records,
    subscribe,
    setDesired: (next: string[]) => {
      desired = next
    },
    recordsFor: (environmentId: string) =>
      records.filter((record) => record.environmentId === environmentId)
  }
}

// Lets all pending subscribe `.then` microtasks settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createRuntimeClientEventsSync', () => {
  it('subscribes desired environments and unsubscribes ones that leave the set', async () => {
    const h = makeHarness(['A'])
    h.sync.sync()
    h.recordsFor('A')[0].resolveWith()
    await flush()

    h.setDesired([])
    h.sync.sync()

    expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not leak an orphaned subscription when an env is toggled off then on mid-subscribe', async () => {
    // 'B' stays subscribed throughout so subscriptions is never empty — this is
    // what prevents the generation from bumping and exposes the overwrite race.
    const h = makeHarness(['B'])
    h.sync.sync()
    h.recordsFor('B')[0].resolveWith()
    await flush()

    // 'A' becomes desired — first subscribe starts (kept in flight).
    h.setDesired(['A', 'B'])
    h.sync.sync()

    // 'A' removed while its subscribe is in flight (generation does NOT bump
    // because 'B' keeps subscriptions non-empty).
    h.setDesired(['B'])
    h.sync.sync()

    // 'A' desired again before the first subscribe resolved — the de-dupe guard
    // sees no live subscription and no pending entry, so it subscribes AGAIN.
    h.setDesired(['A', 'B'])
    h.sync.sync()

    const aRecords = h.recordsFor('A')
    expect(aRecords).toHaveLength(2) // the duplicate subscribe really happened

    // Resolve both A subscribes.
    aRecords[0].resolveWith()
    await flush()
    aRecords[1].resolveWith()
    await flush()

    // Exactly one of the two duplicate subscriptions is unsubscribed (the loser);
    // the other is retained in the map. Before the fix the second resolution
    // overwrote the first's unsubscribe in the map, leaking it (0 unsubscribes).
    const aUnsubscribed = aRecords.filter(
      (record) => record.unsubscribe.mock.calls.length > 0
    ).length
    expect(aUnsubscribed).toBe(1)

    // 'B' is untouched.
    expect(h.recordsFor('B')[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('stop() unsubscribes everything and ignores in-flight resolutions', async () => {
    const h = makeHarness(['A'])
    h.sync.sync()
    h.recordsFor('A')[0].resolveWith()
    await flush()

    h.sync.stop()
    expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)

    // A subscribe that resolves after stop() must not re-register; it unsubscribes.
    h.setDesired(['C'])
    h.sync.sync()
    h.sync.stop()
    h.recordsFor('C')[0].resolveWith()
    await flush()
    expect(h.recordsFor('C')[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('retries failed desired subscriptions without another store-driven sync', async () => {
    vi.useFakeTimers()
    try {
      let desired = ['A']
      let attempt = 0
      const unsubscribe = vi.fn()
      const subscribe = vi.fn((): Promise<RuntimeClientEventSubscriptionHandle> => {
        attempt += 1
        if (attempt === 1) {
          return Promise.reject(new Error('temporary subscribe failure'))
        }
        return Promise.resolve({ unsubscribe })
      })
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => desired,
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 1
      })

      sync.sync()
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(9)
      expect(subscribe).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(2)

      desired = []
      sync.sync()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off exponentially with a cap while an environment keeps failing', async () => {
    vi.useFakeTimers()
    try {
      const subscribe = vi.fn(
        (): Promise<RuntimeClientEventSubscriptionHandle> =>
          Promise.reject(new Error('unreachable'))
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        retryMaxDelayMs: 40,
        random: () => 1
      })

      sync.sync()
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(1)

      // Attempt 2 after 10ms (base).
      await vi.advanceTimersByTimeAsync(10)
      expect(subscribe).toHaveBeenCalledTimes(2)
      // Attempt 3 after 20ms more (doubled) — not before.
      await vi.advanceTimersByTimeAsync(19)
      expect(subscribe).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(subscribe).toHaveBeenCalledTimes(3)
      // Attempt 4 after 40ms more (doubled again, hits cap).
      await vi.advanceTimersByTimeAsync(40)
      expect(subscribe).toHaveBeenCalledTimes(4)
      // Attempt 5 stays at the 40ms cap.
      await vi.advanceTimersByTimeAsync(39)
      expect(subscribe).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(subscribe).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies jitter below the full backoff delay', async () => {
    vi.useFakeTimers()
    try {
      const subscribe = vi.fn(
        (): Promise<RuntimeClientEventSubscriptionHandle> =>
          Promise.reject(new Error('unreachable'))
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 0
      })

      sync.sync()
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(1)

      // random() => 0 halves the delay: retry at 5ms instead of 10ms.
      await vi.advanceTimersByTimeAsync(5)
      expect(subscribe).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh backoff epoch after a successful subscribe', async () => {
    vi.useFakeTimers()
    try {
      let desired = ['A']
      let failing = true
      const unsubscribe = vi.fn()
      const subscribe = vi.fn((): Promise<RuntimeClientEventSubscriptionHandle> => {
        if (failing) {
          return Promise.reject(new Error('unreachable'))
        }
        return Promise.resolve({ unsubscribe })
      })
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => desired,
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 1
      })

      // Two failures escalate the delay to 20ms.
      sync.sync()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10)
      expect(subscribe).toHaveBeenCalledTimes(2)

      // Third attempt succeeds — failure count resets.
      failing = false
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(3)

      // Env leaves and re-enters the desired set, then fails again: the first
      // retry is back at the 10ms base, not the escalated delay.
      desired = []
      sync.sync()
      desired = ['A']
      failing = true
      sync.sync()
      await Promise.resolve()
      expect(subscribe).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(9)
      expect(subscribe).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(subscribe).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an external sync retries a waiting environment immediately (recovery path)', async () => {
    vi.useFakeTimers()
    try {
      const subscribe = vi.fn(
        (): Promise<RuntimeClientEventSubscriptionHandle> =>
          Promise.reject(new Error('unreachable'))
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10_000,
        random: () => 1
      })

      sync.sync()
      // Let the rejection propagate through the then/catch chain so the retry
      // timer is armed before the external sync fires.
      await vi.advanceTimersByTimeAsync(0)
      expect(subscribe).toHaveBeenCalledTimes(1)

      // A reachable-set transition calls sync() directly; the pending backoff
      // timer must not delay this immediate re-attempt.
      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      expect(subscribe).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not carry a stale failure count when a rejection lands after the env left the set', async () => {
    vi.useFakeTimers()
    try {
      // 'B' stays pending forever so the desired set is never empty and the
      // generation never bumps — this is what lets A's late rejection still be
      // observed by its .catch (the exact leave-while-in-flight race).
      let desired = ['A', 'B']
      const aRejecters: ((error: Error) => void)[] = []
      let aAttempts = 0
      const subscribe = vi.fn(
        (environmentId: string): Promise<RuntimeClientEventSubscriptionHandle> => {
          if (environmentId === 'B') {
            return new Promise(() => {})
          }
          aAttempts += 1
          return new Promise((_resolve, reject) => {
            aRejecters.push(reject)
          })
        }
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => desired,
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 1
      })

      sync.sync()
      expect(aAttempts).toBe(1)

      // A leaves the desired set while its subscribe is still in flight.
      desired = ['B']
      sync.sync()

      // A's in-flight subscribe rejects now, after it is no longer desired.
      aRejecters[0](new Error('unreachable'))
      await vi.advanceTimersByTimeAsync(0)

      // A re-enters and its fresh subscribe (attempt 2) also fails.
      desired = ['A', 'B']
      sync.sync()
      await vi.advanceTimersByTimeAsync(0)
      expect(aAttempts).toBe(2)
      aRejecters[1](new Error('unreachable'))
      await vi.advanceTimersByTimeAsync(0)

      // The first retry after re-entry must use the base delay (10ms). A stale
      // count from the discarded rejection would have doubled it to 20ms.
      await vi.advanceTimersByTimeAsync(9)
      expect(aAttempts).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(aAttempts).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-subscribes after a mid-stream drop on an established subscription', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(['A'], { retryDelayMs: 10, random: () => 1 })
      h.sync.sync()
      h.recordsFor('A')[0].resolveWith()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.recordsFor('A')).toHaveLength(1)

      // A mid-stream transport drop on the already-established subscription.
      h.recordsFor('A')[0].onError(new Error('drop'))
      expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)
      // Nothing re-subscribes synchronously — recovery goes through the backoff.
      expect(h.recordsFor('A')).toHaveLength(1)

      // The supervisor re-subscribes after the base backoff delay.
      await vi.advanceTimersByTimeAsync(10)
      expect(h.recordsFor('A')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-subscribe after a drop for an env no longer desired', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(['A'], { retryDelayMs: 10, random: () => 1 })
      h.sync.sync()
      h.recordsFor('A')[0].resolveWith()
      await vi.advanceTimersByTimeAsync(0)

      // The env leaves the desired set, then its established subscription drops.
      h.setDesired([])
      h.recordsFor('A')[0].onError(new Error('drop'))
      expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)

      // No retry timer is armed, so no second subscribe ever happens.
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.recordsFor('A')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a mid-stream drop that arrives after stop() (generation guard)', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(['A'], { retryDelayMs: 10, random: () => 1 })
      h.sync.sync()
      h.recordsFor('A')[0].resolveWith()
      await vi.advanceTimersByTimeAsync(0)

      h.sync.stop()
      expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)

      // A late drop from the torn-down subscription must not re-subscribe nor
      // double-unsubscribe.
      h.recordsFor('A')[0].onError(new Error('late drop'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.recordsFor('A')).toHaveLength(1)
      expect(h.recordsFor('A')[0].unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('generation guard: a late drop from a pre-stop subscription never tears down a fresh one', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(['A'], { retryDelayMs: 10, random: () => 1 })
      h.sync.sync()
      h.recordsFor('A')[0].resolveWith()
      await vi.advanceTimersByTimeAsync(0)

      // Tear everything down (bumping the generation), then establish a brand-new
      // subscription for the same env under the new generation.
      h.sync.stop()
      h.setDesired(['A'])
      h.sync.sync()
      h.recordsFor('A')[1].resolveWith()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.recordsFor('A')).toHaveLength(2)

      // The OLD (pre-stop) subscription drops late. Without the generation guard
      // this would find the fresh live entry, unsubscribe it and schedule a
      // spurious third subscribe. The guard must ignore the stale drop entirely.
      h.recordsFor('A')[0].onError(new Error('stale drop from old generation'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.recordsFor('A')[1].unsubscribe).not.toHaveBeenCalled()
      expect(h.recordsFor('A')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a drop during the pending window as a no-op owned by the subscribe rejection', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      let onErrorCb: ((error: unknown) => void) | undefined
      let rejectFirst: ((error: Error) => void) | undefined
      const unsubscribe = vi.fn()
      const subscribe = vi.fn(
        (
          _environmentId: string,
          _onEvent: (event: RuntimeClientEvent) => void,
          onError: (error: unknown) => void
        ): Promise<RuntimeClientEventSubscriptionHandle> => {
          attempt += 1
          if (attempt === 1) {
            onErrorCb = onError
            return new Promise((_resolve, reject) => {
              rejectFirst = reject
            })
          }
          return Promise.resolve({ unsubscribe })
        }
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        random: () => 1
      })

      sync.sync()
      await Promise.resolve()
      expect(attempt).toBe(1)

      // A transport error arrives while the subscribe promise is still pending.
      // There is no live map entry yet, so handleSubscriptionDrop must return
      // without unsubscribing (a guard against calling unsubscribe() on undefined)
      // and without double-counting the failure — the then/catch owns this window.
      onErrorCb!(new Error('pre-establishment drop'))
      expect(unsubscribe).not.toHaveBeenCalled()

      // The same failure surfaces as the promise rejection, which arms exactly one
      // base-delay retry. The env is not left permanently stuck in `pending`.
      rejectFirst!(new Error('pre-establishment drop'))
      await vi.advanceTimersByTimeAsync(9)
      expect(attempt).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(attempt).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('feeds mid-stream drops into the failure counter so a failed re-subscribe escalates', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      let onErrorCb: ((error: unknown) => void) | undefined
      const unsubscribe = vi.fn()
      const subscribe = vi.fn(
        (
          _environmentId: string,
          _onEvent: (event: RuntimeClientEvent) => void,
          onError: (error: unknown) => void
        ): Promise<RuntimeClientEventSubscriptionHandle> => {
          attempt += 1
          if (attempt === 1) {
            onErrorCb = onError
            return Promise.resolve({ unsubscribe })
          }
          return Promise.reject(new Error('unreachable'))
        }
      )
      const sync = createRuntimeClientEventsSync({
        getDesiredEnvironmentIds: () => ['A'],
        subscribe,
        onEvent: vi.fn(),
        retryDelayMs: 10,
        retryMaxDelayMs: 1_000,
        random: () => 1
      })

      sync.sync()
      await Promise.resolve()
      expect(attempt).toBe(1)

      // Mid-stream drop on the established subscription: counts as failure #1, so
      // the first retry fires at the base delay.
      onErrorCb!(new Error('drop'))
      await vi.advanceTimersByTimeAsync(10)
      expect(attempt).toBe(2)

      // Because the drop already counted, the rejected retry is failure #2 and the
      // next retry uses the DOUBLED delay (20ms). Were the drop not counted, this
      // would fire at the base 10ms instead.
      await vi.advanceTimersByTimeAsync(19)
      expect(attempt).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempt).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the drop backoff after each successful re-subscribe (flapping stays at base delay)', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(['A'], { retryDelayMs: 10, random: () => 1 })
      h.sync.sync()
      h.recordsFor('A')[0].resolveWith()
      await vi.advanceTimersByTimeAsync(0)

      // First drop → retry at the base delay → re-establish successfully.
      h.recordsFor('A')[0].onError(new Error('drop 1'))
      await vi.advanceTimersByTimeAsync(10)
      expect(h.recordsFor('A')).toHaveLength(2)
      h.recordsFor('A')[1].resolveWith()
      await vi.advanceTimersByTimeAsync(0)

      // Second drop on the re-established subscription retries AGAIN at the base
      // delay: the successful re-subscribe reset the failure counter. Without the
      // reset this would be delayed to the doubled 20ms.
      h.recordsFor('A')[1].onError(new Error('drop 2'))
      await vi.advanceTimersByTimeAsync(9)
      expect(h.recordsFor('A')).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.recordsFor('A')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
