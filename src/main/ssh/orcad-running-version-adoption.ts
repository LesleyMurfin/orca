/**
 * A first deploy onto a host whose orcad another Orca version already runs. Its terminal count
 * needs a paired connection, so the update would always wait; instead this client pairs with the
 * running build as it is, and the linked update check decides whether it may replace it.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import { OrcadActiveReadinessError, probeActiveOrcadReadiness } from './orcad-active-readiness'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { resolveOrcadSlotIdentity, type OrcadSlotOptions } from './orcad-recovery-slot'

export type OrcadRunningAdoption = {
  version: string
  readiness: ServeReadiness
  /** Reads the adopted slot's readiness again, e.g. after it rebinds its port. */
  reprobe: () => Promise<ServeReadiness>
}

/** Null when no other version is activated, so the caller deploys its own as usual. */
export async function adoptRunningOrcadVersion(
  slot: OrcadSlotOptions,
  record: OrcadActivationRecord,
  localVersion: string
): Promise<OrcadRunningAdoption | null> {
  if (!record.active || record.active === localVersion) {
    return null
  }
  // Starts it only on proven exit: an idle stop leaves its daemon's terminals running.
  const wake = await wakeStoppedManagedOrcad(slot)
  switch (wake.outcome) {
    // Another desktop stopped it meanwhile, or holds the fence; the deploy's own gates decide.
    case 'not-activated':
    case 'fenced':
      return null
    case 'unverifiable':
      throw new OrcadActiveReadinessError(
        'unverifiable',
        `Orca ${record.active} runs this host's server, but its process state is unverifiable, ` +
          'so it was left as it is. Try connecting again.'
      )
    case 'recovery-refused':
      throw new Error(wake.reason)
    case 'serving':
    case 'started':
      break
  }
  // Re-read: the wake follows whatever the record names now, which another desktop may change.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active || active === localVersion) {
    return null
  }
  const identity = await resolveOrcadSlotIdentity(slot, active)
  const reprobe = () =>
    probeActiveOrcadReadiness(
      { ...slot, remoteInstallDir: identity.remoteDir },
      { buildHash: identity.buildHash, fullVersion: identity.version }
    )
  return { version: active, readiness: await reprobe(), reprobe }
}
