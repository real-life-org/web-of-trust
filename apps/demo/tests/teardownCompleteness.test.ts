/**
 * Teardown-Completeness (model-teardown-completeness-fix W1/W2/W4/W5 + scope
 * regression). Logic-level tests against the trigger table; fake-indexeddb gives a
 * real IndexedDB (incl. databases()) — see [[feedback_teardown_is_security_surface]].
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Controls the seed tier (hasStoredIdentity) + whether the record-level delete throws.
const idState = vi.hoisted(() => ({ hasStored: false, deleteThrows: false }))
vi.mock('../src/services/identityWorkflow', () => ({
  createIdentityWorkflow: () => ({
    hasStoredIdentity: async () => idState.hasStored,
    deleteStoredIdentity: async () => {
      if (idState.deleteThrows) throw new Error('record-level delete failed')
    },
  }),
}))
vi.mock('@web_of_trust/adapter-automerge', () => ({ deletePersonalDocDB: vi.fn(async () => {}) }))
vi.mock('@web_of_trust/adapter-yjs', () => ({ deleteYjsPersonalDocDB: vi.fn(async () => {}) }))

import { resetLocalAppData, findSurvivingWipeTier } from '../src/services/resetLocalAppData'
import {
  wipeAllLocalAppData,
  wipeOrphanDurableStores,
  deleteDatabase,
  LEGACY_DB_NAMES,
  SEED_VAULT_DB_NAME,
} from '../src/services/durableStoreWipe'
import { BiometricService } from '../src/services/BiometricService'

function seedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('s', { keyPath: 'k' })
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('s', 'readwrite')
      tx.objectStore('s').put({ k: 'x', v: 'secret' })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function dbExists(name: string): Promise<boolean> {
  const dbs = await indexedDB.databases()
  return dbs.some((d) => d.name === name)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  idState.hasStored = false
  idState.deleteThrows = false
  vi.restoreAllMocks()
})

describe('W4 — unenroll() web-build-safe', () => {
  it('is a no-op on web (no native plugin) and does not throw', async () => {
    expect(BiometricService.isSupported()).toBe(false) // happy-dom = non-native
    await expect(BiometricService.unenroll()).resolves.toBeUndefined()
  })
})

describe('W1 — resetLocalAppData clears the native keystore tier', () => {
  it('leaves isEnrolled() === false afterwards (cleared state, not just "unenroll called")', async () => {
    let enrolled = true
    vi.spyOn(BiometricService, 'isSupported').mockReturnValue(true)
    vi.spyOn(BiometricService, 'isEnrolled').mockImplementation(async () => enrolled)
    vi.spyOn(BiometricService, 'unenroll').mockImplementation(async () => {
      enrolled = false
    })

    await resetLocalAppData()

    expect(await BiometricService.isEnrolled()).toBe(false)
  })
})

describe('W2 — Seed-Vault whole-DB backstop', () => {
  it('wipeAllLocalAppData deletes the wot-identity vault as a whole DB', async () => {
    await seedDb(SEED_VAULT_DB_NAME)
    await wipeAllLocalAppData()
    expect(await dbExists(SEED_VAULT_DB_NAME)).toBe(false)
  })

  it('the vault is deleted even when the record-level deleteStoredIdentity throws', async () => {
    idState.deleteThrows = true
    await seedDb(SEED_VAULT_DB_NAME)
    await resetLocalAppData()
    expect(await dbExists(SEED_VAULT_DB_NAME)).toBe(false)
  })
})

describe('W5 — findSurvivingWipeTier (interactive post-wipe recheck)', () => {
  it('returns null when both tiers are clean', async () => {
    idState.hasStored = false // seed gone; web → keystore tier skipped
    expect(await findSurvivingWipeTier()).toBeNull()
  })

  it('flags a surviving seed', async () => {
    idState.hasStored = true
    expect(await findSurvivingWipeTier()).toMatch(/seed/i)
  })

  it('flags a surviving native keystore enrollment (via the STRICT check)', async () => {
    idState.hasStored = false
    vi.spyOn(BiometricService, 'isSupported').mockReturnValue(true)
    vi.spyOn(BiometricService, 'isEnrolledStrict').mockResolvedValue(true)
    expect(await findSurvivingWipeTier()).toMatch(/keystore/i)
  })

  it('fails CLOSED when the native keystore check throws (unverifiable ≠ clean)', async () => {
    // The blocker: isEnrolled() swallows native errors to false, which would read a
    // failed/unverifiable keystore cleanup as clean. The strict check propagates, and
    // findSurvivingWipeTier must report a survivor (not null) so the caller does NOT redirect.
    idState.hasStored = false
    vi.spyOn(BiometricService, 'isSupported').mockReturnValue(true)
    vi.spyOn(BiometricService, 'isEnrolledStrict').mockRejectedValue(new Error('native keystore unavailable'))
    expect(await findSurvivingWipeTier()).toMatch(/keystore/i)
  })

  it('reports the seed tier first when BOTH survive', async () => {
    idState.hasStored = true
    vi.spyOn(BiometricService, 'isSupported').mockReturnValue(true)
    vi.spyOn(BiometricService, 'isEnrolledStrict').mockResolvedValue(true)
    expect(await findSurvivingWipeTier()).toMatch(/seed/i)
  })
})

describe('W2 scope regression — switch path must NOT touch the seed vault', () => {
  it('LEGACY_DB_NAMES does not include the seed vault (it is iterated in the switch path)', () => {
    expect(LEGACY_DB_NAMES as readonly string[]).not.toContain(SEED_VAULT_DB_NAME)
  })

  it('orphan cleanup + the legacy-loop preserve wot-identity (new identity keeps its seed)', async () => {
    await seedDb(SEED_VAULT_DB_NAME)
    // The AdapterContext identity-switch path: orphan cleanup + LEGACY_DB_NAMES loop.
    await wipeOrphanDurableStores('did:key:zCurrent', 'did:key:zPrev')
    for (const name of LEGACY_DB_NAMES) await deleteDatabase(name)
    expect(await dbExists(SEED_VAULT_DB_NAME)).toBe(true)
  })
})
