export const COPY_PROMPT_RESET_MS = 2000

/**
 * @typedef {{ copied: boolean, failed: boolean }} CopyPromptState
 * @typedef {{ writeText?: (text: string) => Promise<void> } | undefined | null} ClipboardLike
 * @typedef {{
 *   copy: (prompt: string) => Promise<'copied' | 'failed'>,
 *   dispose: () => void
 * }} CopyPromptController
 */

/**
 * Clipboard write plus the copied/failed state machine, kept framework-free so the
 * insecure-context failure path is testable without a DOM harness.
 *
 * @param {{
 *   getClipboard: () => ClipboardLike,
 *   onState: (state: CopyPromptState) => void,
 *   setTimer?: (callback: () => void, delayMs: number) => unknown,
 *   clearTimer?: (handle: unknown) => void
 * }} options
 * @returns {CopyPromptController}
 */
export function createCopyPromptController({
  getClipboard,
  onState,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (handle) => clearTimeout(/** @type {never} */ (handle))
}) {
  /** @type {unknown} */
  let resetHandle = null

  const cancelReset = () => {
    if (resetHandle !== null) {
      clearTimer(resetHandle)
      resetHandle = null
    }
  }

  return {
    /**
     * @param {string} prompt
     * @returns {Promise<'copied' | 'failed'>}
     */
    async copy(prompt) {
      try {
        // Why: in an insecure context navigator.clipboard is undefined, so the user needs a
        // visible failure rather than a button that does nothing.
        const clipboard = getClipboard()
        if (typeof clipboard?.writeText !== 'function') {
          throw new Error('Clipboard API unavailable in this context')
        }
        await clipboard.writeText(prompt)
      } catch {
        cancelReset()
        onState({ copied: false, failed: true })
        return 'failed'
      }

      cancelReset()
      onState({ copied: true, failed: false })
      resetHandle = setTimer(() => {
        resetHandle = null
        onState({ copied: false, failed: false })
      }, COPY_PROMPT_RESET_MS)
      return 'copied'
    },
    // Why: the reset fires 2s later; an unmount (or a second click) in between would
    // otherwise leave a timer that calls setState on a dead component.
    dispose: cancelReset
  }
}
