import { describe, it, expect, beforeAll } from 'vitest'
import { IdentityWorkflow, AttestationWorkflow, VerificationWorkflow } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { IdentitySession, Attestation } from '@web_of_trust/core/types'
import { isVerificationAttestation } from '../src/lib/verification-attestation'

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
})
