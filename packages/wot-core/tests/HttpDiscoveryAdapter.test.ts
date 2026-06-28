import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpDiscoveryAdapter } from '../src/adapters/discovery/HttpDiscoveryAdapter'
import { createProfilePublicationWorkflow } from '../src/application/discovery'
import {
  ProfileResourceRollbackError,
  type ProfileVersionCache,
  type PublicAttestationsData,
} from '../src/ports/DiscoveryAdapter'
import type { PublicProfile } from '../src/types/identity'
import type { PublicIdentitySession } from '../src/application/identity'
import { createTestIdentity } from './helpers/identity-session'

/** Extract the Content-Type header from a fetch RequestInit, regardless of shape. */
function contentTypeOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.['Content-Type']
}

function createVersionCache(): ProfileVersionCache {
  const versions = new Map<string, number>()
  const key = (did: string, resource: string) => `${did}:${resource}`
  return {
    async getLastSeenVersion(did: string, resource) {
      return versions.get(key(did, resource))
    },
    async setLastSeenVersion(did: string, resource, version: number) {
      versions.set(key(did, resource), version)
    },
  }
}

describe('HttpDiscoveryAdapter Content-Type', () => {
  let adapter: HttpDiscoveryAdapter
  let identity: PublicIdentitySession
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    identity = (await createTestIdentity('http-discovery-content-type')).identity
    adapter = new HttpDiscoveryAdapter('https://profiles.example')
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('publishProfile PUTs with Content-Type application/jws', async () => {
    const profile: PublicProfile = { did: identity.getDid(), name: 'Alice', updatedAt: new Date().toISOString() }
    await adapter.publishProfile(profile, identity)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('PUT')
    expect(contentTypeOf(init)).toBe('application/jws')
  })

  it('publishAttestations PUTs with Content-Type application/jws (same as publishProfile)', async () => {
    const attestations: PublicAttestationsData = { did: identity.getDid(), attestations: [], updatedAt: new Date().toISOString() }
    await adapter.publishAttestations(attestations, identity)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/p/${encodeURIComponent(identity.getDid())}/a`)
    expect(init.method).toBe('PUT')
    expect(contentTypeOf(init)).toBe('application/jws')
  })

  it('uses the same Content-Type for profile and attestations uploads', async () => {
    const profile: PublicProfile = { did: identity.getDid(), name: 'Alice', updatedAt: new Date().toISOString() }
    const attestations: PublicAttestationsData = { did: identity.getDid(), attestations: [], updatedAt: new Date().toISOString() }
    await adapter.publishProfile(profile, identity)
    await adapter.publishAttestations(attestations, identity)

    const profileCt = contentTypeOf(fetchMock.mock.calls[0][1])
    const attestationsCt = contentTypeOf(fetchMock.mock.calls[1][1])
    expect(attestationsCt).toBe(profileCt)
    expect(attestationsCt).toBe('application/jws')
  })
})

describe('HttpDiscoveryAdapter profile rollback detection', () => {
  let adapter: HttpDiscoveryAdapter
  let identity: PublicIdentitySession
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    identity = (await createTestIdentity('http-discovery-rollback')).identity
    adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects an older profile resource version after a newer one was seen', async () => {
    const workflow = createProfilePublicationWorkflow()
    const did = identity.getDid()
    const updatedAt = '2026-05-18T10:43:25.976Z'
    const jws7 = await workflow.signProfile({ did, name: 'Alice', updatedAt }, identity, { version: 7 })
    const jws6 = await workflow.signProfile({ did, name: 'Alice stale', updatedAt }, identity, { version: 6 })

    fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(jws7, { status: 200 }))
      .mockResolvedValueOnce(new Response(jws6, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(adapter.resolveProfile(did)).resolves.toMatchObject({ version: 7, fromCache: false })
    await expect(adapter.resolveProfile(did)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('HttpDiscoveryAdapter resolve', () => {
  let adapter: HttpDiscoveryAdapter
  let identity: PublicIdentitySession
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    identity = (await createTestIdentity('http-discovery-resolve')).identity
    adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // VE-1 breaking migration (Step 3): the old structured `Attestation[]` wire form
  // is no longer a valid ListResource (items MUST be compact VC-JWS strings,
  // Sync 004 Z.106-126). Such legacy payloads now fail owner-JWS schema validation
  // and resolve to [] + a warning — the next publish overwrites them. The positive
  // wire-roundtrip + split coverage lives in DiscoveryStep3Wire.test.ts.
  it('resolveAttestations returns [] for the legacy structured wire form (VE-1 breaking)', async () => {
    const did = identity.getDid()
    const updatedAt = '2026-05-18T10:43:25.976Z'
    const attestations = [
      { id: 'att-1', type: 'knows', from: did, to: 'did:key:zPeer1', createdAt: updatedAt },
      { id: 'att-2', type: 'trusts', from: did, to: 'did:key:zPeer2', createdAt: updatedAt },
    ]
    const jws = await identity.signJws({ did, version: 1, attestations, updatedAt })
    fetchMock = vi.fn().mockResolvedValue(new Response(jws, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await adapter.resolveAttestations(did)).toEqual([])
  })

  it('resolveAttestations returns [] when the payload signature is invalid', async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response('not.a.jws', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await adapter.resolveAttestations(identity.getDid())).toEqual([])
  })

  it('resolveAttestations returns [] for a signed payload whose attestations field is not an array', async () => {
    const did = identity.getDid()
    const jws = await identity.signJws({ did, version: 1, attestations: 'not-an-array', updatedAt: '2026-05-18T10:43:25.976Z' })
    fetchMock = vi.fn().mockResolvedValue(new Response(jws, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await adapter.resolveAttestations(did)).toEqual([])
  })

  it('resolveProfile returns { profile: null } when verification fails', async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response('not.a.jws', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await adapter.resolveProfile(identity.getDid())).toEqual({ profile: null, fromCache: false })
  })
})
