/**
 * GAP-03 (revive_labs#962 / stablyai/orca#22038): offline paired desktop clients retain stale
 * tabs in `orca-data.json` and re-inject them upon reconnect.
 *
 * `fetchWorkspaceSessionWithRuntimeHostOwners` (src/renderer/src/lib/workspace-session-host-hydration.ts)
 * runs exactly once per app lifetime, at renderer boot (`use-app-startup-hydration.ts`). It is
 * NOT re-run on a live WebSocket/SSH reconnect inside a running app — confirmed by grepping every
 * call site in this worktree. The bug therefore only manifests across an actual app relaunch: a
 * paired client whose SSH host closed some of its tabs while the client was gone (network drop or
 * the app itself not running), reopened later. `ssh-lost-kill-tab-resurrection.spec.ts` already
 * covers the sibling, single-process-lifetime bug (STA-3374, a lost `pty.kill` reattach); this
 * spec is deliberately a *two-launch* `createRestartSession` test — same shape as
 * `golden-quit-relaunch-session.spec.ts` / `persisted-session-production-upgrade.spec.ts` — so it
 * exercises the actual boot-time reconciliation path GAP-03 touches.
 *
 * Sequence, matching the six required GAP-03 repro steps:
 *   1. Pair a client (first Electron launch) to a Dockerized SSH host (`docker-ssh-relay-target`).
 *   2. Open N terminal tabs on the SSH-hosted worktree.
 *   3. "Go offline": quit the client app. Its on-disk `orca-data.json` (`local.tabsByWorktree` and
 *      the frozen `ssh:<targetId>` host-partition mirror in `workspaceSessionsByHostId`) persists
 *      untouched — this is the literal on-disk shape of "offline, app state intact".
 *   4. Close M of the N tabs "server-side" while offline: edit ONLY the local base row
 *      (`workspaceSession.tabsByWorktree`) down to N-M tabs, leaving the stale SSH host-partition
 *      mirror at N tabs. This is the exact fixture shape
 *      `workspace-session-host-offline-reconnect.test.ts` uses, and precisely what "closed by the
 *      server while this client was offline" produces on disk (the host partition write requires
 *      the live SSH transport, which the offline client no longer has — see the spec's Current
 *      State section for the full mechanism). Editing the file directly (rather than an in-app
 *      admin RPC call) is this repo's own established technique for this exact class of fixture —
 *      see `persisted-session-production-upgrade.spec.ts`'s `installProductionSessionFixture`.
 *   5. "Reconnect": relaunch the app against the same profile — this is what a user reopening an
 *      offline paired desktop client does, and the only trigger for the boot-time hydration path.
 *   6. Measure resurrection: do the M closed tabs reappear? Also measure the #12721 non-regression:
 *      does a tab drafted entirely offline (present only in `local`, absent from every host
 *      partition, because it was never synced) survive the same relaunch?
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  createRemoteTerminalTab,
  readRemoteTerminalTabs
} from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
  startDockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const TAB_COUNT = Math.max(2, Number(process.env.ORCA_GAP03_TAB_COUNT ?? '4'))
const CLOSE_COUNT = Math.min(
  TAB_COUNT - 1,
  Math.max(1, Number(process.env.ORCA_GAP03_CLOSE_COUNT ?? '2'))
)
const OFFLINE_DRAFT_TAB_ID = 'gap03-offline-draft-tab'

type SessionProfile = {
  workspaceSession: { tabsByWorktree: Record<string, { id: string }[]> }
  workspaceSessionsByHostId?: Record<string, { tabsByWorktree?: Record<string, { id: string }[]> }>
}

function profilePath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function readProfile(userDataDir: string): SessionProfile {
  return JSON.parse(readFileSync(profilePath(userDataDir), 'utf8')) as SessionProfile
}

/** Emit one machine-readable KPI line, matching this project's before/after report convention. */
function logKpi(label: string, fields: Record<string, unknown>): void {
  console.log(`[gap-03] ${label}: ${JSON.stringify(fields)}`)
}

test.describe('GAP-03: offline client reconnect must not resurrect server-closed tabs (Docker cross-site)', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed GAP-03 tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  test('closed-while-offline tabs do not resurrect on client reopen; #12721 offline draft survives', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo)
    const target = startDockerSshRelayTarget(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // --- Step 1+2: pair to the Dockerized SSH host, open N tabs ---
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      const remote = await connectDockerSshRelayTarget(first.page, target)
      await expect
        .poll(() => waitForActiveWorktree(first.page), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(first.page, 60_000)
      await waitForActivePanePtyId(first.page, 60_000)
      for (let i = 1; i < TAB_COUNT; i += 1) {
        await createRemoteTerminalTab(first.page, remote.worktreeId)
      }
      const openedTabs = await readRemoteTerminalTabs(first.page, remote.worktreeId)
      expect(openedTabs.length, 'setup must open exactly TAB_COUNT tabs').toBe(TAB_COUNT)

      // A second, real SSH-hosted worktree on the same target, connected with zero tabs. Its
      // host-partition mirror genuinely has nothing for it — the exact "host has nothing for it"
      // shape #12721 protects, reproduced with a real catalog entry instead of a synthetic key.
      const offlineDraftTarget = await connectDockerSshRelayTarget(first.page, target, {
        remotePath: DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
        seedInitialTab: false
      })
      logKpi('setup', {
        worktreeId: remote.worktreeId,
        tabCount: openedTabs.length,
        offlineDraftWorktreeId: offlineDraftTarget.worktreeId
      })

      // --- Step 3: "go offline" — quit the client; its on-disk state (including the frozen SSH
      // host-partition mirror) is left exactly as the live app last wrote it. ---
      await session.close(firstApp)
      firstApp = null

      const sshHostId = toSshExecutionHostId(remote.targetId)
      const preFaultProfile = readProfile(session.userDataDir)
      const hostMirrorTabs =
        preFaultProfile.workspaceSessionsByHostId?.[sshHostId]?.tabsByWorktree?.[remote.worktreeId]
      expect(
        hostMirrorTabs?.length,
        `the SSH host-partition mirror (${sshHostId}) must have cached every opened tab before the fault is injected`
      ).toBe(TAB_COUNT)
      logKpi('offline-snapshot', {
        sshHostId,
        localTabs: preFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId]?.length ?? 0,
        hostMirrorTabs: hostMirrorTabs?.length ?? 0
      })

      // --- Step 4: close M of the N tabs "server-side" while offline. The local base row is
      // exactly what a live client resyncs to on next contact with the server; the stale SSH
      // host-partition mirror is left untouched, matching what an offline client's own on-disk
      // cache looks like the moment it went unreachable. ---
      const closedIds = openedTabs.slice(0, CLOSE_COUNT).map((t) => t.id)
      const survivorIds = openedTabs.slice(CLOSE_COUNT).map((t) => t.id)
      const closedFaultProfile = readProfile(session.userDataDir)
      const localRow = closedFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId] ?? []
      closedFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId] = localRow.filter(
        (tab) => survivorIds.includes(tab.id)
      )

      // #12721 non-regression, injected in the same fault-injection pass: a tab drafted entirely
      // offline lives only in `local`, on a real, catalog-known worktree whose SSH host partition
      // has never heard of it at all (connected with zero tabs above) — the exact "host has
      // nothing for it" shape `workspace-session-host-offline-reconnect.test.ts`'s non-regression
      // case pins.
      closedFaultProfile.workspaceSession.tabsByWorktree[offlineDraftTarget.worktreeId] = [
        {
          id: OFFLINE_DRAFT_TAB_ID,
          ptyId: null,
          worktreeId: offlineDraftTarget.worktreeId,
          title: 'offline draft',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: Date.now()
        } as unknown as { id: string }
      ]
      writeFileSync(
        profilePath(session.userDataDir),
        `${JSON.stringify(closedFaultProfile, null, 2)}\n`
      )
      logKpi('fault-injected', {
        closedIds,
        survivorIds,
        offlineDraftWorktreeId: offlineDraftTarget.worktreeId
      })

      // --- Step 5: "reconnect" — relaunch against the same profile. This is the only code path
      // that re-runs fetchWorkspaceSessionWithRuntimeHostOwners. ---
      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)

      // --- Step 6: measure resurrection and the #12721 non-regression. ---
      const afterTabs = await readRemoteTerminalTabs(second.page, remote.worktreeId)
      const afterIds = afterTabs.map((t) => t.id)
      const resurrected = closedIds.filter((id) => afterIds.includes(id))
      const offlineDraftSurvived = await second.page.evaluate(
        (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
        offlineDraftTarget.worktreeId
      )
      logKpi('post-relaunch', {
        expectedCount: survivorIds.length,
        actualCount: afterIds.length,
        resurrectedCount: resurrected.length,
        resurrectedIds: resurrected,
        offlineDraftSurvived: offlineDraftSurvived.includes(OFFLINE_DRAFT_TAB_ID)
      })

      expect(
        resurrected,
        `GAP-03: ${resurrected.length}/${closedIds.length} tabs closed while offline resurrected on reconnect`
      ).toEqual([])
      expect(
        afterIds.length,
        `tab count after reconnect must equal the survivor count, not the pre-close total`
      ).toBe(survivorIds.length)
      expect(
        offlineDraftSurvived,
        '#12721 non-regression: an offline-created, never-synced tab must survive reconnect'
      ).toContain(OFFLINE_DRAFT_TAB_ID)
    } finally {
      for (const app of [secondApp, firstApp]) {
        if (app) {
          await session.close(app).catch(() => undefined)
        }
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
