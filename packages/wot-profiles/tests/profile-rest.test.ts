import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { IdentityWorkflow, type PublicIdentitySession } from '../../wot-core/src/application/identity'
import { WebCryptoProtocolCryptoAdapter } from '../../wot-core/src/adapters/protocol-crypto'
import { ProfileServer } from '../src/server.js'

const PORT = 9877
const BASE_URL = `http://localhost:${PORT}`

describe('Profile REST API', () => {
  let server: ProfileServer
  let identity: PublicIdentitySession
  let did: string

  beforeAll(async () => {
    // Start server
    server = new ProfileServer({ port: PORT, dbPath: ':memory:' })
    await server.start()

    // Create identity for signing
    const result = await new IdentityWorkflow({
      crypto: new WebCryptoProtocolCryptoAdapter(),
    }).createIdentity({
      passphrase: 'test-passphrase',
      storeSeed: false,
    })
    identity = result.identity
    did = identity.getDid()
  })

  afterAll(async () => {
    await server.stop()
  })

  // Per-resource monotonic version counters. The server now enforces a mandatory
  // non-negative integer `version` plus strict monotonicity (review MAJOR 1), so
  // every PUT in this suite — which all share a single DID — must carry a strictly
  // increasing version per resource.
  const versions = { profile: 0, v: 0, a: 0 }
  function nextVersion(resource: 'profile' | 'v' | 'a'): number {
    versions[resource] += 1
    return versions[resource]
  }

  async function createSignedProfile(
    profileDid: string,
    name: string,
  ): Promise<string> {
    // Spec-conformant profile resource (Sync 004 Z.132-140): did, mandatory
    // integer version, structured didDocument (id === did), profile.name, updatedAt.
    const profile = {
      did: profileDid,
      version: nextVersion('profile'),
      didDocument: {
        id: profileDid,
        verificationMethod: [],
        authentication: [],
        assertionMethod: [],
        keyAgreement: [],
      },
      profile: { name },
      updatedAt: new Date().toISOString(),
    }
    return identity.signJws(profile)
  }

  // List resources (`/v`, `/a`) carry a list of compact-JWS VC strings (Sync 004
  // Z.142). The server validates only the wire shape (3 base64url segments), not
  // individual VC semantics — per-item VC verification is the client's job — so a
  // syntactically valid compact-JWS placeholder is sufficient for these REST tests.
  function jwsItem(tag: string): string {
    const seg = (s: string) => Buffer.from(s).toString('base64url')
    return `${seg(`{"h":"${tag}"}`)}.${seg(`{"p":"${tag}"}`)}.${seg(`sig-${tag}`)}`
  }

  describe('PUT /p/{did}', () => {
    it('should accept valid JWS and return 200', async () => {
      const jws = await createSignedProfile(did, 'Alice')
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(200)
    })

    it('should reject mismatched DID (payload.did ≠ URL DID) with 403', async () => {
      const jws = await createSignedProfile(did, 'Alice')
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent('did:key:z6MkOtherDid123')}`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(403)
    })

    it('should reject invalid JWS with 400', async () => {
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
        method: 'PUT',
        body: 'not-a-valid-jws',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(400)
    })

    it('should reject empty body with 400', async () => {
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
        method: 'PUT',
        body: '',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /p/{did}', () => {
    it('should return stored JWS', async () => {
      const jws = await createSignedProfile(did, 'Alice Updated')
      await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })

      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe(jws)
    })

    it('should return 404 for unknown DID', async () => {
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent('did:key:z6MkNobody123')}`)
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /p/{did}/v (verifications)', () => {
    it('should accept valid JWS and return 200', async () => {
      const payload = {
        did,
        version: nextVersion('v'),
        verifications: [jwsItem('v1')],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/v`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(200)
    })

    it('should reject mismatched DID with 403', async () => {
      const payload = {
        did,
        version: nextVersion('v'),
        verifications: [],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent('did:key:z6MkOther')}/v`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(403)
    })
  })

  describe('GET /p/{did}/v (verifications)', () => {
    it('should return stored JWS', async () => {
      const payload = {
        did,
        version: nextVersion('v'),
        verifications: [jwsItem('v2')],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/v`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })

      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/v`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe(jws)
    })

    it('should return 404 for unknown DID', async () => {
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent('did:key:z6MkNobody')}/v`)
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /p/{did}/a (attestations)', () => {
    it('should accept valid JWS and return 200', async () => {
      const payload = {
        did,
        version: nextVersion('a'),
        attestations: [jwsItem('a1')],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/a`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(200)
    })

    it('should reject mismatched DID with 403', async () => {
      const payload = {
        did,
        version: nextVersion('a'),
        attestations: [],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent('did:key:z6MkOther')}/a`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(403)
    })
  })

  describe('GET /p/{did}/a (attestations)', () => {
    it('should return stored JWS', async () => {
      const payload = {
        did,
        version: nextVersion('a'),
        attestations: [jwsItem('a2')],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/a`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })

      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/a`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe(jws)
    })

    it('should return 404 for unknown DID', async () => {
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent('did:key:z6MkNobody')}/a`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /s (batch summaries)', () => {
    it('should return summaries for known DIDs', async () => {
      // The beforeAll + earlier tests already stored profile, verifications, attestations for `did`
      const res = await fetch(`${BASE_URL}/s?dids=${encodeURIComponent(did)}`)
      expect(res.status).toBe(200)
      const summaries = await res.json()
      expect(summaries).toHaveLength(1)
      expect(summaries[0].did).toBe(did)
      expect(summaries[0].name).toBeTruthy()
      expect(summaries[0].verificationCount).toBeGreaterThan(0)
      expect(summaries[0].attestationCount).toBeGreaterThan(0)
    })

    it('should return name=null and counts=0 for unknown DIDs', async () => {
      const unknownDid = 'did:key:z6MkUnknown123'
      const res = await fetch(`${BASE_URL}/s?dids=${encodeURIComponent(unknownDid)}`)
      expect(res.status).toBe(200)
      const summaries = await res.json()
      expect(summaries).toHaveLength(1)
      expect(summaries[0].did).toBe(unknownDid)
      expect(summaries[0].name).toBeNull()
      expect(summaries[0].verificationCount).toBe(0)
      expect(summaries[0].attestationCount).toBe(0)
    })

    it('should handle mixed known and unknown DIDs', async () => {
      const unknownDid = 'did:key:z6MkNobody456'
      const dids = [did, unknownDid].map(d => encodeURIComponent(d)).join(',')
      const res = await fetch(`${BASE_URL}/s?dids=${dids}`)
      expect(res.status).toBe(200)
      const summaries = await res.json()
      expect(summaries).toHaveLength(2)

      const known = summaries.find((s: any) => s.did === did)
      const unknown = summaries.find((s: any) => s.did === unknownDid)
      expect(known.name).toBeTruthy()
      expect(unknown.name).toBeNull()
      expect(unknown.verificationCount).toBe(0)
    })

    it('should reflect updated counts after attestation change', async () => {
      // Get current count
      const before = await fetch(`${BASE_URL}/s?dids=${encodeURIComponent(did)}`)
      const beforeData = await before.json()
      const countBefore = beforeData[0].attestationCount

      // Publish new attestations (replacing the old ones)
      const payload = {
        did,
        version: nextVersion('a'),
        attestations: [jwsItem('a10'), jwsItem('a11'), jwsItem('a12')],
        updatedAt: new Date().toISOString(),
      }
      const jws = await identity.signJws(payload)
      await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/a`, {
        method: 'PUT',
        body: jws,
        headers: { 'Content-Type': 'text/plain' },
      })

      // Count should now be 3
      const after = await fetch(`${BASE_URL}/s?dids=${encodeURIComponent(did)}`)
      const afterData = await after.json()
      expect(afterData[0].attestationCount).toBe(3)

      // Publish with fewer attestations (simulating retraction)
      const reduced = {
        did,
        version: nextVersion('a'),
        attestations: [jwsItem('a10')],
        updatedAt: new Date().toISOString(),
      }
      const jwsReduced = await identity.signJws(reduced)
      await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/a`, {
        method: 'PUT',
        body: jwsReduced,
        headers: { 'Content-Type': 'text/plain' },
      })

      // Count should now be 1
      const final = await fetch(`${BASE_URL}/s?dids=${encodeURIComponent(did)}`)
      const finalData = await final.json()
      expect(finalData[0].attestationCount).toBe(1)
    })

    it('should return 400 for missing dids parameter', async () => {
      const res = await fetch(`${BASE_URL}/s`)
      expect(res.status).toBe(400)
    })

    it('should return 400 for empty dids parameter', async () => {
      const res = await fetch(`${BASE_URL}/s?dids=`)
      expect(res.status).toBe(400)
    })
  })

  describe('CORS', () => {
    it('should include Access-Control-Allow-Origin header', async () => {
      const res = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })
  })
})
