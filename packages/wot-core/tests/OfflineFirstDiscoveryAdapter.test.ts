import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OfflineFirstDiscoveryAdapter } from '../src/adapters/discovery/OfflineFirstDiscoveryAdapter'
import { InMemoryPublishStateStore } from '../src/adapters/discovery/InMemoryPublishStateStore'
import { InMemoryGraphCacheStore } from '../src/adapters/discovery/InMemoryGraphCacheStore'
import type { DiscoveryAdapter, PublicAttestationsData } from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { PublicIdentitySession } from '../src/application/identity'

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

const MOCK_IDENTITY = {} as PublicIdentitySession

function createMockInner(overrides: Partial<DiscoveryAdapter> = {}): DiscoveryAdapter {
  return {
    publishProfile: vi.fn().mockResolvedValue(undefined),
    publishAttestations: vi.fn().mockResolvedValue(undefined),
    resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }),
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
      await graphCache.cacheEntry(ALICE_DID, TEST_PROFILE, [])

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
      await graphCache.cacheEntry(ALICE_DID, TEST_PROFILE, attestations)

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

describe('Discovery 094 legacy verification publication source guard', () => {
  // Sync 004 profile-service `/p/{did}/v` protocol/server compatibility and Trust
  // 002 verification types/workflows stay. This guard only removes the broad
  // DiscoveryAdapter publication/resolve surface and PublishStateField slot for
  // legacy `Verification[]` publication via the discovery port.
  const read = (file: string): string => {
    const candidates = [file, path.join('..', '..', file), path.join('..', file)]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    }
    throw new Error(`source guard cannot locate ${file}`)
  }

  it('removes PublicVerificationsData/publishVerifications/resolveVerifications from the broad DiscoveryAdapter surface', () => {
    const files = {
      port: 'packages/wot-core/src/ports/DiscoveryAdapter.ts',
      http: 'packages/wot-core/src/adapters/discovery/HttpDiscoveryAdapter.ts',
      offline: 'packages/wot-core/src/adapters/discovery/OfflineFirstDiscoveryAdapter.ts',
      index: 'packages/wot-core/src/index.ts',
    } as const

    const hits: string[] = []
    const legacyNeedles = ['PublicVerificationsData', 'publishVerifications', 'resolveVerifications'] as const

    for (const [, file] of Object.entries(files)) {
      const text = read(file)
      for (const needle of legacyNeedles) {
        if (text.includes(needle)) hits.push(`${file} still contains ${needle}`)
      }
    }

    const httpText = read(files.http)
    if (/from\s+['"][^'"]*types\/verification['"]/.test(httpText)) {
      hits.push(`${files.http} still imports the legacy Verification type`)
    }

    expect(hits).toEqual([])
  })

  it('narrows PublishStateField to profile | attestations and drops verifications from in-memory store', () => {
    const portFile = 'packages/wot-core/src/ports/PublishStateStore.ts'
    const inMemoryFile = 'packages/wot-core/src/adapters/discovery/InMemoryPublishStateStore.ts'

    const portText = read(portFile)
    const inMemoryText = read(inMemoryFile)

    const hits: string[] = []

    if (portText.includes("'verifications'")) {
      hits.push(`${portFile} still includes 'verifications' in PublishStateField`)
    }
    if (!/PublishStateField\s*=\s*'profile'\s*\|\s*'attestations'/.test(portText)) {
      hits.push(`${portFile} PublishStateField should narrow to 'profile' | 'attestations'`)
    }
    if (inMemoryText.includes("'verifications'") || /case\s+'verifications'/.test(inMemoryText)) {
      hits.push(`${inMemoryFile} still tracks 'verifications' as a publish state field`)
    }

    expect(hits).toEqual([])
  })

  it('drops verifications from OfflineFirstDiscoveryAdapter.syncPending getPublishData callback', () => {
    const offlineText = read('packages/wot-core/src/adapters/discovery/OfflineFirstDiscoveryAdapter.ts')
    const hits: string[] = []

    if (/verifications\??\s*:\s*PublicVerificationsData/.test(offlineText)) {
      hits.push('OfflineFirstDiscoveryAdapter.syncPending still accepts verifications in getPublishData')
    }
    if (/dirty\.has\(\s*['"]verifications['"]\s*\)/.test(offlineText)) {
      hits.push('OfflineFirstDiscoveryAdapter.syncPending still retries verifications dirty field')
    }

    expect(hits).toEqual([])
  })
})
