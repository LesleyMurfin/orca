import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeFileCommands } from './orca-runtime-files'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeFileReads } from './files/file-reads'
import { RuntimeTerminalArtifacts } from './terminal/artifacts/terminal-artifacts'
import type { RuntimeFileCommandHost } from './files/file-command-host'

const unexpectedHostRead = (): never => {
  throw new Error('unexpected_host_read')
}

const host = {
  getRuntimeId: () => 'artifact-facade',
  requireStore: unexpectedHostRead,
  resolveWorktreeSelector: async () => unexpectedHostRead(),
  resolveRuntimeFileTarget: async () => unexpectedHostRead(),
  resolveRuntimeGitTarget: async () => unexpectedHostRead(),
  openFile: unexpectedHostRead,
  openDiff: unexpectedHostRead
} satisfies RuntimeFileCommandHost

const reachedArtifactOwner = (): never => {
  throw new Error('artifact_owner_reached')
}

afterEach(() => vi.restoreAllMocks())

it('preserves artifact facade arity, optional slots, and the same artifact receiver', () => {
  const read = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'readTerminalArtifactFile')
    .mockImplementation(reachedArtifactOwner)
  const preview = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'readTerminalArtifactPreview')
    .mockImplementation(reachedArtifactOwner)
  const write = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'writeTerminalArtifactFile')
    .mockImplementation(reachedArtifactOwner)
  const revoke = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'revokeTerminalFileGrantsForClient')
    .mockImplementation(reachedArtifactOwner)
  const commands = new RuntimeFileCommands(host)

  expect([
    commands.readTerminalArtifactFile.length,
    commands.readTerminalArtifactPreview.length,
    commands.writeTerminalArtifactFile.length,
    commands.revokeTerminalFileGrantsForClient.length
  ]).toEqual([4, 5, 5, 1])

  expect(() => commands.readTerminalArtifactFile('worktree', 'grant', '/artifact')).toThrow(
    'artifact_owner_reached'
  )
  expect(() =>
    commands.readTerminalArtifactFile('worktree', 'grant', '/artifact', undefined)
  ).toThrow('artifact_owner_reached')
  expect(read.mock.calls).toEqual([
    ['worktree', 'grant', '/artifact', undefined],
    ['worktree', 'grant', '/artifact', undefined]
  ])

  expect(() => commands.readTerminalArtifactPreview('worktree', 'grant', '/artifact')).toThrow(
    'artifact_owner_reached'
  )
  expect(() =>
    commands.readTerminalArtifactPreview('worktree', 'grant', '/artifact', undefined, undefined)
  ).toThrow('artifact_owner_reached')
  expect(preview.mock.calls).toEqual([
    ['worktree', 'grant', '/artifact', undefined, undefined],
    ['worktree', 'grant', '/artifact', undefined, undefined]
  ])

  expect(() =>
    commands.writeTerminalArtifactFile('worktree', 'grant', '/artifact', 'text')
  ).toThrow('artifact_owner_reached')
  expect(() =>
    commands.writeTerminalArtifactFile('worktree', 'grant', '/artifact', 'text', undefined)
  ).toThrow('artifact_owner_reached')
  expect(write.mock.calls).toEqual([
    ['worktree', 'grant', '/artifact', 'text', undefined],
    ['worktree', 'grant', '/artifact', 'text', undefined]
  ])

  expect(() => commands.revokeTerminalFileGrantsForClient('client')).toThrow(
    'artifact_owner_reached'
  )
  expect(revoke.mock.calls).toEqual([['client']])
  const owner = read.mock.contexts[0]
  expect(owner).toBeInstanceOf(RuntimeTerminalArtifacts)
  for (const context of [read, preview, write, revoke].flatMap((spy) => spy.mock.contexts)) {
    expect(context).toBe(owner)
  }
})

const originalMethodMetadata = [
  ['openMobileFile', 3, true],
  ['openMobileDiff', 4, true],
  ['listRuntimeMarkdownDocuments', 1, true],
  ['pathsExistRuntimeFiles', 2, true],
  ['statRuntimeFile', 2, true],
  ['readMobileFile', 2, true],
  ['readFileExplorerPreview', 3, true],
  ['readDocPreviewFile', 6, true],
  ['readFileExplorerChunk', 4, true],
  ['writeFileExplorerFile', 6, true],
  ['writeFileExplorerFileBase64', 6, true],
  ['writeFileExplorerFileBase64Chunk', 7, true],
  ['createFileExplorerFile', 5, true],
  ['createFileExplorerDir', 5, true],
  ['createFileExplorerDirNoClobber', 5, true],
  ['commitFileExplorerUpload', 6, true],
  ['renameFileExplorerPath', 6, true],
  ['copyFileExplorerPath', 6, true],
  ['deleteFileExplorerPath', 6, true],
  ['readFileExplorerDir', 2, true],
  ['watchFileExplorer', 2, true],
  ['closeFileExplorerWatchersForPath', 2, true],
  ['restoreFileExplorerWatchersAfterFailedRemoval', 2, true],
  ['forgetFileExplorerWatchersAfterRemoval', 2, false],
  ['resolveTerminalPath', 7, true]
] as const

it('preserves the original public command arities and native async functions', () => {
  const commands = new RuntimeFileCommands(host)
  for (const [name, arity, async] of originalMethodMetadata) {
    expect(commands[name].length, name).toBe(arity)
    expect(Object.prototype.toString.call(commands[name]), name).toBe(
      async ? '[object AsyncFunction]' : '[object Function]'
    )
  }
})

it('installs the original public file command metadata on the actual runtime', () => {
  const runtime = new OrcaRuntimeService(null)
  const commands = {
    openMobileFile: runtime.openMobileFile,
    openMobileDiff: runtime.openMobileDiff,
    listRuntimeMarkdownDocuments: runtime.listRuntimeMarkdownDocuments,
    pathsExistRuntimeFiles: runtime.pathsExistRuntimeFiles,
    statRuntimeFile: runtime.statRuntimeFile,
    readMobileFile: runtime.readMobileFile,
    readFileExplorerPreview: runtime.readFileExplorerPreview,
    readDocPreviewFile: runtime.readDocPreviewFile,
    readFileExplorerChunk: runtime.readFileExplorerChunk,
    writeFileExplorerFile: runtime.writeFileExplorerFile,
    writeFileExplorerFileBase64: runtime.writeFileExplorerFileBase64,
    writeFileExplorerFileBase64Chunk: runtime.writeFileExplorerFileBase64Chunk,
    createFileExplorerFile: runtime.createFileExplorerFile,
    createFileExplorerDir: runtime.createFileExplorerDir,
    createFileExplorerDirNoClobber: runtime.createFileExplorerDirNoClobber,
    commitFileExplorerUpload: runtime.commitFileExplorerUpload,
    renameFileExplorerPath: runtime.renameFileExplorerPath,
    copyFileExplorerPath: runtime.copyFileExplorerPath,
    deleteFileExplorerPath: runtime.deleteFileExplorerPath,
    readFileExplorerDir: runtime.readFileExplorerDir,
    watchFileExplorer: runtime.watchFileExplorer,
    resolveTerminalPath: runtime.resolveTerminalPath
  }
  for (const [name, arity, async] of originalMethodMetadata) {
    if (!(name in commands)) {
      continue
    }
    const installed = Object.getOwnPropertyDescriptor(commands, name)?.value
    expect(installed.length, name).toBe(arity)
    expect(Object.prototype.toString.call(installed), name).toBe(
      async ? '[object AsyncFunction]' : '[object Function]'
    )
  }
})

it('preserves omitted argument slots, owner receivers, and the returned promise', () => {
  const returned: ReturnType<RuntimeFileReads['readFileExplorerPreview']> = Promise.resolve({
    content: 'bound-owner',
    isBinary: false
  })
  const read = vi
    .spyOn(RuntimeFileReads.prototype, 'readFileExplorerPreview')
    .mockImplementation(function (this: RuntimeFileReads) {
      return returned
    })
  const runtime = new OrcaRuntimeService(null)

  expect(runtime.readFileExplorerPreview('worktree', 'file')).toBe(returned)
  expect(runtime.readFileExplorerPreview('worktree', 'file', undefined)).toBe(returned)
  expect(read.mock.calls).toEqual([
    ['worktree', 'file'],
    ['worktree', 'file', undefined]
  ])
  expect(read.mock.contexts[0]).toBeInstanceOf(RuntimeFileReads)
  expect(read.mock.contexts[1]).toBe(read.mock.contexts[0])

  const replacement: ReturnType<RuntimeFileReads['readFileExplorerPreview']> = Promise.resolve({
    content: 'runtime-override',
    isBinary: false
  })
  vi.spyOn(runtime, 'readFileExplorerPreview').mockReturnValueOnce(replacement)
  expect(runtime.readFileExplorerPreview('other-worktree', 'other-file')).toBe(replacement)
  expect(read).toHaveBeenCalledTimes(2)
})
