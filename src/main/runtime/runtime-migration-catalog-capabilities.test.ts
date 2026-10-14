import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { store } from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationCatalogState,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'

const manifest: OrcadMigrationManifest = {
  version: ORCAD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-capabilities',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'source', sshTargetGeneration: null, targetLabel: 'Source' },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
  manifestSha256: '0'.repeat(64)
}

const staged: OrcadMigrationCatalogState = {
  state: 'staged',
  migrationId: manifest.migrationId,
  manifestSha256: manifest.manifestSha256,
  stagedAt: manifest.createdAt
}

describe('runtime migration catalog capabilities', () => {
  it('re-enters requireStore after checking the captured store capabilities', () => {
    const seen: OrcaRuntimeService[] = []
    class Probe extends OrcaRuntimeService {
      protected override requireStore(): RuntimeStore {
        seen.push(this)
        return super.requireStore()
      }
    }
    const runtime = new Probe({ ...store, getOrcadMigrationCatalogState: () => staged })
    expect(runtime.getOrcadMigrationCatalogState(manifest)).toBe(staged)
    expect(seen).toEqual([runtime])
  })

  it('retains the native missing-method error on a different returned store', () => {
    const seen: OrcaRuntimeService[] = []
    class Probe extends OrcaRuntimeService {
      protected override requireStore(): RuntimeStore {
        seen.push(this)
        return store
      }
    }
    const runtime = new Probe({ ...store, getOrcadMigrationCatalogState: () => staged })
    expect(() => runtime.getOrcadMigrationCatalogState(manifest)).toThrow(TypeError)
    expect(seen).toEqual([runtime])
  })

  it('mutates the returned store before its native missing-flush rejection', async () => {
    const stage = vi.fn(() => staged)
    class Probe extends OrcaRuntimeService {
      protected override requireStore(): RuntimeStore {
        return { ...store, stageOrcadMigrationCatalog: stage }
      }
    }
    const runtime = new Probe({
      ...store,
      stageOrcadMigrationCatalog: () => staged,
      flushPendingOrThrowAsync: async () => {}
    })
    const pending = runtime.stageOrcadMigrationCatalog(manifest)
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toThrow(TypeError)
    expect(stage).toHaveBeenCalledWith(manifest)
    expect(stage).toHaveBeenCalledOnce()
  })

  it('refuses a catalog read when the runtime has no store', () => {
    const runtime = new OrcaRuntimeService(null)
    expect(() => runtime.getOrcadMigrationCatalogState(manifest)).toThrow('runtime_unavailable')
  })

  it('refuses a missing catalog reader on a partial store', () => {
    const runtime = new OrcaRuntimeService(store)
    expect(() => runtime.getOrcadMigrationCatalogState(manifest)).toThrow('runtime_unavailable')
  })

  it('refuses staging before mutation when the partial store cannot flush', async () => {
    const stage = vi.fn(() => staged)
    const runtime = new OrcaRuntimeService({ ...store, stageOrcadMigrationCatalog: stage })
    await expect(runtime.stageOrcadMigrationCatalog(manifest)).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(stage).not.toHaveBeenCalled()
  })

  it('admits staging with only the methods that operation needs', async () => {
    const stage = vi.fn(() => staged)
    const flush = vi.fn(async () => {})
    const runtime = new OrcaRuntimeService({
      ...store,
      stageOrcadMigrationCatalog: stage,
      flushPendingOrThrowAsync: flush
    })
    await expect(runtime.stageOrcadMigrationCatalog(manifest)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledWith(manifest)
    expect(flush).toHaveBeenCalledOnce()
  })
})
