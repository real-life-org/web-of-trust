import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { GraphCacheService } from '../src/adapters/discovery/GraphCacheService'
import { InMemoryGraphCacheStore } from '../src/adapters/discovery/InMemoryGraphCacheStore'
import type { DiscoveryAdapter } from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { Attestation } from '../src/types/attestation'
import type { DidDocument } from '../src/protocol/identity/did-document'
import { x25519PublicKeyToMultibase } from '../src/protocol/identity/did-key'

const ALICE_DID = 'did:key:z6MkAlice'
const BOB_DID = 'did:key:z6MkBob'
const CARLA_DID = 'did:key:z6MkCarla'

// A syntactically valid X25519 keyAgreement multibase (decodes to 32 bytes).
const ENC_MULTIBASE = x25519PublicKeyToMultibase(new Uint8Array(32).fill(9))

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

const ALICE_PROFILE: PublicProfile = {
  did: ALICE_DID,
  name: 'Alice',
  bio: 'Gärtnerin',
  updatedAt: new Date().toISOString(),
}

const BOB_PROFILE: PublicProfile = {
  did: BOB_DID,
  name: 'Bob',
  updatedAt: new Date().toISOString(),
}

function makeAttestation(from: string, to: string, claim: string): Attestation {
  const id = `a-${from}-${to}-${claim}`
  return {
    id,
    from,
    to,
    claim,
    createdAt: new Date().toISOString(),
    vcJws: `header.${id}.signature`,
  }
}

function createMockDiscovery(overrides: Partial<DiscoveryAdapter> = {}): DiscoveryAdapter {
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

describe('GraphCacheService', () => {
  let store: InMemoryGraphCacheStore
  let discovery: DiscoveryAdapter
  let service: GraphCacheService

  beforeEach(() => {
    store = new InMemoryGraphCacheStore()
    discovery = createMockDiscovery()
    service = new GraphCacheService(discovery, store, { staleDurationMs: 60000 })
  })

  describe('refresh', () => {
    it('should fetch and cache profile and attestations', async () => {
      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Zuverlässig')]

      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: ALICE_PROFILE, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue(attestations),
      })
      service = new GraphCacheService(discovery, store)

      const entry = await service.refresh(ALICE_DID)

      expect(entry).not.toBeNull()
      expect(entry!.name).toBe('Alice')
      expect(entry!.attestationCount).toBe(1)
    })

    it('should fetch and cache the /v verification list (Sync 004) — CodeRabbit #198', async () => {
      const verifications = [makeAttestation(BOB_DID, ALICE_DID, 'in-person verifiziert')]

      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: ALICE_PROFILE, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
        resolveVerifications: vi.fn().mockResolvedValue(verifications),
      })
      service = new GraphCacheService(discovery, store)

      const entry = await service.refresh(ALICE_DID)

      expect(discovery.resolveVerifications).toHaveBeenCalledWith(ALICE_DID)
      expect(entry).not.toBeNull()
      expect(entry!.verificationCount).toBe(1)
      expect(entry!.attestationCount).toBe(0)
    })

    it('threads the online didDocument keyAgreement key into the cache (VE-3)', async () => {
      // The ONLY callsite where the network didDocument is available. The
      // keyAgreement key must survive into the cache so offline ECIES delivery works.
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({
          profile: ALICE_PROFILE,
          didDocument: didDocumentWithKey(ALICE_DID, ENC_MULTIBASE),
          fromCache: false,
        }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store)

      await service.refresh(ALICE_DID)

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
    })

    it('caches no key when the online didDocument is absent (backward-compat)', async () => {
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: ALICE_PROFILE, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store)

      await service.refresh(ALICE_DID)

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.encryptionKeyMultibase).toBeUndefined()
    })

    it('should return cached data on network failure', async () => {
      // Pre-populate cache
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
        resolveAttestations: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      service = new GraphCacheService(discovery, store)

      const entry = await service.refresh(ALICE_DID)

      expect(entry).not.toBeNull()
      expect(entry!.name).toBe('Alice')
    })

    it('should return null when no cache and network fails', async () => {
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockRejectedValue(new Error('Offline')),
        resolveAttestations: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      service = new GraphCacheService(discovery, store)

      const entry = await service.refresh(ALICE_DID)

      expect(entry).toBeNull()
    })

    it('should fetch profile and attestations in parallel', async () => {
      let resolveProfile!: (value: { profile: typeof ALICE_PROFILE; fromCache: false }) => void
      let resolveAttestations!: (value: Attestation[]) => void
      const profilePromise = new Promise<{ profile: typeof ALICE_PROFILE; fromCache: false }>((resolve) => {
        resolveProfile = resolve
      })
      const attestationsPromise = new Promise<Attestation[]>((resolve) => {
        resolveAttestations = resolve
      })

      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockReturnValue(profilePromise),
        resolveAttestations: vi.fn().mockReturnValue(attestationsPromise),
      })
      service = new GraphCacheService(discovery, store)

      const refresh = service.refresh(ALICE_DID)
      await Promise.resolve()

      expect(discovery.resolveProfile).toHaveBeenCalledWith(ALICE_DID)
      expect(discovery.resolveAttestations).toHaveBeenCalledWith(ALICE_DID)

      resolveProfile({ profile: ALICE_PROFILE, fromCache: false })
      resolveAttestations([])
      await refresh
    })
  })

  describe('ensureCached', () => {
    it('should return cached data without fetching when fresh', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const entry = await service.ensureCached(ALICE_DID)

      expect(entry).not.toBeNull()
      expect(entry!.name).toBe('Alice')
      expect(discovery.resolveProfile).not.toHaveBeenCalled()
    })

    it('should return null and trigger background refresh when not cached', async () => {
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: ALICE_PROFILE, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store)

      const entry = await service.ensureCached(ALICE_DID)

      expect(entry).toBeNull()
      // Wait for background refresh
      await vi.waitFor(async () => {
        const cached = await store.getEntry(ALICE_DID)
        expect(cached).not.toBeNull()
      })
    })

    it('should return stale data and trigger refresh', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const updatedProfile = { ...ALICE_PROFILE, name: 'Alice Updated' }
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: updatedProfile, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store, { staleDurationMs: 0 }) // everything is stale

      const entry = await service.ensureCached(ALICE_DID)

      // Returns existing (stale) data immediately
      expect(entry).not.toBeNull()
      expect(entry!.name).toBe('Alice')

      // Verify that discovery was called (refresh was triggered)
      // Use refresh() directly to verify the update works
      await service.refresh(ALICE_DID)
      const cached = await store.getEntry(ALICE_DID)
      expect(cached!.name).toBe('Alice Updated')
    })
  })

  describe('refreshContacts', () => {
    it('should refresh only stale or missing contacts', async () => {
      // Alice is fresh in cache
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      // Bob is not cached
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: BOB_PROFILE, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store)

      await service.refreshContacts([ALICE_DID, BOB_DID])

      // Only Bob should have been fetched (Alice is fresh)
      expect(discovery.resolveProfile).toHaveBeenCalledTimes(1)
      expect(discovery.resolveProfile).toHaveBeenCalledWith(BOB_DID)
    })

    it('should respect concurrency limit', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockImplementation(async () => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise(r => setTimeout(r, 10))
          concurrent--
          return { profile: null, fromCache: false }
        }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store, { concurrency: 2 })

      const dids = ['did:key:a', 'did:key:b', 'did:key:c', 'did:key:d', 'did:key:e']
      await service.refreshContacts(dids)

      expect(maxConcurrent).toBeLessThanOrEqual(2)
      expect(discovery.resolveProfile).toHaveBeenCalledTimes(5)
    })

    it('should do nothing when all contacts are fresh', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      await service.refreshContacts([ALICE_DID, BOB_DID])

      expect(discovery.resolveProfile).not.toHaveBeenCalled()
    })
  })

  describe('refreshContactSummaries', () => {
    it('should update counts from batch summary endpoint', async () => {
      discovery = createMockDiscovery({
        resolveSummaries: vi.fn().mockResolvedValue([
          { did: ALICE_DID, name: 'Alice', verificationCount: 5, attestationCount: 3 },
          { did: BOB_DID, name: 'Bob', verificationCount: 2, attestationCount: 0 },
        ]),
      })
      service = new GraphCacheService(discovery, store)

      await service.refreshContactSummaries([ALICE_DID, BOB_DID])

      const alice = await store.getEntry(ALICE_DID)
      expect(alice).not.toBeNull()
      expect(alice!.name).toBe('Alice')
      expect(alice!.verificationCount).toBe(5)
      expect(alice!.attestationCount).toBe(3)

      const bob = await store.getEntry(BOB_DID)
      expect(bob).not.toBeNull()
      expect(bob!.verificationCount).toBe(2)
      expect(bob!.attestationCount).toBe(0)
    })

    it('should update counts when they decrease (retraction)', async () => {
      // Pre-populate with old counts
      await store.updateSummary(ALICE_DID, 'Alice', 5, 3)

      discovery = createMockDiscovery({
        resolveSummaries: vi.fn().mockResolvedValue([
          { did: ALICE_DID, name: 'Alice', verificationCount: 5, attestationCount: 1 },
        ]),
      })
      service = new GraphCacheService(discovery, store)

      await service.refreshContactSummaries([ALICE_DID])

      const alice = await store.getEntry(ALICE_DID)
      expect(alice!.attestationCount).toBe(1) // decreased from 3 to 1
    })

    it('should fall back to refreshContacts when resolveSummaries not available', async () => {
      discovery = createMockDiscovery({
        resolveProfile: vi.fn().mockResolvedValue({ profile: ALICE_PROFILE, fromCache: false }),
        resolveAttestations: vi.fn().mockResolvedValue([]),
      })
      // No resolveSummaries on this adapter
      service = new GraphCacheService(discovery, store)

      await service.refreshContactSummaries([ALICE_DID])

      // Should have used full refresh
      expect(discovery.resolveProfile).toHaveBeenCalledWith(ALICE_DID)
    })

    it('should silently handle network errors', async () => {
      discovery = createMockDiscovery({
        resolveSummaries: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      service = new GraphCacheService(discovery, store)

      // Should not throw
      await service.refreshContactSummaries([ALICE_DID])
    })

    it('should do nothing for empty DID list', async () => {
      discovery = createMockDiscovery({
        resolveSummaries: vi.fn().mockResolvedValue([]),
      })
      service = new GraphCacheService(discovery, store)

      await service.refreshContactSummaries([])

      expect(discovery.resolveSummaries).not.toHaveBeenCalled()
    })
  })

  describe('resolveName', () => {
    it('should return name from cache', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const name = await service.resolveName(ALICE_DID)

      expect(name).toBe('Alice')
    })

    it('should return null when not cached', async () => {
      const name = await service.resolveName(ALICE_DID)

      expect(name).toBeNull()
    })
  })

  describe('resolveNames', () => {
    it('should batch resolve names from cache', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      const names = await service.resolveNames([ALICE_DID, BOB_DID, CARLA_DID])

      expect(names.get(ALICE_DID)).toBe('Alice')
      expect(names.get(BOB_DID)).toBe('Bob')
      expect(names.has(CARLA_DID)).toBe(false)
    })
  })

})

describe('InMemoryGraphCacheStore', () => {
  let store: InMemoryGraphCacheStore

  beforeEach(() => {
    store = new InMemoryGraphCacheStore()
  })

  describe('cacheEntry and getEntry', () => {
    it('should store and retrieve a complete entry', async () => {
      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Hilfsbereit')]

      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: attestations, verifications: [] })
      const entry = await store.getEntry(ALICE_DID)

      expect(entry).not.toBeNull()
      expect(entry!.did).toBe(ALICE_DID)
      expect(entry!.name).toBe('Alice')
      expect(entry!.bio).toBe('Gärtnerin')
      expect(entry!.verificationCount).toBe(0)
      expect(entry!.attestationCount).toBe(1)
      expect(entry!.fetchedAt).toBeDefined()
    })

    it('should handle null profile', async () => {
      await store.cacheEntry(ALICE_DID, { profile: null, attestations: [], verifications: [] })
      const entry = await store.getEntry(ALICE_DID)

      expect(entry).not.toBeNull()
      expect(entry!.name).toBeUndefined()
      expect(entry!.verificationCount).toBe(0)
    })

    it('should return null for uncached DID', async () => {
      const entry = await store.getEntry('did:key:unknown')
      expect(entry).toBeNull()
    })

    it('extracts and exposes the keyAgreement key from a snapshot didDocument (VE-4)', async () => {
      await store.cacheEntry(ALICE_DID, {
        profile: ALICE_PROFILE,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(ALICE_DID, ENC_MULTIBASE),
      })

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
    })

    it('omits encryptionKeyMultibase when no key was ever cached', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.encryptionKeyMultibase).toBeUndefined()
    })

    it('does NOT persist a malformed keyAgreement key (validated via x25519 decode, VE-2/VE-4)', async () => {
      await store.cacheEntry(ALICE_DID, {
        profile: ALICE_PROFILE,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(ALICE_DID, 'zABC'),
      })

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.encryptionKeyMultibase).toBeUndefined()
    })

    it('preserve-on-missing: a later snapshot without didDocument keeps the cached key (VE-4)', async () => {
      // First online resolve carries the key…
      await store.cacheEntry(ALICE_DID, {
        profile: ALICE_PROFILE,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(ALICE_DID, ENC_MULTIBASE),
      })
      // …a subsequent refresh WITHOUT a didDocument must NOT null the key.
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)
    })

    it('drops the cached key on evict and clear (VE-4 lifecycle)', async () => {
      await store.cacheEntry(ALICE_DID, {
        profile: ALICE_PROFILE,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(ALICE_DID, ENC_MULTIBASE),
      })
      await store.cacheEntry(BOB_DID, {
        profile: BOB_PROFILE,
        attestations: [],
        verifications: [],
        didDocument: didDocumentWithKey(BOB_DID, ENC_MULTIBASE),
      })

      await store.evict(ALICE_DID)
      // Bob still has his key; re-caching Alice with no didDocument must NOT
      // resurrect the evicted key.
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      expect((await store.getEntry(ALICE_DID))!.encryptionKeyMultibase).toBeUndefined()
      expect((await store.getEntry(BOB_DID))!.encryptionKeyMultibase).toBe(ENC_MULTIBASE)

      await store.clear()
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })
      expect((await store.getEntry(BOB_DID))!.encryptionKeyMultibase).toBeUndefined()
    })
  })

  describe('getEntries', () => {
    it('should batch retrieve entries', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      const entries = await store.getEntries([ALICE_DID, BOB_DID, CARLA_DID])

      expect(entries.size).toBe(2)
      expect(entries.get(ALICE_DID)!.name).toBe('Alice')
      expect(entries.get(BOB_DID)!.name).toBe('Bob')
      expect(entries.has(CARLA_DID)).toBe(false)
    })
  })

  describe('getCachedAttestations', () => {
    it('should return cached attestations', async () => {
      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Zuverlässig')]
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: attestations, verifications: [] })

      const result = await store.getCachedAttestations(ALICE_DID)
      expect(result).toHaveLength(1)
      expect(result[0].claim).toBe('Zuverlässig')
    })

    it('should return empty arrays for uncached DID', async () => {
      expect(await store.getCachedAttestations('did:key:unknown')).toEqual([])
    })
  })

  describe('resolveName and resolveNames', () => {
    it('should resolve single name', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      expect(await store.resolveName(ALICE_DID)).toBe('Alice')
    })

    it('should return null for uncached DID', async () => {
      expect(await store.resolveName('did:key:unknown')).toBeNull()
    })

    it('should batch resolve names', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      const names = await store.resolveNames([ALICE_DID, BOB_DID, CARLA_DID])

      expect(names.size).toBe(2)
      expect(names.get(ALICE_DID)).toBe('Alice')
      expect(names.get(BOB_DID)).toBe('Bob')
    })
  })

  describe('search', () => {
    it('should search by profile name', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      const results = await store.search('alice')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should search by bio', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const results = await store.search('gärtnerin')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should search by attestation claim', async () => {
      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Kann gut kochen')]
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: attestations, verifications: [] })

      const results = await store.search('kochen')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should return empty for no matches', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })

      const results = await store.search('xyz123')

      expect(results).toHaveLength(0)
    })
  })

  describe('updateSummary', () => {
    it('should create entry with counts when DID not yet cached', async () => {
      await store.updateSummary(ALICE_DID, 'Alice', 3, 2)

      const entry = await store.getEntry(ALICE_DID)
      expect(entry).not.toBeNull()
      expect(entry!.name).toBe('Alice')
      expect(entry!.verificationCount).toBe(3)
      expect(entry!.attestationCount).toBe(2)
    })

    it('should update counts without overwriting attestation detail data', async () => {
      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Zuverlässig')]
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: attestations, verifications: [] })

      await store.updateSummary(ALICE_DID, 'Alice Updated', 5, 3)

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.name).toBe('Alice Updated')
      expect(entry!.verificationCount).toBe(5)
      expect(entry!.attestationCount).toBe(3)

      const cachedAttestations = await store.getCachedAttestations(ALICE_DID)
      expect(cachedAttestations).toHaveLength(1)
      expect(cachedAttestations[0].claim).toBe('Zuverlässig')
    })

    it('should handle null name (unknown DID)', async () => {
      await store.updateSummary(ALICE_DID, null, 0, 0)

      const entry = await store.getEntry(ALICE_DID)
      expect(entry).not.toBeNull()
      expect(entry!.name).toBeUndefined()
      expect(entry!.verificationCount).toBe(0)
    })

    it('cacheEntry now sets the verification count authoritatively from the verifications list (VE-2)', async () => {
      // VE-2: cacheEntry carries the verifications resource, so a detail refresh
      // overwrites the lightweight summary count instead of preserving it.
      await store.updateSummary(ALICE_DID, 'Alice', 10, 5)

      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Zuverlässig')]
      const verifications = [makeAttestation(CARLA_DID, ALICE_DID, 'in-person verifiziert')]
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations, verifications })

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.verificationCount).toBe(1)
      expect(entry!.attestationCount).toBe(1)
    })
  })

  describe('evict and clear', () => {
    it('should evict a single DID', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      await store.evict(ALICE_DID)

      expect(await store.getEntry(ALICE_DID)).toBeNull()
      expect(await store.getEntry(BOB_DID)).not.toBeNull()
    })

    it('should clear all entries', async () => {
      await store.cacheEntry(ALICE_DID, { profile: ALICE_PROFILE, attestations: [], verifications: [] })
      await store.cacheEntry(BOB_DID, { profile: BOB_PROFILE, attestations: [], verifications: [] })

      await store.clear()

      expect(await store.getEntry(ALICE_DID)).toBeNull()
      expect(await store.getEntry(BOB_DID)).toBeNull()
    })
  })
})

describe('Trust 002 graph cache port source guard', () => {
  // VE-2 inversion (1.B.3 Step 2): the May refactor (9117c82) BANNED
  // getCachedVerifications / resolveVerifications / verifications-in-cacheEntry
  // because it removed the unspecified legacy `/v` publication. This slice
  // RESTORES `/v` spec-driven as a compact-JWS ListResource, so those symbols
  // MUST now exist. The remaining ban stays: the new path carries the DERIVED
  // `Attestation[]` form — never the legacy structured `Verification[]` type and
  // never a `types/verification` import.
  it('exposes the spec-form verification surface while keeping the legacy Verification type banned', () => {
    const files = {
      port: 'packages/wot-core/src/ports/GraphCacheStore.ts',
      inMemory: 'packages/wot-core/src/adapters/discovery/InMemoryGraphCacheStore.ts',
      service: 'packages/wot-core/src/adapters/discovery/GraphCacheService.ts',
      offline: 'packages/wot-core/src/adapters/discovery/OfflineFirstDiscoveryAdapter.ts',
      automerge: 'apps/demo/src/adapters/AutomergeGraphCacheStore.ts',
    } as const

    const read = (file: string): string => {
      const candidates = [
        file,
        path.join('..', '..', file),
        path.join('..', file),
      ]
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
      }
      throw new Error(`source guard cannot locate ${file}`)
    }

    const text = {
      port: read(files.port),
      inMemory: read(files.inMemory),
      service: read(files.service),
      offline: read(files.offline),
      automerge: read(files.automerge),
    }

    const hits: string[] = []

    // STILL BANNED: legacy structured Verification type anywhere on the cache surface.
    for (const key of ['port', 'inMemory', 'service', 'offline', 'automerge'] as const) {
      if (/types\/verification/.test(text[key])) {
        hits.push(`${files[key]} still imports legacy Verification type`)
      }
    }
    if (
      /verifications\s*:\s*Verification\[\]/.test(text.port) ||
      /verifications\s*:\s*Verification\[\]/.test(text.inMemory) ||
      /_verifications\s*:\s*Verification\[\]/.test(text.automerge)
    ) {
      hits.push('graph cache still accepts the legacy Verification[] detail form')
    }

    // NOW REQUIRED (VE-2): the spec-form Attestation[]-derived verification surface.
    for (const key of ['port', 'inMemory', 'automerge'] as const) {
      if (!/getCachedVerifications\s*\(/.test(text[key])) {
        hits.push(`${files[key]} must expose getCachedVerifications (Attestation[] form)`)
      }
    }
    if (!/resolveVerifications\s*\(/.test(text.service)) {
      hits.push('GraphCacheService.refresh must fetch verifications for the graph cache')
    }
    if (!/graphCache\.getCachedVerifications/.test(text.offline)) {
      hits.push('OfflineFirstDiscoveryAdapter must fall back to graph-cache verifications')
    }
    if (!/resolveVerifications/.test(text.offline)) {
      hits.push('OfflineFirstDiscoveryAdapter must expose resolveVerifications')
    }

    expect(hits).toEqual([])
  })

  it('drops legacy verifierDids and findMutualContacts from the graph-cache surface', () => {
    const files = {
      port: 'packages/wot-core/src/ports/GraphCacheStore.ts',
      service: 'packages/wot-core/src/adapters/discovery/GraphCacheService.ts',
      inMemory: 'packages/wot-core/src/adapters/discovery/InMemoryGraphCacheStore.ts',
      automerge: 'apps/demo/src/adapters/AutomergeGraphCacheStore.ts',
      personalDoc: 'packages/adapter-automerge/src/PersonalDocManager.ts',
    } as const

    const read = (file: string): string => {
      const candidates = [
        file,
        path.join('..', '..', file),
        path.join('..', file),
      ]
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
      }
      throw new Error(`source guard cannot locate ${file}`)
    }

    const hits: string[] = []

    for (const [key, file] of Object.entries(files) as Array<[keyof typeof files, string]>) {
      const text = read(file)
      if (/\bverifierDids\b/.test(text)) {
        hits.push(`${file} still references verifierDids`)
      }
      if (/\bverifierDidsJson\b/.test(text)) {
        hits.push(`${file} still references verifierDidsJson`)
      }
      if (/\bfindMutualContacts\b/.test(text)) {
        hits.push(`${file} still references findMutualContacts`)
      }
      void key
    }

    // Keep core graph-cache APIs that this slice must preserve.
    const portText = read(files.port)
    for (const needle of ['verificationCount', 'attestationCount', 'getCachedAttestations']) {
      if (!portText.includes(needle)) {
        hits.push(`${files.port} lost required API ${needle}`)
      }
    }

    expect(hits).toEqual([])
  })
})
