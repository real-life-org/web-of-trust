import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FallbackDiscoveryAdapter } from '../src/adapters/discovery/FallbackDiscoveryAdapter'
import {
  DiscoveryPartialPublishError,
  LocalProfileVersionCache,
  ProfileResourceRollbackError,
  normalizeDiscoveryServerKey,
  type ProfileVersionCache,
  type VersionedDiscoveryAdapter,
  type ProfileResolveResult,
} from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { IdentitySession } from '../src/types/identity-session'

const ALICE = 'did:key:z6MkAlice'
const PROFILE: PublicProfile = { did: ALICE, name: 'Alice', updatedAt: '2026-07-07T00:00:00.000Z' }
const RESOLVED: ProfileResolveResult = { profile: PROFILE, version: 3, fromCache: false }
const IDENTITY = {} as IdentitySession

/** Structural VersionedDiscoveryAdapter fake (vi.fn), like DualVaultClient's fakes. */
function makeTarget(overrides: Partial<VersionedDiscoveryAdapter> = {}): VersionedDiscoveryAdapter {
  return {
    publishProfile: vi.fn().mockResolvedValue(undefined),
    publishAttestations: vi.fn().mockResolvedValue(undefined),
    publishVerifications: vi.fn().mockResolvedValue(undefined),
    resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }),
    resolveAttestations: vi.fn().mockResolvedValue([]),
    resolveVerifications: vi.fn().mockResolvedValue([]),
    resolveSummaries: vi.fn().mockResolvedValue([]),
    getVersionCache: vi.fn().mockReturnValue({} as ProfileVersionCache),
    ...overrides,
  }
}

describe('FallbackDiscoveryAdapter — constructor', () => {
  it('throws on an empty target list', () => {
    expect(() => new FallbackDiscoveryAdapter([])).toThrow(/at least one target/)
  })

  it('delegates getVersionCache to the PRIMARY target', () => {
    const cache = {} as ProfileVersionCache
    const primary = makeTarget({ getVersionCache: vi.fn().mockReturnValue(cache) })
    const secondary = makeTarget()
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])
    expect(fallback.getVersionCache()).toBe(cache)
    expect(secondary.getVersionCache).not.toHaveBeenCalled()
  })
})

describe('FallbackDiscoveryAdapter — reads (fallback ONLY on a throw)', () => {
  it('returns the primary result and does NOT touch the secondary on a resolved value', async () => {
    const primary = makeTarget({ resolveProfile: vi.fn().mockResolvedValue(RESOLVED) })
    const secondary = makeTarget()
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveProfile(ALICE)).resolves.toEqual(RESOLVED)
    expect(secondary.resolveProfile).not.toHaveBeenCalled()
  })

  it('treats a resolved profile:null as FINAL — no fallback (a legitimate not-found must not be masked)', async () => {
    const primary = makeTarget({ resolveProfile: vi.fn().mockResolvedValue({ profile: null, fromCache: false }) })
    const secondary = makeTarget({ resolveProfile: vi.fn().mockResolvedValue(RESOLVED) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveProfile(ALICE)).resolves.toEqual({ profile: null, fromCache: false })
    expect(secondary.resolveProfile).not.toHaveBeenCalled()
  })

  it('treats a resolved empty list as FINAL — no fallback', async () => {
    const primary = makeTarget({ resolveAttestations: vi.fn().mockResolvedValue([]) })
    const secondary = makeTarget({ resolveAttestations: vi.fn().mockResolvedValue([{ id: 'a1' } as never]) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveAttestations(ALICE)).resolves.toEqual([])
    expect(secondary.resolveAttestations).not.toHaveBeenCalled()
  })

  it('falls through to the secondary when the primary THROWS a network fault (5xx/reject)', async () => {
    const primary = makeTarget({ resolveProfile: vi.fn().mockRejectedValue(new Error('Profile fetch failed: 503')) })
    const secondary = makeTarget({ resolveProfile: vi.fn().mockResolvedValue(RESOLVED) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveProfile(ALICE)).resolves.toEqual(RESOLVED)
    expect(primary.resolveProfile).toHaveBeenCalledTimes(1)
    expect(secondary.resolveProfile).toHaveBeenCalledTimes(1)
  })

  it('falls through on an AbortError (timeout) too', async () => {
    const abort = new DOMException('signal is aborted without reason', 'AbortError')
    const primary = makeTarget({ resolveVerifications: vi.fn().mockRejectedValue(abort) })
    const secondary = makeTarget({ resolveVerifications: vi.fn().mockResolvedValue([{ id: 'v1' } as never]) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveVerifications(ALICE)).resolves.toEqual([{ id: 'v1' }])
  })

  it('surfaces the PRIMARY (first) error when EVERY target throws transport-shaped', async () => {
    const primaryErr = new Error('Profile fetch failed: 503')
    const primary = makeTarget({ resolveProfile: vi.fn().mockRejectedValue(primaryErr) })
    const secondary = makeTarget({ resolveProfile: vi.fn().mockRejectedValue(new Error('also down')) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveProfile(ALICE)).rejects.toBe(primaryErr)
    // Transport-shaped errors ARE retried: the secondary was consulted.
    expect(secondary.resolveProfile).toHaveBeenCalledTimes(1)
  })

  // Codex #253 blocker: the rollback detector is a SECURITY mechanism (server
  // served an older version than ever seen = tamper indicator). A healthy
  // secondary answer must never mask it — same rule OfflineFirstDiscoveryAdapter
  // enforces against its offline cache.
  it('rethrows a primary ProfileResourceRollbackError WITHOUT consulting the secondary (security-final)', async () => {
    const rollback = new ProfileResourceRollbackError(ALICE, 6, 7, 'profile')
    const primary = makeTarget({ resolveProfile: vi.fn().mockRejectedValue(rollback) })
    const secondary = makeTarget({ resolveProfile: vi.fn().mockResolvedValue(RESOLVED) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveProfile(ALICE)).rejects.toBe(rollback)
    expect(secondary.resolveProfile).not.toHaveBeenCalled()
  })

  it('rethrows a SECONDARY ProfileResourceRollbackError reached via transport fallback', async () => {
    // Each target owns its own namespaced baseline — a rollback on the secondary
    // is a tamper indicator for the secondary and must surface identically.
    const rollback = new ProfileResourceRollbackError(ALICE, 2, 5, 'verifications')
    const primary = makeTarget({ resolveVerifications: vi.fn().mockRejectedValue(new Error('fetch failed')) })
    const secondary = makeTarget({ resolveVerifications: vi.fn().mockRejectedValue(rollback) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])

    await expect(fallback.resolveVerifications(ALICE)).rejects.toBe(rollback)
  })

  it('resolveSummaries: throws when the PRIMARY does not support it', async () => {
    const primary = makeTarget({ resolveSummaries: undefined })
    const fallback = new FallbackDiscoveryAdapter([primary, makeTarget()])
    await expect(fallback.resolveSummaries([ALICE])).rejects.toThrow(/does not support resolveSummaries/)
  })

  it('resolveSummaries: falls through to the secondary on a primary throw', async () => {
    const summaries = [{ did: ALICE, name: 'Alice', verificationCount: 1, attestationCount: 0 }]
    const primary = makeTarget({ resolveSummaries: vi.fn().mockRejectedValue(new Error('down')) })
    const secondary = makeTarget({ resolveSummaries: vi.fn().mockResolvedValue(summaries) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary])
    await expect(fallback.resolveSummaries([ALICE])).resolves.toEqual(summaries)
  })
})

describe('FallbackDiscoveryAdapter — writes (best-effort to every target)', () => {
  it('publishes to BOTH targets and resolves on full success', async () => {
    const primary = makeTarget()
    const secondary = makeTarget()
    const fallback = new FallbackDiscoveryAdapter([primary, secondary], { targetKeys: ['A', 'B'] })

    await expect(fallback.publishProfile(PROFILE, IDENTITY)).resolves.toBeUndefined()
    expect(primary.publishProfile).toHaveBeenCalledTimes(1)
    expect(secondary.publishProfile).toHaveBeenCalledTimes(1)
  })

  it('throws DiscoveryPartialPublishError (soft) when one target fails but the other succeeds', async () => {
    const primary = makeTarget()
    const secondary = makeTarget({ publishProfile: vi.fn().mockRejectedValue(new Error('secondary down')) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary], { targetKeys: ['boxUrl', 'serverUrl'] })

    const err = await fallback.publishProfile(PROFILE, IDENTITY).catch((e) => e)
    expect(err).toBeInstanceOf(DiscoveryPartialPublishError)
    expect(err.succeededTargets).toEqual(['boxUrl'])
    expect(err.failedTargets).toEqual(['serverUrl'])
    // The primary still got the publish.
    expect(primary.publishProfile).toHaveBeenCalledTimes(1)
  })

  it('throws the first underlying error (NOT partial) when ALL targets fail', async () => {
    const boom = new Error('primary down')
    const primary = makeTarget({ publishAttestations: vi.fn().mockRejectedValue(boom) })
    const secondary = makeTarget({ publishAttestations: vi.fn().mockRejectedValue(new Error('secondary down')) })
    const fallback = new FallbackDiscoveryAdapter([primary, secondary], { targetKeys: ['A', 'B'] })

    const err = await fallback.publishAttestations({ did: ALICE, attestations: [], updatedAt: '' }, IDENTITY).catch((e) => e)
    expect(err).not.toBeInstanceOf(DiscoveryPartialPublishError)
    expect(err).toBe(boom)
  })

  it('publishVerifications signals partial success identically', async () => {
    const primary = makeTarget({ publishVerifications: vi.fn().mockRejectedValue(new Error('down')) })
    const secondary = makeTarget()
    const fallback = new FallbackDiscoveryAdapter([primary, secondary], { targetKeys: ['A', 'B'] })

    const err = await fallback.publishVerifications({ did: ALICE, verifications: [], updatedAt: '' }, IDENTITY).catch((e) => e)
    expect(err).toBeInstanceOf(DiscoveryPartialPublishError)
    expect(err.succeededTargets).toEqual(['B'])
    expect(err.failedTargets).toEqual(['A'])
  })
})

describe('normalizeDiscoveryServerKey', () => {
  it('lowercases host, drops trailing slash + query/hash', () => {
    expect(normalizeDiscoveryServerKey('https://Profiles.Box.Web-Of-Trust.de/')).toBe('https://profiles.box.web-of-trust.de')
    expect(normalizeDiscoveryServerKey('http://localhost:8788')).toBe('http://localhost:8788')
    expect(normalizeDiscoveryServerKey('https://x.de/api/?q=1#h')).toBe('https://x.de/api')
  })

  it('produces DISTINCT keys for two different profile servers', () => {
    expect(normalizeDiscoveryServerKey('https://profiles.box.web-of-trust.de'))
      .not.toBe(normalizeDiscoveryServerKey('https://profiles.web-of-trust.de'))
  })
})

// SF4 (Codex R1): the persistent rollback baseline must be namespaced per target,
// and the pre-namespace baseline must LAZY-MIGRATE for the primary (a silent switch
// would drop the baseline and weaken rollback detection — a security regression).
describe('LocalProfileVersionCache — per-target namespace + lazy migration', () => {
  const KEY_A = `wot:profile-version:${normalizeDiscoveryServerKey('https://a.example')}:`
  const KEY_B = `wot:profile-version:${normalizeDiscoveryServerKey('https://b.example')}:`
  const LEGACY = 'wot:profile-version:'

  beforeEach(() => {
    localStorage.clear()
  })

  it('two namespaced caches do NOT share a rollback baseline (no cross-contamination)', async () => {
    const a = new LocalProfileVersionCache(KEY_A)
    const b = new LocalProfileVersionCache(KEY_B)

    await a.setLastSeenVersion(ALICE, 'profile', 10)

    // b (a different server) must still see NO baseline for the same did/resource —
    // else b would false-reject a legitimately lower version as a rollback.
    expect(await b.getLastSeenVersion(ALICE, 'profile')).toBeUndefined()
    expect(await a.getLastSeenVersion(ALICE, 'profile')).toBe(10)
  })

  it('PRIMARY (legacyKeyPrefix set) adopts the legacy baseline once, rewrites it, drops the legacy key', async () => {
    // A pre-namespace baseline written by an older single-server build.
    localStorage.setItem(`${LEGACY}${ALICE}:profile`, '9')

    const primary = new LocalProfileVersionCache(KEY_A, LEGACY)
    expect(await primary.getLastSeenVersion(ALICE, 'profile')).toBe(9) // baseline survives

    // Adopted: rewritten under the namespaced key, legacy key removed.
    expect(localStorage.getItem(`${KEY_A}${ALICE}:profile`)).toBe('9')
    expect(localStorage.getItem(`${LEGACY}${ALICE}:profile`)).toBeNull()
  })

  it('SECONDARY (no legacyKeyPrefix) starts EMPTY and leaves the legacy key untouched', async () => {
    localStorage.setItem(`${LEGACY}${ALICE}:profile`, '9')

    const secondary = new LocalProfileVersionCache(KEY_B)
    expect(await secondary.getLastSeenVersion(ALICE, 'profile')).toBeUndefined()
    // Secondary never touches the legacy key (it belongs to the primary).
    expect(localStorage.getItem(`${LEGACY}${ALICE}:profile`)).toBe('9')
  })
})
