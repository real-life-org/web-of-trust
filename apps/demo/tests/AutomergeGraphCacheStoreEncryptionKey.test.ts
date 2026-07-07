import { describe, it, expect, beforeEach } from 'vitest'
import {
  x25519PublicKeyToMultibase,
  type DidDocument,
} from '@web_of_trust/core/protocol'
import type { PublicProfile } from '@web_of_trust/core/types'
import { AutomergeGraphCacheStore } from '../src/adapters/AutomergeGraphCacheStore'
import type { LocalCacheStore } from '../src/adapters/LocalCacheStore'

// VE-5: AutomergeGraphCacheStore must thread the keyAgreement key through the
// persistent cache with PRESERVE-ON-MISSING semantics (a snapshot without a
// didDocument must NEVER null an already-cached key) so offline ECIES delivery
// can reconstruct the recipient key after an online resolve.

const REAL_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const ENC_MULTIBASE = x25519PublicKeyToMultibase(new Uint8Array(32).fill(7))

function didDocumentWithKey(did: string, publicKeyMultibase: string): DidDocument {
  return {
    id: did,
    verificationMethod: [],
    authentication: [],
    assertionMethod: [],
    keyAgreement: [{
      id: '#enc-0',
      type: 'X25519KeyAgreementKey2020',
      controller: did,
      publicKeyMultibase,
    }],
  }
}

const PROFILE: PublicProfile = {
  did: REAL_DID,
  name: 'Bob',
  updatedAt: new Date().toISOString(),
}

/**
 * Minimal in-memory LocalCacheStore stub — happy-dom has no IndexedDB, and
 * AutomergeGraphCacheStore only needs get()/set() for persist/reload. A fresh
 * store loaded against the same backing map proves the field survives a reload.
 */
function createMemoryCacheStore(): LocalCacheStore {
  const backing = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | null> {
      return (backing.has(key) ? (backing.get(key) as T) : null)
    },
    async set<T>(key: string, value: T): Promise<void> {
      // Deep clone to mimic the JSON round-trip through IndexedDB.
      backing.set(key, JSON.parse(JSON.stringify(value)))
    },
  } as unknown as LocalCacheStore
}

describe('AutomergeGraphCacheStore encryptionKeyMultibase (VE-5)', () => {
  let store: AutomergeGraphCacheStore

  beforeEach(async () => {
    store = new AutomergeGraphCacheStore(createMemoryCacheStore())
    await store.load()
  })

  it('extracts and exposes the keyAgreement key from a snapshot didDocument', async () => {
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
      didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
    })

    const entry = await store.getEntry(REAL_DID)
    expect(entry).not.toBeNull()
    expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
  })

  it('omits the key when the snapshot carries no didDocument', async () => {
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
    })

    const entry = await store.getEntry(REAL_DID)
    expect(entry).not.toBeNull()
    expect(entry!.encryptionKeyMultibase).toBeUndefined()
  })

  it('omits the key when the didDocument carries a malformed keyAgreement key', async () => {
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
      // 'znot-a-valid-key' is base58btc-shaped but does NOT decode to 32 x25519
      // bytes → the canonical validating extractor returns null → no key cached.
      didDocument: didDocumentWithKey(REAL_DID, 'znotavalidx25519key'),
    })

    const entry = await store.getEntry(REAL_DID)
    expect(entry!.encryptionKeyMultibase).toBeUndefined()
  })

  it('PRESERVE-ON-MISSING: a later key-less cacheEntry does not null the cached key', async () => {
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
      didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
    })
    // A subsequent snapshot without a didDocument (e.g. a refresh that only
    // carries name/counts) must keep the previously cached key.
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
    })

    const entry = await store.getEntry(REAL_DID)
    expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
  })

  it('updateSummary preserves an already-cached key', async () => {
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
      didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
    })
    await store.updateSummary(REAL_DID, 'Bob (renamed)', 3, 5)

    const entry = await store.getEntry(REAL_DID)
    expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
    expect(entry!.verificationCount).toBe(3)
    expect(entry!.attestationCount).toBe(5)
  })

  it('survives a persist + reload round-trip', async () => {
    const backing = createMemoryCacheStore()
    const first = new AutomergeGraphCacheStore(backing)
    await first.load()
    await first.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
      didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
    })

    // Fresh store over the same backing = app restart.
    const second = new AutomergeGraphCacheStore(backing)
    await second.load()
    const entry = await second.getEntry(REAL_DID)
    expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
  })

  it('backward-compat: a persisted EntryDoc without the field yields no key', async () => {
    const backing = createMemoryCacheStore()
    // Simulate an OLD persisted entry (pre-migration shape, no encryptionKeyMultibase).
    await backing.set('graph:entries', {
      [REAL_DID]: {
        did: REAL_DID,
        name: 'Bob',
        bio: null,
        avatar: null,
        verificationCount: 0,
        attestationCount: 0,
        fetchedAt: new Date().toISOString(),
      },
    })
    const store2 = new AutomergeGraphCacheStore(backing)
    await store2.load()

    const entry = await store2.getEntry(REAL_DID)
    expect(entry).not.toBeNull()
    expect(entry!.encryptionKeyMultibase).toBeUndefined()
  })

  it('evict removes the cached key', async () => {
    await store.cacheEntry(REAL_DID, {
      profile: PROFILE,
      attestations: [],
      verifications: [],
      didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
    })
    await store.evict(REAL_DID)
    expect(await store.getEntry(REAL_DID)).toBeNull()
  })
})
