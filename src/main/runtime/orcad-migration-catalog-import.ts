import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type { Store } from '../persistence'

type OrcadMigrationCatalogFlushStore = Partial<Pick<Store, 'flushPendingOrThrowAsync'>>
type OrcadMigrationCatalogStageStore = OrcadMigrationCatalogFlushStore &
  Partial<Pick<Store, 'stageOrcadMigrationCatalog'>>
type OrcadMigrationCatalogCommitStore = OrcadMigrationCatalogFlushStore &
  Partial<Pick<Store, 'commitStagedOrcadMigrationCatalog'>>
type OrcadMigrationCatalogAbortStore = OrcadMigrationCatalogFlushStore &
  Partial<Pick<Store, 'abortStagedOrcadMigrationCatalog'>>

export async function stageOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogStageStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
}): Promise<OrcadMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.stageOrcadMigrationCatalog!(args.manifest)
  await flushMigrationState(args.store, args.signal)
  return result
}

export async function commitStagedOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogCommitStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
  onDurableCommit: () => void
}): Promise<OrcadMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.commitStagedOrcadMigrationCatalog!(args.manifest)
  await flushMigrationState(args.store, args.signal)
  args.onDurableCommit()
  return result
}

export async function abortStagedOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogAbortStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
}): Promise<OrcadMigrationCatalogAbortResult> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.abortStagedOrcadMigrationCatalog!(args.manifest)
  // An already-absent retry may follow an in-memory abort whose flush failed.
  if (result.state === 'absent') {
    await flushMigrationState(args.store, args.signal)
    return { ...result, durableAbsent: true }
  }
  return result
}

export function getOrcadMigrationCatalogState(args: {
  store: Partial<Pick<Store, 'getOrcadMigrationCatalogState'>>
  manifest: OrcadMigrationManifest
}): OrcadMigrationCatalogState {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  return args.store.getOrcadMigrationCatalogState!(args.manifest)
}

function flushMigrationState(
  store: OrcadMigrationCatalogFlushStore,
  signal?: AbortSignal
): Promise<void> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  return store.flushPendingOrThrowAsync!({ signal, drainToStableGeneration: false })
}
