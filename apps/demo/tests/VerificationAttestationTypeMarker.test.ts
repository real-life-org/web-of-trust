import { describe, it, expect, beforeAll } from 'vitest'
import { IdentityWorkflow, AttestationWorkflow, VerificationWorkflow } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { IdentitySession, Attestation } from '@web_of_trust/core/types'
import { isVerificationAttestation } from '../src/lib/verification-attestation'
import { attestationFromDoc } from '../src/adapters/AutomergeStorageAdapter'
import type { AttestationDoc } from '@web_of_trust/adapter-automerge'
import { AutomergeGraphCacheStore } from '../src/adapters/AutomergeGraphCacheStore'
import type { LocalCacheStore } from '../src/adapters/LocalCacheStore'

/**
 * Review MAJOR 2: the demo must classify verifications by the WotVerification
 * `type` marker, NOT by the spoofable `claim` text.
 *
 * Attack vector: a validly signed ordinary WotAttestation whose `type` array
 * does NOT contain `WotVerification`, but whose human `claim` is exactly
 * 'in-person verifiziert'. A claim-based predicate wrongly classifies it as a
 * live verification (fake trust badge). The type-borne predicate MUST NOT.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const attestationWorkflow = new AttestationWorkflow({ crypto })
const verificationWorkflow = new VerificationWorkflow({ crypto })

async function makeIdentity(): Promise<IdentitySession> {
  const { identity } = await new IdentityWorkflow({ crypto }).createIdentity({ storeSeed: false })
  return identity
}

describe('demo isVerificationAttestation — type-borne classification (review MAJOR 2)', () => {
  let realVerification: Attestation
  let spoof: Attestation

  beforeAll(async () => {
    const issuer = await makeIdentity()
    const subject = await makeIdentity()

    // A genuine live verification: its VC `type` array carries WotVerification.
    realVerification = await verificationWorkflow.createVerificationAttestation({
      issuer,
      subjectDid: subject.getDid(),
      challengeNonce: 'a1b2c3d4-e5f6-4789-abcd-1234567890ab',
    })

    // The attack: an ordinary attestation whose claim is the EXACT display label
    // but whose VC `type` does NOT contain WotVerification.
    spoof = await attestationWorkflow.createAttestation({
      issuer,
      subjectDid: subject.getDid(),
      claim: 'in-person verifiziert',
    })
  })

  it('classifies a real WotVerification attestation as a verification', () => {
    expect(isVerificationAttestation(realVerification)).toBe(true)
  })

  it('does NOT classify a spoof (magic claim, no WotVerification type) as a verification', () => {
    // Precondition: the spoof carries the exact display label that a claim-based
    // predicate would key off.
    expect(spoof.claim).toBe('in-person verifiziert')
    expect(isVerificationAttestation(spoof)).toBe(false)
  })

  /**
   * Review BLOCKER: the `isVerification` marker is NOT separately persisted in
   * the Personal-Doc `AttestationDoc` schema. `attestationFromDoc` must
   * re-derive it from the stored `vcJws`, so a stored verification survives the
   * storage round-trip / reload and is still classified correctly — and the
   * spoof still is not, even after persistence.
   */
  describe('survives the storage round-trip (attestationFromDoc re-derives from vcJws)', () => {
    // Build the AttestationDoc exactly as saveAttestation persists it — note it
    // carries NO `isVerification` field (the schema has none).
    const toDoc = (att: Attestation): AttestationDoc => ({
      id: att.id,
      attestationId: att.id,
      fromDid: att.from,
      toDid: att.to,
      claim: att.claim,
      tagsJson: att.tags ? JSON.stringify(att.tags) : null,
      context: att.context ?? null,
      createdAt: att.createdAt,
      vcJws: att.vcJws as string,
    })

    it('reconstructs a verification from its stored doc as a verification', () => {
      const reloaded = attestationFromDoc(toDoc(realVerification))
      expect(reloaded.isVerification).toBe(true)
      expect(isVerificationAttestation(reloaded)).toBe(true)
    })

    it('does not promote a stored spoof to a verification after reload', () => {
      const reloaded = attestationFromDoc(toDoc(spoof))
      expect(isVerificationAttestation(reloaded)).toBe(false)
    })
  })

  /**
   * Codex review #198: the GraphCache /v fallback (offline) reconstructs cached
   * verification attestations WITHOUT a persisted isVerification field.
   * `mapSubjectDocs` must re-derive it from the cached vcJws — otherwise
   * OfflineFirstDiscoveryAdapter.resolveVerifications() would hand consumers /v
   * data that classifies as non-verification (lost trust badge offline).
   */
  describe('GraphCache /v fallback keeps the verification marker (Codex review #198)', () => {
    // Minimal in-memory LocalCacheStore stand-in — cacheEntry only fire-and-forget
    // persists via set(); getCached* read from the in-memory maps.
    const fakeStore = { set: () => Promise.resolve() } as unknown as LocalCacheStore

    it('classifies a cached /v verification as a verification', async () => {
      const cache = new AutomergeGraphCacheStore(fakeStore)
      await cache.cacheEntry(realVerification.to, {
        profile: null,
        attestations: [],
        verifications: [realVerification],
      })
      const cachedV = await cache.getCachedVerifications(realVerification.to)
      expect(cachedV).toHaveLength(1)
      expect(isVerificationAttestation(cachedV[0])).toBe(true)
    })

    it('does not promote a cached /a spoof to a verification', async () => {
      const cache = new AutomergeGraphCacheStore(fakeStore)
      await cache.cacheEntry(spoof.to, {
        profile: null,
        attestations: [spoof],
        verifications: [],
      })
      const cachedA = await cache.getCachedAttestations(spoof.to)
      expect(cachedA).toHaveLength(1)
      expect(isVerificationAttestation(cachedA[0])).toBe(false)
    })
  })
})
