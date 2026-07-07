import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpDiscoveryAdapter } from '../src/adapters/discovery/HttpDiscoveryAdapter'
import {
  LocalProfilePublishVersionStore,
  ProfileResourceRollbackError,
  type ProfilePublishVersionStore,
  type ProfileVersionCache,
  type PublicAttestationsData,
  type PublicVerificationsData,
} from '../src/ports/DiscoveryAdapter'
import { AttestationWorkflow, VerificationWorkflow } from '../src/application'
import { createProfilePublicationWorkflow } from '../src/application/discovery'
import type { Attestation } from '../src/types/attestation'
import type { PublicIdentitySession } from '../src/application/identity'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'

const crypto = new WebCryptoProtocolCryptoAdapter()

/** Resource-dimensional in-memory version cache (resolve-side rollback baseline). */
function createVersionCache(): ProfileVersionCache {
  const versions = new Map<string, number>()
  const key = (did: string, resource: string) => `${did}:${resource}`
  return {
    async getLastSeenVersion(did, resource) {
      return versions.get(key(did, resource))
    },
    async setLastSeenVersion(did, resource, version) {
      versions.set(key(did, resource), version)
    },
  }
}

/**
 * Round-trip server stub keyed by URL path. PUT stores the JWS body for the
 * matching `/p/{did}/{a|v}` route; GET replays it. This is the same fetch-stub
 * mechanism the existing HttpDiscoveryAdapter tests use — no new infra invented.
 */
function createRoundtripServer() {
  const store = new Map<string, string>()
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (init?.method === 'PUT') {
      store.set(path, String(init.body))
      return new Response(null, { status: 200 })
    }
    const body = store.get(path)
    if (body === undefined) return new Response(null, { status: 404 })
    return new Response(body, { status: 200 })
  })
  return { fetchMock, store }
}

/** A plain `WotAttestation` (lands in `/a`), issued BY `issuer` ABOUT `holder`. */
async function makePlainAttestation(issuer: PublicIdentitySession, holderDid: string): Promise<Attestation> {
  const workflow = new AttestationWorkflow({ crypto })
  return workflow.createAttestation({ issuer, subjectDid: holderDid, claim: 'hilft im Garten' })
}

/** A `WotVerification` attestation (lands in `/v`), issued BY `issuer` ABOUT `holder`. */
async function makeVerificationAttestation(issuer: PublicIdentitySession, holderDid: string): Promise<Attestation> {
  const workflow = new VerificationWorkflow({ crypto })
  return workflow.createVerificationAttestation({ issuer, subjectDid: holderDid, challengeNonce: 'nonce-0' })
}

describe('HttpDiscoveryAdapter /a wire roundtrip (Pflicht-Test 1)', () => {
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession

  beforeEach(async () => {
    holder = (await createTestIdentity('step3-holder-a')).identity
    issuer = (await createTestIdentity('step3-issuer-a')).identity
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('publishes compact VC-JWS strings and resolves identical Attestation fields', async () => {
    const { fetchMock, store } = createRoundtripServer()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new HttpDiscoveryAdapter(
      'https://profiles.example',
      createVersionCache(),
      undefined,
      crypto,
    )
    const did = holder.getDid()
    const attestation = await makePlainAttestation(issuer, did)
    const data: PublicAttestationsData = { did, attestations: [attestation], updatedAt: '2026-05-18T10:43:25.976Z' }

    await adapter.publishAttestations(data, holder)

    // On the wire: only compact JWS strings, never the structured `claim` object.
    const putBody = store.get(`/p/${encodeURIComponent(did)}/a`)!
    const wirePayload = JSON.parse(new TextDecoder().decode(decodeJwsPayload(putBody)))
    expect(Array.isArray(wirePayload.attestations)).toBe(true)
    expect(typeof wirePayload.attestations[0]).toBe('string')
    expect(wirePayload.attestations[0]).toBe(attestation.vcJws)
    expect(putBody).not.toContain('"claim"')

    const resolved = await adapter.resolveAttestations(did)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      id: attestation.id,
      from: attestation.from,
      to: attestation.to,
      claim: attestation.claim,
      createdAt: attestation.createdAt,
      vcJws: attestation.vcJws,
    })
  })
})

describe('HttpDiscoveryAdapter /v wire roundtrip + disjoint split (Pflicht-Test 2)', () => {
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession

  beforeEach(async () => {
    holder = (await createTestIdentity('step3-holder-v')).identity
    issuer = (await createTestIdentity('step3-issuer-v')).identity
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a WotVerification lands in /v and is rejected from /a; a plain attestation vice versa', async () => {
    const { fetchMock } = createRoundtripServer()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)
    const did = holder.getDid()

    const verification = await makeVerificationAttestation(issuer, did)
    const plain = await makePlainAttestation(issuer, did)

    // Publish the verification to /v and the plain attestation to /a.
    await adapter.publishVerifications({ did, verifications: [verification], updatedAt: '2026-05-18T10:43:25.976Z' } as PublicVerificationsData, holder)
    await adapter.publishAttestations({ did, attestations: [plain], updatedAt: '2026-05-18T10:43:25.976Z' }, holder)

    const v = await adapter.resolveVerifications(did)
    const a = await adapter.resolveAttestations(did)
    expect(v.map(x => x.id)).toEqual([verification.id])
    expect(a.map(x => x.id)).toEqual([plain.id])

    // Now cross-publish: put the verification into /a — resolve must reject it (split lesend).
    await adapter.publishAttestations({ did, attestations: [verification], updatedAt: '2026-05-18T10:43:26.976Z' }, holder)
    expect(await adapter.resolveAttestations(did)).toEqual([])

    // And put the plain attestation into /v — resolve must reject it too.
    await adapter.publishVerifications({ did, verifications: [plain], updatedAt: '2026-05-18T10:43:26.976Z' } as PublicVerificationsData, holder)
    expect(await adapter.resolveVerifications(did)).toEqual([])
  })
})

describe('HttpDiscoveryAdapter publish 409 retry (Pflicht-Test 6)', () => {
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession

  beforeEach(async () => {
    holder = (await createTestIdentity('step3-holder-409')).identity
    issuer = (await createTestIdentity('step3-issuer-409')).identity
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries exactly once with serverVersion+1 after a 409, then succeeds (no loop)', async () => {
    const did = holder.getDid()
    const attestation = await makePlainAttestation(issuer, did)
    const putBodies: string[] = []
    // Local counter starts at 3 (peek === 3); server knows v9 → first PUT (v4) → 409{9}.
    const publishVersions: ProfilePublishVersionStore = new LocalProfilePublishVersionStore(`wot:test-pub-${did}:`)
    await publishVersions.next(did, 'attestations') // 1
    await publishVersions.next(did, 'attestations') // 2
    await publishVersions.next(did, 'attestations') // 3 (now peek === 3)

    let putCount = 0
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCount += 1
        putBodies.push(String(init.body))
        if (putCount === 1) {
          return new Response(JSON.stringify({ version: 9 }), { status: 409 })
        }
        return new Response(null, { status: 200 })
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto, publishVersions)
    await adapter.publishAttestations({ did, attestations: [attestation], updatedAt: '2026-05-18T10:43:25.976Z' }, holder)

    expect(putCount).toBe(2) // exactly one retry, no loop
    const retryPayload = JSON.parse(new TextDecoder().decode(decodeJwsPayload(putBodies[1])))
    expect(retryPayload.version).toBe(10) // serverVersion(9) + 1
    expect(await publishVersions.peek(did, 'attestations')).toBe(10)
  })

  it('surfaces the error when the 409 retry also fails (single retry, then throws)', async () => {
    const did = holder.getDid()
    const attestation = await makePlainAttestation(issuer, did)
    let putCount = 0
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCount += 1
        return new Response(JSON.stringify({ version: 9 }), { status: 409 })
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto, new LocalProfilePublishVersionStore(`wot:test-pub2-${did}:`))
    await expect(adapter.publishAttestations({ did, attestations: [attestation], updatedAt: '2026-05-18T10:43:25.976Z' }, holder)).rejects.toThrow()
    expect(putCount).toBe(2) // original + exactly one retry
  })
})

describe('HttpDiscoveryAdapter item hardening (Pflicht-Test 7)', () => {
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession
  let other: PublicIdentitySession

  beforeEach(async () => {
    holder = (await createTestIdentity('step3-holder-hard')).identity
    issuer = (await createTestIdentity('step3-issuer-hard')).identity
    other = (await createTestIdentity('step3-other-hard')).identity
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the valid item and skips a tampered VC-JWS (warn, no DoS)', async () => {
    const did = holder.getDid()
    const valid = await makePlainAttestation(issuer, did)
    const tampered = tamperJwsPayload(valid.vcJws)
    // Owner-signed ListResource carrying one good + one tampered item.
    const jws = await holder.signJws({ did, version: 1, attestations: [valid.vcJws, tampered], updatedAt: '2026-05-18T10:43:25.976Z' })
    const fetchMock = vi.fn().mockResolvedValue(new Response(jws, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)
    const resolved = await adapter.resolveAttestations(did)
    expect(resolved.map(x => x.id)).toEqual([valid.id])
    expect(warn).toHaveBeenCalled()
  })

  it('returns [] for an invalid owner JWS', async () => {
    const did = holder.getDid()
    const fetchMock = vi.fn().mockResolvedValue(new Response('not.a.jws', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)
    expect(await adapter.resolveAttestations(did)).toEqual([])
  })

  it('skips an item whose subject (attestation.to) is not the resource DID', async () => {
    const did = holder.getDid()
    // Attestation ABOUT `other`, but the holder published it into THEIR own resource.
    const wrongSubject = await makePlainAttestation(issuer, other.getDid())
    const jws = await holder.signJws({ did, version: 1, attestations: [wrongSubject.vcJws], updatedAt: '2026-05-18T10:43:25.976Z' })
    const fetchMock = vi.fn().mockResolvedValue(new Response(jws, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)
    expect(await adapter.resolveAttestations(did)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})

describe('HttpDiscoveryAdapter per-resource client rollback (/v, /a)', () => {
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession

  beforeEach(async () => {
    holder = (await createTestIdentity('step3-holder-rb')).identity
    issuer = (await createTestIdentity('step3-issuer-rb')).identity
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects an older /a version after a newer one was seen', async () => {
    const did = holder.getDid()
    const att = await makePlainAttestation(issuer, did)
    const jws7 = await holder.signJws({ did, version: 7, attestations: [att.vcJws], updatedAt: '2026-05-18T10:43:25.976Z' })
    const jws6 = await holder.signJws({ did, version: 6, attestations: [att.vcJws], updatedAt: '2026-05-18T10:43:25.976Z' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(jws7, { status: 200 }))
      .mockResolvedValueOnce(new Response(jws6, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)

    await expect(adapter.resolveAttestations(did)).resolves.toHaveLength(1)
    await expect(adapter.resolveAttestations(did)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
  })

  it('idempotency fast-path still detects rollback when a shared baseline advanced (Codex review #198)', async () => {
    const did = holder.getDid()
    const att = await makePlainAttestation(issuer, did)
    // The broker re-serves the SAME exact v5 JWS bytes both times.
    const jws5 = await holder.signJws({ did, version: 5, attestations: [att.vcJws], updatedAt: '2026-05-18T10:43:25.976Z' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(jws5, { status: 200 }))
      .mockResolvedValueOnce(new Response(jws5, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const cache = createVersionCache()
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', cache, undefined, crypto)

    // First resolve caches the verified JWS + version 5 and sets last-seen = 5.
    await expect(adapter.resolveAttestations(did)).resolves.toHaveLength(1)

    // Another tab/adapter sharing the (localStorage) baseline advances it to 6.
    await cache.setLastSeenVersion(did, 'attestations', 6)

    // The broker re-serves the SAME v5 JWS. The byte-identical fast-path matches,
    // but must NOT return the cached result — v5 < last-seen 6 is a rollback.
    await expect(adapter.resolveAttestations(did)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
  })

  it('rejects an older /v version with resource="verifications", independent of /a', async () => {
    const did = holder.getDid()
    const ver = await makeVerificationAttestation(issuer, did)
    const jws7 = await holder.signJws({ did, version: 7, verifications: [ver.vcJws], updatedAt: '2026-05-18T10:43:25.976Z' })
    const jws6 = await holder.signJws({ did, version: 6, verifications: [ver.vcJws], updatedAt: '2026-05-18T10:43:25.976Z' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(jws7, { status: 200 }))
      .mockResolvedValueOnce(new Response(jws6, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)

    await expect(adapter.resolveVerifications(did)).resolves.toHaveLength(1)
    await adapter.resolveVerifications(did).then(
      () => { throw new Error('expected rollback') },
      (err) => {
        expect(err).toBeInstanceOf(ProfileResourceRollbackError)
        expect((err as ProfileResourceRollbackError).resource).toBe('verifications')
      },
    )
  })
})

describe('HttpDiscoveryAdapter rollback independence across /p, /v, /a (Pflicht-Test 3)', () => {
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession

  beforeEach(async () => {
    holder = (await createTestIdentity('step4-holder-indep')).identity
    issuer = (await createTestIdentity('step4-issuer-indep')).identity
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('an /a rollback (v7→v6) does not block resolving /p or /v on the same adapter', async () => {
    const did = holder.getDid()
    const updatedAt = '2026-05-18T10:43:25.976Z'
    const workflow = createProfilePublicationWorkflow()
    const att = await makePlainAttestation(issuer, did)
    const ver = await makeVerificationAttestation(issuer, did)

    // Per-resource bodies. `/a` will be served v7 then v6 (rollback). `/p` and
    // `/v` stay at a stable version and must remain resolvable throughout —
    // proving each resource has its OWN independent rollback baseline (Z.181).
    const profileJws = await workflow.signProfile({ did, name: 'Alice', updatedAt }, holder, { version: 3 })
    const verJws = await holder.signJws({ did, version: 4, verifications: [ver.vcJws], updatedAt })
    const aJws7 = await holder.signJws({ did, version: 7, attestations: [att.vcJws], updatedAt })
    const aJws6 = await holder.signJws({ did, version: 6, attestations: [att.vcJws], updatedAt })

    let aGetCount = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/a')) {
        aGetCount += 1
        return new Response(aGetCount === 1 ? aJws7 : aJws6, { status: 200 })
      }
      if (path.endsWith('/v')) return new Response(verJws, { status: 200 })
      return new Response(profileJws, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new HttpDiscoveryAdapter('https://profiles.example', createVersionCache(), undefined, crypto)

    // First /a resolve seeds the baseline at v7.
    await expect(adapter.resolveAttestations(did)).resolves.toHaveLength(1)

    // The /a rollback throws — but /p and /v on the SAME adapter still resolve.
    await expect(adapter.resolveAttestations(did)).rejects.toBeInstanceOf(ProfileResourceRollbackError)
    await expect(adapter.resolveProfile(did)).resolves.toMatchObject({ version: 3, fromCache: false })
    await expect(adapter.resolveVerifications(did)).resolves.toHaveLength(1)
  })
})

// --- helpers ---

function decodeJwsPayload(jws: string): Uint8Array {
  return decodeBase64Url(jws.split('.')[1])
}

/** Flip a byte in the compact-JWS payload so the signature no longer verifies. */
function tamperJwsPayload(jws: string): string {
  const [header, payload, signature] = jws.split('.')
  const bytes = decodeBase64Url(payload)
  bytes[0] ^= 0xff
  return `${header}.${encodeBase64Url(bytes)}.${signature}`
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
