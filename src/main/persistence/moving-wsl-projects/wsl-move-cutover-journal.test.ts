import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { orcadMigrationCutoverJournalDirectory } from '../../ssh/orcad-migration-cutover-journal'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-journal-'))
})
afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

const journalPath = (id: string) => join(wslMoveJournalDirectory(userDataPath), `${id}.json`)

describe('WSL move journal', () => {
  it('round-trips a move in an owner-only file of its own directory', () => {
    writeWslMoveCutover(userDataPath, cutover())
    expect(listWslMoveCutovers(userDataPath)).toEqual([cutover()])
    expect(wslMoveJournalDirectory(userDataPath)).not.toBe(
      orcadMigrationCutoverJournalDirectory(userDataPath)
    )
    if (process.platform !== 'win32') {
      expect(statSync(journalPath('move-1')).mode & 0o077).toBe(0)
    }
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['another distro key', JSON.stringify({ ...cutover(), journalKey: 'local-wsl:debian' })],
    ['a tampered manifest', JSON.stringify({ ...cutover(), manifestSha256: 'f'.repeat(64) })],
    ['an unknown phase', JSON.stringify({ ...cutover(), phase: 'teleported' })]
  ])('fails closed on %s', (_label, contents) => {
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), contents)
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })

  it('refuses a second move into a distro while the first is in flight', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
      )
    ).toThrow('wsl_move_already_in_flight')
  })

  it('chains a delta move after a finished one, and only onto the head', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-2'))).toThrow(
      'wsl_move_must_extend_its_chain'
    )
    writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    expect(
      listWslMoveCutoverChain(userDataPath, wslMoveJournalKey('ubuntu')).map((c) => c.migrationId)
    ).toEqual(['move-1', 'move-2'])
  })

  it('advances its own record through the phases', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('source-fenced')
  })

  it('never moves a record backwards, rebinds it, or advances a superseded one', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))).toThrow(
      'wsl_move_phase_regressed'
    )
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'retained', {}, { repoIds: ['repo-1', 'repo-2'] })
      )
    ).toThrow('wsl_move_binding_changed')
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    // Rewriting the finished link unchanged is fine; nothing may restart it.
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
  })

  it('hands out records a caller cannot edit into the next comparison', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const [listed] = listWslMoveCutovers(userDataPath)
    if (listed) {
      listed.phase = 'prepared'
    }
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('destination-committed')
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))).toThrow(
      'wsl_move_phase_regressed'
    )
  })

  it('refuses one id for two distros, and a first move that names a predecessor', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1'))
    const debian = cutover('move-1')
    const other = { ...debian, journalKey: wslMoveJournalKey('Debian') }
    other.manifest = { ...debian.manifest, source: { ...debian.manifest.source, distro: 'Debian' } }
    expect(() => writeWslMoveCutover(userDataPath, other)).toThrow()
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-9', 'prepared', { supersedesMigrationId: 'gone' })
      )
    ).toThrow()
  })

  it('keeps the fence: an in-flight record cannot be removed', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(() => removeWslMoveCutover(userDataPath, 'move-1')).toThrow('wsl_move_in_flight')
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })

  it('fails closed on a manifest edited without re-signing it', () => {
    const record = cutover()
    const edited = {
      ...record,
      manifest: {
        ...record.manifest,
        source: { ...record.manifest.source, scopeRepoIds: ['repo-2'] },
        payload: {
          ...record.manifest.payload,
          repositories: [{ ...record.manifest.payload.repositories[0], id: 'repo-2' }]
        }
      }
    }
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), JSON.stringify(edited))
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })
})
