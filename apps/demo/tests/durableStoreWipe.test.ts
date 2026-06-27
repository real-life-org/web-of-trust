// fake-indexeddb gives happy-dom a real IndexedDB (incl. `databases()`), scoped to
// this test file's worker so other demo tests are untouched.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  wipeAllLocalAppData,
  wipeDurableStoresForDid,
  wipeOrphanDurableStores,
} from '../src/services/durableStoreWipe'

const DID_A = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAA'
const DID_B = 'did:key:zBBBBBBBBBBBBBBBBBBBBBBBBB'

/** Create a DB with one store holding a "secret" record, then close it. */
function seedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('s', { keyPath: 'k' })
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('s', 'readwrite')
      tx.objectStore('s').put({ k: 'x', v: 'secret-key-material' })
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

/** Seed the full DID-aware durable set for one identity + its deviceId key. */
async function seedDurableSet(did: string): Promise<void> {
  await seedDb(`wot-doc-log:${did}`)
  await seedDb(`wot-key-management:${did}`)
  await seedDb(`wot-member-update-pending:${did}`)
  await seedDb(`wot-message-id-history:${did}`)
  localStorage.setItem(`wot-device-id:${did}`, 'device-xyz')
}

beforeEach(() => {
  // Fresh IndexedDB + localStorage per test (fake-indexeddb persists across a file otherwise).
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('wipeAllLocalAppData (reset / identity-delete clean slate)', () => {
  it('deletes EVERY DID-aware durable store, legacy DB, deviceId key, and the active-DID marker', async () => {
    await seedDb('wot-space-metadata') // legacy
    await seedDurableSet(DID_A)
    await seedDurableSet(DID_B) // a second identity's leftovers
    localStorage.setItem('wot-active-did', DID_A)

    await wipeAllLocalAppData()

    // The security-critical regression: raw key material must NOT survive a reset.
    expect(await dbExists(`wot-key-management:${DID_A}`)).toBe(false)
    expect(await dbExists(`wot-key-management:${DID_B}`)).toBe(false)
    expect(await dbExists(`wot-doc-log:${DID_A}`)).toBe(false)
    expect(await dbExists(`wot-doc-log:${DID_B}`)).toBe(false)
    expect(await dbExists(`wot-member-update-pending:${DID_A}`)).toBe(false)
    expect(await dbExists(`wot-message-id-history:${DID_A}`)).toBe(false)
    expect(await dbExists('wot-space-metadata')).toBe(false)
    expect(localStorage.getItem(`wot-device-id:${DID_A}`)).toBeNull()
    expect(localStorage.getItem(`wot-device-id:${DID_B}`)).toBeNull()
    expect(localStorage.getItem('wot-active-did')).toBeNull()
  })

  it('falls back to the active-DID marker when indexedDB.databases() is unavailable', async () => {
    await seedDurableSet(DID_A)
    localStorage.setItem('wot-active-did', DID_A)
    // Simulate an older browser without enumeration support.
    const spy = vi.spyOn(indexedDB, 'databases').mockImplementation(() => {
      throw new Error('not supported')
    })

    await wipeAllLocalAppData()

    spy.mockRestore() // restore so the assertions below can enumerate again
    expect(await dbExists(`wot-key-management:${DID_A}`)).toBe(false)
    expect(await dbExists(`wot-doc-log:${DID_A}`)).toBe(false)
    expect(localStorage.getItem(`wot-device-id:${DID_A}`)).toBeNull()
  })
})

describe('wipeDurableStoresForDid (single identity)', () => {
  it('removes the target identity stores and keeps the others', async () => {
    await seedDurableSet(DID_A)
    await seedDurableSet(DID_B)

    await wipeDurableStoresForDid(DID_A)

    expect(await dbExists(`wot-key-management:${DID_A}`)).toBe(false)
    expect(localStorage.getItem(`wot-device-id:${DID_A}`)).toBeNull()
    // DID_B untouched.
    expect(await dbExists(`wot-key-management:${DID_B}`)).toBe(true)
    expect(localStorage.getItem(`wot-device-id:${DID_B}`)).toBe('device-xyz')
  })
})

describe('wipeOrphanDurableStores (AdapterProvider fresh-start)', () => {
  it('keeps the current identity and removes a departing one on an identity switch', async () => {
    await seedDurableSet(DID_A) // current
    await seedDurableSet(DID_B) // departing / orphan

    await wipeOrphanDurableStores(DID_A, DID_B)

    expect(await dbExists(`wot-doc-log:${DID_A}`)).toBe(true)
    expect(await dbExists(`wot-key-management:${DID_A}`)).toBe(true)
    expect(localStorage.getItem(`wot-device-id:${DID_A}`)).toBe('device-xyz')
    expect(await dbExists(`wot-doc-log:${DID_B}`)).toBe(false)
    expect(await dbExists(`wot-key-management:${DID_B}`)).toBe(false)
    expect(localStorage.getItem(`wot-device-id:${DID_B}`)).toBeNull()
  })

  it('removes a foreign orphan even when previousDid === null (the logout fresh-start case)', async () => {
    // The case the old previousDid-only branch missed: wot-active-did was cleared,
    // yet a foreign identity's durable stores still sit on disk.
    await seedDurableSet(DID_A) // current
    await seedDurableSet(DID_B) // orphan with no recorded previousDid

    await wipeOrphanDurableStores(DID_A, null)

    expect(await dbExists(`wot-key-management:${DID_A}`)).toBe(true)
    expect(await dbExists(`wot-key-management:${DID_B}`)).toBe(false)
    expect(await dbExists(`wot-doc-log:${DID_B}`)).toBe(false)
    expect(localStorage.getItem(`wot-device-id:${DID_B}`)).toBeNull()
  })
})

describe('resetLocalAppData wiring (end-to-end)', () => {
  it('wot-doc-log:<did> and wot-key-management:<did> do NOT survive a reset', async () => {
    vi.doMock('../src/services/identityWorkflow', () => ({
      createIdentityWorkflow: () => ({ deleteStoredIdentity: vi.fn().mockResolvedValue(undefined) }),
    }))
    vi.doMock('@web_of_trust/adapter-automerge', () => ({
      deletePersonalDocDB: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('@web_of_trust/adapter-yjs', () => ({
      deleteYjsPersonalDocDB: vi.fn().mockResolvedValue(undefined),
    }))

    await seedDurableSet(DID_A)
    localStorage.setItem('wot-active-did', DID_A)

    const { resetLocalAppData } = await import('../src/services/resetLocalAppData')
    await resetLocalAppData()

    expect(await dbExists(`wot-doc-log:${DID_A}`)).toBe(false)
    expect(await dbExists(`wot-key-management:${DID_A}`)).toBe(false)
    expect(localStorage.getItem(`wot-device-id:${DID_A}`)).toBeNull()
    expect(localStorage.getItem('wot-active-did')).toBeNull()

    vi.doUnmock('../src/services/identityWorkflow')
    vi.doUnmock('@web_of_trust/adapter-automerge')
    vi.doUnmock('@web_of_trust/adapter-yjs')
  })
})
