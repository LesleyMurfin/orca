import type { AppState } from '@/store/types'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { runtimeHostConnectionState } from '@/runtime/runtime-host-connection-state'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { resolveExactWorktreeRoute } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  hasIndexedDetectedWorktree,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  type FolderWorkspaceRuntimeOwnerState
} from './folder-workspace-runtime-owner'

export { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'

export type WorktreeOperationRoute = {
  executionHostId: ExecutionHostId | null
  runtimeEnvironmentId: string | null
}

export type WorktreeOperationRouteResolution =
  | { kind: 'resolved'; route: WorktreeOperationRoute }
  | { kind: 'ambiguous' }
  // Why: the id is unknown, and the catalogs that would prove it absent have not arrived yet.
  // Runtime-owned projects are never persisted client-side, so at app start, on reconnect, and
  // right after a runtime drop every one of that host's ids is briefly unknown. Reporting them
  // `missing` in that window is what refused resume and delete for workspaces that do exist.
  | { kind: 'pending' }
  | { kind: 'missing' }

export type WorktreeOperationOwnerRecord = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

// settings/runtimeEnvironments come from FolderWorkspaceRuntimeOwnerState's legacy-owner base.
export type WorktreeOperationRouteState = FolderWorkspaceRuntimeOwnerState & {
  repos?: readonly Pick<AppState['repos'][number], 'id' | 'connectionId' | 'executionHostId'>[]
  worktreesByRepo?: Record<string, readonly WorktreeOperationOwnerRecord[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly WorktreeOperationOwnerRecord[] }>
  runtimeEnvironmentCatalogHydrated?: boolean
  removedRuntimeEnvironmentIds?: ReadonlySet<string>
  // Live per-runtime health, keyed by environment id. Absent for narrow adapters that cannot
  // observe connection state at all; those keep their catalog-blind verdict.
  runtimeStatusByEnvironmentId?: ReadonlyMap<string, { status: RuntimeStatus | null }>
  startupWorktreeRefreshCompleted?: boolean
}

function ownerRecordsOnHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationOwnerRecord[] {
  const owners: WorktreeOperationOwnerRecord[] = []
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      if (
        worktree.id === worktreeId &&
        parseExecutionHostId(worktree.hostId)?.id === executionHostId
      ) {
        owners.push(worktree)
      }
    }
  }
  for (const worktree of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)) {
    if (parseExecutionHostId(worktree.hostId)?.id === executionHostId) {
      owners.push(worktree)
    }
  }
  return owners
}

/**
 * The active workspace's host selection is authoritative identity, but it carries no transport:
 * an `ssh:` host reached through a paired HUB names the target, not the HUB that proxies it. Keep
 * the selected host and recover the runtime owner from the matching owner rows (#11346).
 */
export function resolveActiveWorkspaceRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRoute | null {
  const activeHost =
    state.activeWorktreeId === worktreeId
      ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  return activeHost ? resolveSelectedHostRoute(state, worktreeId, activeHost) : null
}

/**
 * Route an operation at the host the CALLER named rather than whichever host
 * the active workspace happens to select. `repoId::path` ids repeat across
 * hosts, so a destructive path that resolves host-blind can delete the same-id
 * workspace on the wrong machine (STA-4343); qualified callers resolve here.
 */
export function resolveWorktreeOperationRouteResultForHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationRouteResolution {
  const host = parseExecutionHostId(executionHostId)
  // Why: an unparseable qualifier is not evidence of an owner — fail closed.
  return host
    ? { kind: 'resolved', route: resolveSelectedHostRoute(state, worktreeId, host) }
    : { kind: 'missing' }
}

export function resolveWorktreeOperationRouteForHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationRoute | null {
  const resolution = resolveWorktreeOperationRouteResultForHost(state, worktreeId, executionHostId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

function resolveSelectedHostRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  selectedHost: NonNullable<ReturnType<typeof parseExecutionHostId>>
): WorktreeOperationRoute {
  if (selectedHost.kind === 'runtime') {
    return { executionHostId: selectedHost.id, runtimeEnvironmentId: selectedHost.environmentId }
  }
  // Why: only an `ssh:` selection can hide a paired HUB owner, so local stays an O(1) hot path.
  if (selectedHost.kind !== 'ssh') {
    return { executionHostId: selectedHost.id, runtimeEnvironmentId: null }
  }
  const environmentIds = new Set<string>()
  for (const owner of ownerRecordsOnHost(state, worktreeId, selectedHost.id)) {
    const resolution = resolveExactWorktreeRoute(state, owner)
    if (resolution.kind === 'resolved' && resolution.route.runtimeEnvironmentId) {
      environmentIds.add(resolution.route.runtimeEnvironmentId)
    }
  }
  const environmentId = environmentIds.values().next().value
  return {
    executionHostId: selectedHost.id,
    // Why: rival HUBs projecting the same host cannot be disambiguated by the host selection alone.
    runtimeEnvironmentId: environmentIds.size === 1 && environmentId ? environmentId : null
  }
}

/**
 * Distinct execution hosts the store knows as owners of this id. More than one
 * means an unqualified destructive call cannot pick a target without guessing;
 * empty means no owner row carries host provenance (legacy hydration).
 */
export function getWorktreeOperationOwnerHostIds(
  state: WorktreeOperationRouteState,
  worktreeId: string
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      const hostId = worktree.id === worktreeId ? parseExecutionHostId(worktree.hostId)?.id : null
      if (hostId) {
        hostIds.add(hostId)
      }
    }
  }
  for (const worktree of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)) {
    const hostId = parseExecutionHostId(worktree.hostId)?.id
    if (hostId) {
      hostIds.add(hostId)
    }
  }
  return [...hostIds]
}

/** Whether this runtime has published any repo/worktree row into the client store yet. */
function runtimeEnvironmentHasPublishedRows(
  state: WorktreeOperationRouteState,
  environmentId: string
): boolean {
  for (const repo of state.repos ?? []) {
    const host = parseExecutionHostId(repo.executionHostId ?? undefined)
    if (host?.kind === 'runtime' && host.environmentId === environmentId) {
      return true
    }
  }
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      const host = parseExecutionHostId(worktree.hostId)
      if (
        worktree.runtimeOwnerEnvironmentId === environmentId ||
        (host?.kind === 'runtime' && host.environmentId === environmentId)
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Whether the catalogs that would prove an id absent are still arriving, so an unknown id is
 * not-yet-known rather than known-absent. Two store signals decide it:
 * `runtimeEnvironmentCatalogHydrated` (the saved-runtime list itself has not loaded, so the
 * owning host may not even be nameable yet) and, per saved runtime, `runtimeStatusByEnvironmentId`
 * read through `runtimeHostConnectionState` — a reachable or still-being-probed runtime that has
 * published no rows here (or whose rows may be mid-refresh, `startupWorktreeRefreshCompleted`)
 * still owes this store its projects. A `disconnected` runtime owes nothing: it will never publish,
 * so its ids stay `missing` and every destructive path keeps failing closed.
 */
export function hasPendingWorktreeOperationCatalog(
  state: WorktreeOperationRouteState
): boolean {
  const statuses = state.runtimeStatusByEnvironmentId
  if (statuses === undefined) {
    // Why: a caller that cannot observe runtime health has no evidence of pending hydration
    // either — keep its existing verdict rather than inventing a wait.
    return false
  }
  if (state.runtimeEnvironmentCatalogHydrated !== true) {
    return true
  }
  return (state.runtimeEnvironments ?? []).some((environment) => {
    const environmentId = environment.id
    if (state.removedRuntimeEnvironmentIds?.has(environmentId)) {
      return false
    }
    const entry = statuses.get(environmentId)
    if (
      runtimeHostConnectionState({ hasStatusEntry: entry !== undefined, status: entry?.status }) ===
      'disconnected'
    ) {
      return false
    }
    return (
      state.startupWorktreeRefreshCompleted === false ||
      !runtimeEnvironmentHasPublishedRows(state, environmentId)
    )
  })
}

export function resolveWorktreeOperationRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRoute | null {
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

export function resolveWorktreeOperationRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const activeRoute = resolveActiveWorkspaceRoute(state, worktreeId)
  if (activeRoute) {
    return { kind: 'resolved', route: activeRoute }
  }
  // Why: folder workspaces are not Git worktrees — they never appear in the worktree/repo
  // catalogs scanned below, so without this branch a plain local folder workspace reads as an
  // unresolved cross-host identity and every owner-routed operation fails closed (#10251).
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return resolveFolderWorkspaceOperationRoute(state, workspaceScope.folderWorkspaceId)
  }
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicitResolution.kind !== 'missing') {
    return explicitResolution
  }

  const hasKnownWorktree =
    resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId).kind !== 'missing' ||
    hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const hasKnownRepo = state.repos?.some((repo) => repo.id === repoId) === true
  if (!hasKnownWorktree && !hasKnownRepo) {
    // Why: unknown is only proof of absence once the catalogs that would carry the row are
    // trustworthy. While a paired runtime is still publishing, treat it as not-yet-known.
    return hasPendingWorktreeOperationCatalog(state) ? { kind: 'pending' } : { kind: 'missing' }
  }

  // Why: a known row published with no owner fields at all — its repo carries no host either, or
  // the explicit catalog pass above would have routed it — is positive identity evidence, the same
  // reasoning folder workspaces use (#10251). Without it a plain local worktree stops routing, and
  // terminal creation reports an unresolvable owner, the moment one unrelated runtime is
  // configured. A hydrated catalog with no removed runtimes is what makes the absent owner fields
  // trustworthy: mid-hydration, or right after a runtime is removed, a genuinely remote row can
  // still be missing its owner, so those keep failing closed.
  const ownerlessRowIsLocal =
    hasKnownWorktree &&
    state.runtimeEnvironmentCatalogHydrated === true &&
    (state.removedRuntimeEnvironmentIds?.size ?? 0) === 0
  const LOCAL_ROUTE: WorktreeOperationRouteResolution = {
    kind: 'resolved',
    route: { executionHostId: 'local', runtimeEnvironmentId: null }
  }

  // Why: pre-owner-projection runtimes published no host fields; terminal routing retains their single focused-runtime behavior.
  const legacyRuntimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  const savedRuntimeIds = state.runtimeEnvironments?.map((environment) => environment.id.trim())
  const legacyRuntimeIsUnambiguous =
    savedRuntimeIds === undefined ||
    (savedRuntimeIds.length === 1 && savedRuntimeIds[0] === legacyRuntimeEnvironmentId)
  if (legacyRuntimeEnvironmentId && !legacyRuntimeIsUnambiguous) {
    return ownerlessRowIsLocal ? LOCAL_ROUTE : { kind: 'missing' }
  }
  if (legacyRuntimeEnvironmentId) {
    return {
      kind: 'resolved',
      route: {
        executionHostId: `runtime:${encodeURIComponent(legacyRuntimeEnvironmentId)}`,
        runtimeEnvironmentId: legacyRuntimeEnvironmentId
      }
    }
  }
  const mayBeLegacyLocal =
    (savedRuntimeIds === undefined ||
      (state.runtimeEnvironmentCatalogHydrated === true && savedRuntimeIds.length === 0)) &&
    (state.removedRuntimeEnvironmentIds?.size ?? 0) === 0
  return mayBeLegacyLocal || ownerlessRowIsLocal ? LOCAL_ROUTE : { kind: 'missing' }
}

function resolveFolderWorkspaceOperationRoute(
  state: WorktreeOperationRouteState,
  folderWorkspaceId: string
): WorktreeOperationRouteResolution {
  if (!findFolderWorkspaceOwner(state, folderWorkspaceId)) {
    // Why: deleted/stale folder ids keep failing closed like unknown worktrees.
    return { kind: 'missing' }
  }
  // Why: a found folder record is positive identity evidence, so keep terminal-owner parity;
  // the worktree legacy hydration gates would fail local folders closed whenever unrelated
  // runtimes exist — the exact #10251 symptom.
  const executionHostId = getExecutionHostIdForFolderWorkspace(state, folderWorkspaceId)
  const parsedHost = parseExecutionHostId(executionHostId)
  return {
    kind: 'resolved',
    route: {
      executionHostId,
      runtimeEnvironmentId: parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
    }
  }
}

export function settingsForWorktreeOperationRoute(
  settings: AppState['settings'],
  route: WorktreeOperationRoute
): AppState['settings'] {
  return settings
    ? { ...settings, activeRuntimeEnvironmentId: route.runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: route.runtimeEnvironmentId } as AppState['settings'])
}
