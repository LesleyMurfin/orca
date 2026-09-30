export type LocalEchoControllerOptions = {
  isEnabled: () => boolean
  write: (data: string) => void
  clear: (count: number) => void
}

export type LocalEchoController = {
  handleLocalInput(data: string): void
  reconcileRemoteData(data: string): string
  reset(): void
  hasPending(): boolean
}

/**
 * Returns true iff the chunk is non-empty and every character code is in [0x20, 0x7E].
 */
export function isSpeculativeEchoEligible(chunk: string): boolean {
  if (chunk.length === 0) {
    return false
  }

  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) {
      return false
    }
  }

  return true
}

export function createLocalEchoController(
  options: LocalEchoControllerOptions
): LocalEchoController {
  let pending = ''

  return {
    handleLocalInput(data: string): void {
      if (!options.isEnabled()) {
        return
      }

      if (isSpeculativeEchoEligible(data)) {
        options.write(data)
        pending += data
      } else {
        // Control key or ineligible chunk: if there's pending speculation, clear it
        if (pending.length > 0) {
          const count = pending.length
          pending = ''
          options.clear(count)
        }
      }
    },

    reconcileRemoteData(data: string): string {
      if (pending.length === 0) {
        return data
      }

      // Check if remote data starts matching pending or mismatches
      // Remote data can be shorter, equal, or longer than pending.
      // If remote matches pending up to min(remote.length, pending.length):
      const matchLen = Math.min(data.length, pending.length)
      const dataPrefix = data.slice(0, matchLen)
      const pendingPrefix = pending.slice(0, matchLen)

      if (dataPrefix === pendingPrefix) {
        // Remote matches the pending prefix!
        // Consume the matched prefix from pending.
        pending = pending.slice(matchLen)
        // The echoed prefix was already speculatively displayed.
        // Return only the remainder of remote data.
        return data.slice(matchLen)
      }

      // Mismatch: the speculative echo was incorrect or server diverged.
      // Clear all speculative characters rendered so far and return the full remote data.
      const count = pending.length
      pending = ''
      options.clear(count)
      return data
    },

    reset(): void {
      pending = ''
    },

    hasPending(): boolean {
      return pending.length > 0
    }
  }
}
