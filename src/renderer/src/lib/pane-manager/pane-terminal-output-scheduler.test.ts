import { afterEach, describe, expect, it, vi } from 'vitest'

function createTerminal() {
  return {
    write: vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
  }
}

function writtenData(terminal: ReturnType<typeof createTerminal>): string[] {
  return terminal.write.mock.calls.map(([data]) => data)
}

async function loadScheduler() {
  vi.resetModules()
  return import('./pane-terminal-output-scheduler')
}

describe('pane terminal output scheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes foreground output immediately', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'foreground', { foreground: true })

    expect(writtenData(terminal)).toEqual(['foreground'])
  })

  it('coalesces background output until the shared drain runs', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'a', { foreground: false })
    writeTerminalOutput(terminal, 'b', { foreground: false })

    expect(terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(writtenData(terminal)).toEqual(['ab'])
  })

  it('limits how many background terminals begin xterm writes per drain tick', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminals = [createTerminal(), createTerminal(), createTerminal()]

    terminals.forEach((terminal, index) => {
      writeTerminalOutput(terminal, `pane-${index}`, { foreground: false })
    })

    vi.advanceTimersByTime(50)
    expect(writtenData(terminals[0])).toEqual(['pane-0'])
    expect(writtenData(terminals[1])).toEqual(['pane-1'])
    expect(terminals[2].write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(writtenData(terminals[2])).toEqual(['pane-2'])
  })

  it('rotates terminals with remaining backlog behind untouched queued terminals', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminals = [createTerminal(), createTerminal(), createTerminal()]
    const largeChunk = 'x'.repeat(20 * 1024)

    writeTerminalOutput(terminals[0], largeChunk, { foreground: false })
    writeTerminalOutput(terminals[1], 'pane-1', { foreground: false })
    writeTerminalOutput(terminals[2], 'pane-2', { foreground: false })

    vi.advanceTimersByTime(50)
    expect(terminals[0].write).toHaveBeenCalledTimes(1)
    expect(writtenData(terminals[1])).toEqual(['pane-1'])
    expect(terminals[2].write).not.toHaveBeenCalled()

    // Why: a terminal with leftover bytes is deleted/re-set after each drain
    // chunk, moving it to the back of the Map so a big burst cannot starve
    // other queued panes.
    vi.advanceTimersByTime(16)
    expect(writtenData(terminals[2])).toEqual(['pane-2'])
    expect(terminals[0].write).toHaveBeenCalledTimes(2)
  })

  it('flushes queued output before foreground output on the same terminal', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'old', { foreground: false })
    writeTerminalOutput(terminal, 'new', { foreground: true })

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['old', 'new'])
  })

  it('waits for xterm write callbacks before starting the next write for a terminal', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const callbacks: (() => void)[] = []
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback)
        }
      })
    }

    writeTerminalOutput(terminal, 'first', { foreground: true })
    writeTerminalOutput(terminal, 'second', { foreground: true })

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['first'])

    callbacks.shift()?.()

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['first', 'second'])
  })

  it('acknowledges background chunks only after xterm parses each split write', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const callbacks: (() => void)[] = []
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback)
        }
      })
    }
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'x'.repeat(20 * 1024), { foreground: false, onParsed })

    vi.advanceTimersByTime(50)
    expect(terminal.write.mock.calls.map(([data]) => data.length)).toEqual([16 * 1024])
    expect(onParsed).not.toHaveBeenCalled()

    callbacks.shift()?.()
    expect(onParsed).toHaveBeenCalledWith(16 * 1024)

    vi.advanceTimersByTime(16)
    expect(terminal.write.mock.calls.map(([data]) => data.length)).toEqual([16 * 1024, 4 * 1024])

    callbacks.shift()?.()
    expect(onParsed).toHaveBeenLastCalledWith(4 * 1024)
  })

  it('discards queued output for disposed terminals', async () => {
    vi.useFakeTimers()
    const { discardTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'stale', { foreground: false, onParsed })
    discardTerminalOutput(terminal)
    vi.advanceTimersByTime(50)

    expect(terminal.write).not.toHaveBeenCalled()
    expect(onParsed).toHaveBeenCalledWith('stale'.length)
  })

  it('does not continue queued writes after discard during an in-flight xterm write', async () => {
    vi.useFakeTimers()
    const { discardTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const callbacks: (() => void)[] = []
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback)
        }
      })
    }
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'first', { foreground: true, onParsed })
    writeTerminalOutput(terminal, 'second', { foreground: true, onParsed })
    discardTerminalOutput(terminal)

    callbacks.shift()?.()

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['first'])
    expect(onParsed.mock.calls).toEqual([[5], [6]])
  })

  it('ignores stale callbacks from a discarded write state after new output starts', async () => {
    vi.useFakeTimers()
    const { discardTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const callbacks: (() => void)[] = []
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback)
        }
      })
    }

    writeTerminalOutput(terminal, 'old-first', { foreground: true })
    writeTerminalOutput(terminal, 'old-second', { foreground: true })
    discardTerminalOutput(terminal)
    writeTerminalOutput(terminal, 'new-first', { foreground: true })
    writeTerminalOutput(terminal, 'new-second', { foreground: true })

    callbacks[0]?.()

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['old-first', 'new-first'])

    callbacks[1]?.()

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual([
      'old-first',
      'new-first',
      'new-second'
    ])
  })

  it('acknowledges an abandoned write when xterm never calls back', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = {
      write: vi.fn()
    }
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'stuck', { foreground: true, onParsed })
    writeTerminalOutput(terminal, 'after', { foreground: true, onParsed })

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['stuck'])

    vi.advanceTimersByTime(30_000)

    expect(onParsed).toHaveBeenCalledWith('stuck'.length)
    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['stuck', 'after'])
  })

  it('survives a write to a disposed terminal during background drain', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const throwing = {
      write: vi.fn(() => {
        throw new Error('terminal disposed')
      })
    }

    writeTerminalOutput(throwing, 'late-ping', { foreground: false })

    // Why: drain runs inside setTimeout; if the throw escapes drainQueuedOutput
    // it would crash the timer callback and leave the scheduler poisoned.
    expect(() => vi.advanceTimersByTime(50)).not.toThrow()
    expect(throwing.write).toHaveBeenCalledTimes(1)

    // Advancing further must not rediscover the dead entry.
    vi.advanceTimersByTime(100)
    expect(throwing.write).toHaveBeenCalledTimes(1)
  })

  it('resolves callbacks when xterm throws synchronously', async () => {
    vi.useFakeTimers()
    const { waitForTerminalOutputParsed } = await loadScheduler()
    const throwing = {
      write: vi.fn(() => {
        throw new Error('terminal disposed')
      })
    }
    let resolved = false

    void waitForTerminalOutputParsed(throwing).then(() => {
      resolved = true
    })

    await Promise.resolve()

    expect(resolved).toBe(true)
  })
})
