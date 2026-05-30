import { describe, expect, it } from 'vitest'
import { resolveTerminalFileUrlTarget } from './terminal-file-url-target'

describe('resolveTerminalFileUrlTarget', () => {
  it('resolves UNC file URLs with line and column anchors', () => {
    expect(
      resolveTerminalFileUrlTarget(new URL('file://Server/Share/Repo/src/app.ts#L12C3'))
    ).toEqual({
      filePath: '//server/Share/Repo/src/app.ts',
      line: 12,
      column: 3
    })
  })
})
