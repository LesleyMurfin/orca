import { describe, expect, it, vi } from 'vitest'
import { createLocalEchoController, isSpeculativeEchoEligible } from './terminal-local-echo'

function makeController(overrides: Partial<{ isEnabled: () => boolean }> = {}) {
  const write = vi.fn<(data: string) => void>()
  const clear = vi.fn<(count: number) => void>()
  const controller = createLocalEchoController({
    isEnabled: overrides.isEnabled ?? (() => true),
    write,
    clear
  })
  return { controller, write, clear }
}

describe('isSpeculativeEchoEligible', () => {
  it('accepts printable ASCII characters from space through tilde', () => {
    expect(isSpeculativeEchoEligible(' ')).toBe(true)
    expect(isSpeculativeEchoEligible('~')).toBe(true)
    expect(isSpeculativeEchoEligible('a')).toBe(true)
    expect(isSpeculativeEchoEligible('Z')).toBe(true)
    expect(isSpeculativeEchoEligible('5')).toBe(true)
    expect(isSpeculativeEchoEligible('!')).toBe(true)
  })

  it('accepts a multi-character chunk when every character is printable ASCII', () => {
    expect(isSpeculativeEchoEligible('ls -la')).toBe(true)
  })

  it('rejects an empty chunk', () => {
    expect(isSpeculativeEchoEligible('')).toBe(false)
  })

  it('rejects control characters below 0x20', () => {
    expect(isSpeculativeEchoEligible('\x03')).toBe(false) // Ctrl+C
    expect(isSpeculativeEchoEligible('\r')).toBe(false) // Enter
    expect(isSpeculativeEchoEligible('\t')).toBe(false) // Tab
    expect(isSpeculativeEchoEligible('\x1b')).toBe(false) // ESC
  })

  it('rejects DEL (0x7f) used for backspace', () => {
    expect(isSpeculativeEchoEligible('\x7f')).toBe(false)
  })

  it('rejects a chunk that is mostly printable but contains one control byte', () => {
    expect(isSpeculativeEchoEligible('ls\r')).toBe(false)
    expect(isSpeculativeEchoEligible('\x1b[Als')).toBe(false)
  })
})

describe('createLocalEchoController: speculative rendering of printable keystrokes', () => {
  it('immediately writes a single printable keystroke and buffers it as pending', () => {
    const { controller, write } = makeController()

    controller.handleLocalInput('a')

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('a')
    expect(controller.hasPending()).toBe(true)
  })

  it('accumulates successive printable keystrokes into the pending buffer', () => {
    const { controller, write } = makeController()

    controller.handleLocalInput('l')
    controller.handleLocalInput('s')

    expect(write).toHaveBeenNthCalledWith(1, 'l')
    expect(write).toHaveBeenNthCalledWith(2, 's')
    expect(write).toHaveBeenCalledTimes(2)
    expect(controller.hasPending()).toBe(true)
  })

  it('speculatively echoes a whole pasted printable chunk in one call', () => {
    const { controller, write } = makeController()

    controller.handleLocalInput('echo hi')

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('echo hi')
    expect(controller.hasPending()).toBe(true)
  })

  it('does nothing when the controller is disabled', () => {
    const { controller, write } = makeController({ isEnabled: () => false })

    controller.handleLocalInput('a')

    expect(write).not.toHaveBeenCalled()
    expect(controller.hasPending()).toBe(false)
  })
})

describe('createLocalEchoController: reconciliation against confirmed remote data', () => {
  it('passes remote data through unchanged when there is no pending speculation', () => {
    const { controller, clear } = makeController()

    const residual = controller.reconcileRemoteData('some server output\r\n')

    expect(residual).toBe('some server output\r\n')
    expect(clear).not.toHaveBeenCalled()
  })

  it('consumes an exact-match echo and leaves nothing further to write', () => {
    const { controller, clear } = makeController()
    controller.handleLocalInput('ls')

    const residual = controller.reconcileRemoteData('ls')

    expect(residual).toBe('')
    expect(clear).not.toHaveBeenCalled()
    expect(controller.hasPending()).toBe(false)
  })

  it('consumes the matching prefix and returns the remainder that follows the echo', () => {
    const { controller, clear } = makeController()
    controller.handleLocalInput('ls')

    const residual = controller.reconcileRemoteData('ls\r\nfile.txt\r\n$ ')

    expect(residual).toBe('\r\nfile.txt\r\n$ ')
    expect(clear).not.toHaveBeenCalled()
    expect(controller.hasPending()).toBe(false)
  })

  it('reconciles across multiple partial remote chunks that together match pending', () => {
    const { controller, clear } = makeController()
    controller.handleLocalInput('ls')

    const first = controller.reconcileRemoteData('l')
    expect(first).toBe('')
    expect(controller.hasPending()).toBe(true)

    const second = controller.reconcileRemoteData('s\r\n')
    expect(second).toBe('\r\n')
    expect(clear).not.toHaveBeenCalled()
    expect(controller.hasPending()).toBe(false)
  })

  it('erases the speculative render and forwards authoritative bytes on a full mismatch', () => {
    const { controller, clear } = makeController()
    controller.handleLocalInput('ls')

    const residual = controller.reconcileRemoteData('xyz')

    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(2)
    expect(residual).toBe('xyz')
    expect(controller.hasPending()).toBe(false)
  })

  it('erases the speculative render on a partial mismatch mid-buffer', () => {
    const { controller, clear } = makeController()
    controller.handleLocalInput('lsx')

    const residual = controller.reconcileRemoteData('ls ')

    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(3)
    expect(residual).toBe('ls ')
    expect(controller.hasPending()).toBe(false)
  })

  it('never double-prints: the sum of write() and reconciled residual equals confirmed server bytes', () => {
    const { controller, write } = makeController()
    controller.handleLocalInput('l')
    controller.handleLocalInput('s')

    const residual = controller.reconcileRemoteData('ls')

    const speculativelyWritten = write.mock.calls.map((call) => call[0]).join('')
    expect(speculativelyWritten + residual).toBe('ls')
  })
})

describe('createLocalEchoController: control keys bypass and clear speculation', () => {
  it('does not speculatively echo Ctrl+C and clears any pending buffer', () => {
    const { controller, write, clear } = makeController()
    controller.handleLocalInput('ls')
    write.mockClear()

    controller.handleLocalInput('\x03')

    expect(write).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(2)
    expect(controller.hasPending()).toBe(false)
  })

  it('does not speculatively echo Enter and clears any pending buffer', () => {
    const { controller, write, clear } = makeController()
    controller.handleLocalInput('ls')
    write.mockClear()

    controller.handleLocalInput('\r')

    expect(write).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(2)
    expect(controller.hasPending()).toBe(false)
  })

  it('does not speculatively echo an arrow-key escape sequence and clears pending', () => {
    const { controller, write, clear } = makeController()
    controller.handleLocalInput('cd')
    write.mockClear()

    controller.handleLocalInput('\x1b[A') // ArrowUp

    expect(write).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(2)
    expect(controller.hasPending()).toBe(false)
  })

  it('does not speculatively echo backspace/DEL and clears pending', () => {
    const { controller, write, clear } = makeController()
    controller.handleLocalInput('ab')
    write.mockClear()

    controller.handleLocalInput('\x7f')

    expect(write).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(2)
    expect(controller.hasPending()).toBe(false)
  })

  it('is a no-op clear-wise when a control key arrives with no pending buffer', () => {
    const { controller, write, clear } = makeController()

    controller.handleLocalInput('\x03')

    expect(write).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(controller.hasPending()).toBe(false)
  })
})

describe('createLocalEchoController: reset', () => {
  it('clears internal pending state without invoking the display clear callback', () => {
    const { controller, clear } = makeController()
    controller.handleLocalInput('ls')

    controller.reset()

    expect(controller.hasPending()).toBe(false)
    expect(clear).not.toHaveBeenCalled()
  })

  it('leaves subsequent reconciliation as a pass-through after reset', () => {
    const { controller } = makeController()
    controller.handleLocalInput('ls')
    controller.reset()

    const residual = controller.reconcileRemoteData('ls')

    expect(residual).toBe('ls')
  })
})
