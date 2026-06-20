import { describe, expect, it } from 'vitest'
import { shouldProtectSplitCursorBursts } from './split-cursor-burst-protection'

describe('shouldProtectSplitCursorBursts gate', () => {
  it('fires for a remote-runtime PTY (runtimeEnvironmentId set)', () => {
    expect(
      shouldProtectSplitCursorBursts({
        isNativeWindowsConpty: false,
        runtimeEnvironmentId: 'env-1'
      })
    ).toBe(true)
  })

  it('fires for a native-Windows ConPTY even with no remote runtime', () => {
    expect(
      shouldProtectSplitCursorBursts({
        isNativeWindowsConpty: true,
        runtimeEnvironmentId: null
      })
    ).toBe(true)
  })

  it('stays off for a local non-Windows PTY (no remote runtime, not ConPTY)', () => {
    expect(
      shouldProtectSplitCursorBursts({
        isNativeWindowsConpty: false,
        runtimeEnvironmentId: null
      })
    ).toBe(false)
  })
})
