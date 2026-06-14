import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { IdentityWorkflow, type PublicIdentitySession } from '../../wot-core/src/application/identity'
import { AttestationWorkflow, VerificationWorkflow } from '../../wot-core/src/application'
import { WebCryptoProtocolCryptoAdapter } from '../../wot-core/src/adapters/protocol-crypto'
import { HttpDiscoveryAdapter } from '../../wot-core/src/adapters/discovery/HttpDiscoveryAdapter'
import {
  LocalProfilePublishVersionStore,
  type ProfileVersionCache,
} from '../../wot-core/src/ports/DiscoveryAdapter'
import { ProfileServer } from '../src/server.js'

/**
 * Echter End-zu-End-Roundtrip (Pflicht-Test 1/2 Vervollständigung): a real
 * publish → wot-profiles ProfileServer → resolve roundtrip for `/a` and `/v`,
 * traversing the REAL server-side version monotonicity (VE-4). Step 3 covered
 * the wire format against a fetch-stub; this exercises the actual server.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const PORT = 9890
const BASE_URL = `http://localhost:${PORT}`

/** Resource-dimensional in-memory version cache (resolve-side rollback baseline). */
function createVersionCache(): ProfileVersionCache {
  const versions = new Map<string, number>()
  const key = (did: string, resource: string) => `${did}:${resource}`
  return {
    async getLastSeenVersion(did, resource) { return versions.get(key(did, resource)) },
    async setLastSeenVersion(did, resource, version) { versions.set(key(did, resource), version) },
  }
}

async function createIdentity(passphrase: string): Promise<PublicIdentitySession> {
  const result = await new IdentityWorkflow({ crypto }).createIdentity({ passphrase, storeSeed: false })
  return result.identity
}

describe('wot-profiles real-server roundtrip for /a and /v (Pflicht-Test 1/2)', () => {
  let server: ProfileServer
  let holder: PublicIdentitySession
  let issuer: PublicIdentitySession
  let adapter: HttpDiscoveryAdapter

  beforeAll(async () => {
    server = new ProfileServer({ port: PORT, dbPath: ':memory:' })
    await server.start()
    holder = await createIdentity('roundtrip-holder')
    issuer = await createIdentity('roundtrip-issuer')
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    // Fresh adapter per test: independent publish-version counter + resolve cache.
    adapter = new HttpDiscoveryAdapter(
      BASE_URL,
      createVersionCache(),
      undefined,
      crypto,
      new LocalProfilePublishVersionStore(`wot:rt-${Math.random()}:`),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('publishes a plain attestation to /a and resolves identical fields through the real server', async () => {
    const did = holder.getDid()
    const attestation = await new AttestationWorkflow({ crypto }).createAttestation({
      issuer,
      subjectDid: did,
      claim: 'hilft im Garten',
    })

    await adapter.publishAttestations(
      { did, attestations: [attestation], updatedAt: new Date().toISOString() },
      holder,
    )

    const resolved = await adapter.resolveAttestations(did)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      id: attestation.id,
      from: attestation.from,
      to: attestation.to,
      claim: attestation.claim,
      vcJws: attestation.vcJws,
    })
  })

  it('publishes a verification to /v and resolves it (disjoint from /a) through the real server', async () => {
    const did = holder.getDid()
    const verification = await new VerificationWorkflow({ crypto }).createVerificationAttestation({
      issuer,
      subjectDid: did,
      challengeNonce: 'real-nonce-1',
    })

    await adapter.publishVerifications(
      { did, verifications: [verification], updatedAt: new Date().toISOString() },
      holder,
    )

    const v = await adapter.resolveVerifications(did)
    expect(v.map((x) => x.id)).toEqual([verification.id])
  })

  it('lets the real server-side monotonicity accept a second, higher-version publish', async () => {
    const did = holder.getDid()
    const a1 = await new AttestationWorkflow({ crypto }).createAttestation({ issuer, subjectDid: did, claim: 'one' })
    const a2 = await new AttestationWorkflow({ crypto }).createAttestation({ issuer, subjectDid: did, claim: 'two' })

    // First publish (version 1 from the local counter), then second publish
    // (version 2). The real server's monotonicity check (VE-4) must accept v2 > v1.
    await adapter.publishAttestations({ did, attestations: [a1], updatedAt: new Date().toISOString() }, holder)
    await adapter.publishAttestations({ did, attestations: [a1, a2], updatedAt: new Date().toISOString() }, holder)

    const resolved = await adapter.resolveAttestations(did)
    expect(resolved.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort())
  })

  it('triggers a real 409 + single retry when a stale local counter publishes below the server version', async () => {
    const did = holder.getDid()
    const att = await new AttestationWorkflow({ crypto }).createAttestation({ issuer, subjectDid: did, claim: 'stale-test' })

    // Advance the server to version 5 with an adapter whose counter starts at 5.
    const aheadVersions = new LocalProfilePublishVersionStore(`wot:rt-ahead-${Math.random()}:`)
    const aheadAdapter = new HttpDiscoveryAdapter(BASE_URL, createVersionCache(), undefined, crypto, aheadVersions)
    for (let i = 0; i < 4; i += 1) await aheadVersions.next(did, 'attestations') // counter now at 4, next() → 5
    await aheadAdapter.publishAttestations({ did, attestations: [att], updatedAt: new Date().toISOString() }, holder)

    // Now a fresh adapter with counter starting at 1 publishes — the server (now at
    // 5) returns 409{5}; the adapter reconciles to 6 and retries once → 200.
    const fresh = new HttpDiscoveryAdapter(
      BASE_URL,
      createVersionCache(),
      undefined,
      crypto,
      new LocalProfilePublishVersionStore(`wot:rt-fresh-${Math.random()}:`),
    )
    await expect(
      fresh.publishAttestations({ did, attestations: [att], updatedAt: new Date().toISOString() }, holder),
    ).resolves.toBeUndefined()
  })
})
