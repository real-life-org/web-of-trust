import { describe, it, expect, vi } from 'vitest'
import { getVerificationStatus } from '../src/hooks/useVerificationStatus'
import type { Attestation } from '@web_of_trust/core/types'

vi.mock('../src/context', () => ({
  useAdapters: () => ({ reactiveStorage: {} }),
  useIdentity: () => ({ did: null }),
}))

const ALICE = 'did:key:z6MkAlice'
const BOB = 'did:key:z6MkBob'
const CAROL = 'did:key:z6MkCarol'
const VERIFICATION_CLAIM = 'in-person verifiziert'

function makeTrustVerificationAttestation(
  from: string,
  to: string,
  options: Partial<Pick<Attestation, 'claim' | 'vcJws' | 'inResponseTo' | 'isVerification'>> = {},
): Attestation {
  return {
    id: `urn:uuid:att-${from.slice(-5)}-${to.slice(-5)}-${Math.random()}`,
    from,
    to,
    claim: options.claim ?? VERIFICATION_CLAIM,
    createdAt: new Date().toISOString(),
    vcJws: options.vcJws ?? 'eyJhbGciOiJFZERTQSJ9.eyJ0eXAiOiJXb3RBdHRlc3RhdGlvbiJ9.signature',
    // Type-borne marker (review MAJOR 2): a genuine verification carries it. The
    // 'ignores ...' cases below override it to false to model non-verifications.
    isVerification: options.isVerification ?? true,
    ...(options.inResponseTo ? { inResponseTo: options.inResponseTo } : {}),
  }
}

function makeUnsignedTrustVerificationAttestation(from: string, to: string): Attestation {
  // No VC-JWS → there is no verified `type` to derive the marker from, so an
  // unsigned entry is never a verification (review MAJOR 2).
  const attestation = makeTrustVerificationAttestation(from, to, { isVerification: false })
  delete (attestation as Partial<Attestation>).vcJws
  return attestation
}

describe('getVerificationStatus', () => {
  it('returns "none" when no attestations exist', () => {
    expect(getVerificationStatus(ALICE, BOB, [])).toBe('none')
  })

  it('returns "incoming" for a Trust 002 verification attestation from peer to me', () => {
    const attestations = [makeTrustVerificationAttestation(BOB, ALICE)]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('incoming')
  })

  it('returns "outgoing" for a Trust 002 verification attestation from me to peer', () => {
    const attestations = [makeTrustVerificationAttestation(ALICE, BOB)]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('outgoing')
  })

  it('returns "mutual" when Trust 002 verification attestations exist in both wrapper directions', () => {
    const attestations = [
      makeTrustVerificationAttestation(ALICE, BOB),
      makeTrustVerificationAttestation(BOB, ALICE),
    ]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('mutual')
  })

  it('ignores attestations involving other contacts', () => {
    const attestations = [
      makeTrustVerificationAttestation(CAROL, ALICE),
      makeTrustVerificationAttestation(ALICE, CAROL),
    ]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('none')
  })

  it('ignores generic, profile, and non-verification claim attestations', () => {
    const attestations = [
      makeTrustVerificationAttestation(BOB, ALICE, { claim: 'helped with groceries', isVerification: false }),
      makeTrustVerificationAttestation(ALICE, BOB, { claim: 'profile:name=Alice', isVerification: false }),
      makeTrustVerificationAttestation(BOB, ALICE, { claim: 'has public profile', isVerification: false }),
    ]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('none')
  })

  it('ignores a SPOOF: magic verification claim but no WotVerification type (review MAJOR 2)', () => {
    // A claim-based predicate would wrongly count these as verifications. The
    // type-borne marker (isVerification:false) correctly classifies them as none.
    const attestations = [
      makeTrustVerificationAttestation(BOB, ALICE, { claim: VERIFICATION_CLAIM, isVerification: false }),
      makeTrustVerificationAttestation(ALICE, BOB, { claim: VERIFICATION_CLAIM, isVerification: false }),
    ]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('none')
  })

  it('ignores verification-claim attestations without a VC-JWS', () => {
    const attestations = [
      makeUnsignedTrustVerificationAttestation(BOB, ALICE),
      makeUnsignedTrustVerificationAttestation(ALICE, BOB),
    ]
    expect(getVerificationStatus(ALICE, BOB, attestations)).toBe('none')
  })

  it('counts counter-verifications by wrapper from/to direction even when inResponseTo is present', () => {
    const incoming = makeTrustVerificationAttestation(BOB, ALICE)
    const outgoingCounter = makeTrustVerificationAttestation(ALICE, BOB, {
      inResponseTo: incoming.id,
    })
    expect(getVerificationStatus(ALICE, BOB, [incoming, outgoingCounter])).toBe('mutual')
  })

  it('does not reinterpret inResponseTo as the verification direction', () => {
    const myOriginal = makeTrustVerificationAttestation(ALICE, BOB)
    const peerCounter = makeTrustVerificationAttestation(BOB, ALICE, {
      inResponseTo: myOriginal.id,
    })
    expect(getVerificationStatus(ALICE, BOB, [peerCounter])).toBe('incoming')
  })
})
