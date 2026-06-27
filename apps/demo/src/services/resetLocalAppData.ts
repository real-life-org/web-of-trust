import { createIdentityWorkflow } from './identityWorkflow'
import { wipeAllLocalAppData } from './durableStoreWipe'
import { BiometricService } from './BiometricService'

/**
 * W1 — the single cross-tier full-wipe orchestrator. Every full-wipe trigger
 * (identity-delete, reset/create-new, legacy-break) calls ONLY this, no inline
 * copy. Order: seed record → personal-doc DBs → browser-storage + seed-vault
 * backstop → native keystore last.
 *
 * Best-effort by design (each tier `.catch`-swallowed, `deleteDatabase` resolves
 * even on onerror/onblocked), so it stays usable for the non-interactive
 * legacy-break path. This means the orchestrator alone is NOT a success proof —
 * the same tier failure we are closing would be swallowed. Interactive callers
 * MUST verify via {@link findSurvivingWipeTier} before treating the wipe as done
 * (W5); the legacy-break path is mitigated by its `storedSeedRemains` recheck +
 * the W3 password fallback.
 */
export async function resetLocalAppData(): Promise<void> {
  await createIdentityWorkflow().deleteStoredIdentity().catch(() => {})

  try {
    const { deletePersonalDocDB } = await import('@web_of_trust/adapter-automerge')
    await deletePersonalDocDB().catch(() => {})
  } catch {
    // adapter-automerge may fail to load (e.g. its WASM chunk fails to fetch on a
    // flaky network — the festival target env). Must NOT abort the orchestrator
    // before the security-critical tiers below (seed-vault + durable stores +
    // keystore); those run regardless of personal-doc cleanup.
  }

  try {
    const { deleteYjsPersonalDocDB } = await import('@web_of_trust/adapter-yjs')
    await deleteYjsPersonalDocDB().catch(() => {})
  } catch {
    // adapter-yjs may not be available in every build target.
  }

  // Tiers a–c: legacy DBs + the Seed-Vault + EVERY DID-aware durable store (incl.
  // the raw key material in IndexedDBKeyManagementAdapter, K1) + every deviceId key
  // + the active-DID marker. Centralized so reset / delete / fresh-start cannot drift.
  await wipeAllLocalAppData()

  // Tier d (W4): native biometric keystore. unenroll() is web-build-safe (no-op on
  // web). Best-effort here; the interactive callers verify it via findSurvivingWipeTier.
  await BiometricService.unenroll().catch(() => {})
}

/**
 * W5 — post-wipe verification across ALL security-critical tiers, for the
 * INTERACTIVE full-wipe callers (identity-delete, create-new). Returns a diagnostic
 * string for the first tier that SURVIVED the wipe, or null when the wipe is clean.
 * Lives here (not inside resetLocalAppData) so the orchestrator stays best-effort
 * for the legacy-break, while interactive callers fail closed: a surviving seed
 * (multi-tab / blocked delete) OR a stale keystore enrollment must NOT be reported
 * as success. Generalizes the existing `storedSeedRemains` migration recheck to the
 * keystore tier.
 */
export async function findSurvivingWipeTier(): Promise<string | null> {
  // Fail closed: if the seed check itself errors we cannot confirm the seed is gone,
  // so treat it as surviving (no redirect, surface the error) rather than assuming clean.
  if (await createIdentityWorkflow().hasStoredIdentity().catch(() => true)) {
    return 'stored identity seed survived the wipe (or could not be verified)'
  }
  // Keystore tier — fail closed too: use the STRICT check that PROPAGATES native
  // errors. isEnrolled() swallows them to false, which would read an unverifiable /
  // failed native keystore cleanup as "clean" and let the redirect proceed — the exact
  // tier failure this slice closes. A throw here = could-not-verify = surviving.
  if (BiometricService.isSupported()) {
    try {
      if (await BiometricService.isEnrolledStrict()) {
        return 'biometric keystore enrollment survived the wipe'
      }
    } catch {
      return 'biometric keystore state could not be verified after the wipe'
    }
  }
  return null
}
