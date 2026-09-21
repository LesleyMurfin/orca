import { describe, expect, it } from 'vitest'
import { matchesProcessIncarnation } from './worker-terminal-process-liveness'

describe('matchesProcessIncarnation', () => {
  it.each([
    {
      name: 'an exact ptyId:incarnation match',
      ptyId: 'pty-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: 'incarnation-1' as string | null | undefined,
      processIncarnation: 'pty-1:incarnation-1',
      expected: true
    },
    {
      name: 'a Windows repo::C:\\path@@1 ptyId whose incarnation matches',
      ptyId: 'repo::C:\\path@@1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: 'incarnation-win' as string | null | undefined,
      processIncarnation: 'repo::C:\\path@@1:incarnation-win',
      expected: true
    },
    {
      name: 'a colon-bearing relay incarnationId that a lastIndexOf split would mangle',
      ptyId: 'relay-pty',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: 'relay:conn-3:incarnation-9' as string | null | undefined,
      processIncarnation: 'relay-pty:relay:conn-3:incarnation-9',
      expected: true
    },
    {
      name: 'a whitespace-dirty incarnationId (lost contact is never a match)',
      ptyId: 'pty-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: ' incarnation-1' as string | null | undefined,
      processIncarnation: 'pty-1: incarnation-1',
      expected: false
    },
    {
      name: 'an empty-string incarnationId',
      ptyId: 'pty-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: '' as string | null | undefined,
      processIncarnation: 'pty-1:',
      expected: false
    },
    {
      name: 'an absent (null) incarnationId',
      ptyId: 'pty-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: null as string | null | undefined,
      processIncarnation: 'pty-1:incarnation-1',
      expected: false
    },
    {
      name: 'an absent (undefined) incarnationId',
      ptyId: 'pty-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: undefined as string | null | undefined,
      processIncarnation: 'pty-1:incarnation-1',
      expected: false
    },
    {
      name: 'a prefix-decoy ptyId (@@1) against a longer live pty (@@10)',
      ptyId: 'repo::C:\\path@@1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fixture is deliberately shaped to exercise the private/runtime boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture crosses a private/runtime boundary with a verified shape.
      incarnationId: 'inc-1' as string | null | undefined,
      processIncarnation: 'repo::C:\\path@@10:inc-1',
      expected: false
    }
  ])('returns $expected for $name', ({ ptyId, incarnationId, processIncarnation, expected }) => {
    expect(matchesProcessIncarnation(ptyId, incarnationId, processIncarnation)).toBe(expected)
  })

  it('rejects a partial prefix that is not colon-delimited', () => {
    // 'pty-10' is not the pty 'pty-1'; the `${ptyId}:` fence keeps them distinct.
    expect(matchesProcessIncarnation('pty-1', 'inc', 'pty-10:inc')).toBe(false)
  })
})
