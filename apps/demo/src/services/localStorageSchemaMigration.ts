import { resetLocalAppData } from './resetLocalAppData'

/**
 * Local storage schema version (stamped into `wot-storage-schema-version`).
 *
 * The ABSENCE of this marker is the signal for the one and only hard identity
 * break in the history of the Web of Trust: the legacy → vnext cutover. Only
 * pre-vnext installs lack the marker, so only they are reset + informed. Once
 * stamped, the break path NEVER runs again on this origin.
 *
 * IMPORTANT: future identity/data format changes MUST be handled by MIGRATION,
 * not by another break. When migrations land, increment this constant and add
 * version-to-version migration steps in the `stored !== null` branch below —
 * do NOT extend the reset/notice path. Bumping the version must never wipe data
 * or show the break notice again.
 *
 * History:
 *   1 — first vnext-era schema (one-time breaking cutover from the legacy wire format).
 */
export const LOCAL_STORAGE_SCHEMA_VERSION = 1

const SCHEMA_VERSION_KEY = 'wot-storage-schema-version'

// IndexedDB databases that signal an existing WoT identity / dataset on this origin.
const WOT_DATA_DBS = [
  'wot-identity',
  'wot-personal-doc',
  'web-of-trust',
  'automerge-personal',
  'wot-local-cache',
]

function writeCurrentVersion(): void {
  try {
    localStorage.setItem(SCHEMA_VERSION_KEY, String(LOCAL_STORAGE_SCHEMA_VERSION))
  } catch {
    /* best effort */
  }
}

async function hasExistingWotData(): Promise<boolean> {
  try {
    if (localStorage.getItem('wot-active-did') !== null) return true
  } catch {
    /* ignore */
  }
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      const names = new Set(dbs.map((d) => d.name).filter(Boolean) as string[])
      return WOT_DATA_DBS.some((n) => names.has(n))
    }
  } catch {
    /* ignore */
  }
  return false
}

/**
 * One-time legacy identity break gate. MUST run before any identity/adapter code
 * opens the WoT IndexedDB databases.
 *
 * - marker present → already in the versioned (vnext+) era. NO break, ever.
 *   (Future migrations plug in here, based on the stored version — without reset
 *   or notice.)
 * - marker absent AND existing WoT data → pre-vnext legacy install → wipe all
 *   local app data (reliable logout), stamp the version, and return true so the
 *   caller can inform the user about this one-time identity break.
 * - marker absent AND no data → fresh install → just stamp the version.
 *
 * @returns whether a legacy dataset was reset (→ show the one-time break notice).
 */
export async function runLocalStorageSchemaMigration(): Promise<boolean> {
  let marker: string | null = null
  try {
    marker = localStorage.getItem(SCHEMA_VERSION_KEY)
  } catch {
    marker = null
  }

  // Already stamped → vnext-era install. Future format changes migrate here;
  // this is never again a break.
  if (marker !== null) return false

  let didReset = false
  if (await hasExistingWotData()) {
    await resetLocalAppData().catch(() => {})
    didReset = true
  }
  writeCurrentVersion()
  return didReset
}
