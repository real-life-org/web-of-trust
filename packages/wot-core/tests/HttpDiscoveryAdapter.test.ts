import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpDiscoveryAdapter } from '../src/adapters/discovery/HttpDiscoveryAdapter'
import { ProfileService } from '../src/services/ProfileService'
import {
  ProfileResourceRollbackError,
  type ProfileVersionCache,
  type PublicAttestationsData,
} from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { IdentitySession } from '../src/types/identity-session'
import type { Attestation } from '../src/types/attestation'
import { createTestIdentity } from './helpers/identity-session'

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

// Minimal identity stub — only signJws is exercised by publishAttestations.
const MOCK_IDENTITY = {
  signJws: vi.fn().mockResolvedValue('signed.jws.payload'),
} as unknown as IdentitySession

/** Extract the Content-Type header from a fetch RequestInit, regardless of shape. */
function contentTypeOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.['Content-Type']
}

function createVersionCache(): ProfileVersionCache {
  const versions = new Map<string, number>()
  return {
    async getLastSeenProfileVersion(did: string) {
      return versions.get(did)
    },
    async setLastSeenProfileVersion(did: string, version: number) {
      versions.set(did, version)
    },
  }
}

describe('HttpDiscoveryAdapter Content-Type', () => {
  let adapter: HttpDiscoveryAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new HttpDiscoveryAdapter('https://profiles.example')
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(ProfileService, 'signProfile').mockResolvedValue('signed.profile.jws')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('publishProfile PUTs with Content-Type application/jws', async () => {
    await adapter.publishProfile(TEST_PROFILE, MOCK_IDENTITY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('PUT')
    expect(contentTypeOf(init)).toBe('application/jws')
  })

  it('publishAttestations PUTs with Content-Type application/jws (same as publishProfile)', async () => {
    await adapter.publishAttestations(TEST_ATTESTATIONS, MOCK_IDENTITY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/p/${encodeURIComponent(ALICE_DID)}/a`)
    expect(init.method).toBe('PUT')
    expect(contentTypeOf(init)).toBe('application/jws')
  })

  it('uses the same Content-Type for profile and attestations uploads', async () => {
    await adapter.publishProfile(TEST_PROFILE, MOCK_IDENTITY)
    await adapter.publishAttestations(TEST_ATTESTATIONS, MOCK_IDENTITY)

    const profileCt = contentTypeOf(fetchMock.mock.calls[0][1])
    const attestationsCt = contentTypeOf(fetchMock.mock.calls[1][1])
    expect(attestationsCt).toBe(profileCt)
    expect(attestationsCt).toBe('application/jws')
  })
})

describe('HttpDiscoveryAdapter profile rollback detection', () => {
  let adapter: HttpDiscoveryAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache())
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('signed.profile.jws', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects an older profile resource version after a newer one was seen', async () => {
    vi.spyOn(ProfileService, 'verifyProfile')
      .mockResolvedValueOnce({
        valid: true,
        profile: TEST_PROFILE,
        version: 7,
      })
      .mockResolvedValueOnce({
        valid: true,
        profile: { ...TEST_PROFILE, name: 'Alice stale' },
        version: 6,
      })

    await expect(adapter.resolveProfile(ALICE_DID)).resolves.toMatchObject({
      profile: TEST_PROFILE,
      version: 7,
      fromCache: false,
    })

    await expect(adapter.resolveProfile(ALICE_DID)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('HttpDiscoveryAdapter DID/path consistency', () => {
  let adapter: HttpDiscoveryAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache())
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects a valid profile JWS whose payload DID differs from the requested path DID', async () => {
    const { identity: alice } = await createTestIdentity('http-profile-path-alice')
    const { identity: bob } = await createTestIdentity('http-profile-path-bob')
    const bobProfile: PublicProfile = {
      did: bob.getDid(),
      name: 'Bob',
      updatedAt: '2026-06-04T00:00:00.000Z',
    }
    const bobJws = await ProfileService.signProfile(bobProfile, bob, { version: 1 })
    fetchMock.mockResolvedValue(new Response(bobJws, { status: 200 }))

    const result = await adapter.resolveProfile(alice.getDid())

    expect(result).toMatchObject({ profile: null, fromCache: false })
    expect(result.didDocument).toBeNull()
    expect(result.version).toBeUndefined()
  })

  it('rejects a valid attestations JWS whose payload DID differs from the requested path DID', async () => {
    const { identity: alice } = await createTestIdentity('http-attestations-path-alice')
    const { identity: bob } = await createTestIdentity('http-attestations-path-bob')
    const bobAttestation: Attestation = {
      id: 'att-1',
      from: alice.getDid(),
      to: bob.getDid(),
      claim: 'Zuverlässig',
      createdAt: '2026-06-04T00:00:00.000Z',
      vcJws: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJib2IifQ.sig',
    }
    const bobJws = await bob.signJws({
      did: bob.getDid(),
      attestations: [bobAttestation],
      updatedAt: '2026-06-04T00:00:00.000Z',
    } satisfies PublicAttestationsData)
    fetchMock.mockResolvedValue(new Response(bobJws, { status: 200 }))

    await expect(adapter.resolveAttestations(alice.getDid())).resolves.toEqual([])
  })
})
