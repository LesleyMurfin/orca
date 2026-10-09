import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COPY_PROMPT_RESET_MS,
  createCopyPromptController
} from '../src/components/docs/copy-prompt-clipboard.mjs'

function harness(getClipboard) {
  const states = []
  const timers = new Map()
  let nextHandle = 1
  let cleared = 0
  const controller = createCopyPromptController({
    getClipboard,
    onState: (state) => states.push(state),
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++
      timers.set(handle, { callback, delayMs })
      return handle
    },
    clearTimer: (handle) => {
      cleared += 1
      timers.delete(handle)
    }
  })
  return {
    controller,
    states,
    timers,
    clearedCount: () => cleared,
    runTimers: () => {
      // Snapshot: a callback may schedule a new timer that must not run in this pass.
      for (const [handle, timer] of Array.from(timers)) {
        timers.delete(handle)
        timer.callback()
      }
    }
  }
}

test('a resolved clipboard write enters the copied state and schedules a reset', async () => {
  const written = []
  const { controller, states, timers, runTimers } = harness(() => ({
    writeText: async (text) => {
      written.push(text)
    }
  }))

  assert.equal(await controller.copy('prompt text'), 'copied')
  assert.deepEqual(written, ['prompt text'])
  assert.deepEqual(states, [{ copied: true, failed: false }])
  assert.deepEqual(
    [...timers.values()].map((timer) => timer.delayMs),
    [COPY_PROMPT_RESET_MS]
  )

  runTimers()
  assert.deepEqual(states.at(-1), { copied: false, failed: false })
})

test('a rejected clipboard write surfaces the failure state instead of failing silently', async () => {
  const { controller, states, timers } = harness(() => ({
    writeText: async () => {
      throw new Error('denied')
    }
  }))

  assert.equal(await controller.copy('prompt text'), 'failed')
  assert.deepEqual(states, [{ copied: false, failed: true }])
  assert.equal(timers.size, 0)
})

test('an absent clipboard API fails visibly rather than throwing', async () => {
  for (const getClipboard of [() => undefined, () => null, () => ({}), () => ({ writeText: null })]) {
    const { controller, states } = harness(getClipboard)
    assert.equal(await controller.copy('prompt text'), 'failed')
    assert.deepEqual(states, [{ copied: false, failed: true }])
  }
})

test('a later failure clears the pending reset so it cannot fire', async () => {
  let fail = false
  const { controller, states, timers, clearedCount } = harness(() => ({
    writeText: async () => {
      if (fail) {
        throw new Error('denied')
      }
    }
  }))

  await controller.copy('prompt text')
  assert.equal(timers.size, 1)
  fail = true
  await controller.copy('prompt text')
  assert.equal(timers.size, 0)
  assert.equal(clearedCount(), 1)
  assert.deepEqual(states.at(-1), { copied: false, failed: true })
})

test('dispose clears the reset timer instead of letting it fire after teardown', async () => {
  const { controller, states, timers, clearedCount, runTimers } = harness(() => ({
    writeText: async () => {}
  }))

  await controller.copy('prompt text')
  assert.equal(timers.size, 1)

  controller.dispose()
  assert.equal(timers.size, 0)
  assert.equal(clearedCount(), 1)

  runTimers()
  assert.deepEqual(states, [{ copied: true, failed: false }])

  controller.dispose()
  assert.equal(clearedCount(), 1)
})
