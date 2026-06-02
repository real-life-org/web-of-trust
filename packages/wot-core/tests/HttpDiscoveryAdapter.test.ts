import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpDiscoveryAdapter } from '../src/adapters/discovery/HttpDiscoveryAdapter'
import { ProfileService } from '../src/services/ProfileService'
import type { PublicAttestationsData } from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { IdentitySession } from '../src/types/identity-session'

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
