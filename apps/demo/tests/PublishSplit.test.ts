import { describe, it, expect, beforeAll } from 'vitest'
import { IdentityWorkflow, AttestationWorkflow, VerificationWorkflow } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { IdentitySession, Attestation } from '@web_of_trust/core/types'
import { splitAcceptedAttestations } from '../src/lib/publish-split'

const crypto = new WebCryptoProtocolCryptoAdapter()
const attestationWorkflow = new AttestationWorkflow({ crypto })
const verificationWorkflow = new VerificationWorkflow({ crypto })

async function makeIdentity(): Promise<IdentitySession> {
  const wf = new IdentityWorkflow({ crypto })
  const { identity } = await wf.createIdentity({ storeSeed: false })
  return identity
}

describe('splitAcceptedAttestations — type-based disjoint publish-split (VE-2/VE-7)', () => {
  let issuer: IdentitySession
  let subject: IdentitySession
  let verification: Attestation
  let generic: Attestation

  beforeAll(async () => {
    issuer = await makeIdentity()
    subject = await makeIdentity()

    // A real WotVerification-marked attestation (`type` carries WotVerification).
    verification = await verificationWorkflow.createVerificationAttestation({
      issuer,
      subjectDid: subject.getDid(),
      challengeNonce: 'a1b2c3d4-e5f6-4789-abcd-1234567890ab',
    })

    // An ordinary attestation — same human claim string deliberately, to prove the
    // split is type-based and NOT discriminated on the 'in-person verifiziert' label.
    generic = await attestationWorkflow.createAttestation({
      issuer,
      subjectDid: subject.getDid(),
      claim: 'in-person verifiziert',
    })
  })

  it('routes a WotVerification VC to /v and an ordinary VC to /a', async () => {
    const { verifications, attestations } = await splitAcceptedAttestations(
      [verification, generic],
      { crypto },
    )

    expect(verifications.map(a => a.id)).toEqual([verification.id])
    expect(attestations.map(a => a.id)).toEqual([generic.id])
  })

  it('is disjoint — no attestation lands in both lists', async () => {
    const { verifications, attestations } = await splitAcceptedAttestations(
      [verification, generic],
      { crypto },
    )
    const vIds = new Set(verifications.map(a => a.id))
    const aIds = new Set(attestations.map(a => a.id))
    for (const id of vIds) expect(aIds.has(id)).toBe(false)
    for (const id of aIds) expect(vIds.has(id)).toBe(false)
  })

  it('does not use the claim label as the split discriminator', async () => {
    // The generic attestation carries the exact display label but is NOT a
    // verification — a claim-based split would wrongly route it to /v.
    expect(generic.claim).toBe('in-person verifiziert')
    const { verifications, attestations } = await splitAcceptedAttestations([generic], { crypto })
    expect(verifications).toHaveLength(0)
    expect(attestations.map(a => a.id)).toEqual([generic.id])
  })

  it('drops attestations whose vcJws does not verify', async () => {
    const broken: Attestation = { ...generic, vcJws: 'header.tampered.signature' }
    const { verifications, attestations } = await splitAcceptedAttestations([broken], { crypto })
    expect(verifications).toHaveLength(0)
    expect(attestations).toHaveLength(0)
  })
})
