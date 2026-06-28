import { createIdentityWorkflow } from './identityWorkflow'
import { wipeAllLocalAppData } from './durableStoreWipe'
import { BiometricService } from './BiometricService'
import { closeOpenIdentitySeedVaultConnections } from '@web_of_trust/core/adapters/storage/indexeddb'

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

  // Close EVERY open seed-vault connection — above all the long-lived logged-in vault,
  // which no workflow chain can reach — BEFORE the whole-DB delete below. An open connection
  // BLOCKS deleteDatabase('wot-identity'), so the seed survives, the W5 recheck reports
  // "survived", and the logout/delete redirect never fires (the hang this slice closes). The
  // record-level delete ran above; this makes the W2 whole-DB backstop actually complete.
  // Order: deleteSeed (record) → close connections → whole-DB delete. Single-tab scope.
  closeOpenIdentitySeedVaultConnections()

  // Tiers a–c: legacy DBs + the Seed-Vault + EVERY DID-aware durable store (incl.
  // the raw key material in IndexedDBKeyManagementAdapter, K1) + every deviceId key
  // + the active-DID marker. Centralized so reset / delete / fresh-start cannot drift.
  await wipeAllLocalAppData()

  // Tier d (W4): native biometric keystore. unenroll() is web-build-safe (no-op on
  // web). Best-effort here; the interactive callers verify it via findSurvivingWipeTier.
  await BiometricService.unenroll().catch(() => {})
}

/**
 * TC3 default recheck bound. A recheck stuck in pending-delete limbo (e.g. a second tab still
 * holding `wot-identity` open — out of scope) or a hung native keystore bridge call must NOT
 * hang the logout flow forever. After this, the recheck reports "could not be verified" =
 * surviving (fail closed: no redirect, error visible — W5 intact), instead of an indefinite hang.
 */
const DEFAULT_RECHECK_TIMEOUT_MS = 4_000

/**
 * Race `promise` against a timeout, ALWAYS clearing the timer when either settles — so the
 * common fast path leaves no dangling timer (and no event-loop keep-alive in tests/Node
 * callers). Rejects on timeout so the caller's catch can fail closed.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('recheck timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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
export async function findSurvivingWipeTier(
  options: { recheckTimeoutMs?: number } = {},
): Promise<string | null> {
  const recheckTimeoutMs = options.recheckTimeoutMs ?? DEFAULT_RECHECK_TIMEOUT_MS
  // Fail closed AND bounded: a thrown error OR a `hasSeed()` open that never resolves
  // (pending-delete limbo) must both read as "cannot confirm the seed is gone" = surviving
  // (no redirect, surface the error) — never assume clean, never hang. A clean wipe resolves
  // hasStoredIdentity() to false well within the bound. Distinguishes "DB absent / no seed
  // record = clean → null" (false) from "seed present OR unverifiable = surviving" (true).
  let seedSurvives: boolean
  try {
    seedSurvives = await withTimeout(createIdentityWorkflow().hasStoredIdentity(), recheckTimeoutMs)
  } catch {
    seedSurvives = true
  }
  if (seedSurvives) {
    return 'stored identity seed survived the wipe (or could not be verified)'
  }
  // Keystore tier — fail closed too: use the STRICT check that PROPAGATES native errors
  // (isEnrolled() swallows them to false, which would read an unverifiable / failed native
  // keystore cleanup as "clean" and let the redirect proceed). Also BOUNDED: a hung native
  // bridge call must not reintroduce the hang on the native target. Throw / timeout here =
  // could-not-verify = surviving.
  if (BiometricService.isSupported()) {
    try {
      if (await withTimeout(BiometricService.isEnrolledStrict(), recheckTimeoutMs)) {
        return 'biometric keystore enrollment survived the wipe'
      }
    } catch {
      return 'biometric keystore state could not be verified after the wipe'
    }
  }
  return null
}
