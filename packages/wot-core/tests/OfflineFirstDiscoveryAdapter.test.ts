import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OfflineFirstDiscoveryAdapter } from '../src/adapters/discovery/OfflineFirstDiscoveryAdapter'
import { InMemoryPublishStateStore } from '../src/adapters/discovery/InMemoryPublishStateStore'
import { InMemoryGraphCacheStore } from '../src/adapters/discovery/InMemoryGraphCacheStore'
import type { DiscoveryAdapter, PublicVerificationsData, PublicAttestationsData, ProfileResolveResult } from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { WotIdentity } from '../src/identity/WotIdentity'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'

const TEST_PROFILE: PublicProfile = {
  did: ALICE_DID,
  name: 'Alice',
  updatedAt: new Date().toISOString(),
}

const TEST_VERIFICATIONS: PublicVerificationsData = {
  did: ALICE_DID,
  verifications: [],
  updatedAt: new Date().toISOString(),
}

const TEST_ATTESTATIONS: PublicAttestationsData = {
  did: ALICE_DID,
  attestations: [],
  updatedAt: new Date().toISOString(),
}

const MOCK_IDENTITY = {} as WotIdentity

function createMockInner(overrides: Partial<DiscoveryAdapter> = {}): DiscoveryAdapter {
  return {
    publishProfile: vi.fn().mockResolvedValue(undefined),
    publishVerifications: vi.fn().mockResolvedValue(undefined),
    publishAttestations: vi.fn().mockResolvedValue(undefined),
    resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }),
    resolveVerifications: vi.fn().mockResolvedValue([]),
    resolveAttestations: vi.fn().mockResolvedValue([]),
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

  describe('publishVerifications', () => {
    it('should mark dirty and clear on success', async () => {
      await adapter.publishVerifications(TEST_VERIFICATIONS, MOCK_IDENTITY)

      expect(inner.publishVerifications).toHaveBeenCalledWith(TEST_VERIFICATIONS, MOCK_IDENTITY)
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(0)
    })

    it('should keep dirty flag on failure', async () => {
      inner = createMockInner({
        publishVerifications: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      await adapter.publishVerifications(TEST_VERIFICATIONS, MOCK_IDENTITY)

      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.has('verifications')).toBe(true)
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
      await graphCache.cacheEntry(ALICE_DID, TEST_PROFILE, [], [])

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
  })

  describe('resolveVerifications', () => {
    it('should return verifications from inner on success', async () => {
      const verifications = [{ id: 'v1' }] as any
      inner = createMockInner({
        resolveVerifications: vi.fn().mockResolvedValue(verifications),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveVerifications(ALICE_DID)

      expect(result).toEqual(verifications)
    })

    it('should return cached verifications when inner fails', async () => {
      const verifications = [{ id: 'v1', from: 'did:key:bob', to: ALICE_DID, timestamp: '2026-01-01', proof: {} }] as any
      await graphCache.cacheEntry(ALICE_DID, TEST_PROFILE, verifications, [])

      inner = createMockInner({
        resolveVerifications: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveVerifications(ALICE_DID)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('v1')
    })

    it('should return empty array when inner fails and no cache exists', async () => {
      inner = createMockInner({
        resolveVerifications: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const result = await adapter.resolveVerifications(ALICE_DID)

      expect(result).toEqual([])
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
      await graphCache.cacheEntry(ALICE_DID, TEST_PROFILE, [], attestations)

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
        publishVerifications: vi.fn().mockRejectedValue(new Error('Offline')),
        publishAttestations: vi.fn().mockRejectedValue(new Error('Offline')),
      })
      const failingAdapter = new OfflineFirstDiscoveryAdapter(failingInner, publishState, graphCache)

      await failingAdapter.publishProfile(TEST_PROFILE, MOCK_IDENTITY)
      await failingAdapter.publishVerifications(TEST_VERIFICATIONS, MOCK_IDENTITY)
      await failingAdapter.publishAttestations(TEST_ATTESTATIONS, MOCK_IDENTITY)

      // Verify all three are dirty
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(3)

      // Now retry with a working inner adapter
      const getPublishData = vi.fn().mockResolvedValue({
        profile: TEST_PROFILE,
        verifications: TEST_VERIFICATIONS,
        attestations: TEST_ATTESTATIONS,
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(inner.publishProfile).toHaveBeenCalledWith(TEST_PROFILE, MOCK_IDENTITY)
      expect(inner.publishVerifications).toHaveBeenCalledWith(TEST_VERIFICATIONS, MOCK_IDENTITY)
      expect(inner.publishAttestations).toHaveBeenCalledWith(TEST_ATTESTATIONS, MOCK_IDENTITY)

      // All should be cleared
      const dirtyAfter = await publishState.getDirtyFields(ALICE_DID)
      expect(dirtyAfter.size).toBe(0)
    })

    it('should clear individually on partial success', async () => {
      // Mark all as dirty
      await publishState.markDirty(ALICE_DID, 'profile')
      await publishState.markDirty(ALICE_DID, 'verifications')
      await publishState.markDirty(ALICE_DID, 'attestations')

      // Inner: profile succeeds, verifications fails, attestations succeeds
      inner = createMockInner({
        publishProfile: vi.fn().mockResolvedValue(undefined),
        publishVerifications: vi.fn().mockRejectedValue(new Error('Server error')),
        publishAttestations: vi.fn().mockResolvedValue(undefined),
      })
      adapter = new OfflineFirstDiscoveryAdapter(inner, publishState, graphCache)

      const getPublishData = vi.fn().mockResolvedValue({
        profile: TEST_PROFILE,
        verifications: TEST_VERIFICATIONS,
        attestations: TEST_ATTESTATIONS,
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.size).toBe(1)
      expect(dirty.has('verifications')).toBe(true)
      expect(dirty.has('profile')).toBe(false)
      expect(dirty.has('attestations')).toBe(false)
    })

    it('should skip fields without data in getPublishData', async () => {
      await publishState.markDirty(ALICE_DID, 'profile')
      await publishState.markDirty(ALICE_DID, 'verifications')

      const getPublishData = vi.fn().mockResolvedValue({
        profile: TEST_PROFILE,
        // verifications NOT provided
      })

      await adapter.syncPending(ALICE_DID, MOCK_IDENTITY, getPublishData)

      expect(inner.publishProfile).toHaveBeenCalled()
      expect(inner.publishVerifications).not.toHaveBeenCalled()

      // Profile cleared, verifications still dirty (no data to retry with)
      const dirty = await publishState.getDirtyFields(ALICE_DID)
      expect(dirty.has('profile')).toBe(false)
      expect(dirty.has('verifications')).toBe(true)
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
