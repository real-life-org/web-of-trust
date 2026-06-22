import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OfflineFirstDiscoveryAdapter } from '../src/adapters/discovery/OfflineFirstDiscoveryAdapter'
import { InMemoryPublishStateStore } from '../src/adapters/discovery/InMemoryPublishStateStore'
import { InMemoryGraphCacheStore } from '../src/adapters/discovery/InMemoryGraphCacheStore'
import {
  ProfileResourceRollbackError,
  type DiscoveryAdapter,
  type PublicAttestationsData,
  type PublicVerificationsData,
} from '../src/ports/DiscoveryAdapter'
import {
  encryptionKeyMultibaseFromDidDocument,
  x25519MultibaseToPublicKeyBytes,
  x25519PublicKeyToMultibase,
} from '../src/protocol/identity/did-key'
import type { DidDocument } from '../src/protocol/identity/did-document'
import type { PublicProfile } from '../src/types/identity'
import type { PublicIdentitySession } from '../src/application/identity'

// A real, well-formed bare did:key (ed25519) so the offline fallback's
// resolveDidKey rebuild actually succeeds for the positive cases.
const REAL_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
// A syntactically valid X25519 keyAgreement multibase (decodes to 32 bytes).
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

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'

const TEST_PROFILE: PublicProfile = {
  did: ALICE_DID,
  name: 'Alice',
  updatedAt: new Date().toISOString(),
}

const TEST_ATTESTATIONS: PublicAttestationsData = {
  did: ALICE_DID,
  attestations: [],
  updatedAt: new Date().toISOString(),
}

const TEST_VERIFICATIONS: PublicVerificationsData = {
  did: ALICE_DID,
  verifications: [],
  updatedAt: new Date().toISOString(),
}

const MOCK_IDENTITY = {} as PublicIdentitySession

function createMockInner(overrides: Partial<DiscoveryAdapter> = {}): DiscoveryAdapter {
  return {
    publishProfile: vi.fn().mockResolvedValue(undefined),
    publishAttestations: vi.fn().mockResolvedValue(undefined),
    publishVerifications: vi.fn().mockResolvedValue(undefined),
    resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }),
    resolveAttestations: vi.fn().mockResolvedValue([]),
    resolveVerifications: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('OfflineFirstDiscoveryAdapter', () => {
  let inner: DiscoveryAdapter
  let publishState: InMemoryPublishStateStore
  let graphCache: InMemoryGraphCacheStore
  let adapter: OfflineFirstDiscoveryAdapter

  beforeEach(() => {
    inner = createMockInner()
    publishState = new InMemoryPublishStateStore()
    graphCache = new InMemoryGraphCacheStore()
    adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)
  })

  describe('publishProfile', () => {
    it('should mark dirty and clear on success', async () => {
      await adapter.publishProfile(TEST_PROFILE, MOCK_IDENTITY)

      expect(inner.publishProfile).toHaveBeenCalledWith(TEST_PROFILE, MOCK_IDENTITY)
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(0)
    })

    it('should keep dirty flag on failure', async () => {
      inner = createMockInner({
        publishProfile: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      await adapter.publishProfile(TEST_PROFILE, MOCK_IDENTITY)

      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.has('profile')).toBe(true)
    })
  })

  describe('publishAttestations', () => {
    it('should mark dirty and clear on success', async () => {
      await adapter.publishAttestations(TEST_ATTESTATIONS, MOCK_IDENTITY)

      expect(inner.publishAttestations).toHaveBeenCalledWith(TEST_ATTESTATIONS, MOCK_IDENTITY)
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(0)
    })

    it('should keep dirty flag on failure', async () => {
      inner = createMockInner({
        publishAttestations: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      await adapter.publishAttestations(TEST_ATTESTATIONS, MOCK_IDENTITY)

      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.has('attestations')).toBe(true)
    })
  })

  describe('resolveProfile', () => {
    it('should return profile with fromCache=false on successful resolve', async () => {
      inner = createMockInner({
        resolveProfile: vi.fn().mockResolvedValue({ profile: TEST_PROFILE, fromCache: false }),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(ALICE_DID)

      expect(result.profile).toEqual(TEST_PROFILE)
      expect(result.fromCache).toBe(false)
    })

    it('should return cached profile with fromCache=true when inner fails', async () => {
      // Pre-populate graph cache
      await graphCache.cacheEntry(ALICE_DID, { profile: TEST_PROFILE, attestations: [], verifications: [] })

      inner = createMockInner({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(ALICE_DID)

      expect(result.profile).not.toBeNull()
      expect(result.profile!.name).toBe('Alice')
      expect(result.profile!.did).toBe(ALICE_DID)
      expect(result.fromCache).toBe(true)
    })

    it('should return null profile with fromCache=true when inner fails and no cache exists', async () => {
      inner = createMockInner({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(ALICE_DID)

      expect(result.profile).toBeNull()
      expect(result.fromCache).toBe(true)
    })

    it('should return null profile with fromCache=false when inner returns null', async () => {
      inner = createMockInner({
        resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(ALICE_DID)

      expect(result.profile).toBeNull()
      expect(result.fromCache).toBe(false)

      const cached = await graphCache.getEntry(ALICE_DID)
      expect(cached).toBeNull()
    })

    it('should re-throw an inner rollback instead of falling back to cached profile', async () => {
      // VE-3: version monotonicity + rollback detection now live exclusively in
      // the inner HTTP adapter. The decorator must surface the inner
      // ProfileResourceRollbackError, never mask it with the offline cache.
      await graphCache.cacheEntry(ALICE_DID, { profile: TEST_PROFILE, attestations: [], verifications: [] })

      inner = createMockInner({
        resolveProfile: vi.fn()
          .mockResolvedValueOnce({ profile: TEST_PROFILE, version: 7, fromCache: false })
          .mockRejectedValueOnce(new ProfileResourceRollbackError(ALICE_DID, 6, 7, 'profile')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      await expect(adapter.resolveProfile(ALICE_DID)).resolves.toMatchObject({
        profile: TEST_PROFILE,
        version: 7,
        fromCache: false,
      })

      await expect(adapter.resolveProfile(ALICE_DID)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
    })

    it('reconstructs didDocument.keyAgreement from the cached encryption key when offline (VE-6)', async () => {
      // Online resolve carries the didDocument → GraphCacheService caches the
      // keyAgreement key. Then offline, the fallback must rebuild a didDocument
      // so resolveRecipientEncryptionKey still finds the ECIES key.
      const onlineProfile: PublicProfile = { did: REAL_DID, name: 'Alice', updatedAt: new Date().toISOString() }
      await graphCache.cacheEntry(REAL_DID, {
        profile: onlineProfile,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
      })

      inner = createMockInner({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(REAL_DID)

      expect(result.fromCache).toBe(true)
      expect(result.profile!.name).toBe('Alice')
      expect(result.didDocument).not.toBeNull()
      expect(result.didDocument!.keyAgreement[0].publicKeyMultibase).toBe(ENC_MULTIBASE)
      // The reconstructed key must round-trip to 32 ECIES bytes.
      expect(x25519MultibaseToPublicKeyBytes(result.didDocument!.keyAgreement[0].publicKeyMultibase))
        .toHaveLength(32)
    })

    it('returns didDocument:null offline when no encryption key was ever cached (no crash)', async () => {
      // Cached profile (name present) but no key → fallback must not crash and
      // must not invent a key.
      await graphCache.cacheEntry(REAL_DID, {
        profile: { did: REAL_DID, name: 'Alice', updatedAt: new Date().toISOString() },
        attestations: [],
        verifications: [],
      })

      inner = createMockInner({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(REAL_DID)

      expect(result.fromCache).toBe(true)
      expect(result.profile!.name).toBe('Alice')
      expect(result.didDocument ?? null).toBeNull()
    })

    it('returns didDocument:null offline when the cached DID is not a did:key (resolveDidKey throws)', async () => {
      // ALICE_DID is not a decodable bare did:key → resolveDidKey throws → the
      // try/catch must degrade to didDocument:null, never propagate.
      await graphCache.cacheEntry(ALICE_DID, {
        profile: TEST_PROFILE,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(ALICE_DID, ENC_MULTIBASE),
      })

      inner = createMockInner({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(ALICE_DID)

      expect(result.fromCache).toBe(true)
      expect(result.profile!.name).toBe('Alice')
      expect(result.didDocument ?? null).toBeNull()
    })

    it('chains offline resolveProfile → canonical key extractor → 32 ECIES bytes (delivery-resolver path)', async () => {
      // Service-level chain proof: this is exactly what the demo
      // resolveRecipientEncryptionKey does (resolveProfile offline →
      // encryptionKeyMultibaseFromDidDocument → x25519MultibaseToPublicKeyBytes).
      // It must return BYTES, never null → sendDelivery enqueues instead of throwing.
      await graphCache.cacheEntry(REAL_DID, {
        profile: { did: REAL_DID, name: 'Alice', updatedAt: new Date().toISOString() },
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(REAL_DID, ENC_MULTIBASE),
      })

      inner = createMockInner({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveProfile(REAL_DID)
      const enc = encryptionKeyMultibaseFromDidDocument(result.didDocument)
      expect(enc).toBe(ENC_MULTIBASE)
      const bytes = enc ? x25519MultibaseToPublicKeyBytes(enc) : null
      expect(bytes).not.toBeNull()
      expect(bytes).toHaveLength(32)
    })
  })

  describe('resolveAttestations', () => {
    it('should return attestations from inner on success', async () => {
      const attestations = [{ id: 'a1' }] as any
      inner = createMockInner({
        resolveAttestations: vi.fn().mockResolvedValue(attestations),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveAttestations(ALICE_DID)

      expect(result).toEqual(attestations)
    })

    it('should return cached attestations when inner fails', async () => {
      const attestations = [{ id: 'a1', from: 'did:key:bob', to: ALICE_DID, claim: 'Test', createdAt: '2026-01-01', proof: {} }] as any
      await graphCache.cacheEntry(ALICE_DID, { profile: TEST_PROFILE, attestations, verifications: [] })

      inner = createMockInner({
        resolveAttestations: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveAttestations(ALICE_DID)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('a1')
    })

    it('should return empty array when inner fails and no cache exists', async () => {
      inner = createMockInner({
        resolveAttestations: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveAttestations(ALICE_DID)

      expect(result).toEqual([])
    })
  })

  describe('publishVerifications (Step 4)', () => {
    it('should mark verifications dirty and clear on success', async () => {
      await adapter.publishVerifications(TEST_VERIFICATIONS, MOCK_IDENTITY)

      expect(inner.publishVerifications).toHaveBeenCalledWith(TEST_VERIFICATIONS, MOCK_IDENTITY)
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(0)
    })

    it('should keep verifications dirty flag on failure', async () => {
      inner = createMockInner({
        publishVerifications: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      await adapter.publishVerifications(TEST_VERIFICATIONS, MOCK_IDENTITY)

      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.has('verifications')).toBe(true)
    })
  })

  describe('resolveVerifications (Step 4)', () => {
    it('should return verifications from inner on success', async () => {
      const verifications = [{ id: 'v1' }] as any
      inner = createMockInner({
        resolveVerifications: vi.fn().mockResolvedValue(verifications),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveVerifications(ALICE_DID)

      expect(result).toEqual(verifications)
    })

    it('should fall back to getCachedVerifications when inner fails', async () => {
      const verifications = [{ id: 'v1', from: 'did:key:bob', to: ALICE_DID, claim: 'live verified', createdAt: '2026-01-01', proof: {} }] as any
      await graphCache.cacheEntry(ALICE_DID, { profile: TEST_PROFILE, attestations: [], verifications })

      inner = createMockInner({
        resolveVerifications: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveVerifications(ALICE_DID)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('v1')
    })

    it('should re-throw an inner rollback instead of masking it with the verifications cache', async () => {
      // VE-3: a ProfileResourceRollbackError must surface even for /v — the cache
      // fallback must never hide a rollback.
      await graphCache.cacheEntry(ALICE_DID, {
        profile: TEST_PROFILE,
        attestations: [],
        verifications: [{ id: 'v1', from: 'did:key:bob', to: ALICE_DID, claim: 'x', createdAt: '2026-01-01', proof: {} }] as any,
      })

      inner = createMockInner({
        resolveVerifications: vi.fn().mockRejectedValue(new ProfileResourceRollbackError(ALICE_DID, 6, 7, 'verifications')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      await expect(adapter.resolveVerifications(ALICE_DID)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
    })
  })

  describe('syncPending — verifications (Step 4)', () => {
    it('should retry a dirty verifications publish on reconnect', async () => {
      const failingInner = createMockInner({
        publishVerifications: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      const failingAdapter = new OfflineFirstDiscoveryAdapter(failingInner, publishState, graphCache)

      await failingAdapter.publishVerifications(TEST_VERIFICATIONS, MOCK_IDENTITY)
      expect((await publishState.getDirtyFields(ALICE_DID)).has('verifications')).toBe(true)

      const getPublishData = vi.fn().mockResolvedValue({ verifications: TEST_VERIFICATIONS })
      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(inner.publishVerifications).toHaveBeenCalledWith(TEST_VERIFICATIONS, MOCK_IDENTITY)
      expect((await publishState.getDirtyFields(ALICE_DID)).has('verifications')).toBe(false)
    })

    it('should keep verifications dirty when no verifications data is provided', async () => {
      await publishState.markDirty(ALICE_DID, 'verifications')

      const getPublishData = vi.fn().mockResolvedValue({ profile: TEST_PROFILE })
      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(inner.publishVerifications).not.toHaveBeenCalled()
      expect((await publishState.getDirtyFields(ALICE_DID)).has('verifications')).toBe(true)
    })
  })

  describe('resolveSummaries', () => {
    it('should delegate to inner adapter when supported', async () => {
      const summaries = [
        { did: ALICE_DID, name: 'Alice', verificationCount: 3, attestationCount: 1 },
      ]
      inner = createMockInner({
        resolveSummaries: vi.fn().mockResolvedValue(summaries),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveSummaries([ALICE_DID])

      expect(result).toEqual(summaries)
      expect(inner.resolveSummaries).toHaveBeenCalledWith([ALICE_DID])
    })

    it('should throw when inner adapter does not support resolveSummaries', async () => {
      // Default mock has no resolveSummaries
      await expect(adapter.resolveSummaries([ALICE_DID]))
        .rejects.toThrow('Inner adapter does not support resolveSummaries')
    })
  })

  describe('syncPending', () => {
    it('should do nothing when no dirty fields', async () => {
      const getPublishData = vi.fn()

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(getPublishData).not.toHaveBeenCalled()
      expect(inner.publishProfile).not.toHaveBeenCalled()
    })

    it('should retry all dirty fields', async () => {
      // Simulate failed publishes
      const failingInner = createMockInner({
        publishProfile: vi.fn().mockRejectedValue(new Error('Offline')),
        publishAttestations: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      const failingAdapter = new OfflineFirstDiscoveryAdapter(failingInner, publishState, graphCache)

      await failingAdapter.publishProfile(TEST_PROFILE, MOCK_IDENTITY)
      await failingAdapter.publishAttestations(TEST_ATTESTATIONS, MOCK_IDENTITY)

      // Verify both are dirty
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(2)

      // Now retry with a working inner adapter
      const getPublishData = vi.fn().mockResolvedValue({
        profile: TEST_PROFILE,
        attestations: TEST_ATTESTATIONS,
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(inner.publishProfile).toHaveBeenCalledWith(TEST_PROFILE, MOCK_IDENTITY)
      expect(inner.publishAttestations).toHaveBeenCalledWith(TEST_ATTESTATIONS, MOCK_IDENTITY)

      // All should be cleared
      const dirtyAfter = await publishState.getDirtyFields(ALICE_DID)
      expect(dirtyAfter.size).toBe(0)
    })

    it('should clear individually on partial success', async () => {
      // Mark both as dirty
      await publishState.markDirty(ALICE_DID, 'profile')
      await publishState.markDirty(ALICE_DID, 'attestations')

      // Inner: profile succeeds, attestations fails
      inner = createMockInner({
        publishProfile: vi.fn().mockResolvedValue(undefined),
        publishAttestations: vi.fn().mockRejectedValue(new Error('Server error')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const getPublishData = vi.fn().mockResolvedValue({
        profile: TEST_PROFILE,
        attestations: TEST_ATTESTATIONS,
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(1)
      expect(dirty.has('attestations')).toBe(true)
      expect(dirty.has('profile')).toBe(false)
    })

    it('should skip fields without data in getPublishData', async () => {
      await publishState.markDirty(ALICE_DID, 'profile')
      await publishState.markDirty(ALICE_DID, 'attestations')

      const getPublishData = vi.fn().mockResolvedValue({
        profile: TEST_PROFILE,
        // attestations NOT provided
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(inner.publishProfile).toHaveBeenCalled()
      expect(inner.publishAttestations).not.toHaveBeenCalled()

      // Profile cleared, attestations still dirty (no data to retry with)
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.has('profile')).toBe(false)
      expect(dirty.has('attestations')).toBe(true)
    })

    it('should use fresh data from getPublishData callback', async () => {
      await publishState.markDirty(ALICE_DID, 'profile')

      const updatedProfile: PublicProfile = {
        ...TEST_PROFILE,
        name: 'Alice Updated',
      }

      const getPublishData = vi.fn().mockResolvedValue({
        profile: updatedProfile,
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      // Should publish the UPDATED profile, not the stale one
      expect(inner.publishProfile).toHaveBeenCalledWith(updatedProfile, MOCK_IDENTITY)
    })
  })
})

describe('encryptionKeyMultibaseFromDidDocument (VE-2 canonical key extractor)', () => {
  it('returns the first valid X25519 keyAgreement multibase', () => {
    const doc = didDocumentWithKey(REAL_DID, ENC_MULTIBASE)
    expect(encryptionKeyMultibaseFromDidDocument(doc)).toBe(ENC_MULTIBASE)
  })

  it('returns null for null/undefined/empty keyAgreement', () => {
    expect(encryptionKeyMultibaseFromDidDocument(null)).toBeNull()
    expect(encryptionKeyMultibaseFromDidDocument(undefined)).toBeNull()
    expect(encryptionKeyMultibaseFromDidDocument({
      id: REAL_DID,
      verificationMethod: [],
      authentication: [],
      assertionMethod: [],
      keyAgreement: [],
    })).toBeNull()
  })

  it('returns null on a malformed / too-short multibase (never persists a broken key)', () => {
    // 'zABC' decodes to far fewer than 32 bytes → x25519MultibaseToPublicKeyBytes throws.
    expect(encryptionKeyMultibaseFromDidDocument(didDocumentWithKey(REAL_DID, 'zABC'))).toBeNull()
  })

  it('returns null when the multibase is an Ed25519 key (wrong multicodec, not X25519)', () => {
    // A signature key must not be treated as a keyAgreement/ECIES key.
    const ed = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'.replace('did:key:', '')
    expect(encryptionKeyMultibaseFromDidDocument(didDocumentWithKey(REAL_DID, ed))).toBeNull()
  })

  it('skips entries without publicKeyMultibase and picks the first valid one', () => {
    const doc: DidDocument = {
      id: REAL_DID,
      verificationMethod: [],
      authentication: [],
      assertionMethod: [],
      keyAgreement: [
        { id: '#enc-x', type: 'X25519KeyAgreementKey2020', controller: REAL_DID, publicKeyMultibase: '' },
        { id: '#enc-0', type: 'X25519KeyAgreementKey2020', controller: REAL_DID, publicKeyMultibase: ENC_MULTIBASE },
      ],
    }
    expect(encryptionKeyMultibaseFromDidDocument(doc)).toBe(ENC_MULTIBASE)
  })

  it('skips a non-empty but invalid first entry and falls through to a later valid X25519 key', () => {
    // A malformed / non-X25519 entry must NOT shadow a valid later one
    // (else offline delivery breaks for a recipient that does publish a key).
    const ed = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'.replace('did:key:', '')
    const doc: DidDocument = {
      id: REAL_DID,
      verificationMethod: [],
      authentication: [],
      assertionMethod: [],
      keyAgreement: [
        { id: '#enc-bad', type: 'X25519KeyAgreementKey2020', controller: REAL_DID, publicKeyMultibase: ed },
        { id: '#enc-0', type: 'X25519KeyAgreementKey2020', controller: REAL_DID, publicKeyMultibase: ENC_MULTIBASE },
      ],
    }
    expect(encryptionKeyMultibaseFromDidDocument(doc)).toBe(ENC_MULTIBASE)
  })
})

describe('Discovery 1.B.3 spec-form verification publication surface', () => {
  // VE-1/VE-2 inversion (1.B.3 Step 2): the May refactor (#094 / 9117c82) removed
  // the UNSPECIFIED legacy `/v` publication surface. This slice RESTORES `/v`
  // spec-driven (Sync 004 §004, wot-spec #101/#102), so PublicVerificationsData /
  // publishVerifications / resolveVerifications MUST exist on the discovery surface.
  // STILL BANNED: the legacy structured Verification type module import.
  const read = (file: string): string => {
    const candidates = [file, path.join('..', '..', file), path.join('..', file)]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    }
    throw new Error(`source guard cannot locate ${file}`)
  }

  it('exposes PublicVerificationsData/publishVerifications/resolveVerifications on the DiscoveryAdapter surface', () => {
    const port = read('packages/wot-core/src/ports/DiscoveryAdapter.ts')
    const http = read('packages/wot-core/src/adapters/discovery/HttpDiscoveryAdapter.ts')
    const offline = read('packages/wot-core/src/adapters/discovery/OfflineFirstDiscoveryAdapter.ts')

    const hits: string[] = []

    if (!port.includes('PublicVerificationsData')) hits.push('DiscoveryAdapter port must define PublicVerificationsData')
    for (const [file, text] of [['DiscoveryAdapter.ts', port], ['HttpDiscoveryAdapter.ts', http], ['OfflineFirstDiscoveryAdapter.ts', offline]] as const) {
      if (!text.includes('publishVerifications')) hits.push(`${file} must expose publishVerifications`)
      if (!text.includes('resolveVerifications')) hits.push(`${file} must expose resolveVerifications`)
    }

    // STILL BANNED: legacy structured Verification type import in the HTTP adapter.
    if (/from\s+['"][^'"]*types\/verification['"]/.test(http)) {
      hits.push('HttpDiscoveryAdapter.ts still imports the legacy Verification type')
    }

    expect(hits).toEqual([])
  })

  it('widens PublishStateField to include verifications (Step 4: dirty-tracking of /v)', () => {
    // Inverted from Step 2's narrowing guard: Step 4 introduces independent
    // verifications dirty-tracking, so 'verifications' MUST now be a publish-state
    // field alongside profile and attestations.
    const portFile = 'packages/wot-core/src/ports/PublishStateStore.ts'
    const portText = read(portFile)

    const hits: string[] = []

    if (!/PublishStateField\s*=\s*'profile'\s*\|\s*'attestations'\s*\|\s*'verifications'/.test(portText)) {
      hits.push(`${portFile} PublishStateField must widen to 'profile' | 'attestations' | 'verifications'`)
    }

    expect(hits).toEqual([])
  })

  it('tracks verifications in OfflineFirstDiscoveryAdapter.syncPending getPublishData callback (Step 4)', () => {
    // Inverted from Step 2's drop-guard: Step 4 retries verifications on reconnect.
    const offlineText = read('packages/wot-core/src/adapters/discovery/OfflineFirstDiscoveryAdapter.ts')
    const hits: string[] = []

    if (!/verifications\??\s*:\s*PublicVerificationsData/.test(offlineText)) {
      hits.push('OfflineFirstDiscoveryAdapter.syncPending must accept verifications in getPublishData')
    }
    if (!/dirty\.has\(\s*['"]verifications['"]\s*\)/.test(offlineText)) {
      hits.push('OfflineFirstDiscoveryAdapter.syncPending must retry the verifications dirty field')
    }

    expect(hits).toEqual([])
  })
})
