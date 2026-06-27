/**
 * Centralized teardown of the demo's local databases + identity-bound keys.
 *
 * The Durable-Wiring slice introduced DID-aware durable stores that hold security-
 * sensitive material — the IndexedDBKeyManagementAdapter persists raw Space content
 * keys + capability signing seeds. So EVERY "fresh-start" / identity-switch / reset /
 * delete path MUST remove them, or key material survives an action the UI signals as
 * a wipe (the K1 / N1 lifecycle invariant). This module is the single source of truth
 * for those DB names + the wipe logic, so the paths can never drift apart again.
 */

/** Legacy (non-DID-aware) databases — single global names, wiped on identity switch / reset. */
export const LEGACY_DB_NAMES = [
  'wot-space-metadata',
  'automerge-repo',
  'wot-local-cache',
  'wot-space-compact-store',
  'wot-space-sync-states',
  'wot-yjs-compact-store',
  'wot-personal-doc',
  'automerge-personal',
  'web-of-trust',
] as const

/** DID-aware durable log-sync store DB-name prefixes (the actual name is `${prefix}${did}`). */
export const DURABLE_STORE_PREFIXES = [
  'wot-doc-log:',
  'wot-key-management:',
  'wot-member-update-pending:',
  'wot-message-id-history:',
] as const

/** localStorage prefix for the legacy browser deviceId source (Sync 003 broker auth). */
export const DEVICE_ID_PREFIX = 'wot-device-id:'
/** localStorage marker of the currently active identity's data set. */
export const ACTIVE_DID_KEY = 'wot-active-did'

export function deleteDatabase(dbName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(dbName)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve() // best-effort: never block teardown on one DB
      request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** Enumerate existing IndexedDB database names, or null when the browser lacks `databases()`. */
async function listDatabaseNames(): Promise<string[] | null> {
  if (typeof indexedDB.databases !== 'function') return null
  try {
    const dbs = await indexedDB.databases()
    return dbs.map((d) => d.name).filter((n): n is string => typeof n === 'string')
  } catch {
    return null
  }
}

/** Snapshot of localStorage keys (so callers can remove while iterating safely). */
function localStorageKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k !== null) keys.push(k)
  }
  return keys
}

/** Delete the four DID-aware durable stores + the deviceId key for ONE identity. */
export async function wipeDurableStoresForDid(did: string): Promise<void> {
  for (const prefix of DURABLE_STORE_PREFIXES) await deleteDatabase(`${prefix}${did}`)
  localStorage.removeItem(`${DEVICE_ID_PREFIX}${did}`)
}

/**
 * Fresh-start orphan cleanup for the AdapterProvider init: remove every DID-aware
 * durable store (and deviceId key) that does NOT belong to the CURRENT identity —
 * the departing identity on a switch, plus any orphan left by an earlier session.
 * The current identity's stores are KEPT (continuity; resolveConnectDeviceId keeps
 * them nonce-safe). When `indexedDB.databases()` is unavailable, fall back to the
 * known previous DID.
 */
export async function wipeOrphanDurableStores(
  currentDid: string,
  previousDid: string | null,
): Promise<void> {
  const names = await listDatabaseNames()
  if (names) {
    for (const name of names) {
      const prefix = DURABLE_STORE_PREFIXES.find((p) => name.startsWith(p))
      if (prefix && name !== `${prefix}${currentDid}`) await deleteDatabase(name)
    }
  } else if (previousDid && previousDid !== currentDid) {
    await wipeDurableStoresForDid(previousDid)
  }
  for (const key of localStorageKeys()) {
    if (key.startsWith(DEVICE_ID_PREFIX) && key !== `${DEVICE_ID_PREFIX}${currentDid}`) {
      localStorage.removeItem(key)
    }
  }
}

/**
 * Clean-slate wipe for an explicit reset / identity-delete: legacy DBs + EVERY
 * DID-aware durable store (all identities) + every deviceId key + the active-DID
 * marker. Leaves NO key material behind. Personal-doc DB deletion (adapter-specific)
 * is the caller's job. When `databases()` is unavailable, at least the active DID's
 * durable stores are wiped via the marker.
 */
export async function wipeAllLocalAppData(): Promise<void> {
  for (const name of LEGACY_DB_NAMES) await deleteDatabase(name)
  const names = await listDatabaseNames()
  if (names) {
    for (const name of names) {
      if (DURABLE_STORE_PREFIXES.some((p) => name.startsWith(p))) await deleteDatabase(name)
    }
  } else {
    const activeDid = localStorage.getItem(ACTIVE_DID_KEY)
    if (activeDid) await wipeDurableStoresForDid(activeDid)
  }
  for (const key of localStorageKeys()) {
    if (key.startsWith(DEVICE_ID_PREFIX)) localStorage.removeItem(key)
  }
  localStorage.removeItem(ACTIVE_DID_KEY)
}
