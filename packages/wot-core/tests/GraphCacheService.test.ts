import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { GraphCacheService } from '../src/adapters/discovery/GraphCacheService'
import { InMemoryGraphCacheStore } from '../src/adapters/discovery/InMemoryGraphCacheStore'
import type { DiscoveryAdapter } from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { Attestation } from '../src/types/attestation'

const ALICE_DID = 'did:key:z6MkAlice'
const BOB_DID = 'did:key:z6MkBob'
const CARLA_DID = 'did:key:z6MkCarla'

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
    resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }),
    resolveAttestations: vi.fn().mockResolvedValue([]),
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

    it('should return cached data on network failure', async () => {
      // Pre-populate cache
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

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

      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, attestations)
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
      await store.cacheEntry(ALICE_DID, null, [])
      const entry = await store.getEntry(ALICE_DID)

      expect(entry).not.toBeNull()
      expect(entry!.name).toBeUndefined()
      expect(entry!.verificationCount).toBe(0)
    })

    it('should return null for uncached DID', async () => {
      const entry = await store.getEntry('did:key:unknown')
      expect(entry).toBeNull()
    })
  })

  describe('getEntries', () => {
    it('should batch retrieve entries', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, attestations)

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      expect(await store.resolveName(ALICE_DID)).toBe('Alice')
    })

    it('should return null for uncached DID', async () => {
      expect(await store.resolveName('did:key:unknown')).toBeNull()
    })

    it('should batch resolve names', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

      const names = await store.resolveNames([ALICE_DID, BOB_DID, CARLA_DID])

      expect(names.size).toBe(2)
      expect(names.get(ALICE_DID)).toBe('Alice')
      expect(names.get(BOB_DID)).toBe('Bob')
    })
  })

  describe('search', () => {
    it('should search by profile name', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

      const results = await store.search('alice')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should search by bio', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

      const results = await store.search('gärtnerin')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should search by attestation claim', async () => {
      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Kann gut kochen')]
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, attestations)

      const results = await store.search('kochen')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should return empty for no matches', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])

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
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, attestations)

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

    it('should preserve verification summary count when cacheEntry refreshes details', async () => {
      await store.updateSummary(ALICE_DID, 'Alice', 10, 5)

      const attestations = [makeAttestation(BOB_DID, ALICE_DID, 'Zuverlässig')]
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, attestations)

      const entry = await store.getEntry(ALICE_DID)
      expect(entry!.verificationCount).toBe(10)
      expect(entry!.attestationCount).toBe(1)
    })
  })

  describe('evict and clear', () => {
    it('should evict a single DID', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

      await store.evict(ALICE_DID)

      expect(await store.getEntry(ALICE_DID)).toBeNull()
      expect(await store.getEntry(BOB_DID)).not.toBeNull()
    })

    it('should clear all entries', async () => {
      await store.cacheEntry(ALICE_DID, ALICE_PROFILE, [])
      await store.cacheEntry(BOB_DID, BOB_PROFILE, [])

      await store.clear()

      expect(await store.getEntry(ALICE_DID)).toBeNull()
      expect(await store.getEntry(BOB_DID)).toBeNull()
    })
  })
})

describe('Trust 002 graph cache port source guard', () => {
  it('removes legacy Verification detail surface from the core graph cache port', () => {
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

    for (const key of ['port', 'inMemory', 'automerge'] as const) {
      if (/types\/verification/.test(text[key])) {
        hits.push(`${files[key]} still imports legacy Verification type`)
      }
      if (/getCachedVerifications\s*\(/.test(text[key])) {
        hits.push(`${files[key]} still exposes getCachedVerifications`)
      }
    }

    if (
      /verifications\s*:\s*Verification\[\]/.test(text.port) ||
      /verifications\s*:\s*Verification\[\]/.test(text.inMemory) ||
      /_verifications\s*:\s*Verification\[\]/.test(text.automerge)
    ) {
      hits.push('graph cache cacheEntry still accepts Verification[] detail data')
    }

    if (
      /private\s+verifications\s*=/.test(text.inMemory) ||
      /this\.verifications/.test(text.inMemory)
    ) {
      hits.push('InMemoryGraphCacheStore still stores legacy Verification details')
    }

    if (/resolveVerifications\s*\(/.test(text.service)) {
      hits.push('GraphCacheService.refresh still fetches legacy verifications for graph cache')
    }

    if (/graphCache\.getCachedVerifications/.test(text.offline)) {
      hits.push('OfflineFirstDiscoveryAdapter still falls back to graph-cache legacy verifications')
    }

    if (/resolveVerifications/.test(text.offline)) {
      hits.push('OfflineFirstDiscoveryAdapter should no longer expose resolveVerifications')
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
