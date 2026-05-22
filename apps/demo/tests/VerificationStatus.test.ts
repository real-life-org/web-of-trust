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

type TestAttestation = Omit<Attestation, 'vcJws'> & { vcJws?: string }

function makeTrustVerificationAttestation(
  from: string,
  to: string,
  options: Partial<Pick<Attestation, 'claim' | 'vcJws' | 'inResponseTo'>> = {},
): TestAttestation {
  return {
    id: `urn:uuid:att-${from.slice(-5)}-${to.slice(-5)}-${Math.random()}`,
    from,
    to,
    claim: options.claim ?? VERIFICATION_CLAIM,
    createdAt: new Date().toISOString(),
    vcJws: options.vcJws ?? 'eyJhbGciOiJFZERTQSJ9.eyJ0eXAiOiJXb3RBdHRlc3RhdGlvbiJ9.signature',
    ...(options.inResponseTo ? { inResponseTo: options.inResponseTo } : {}),
  }
}

function makeUnsignedTrustVerificationAttestation(from: string, to: string): TestAttestation {
  return {
    id: `urn:uuid:att-${from.slice(-5)}-${to.slice(-5)}-${Math.random()}`,
    from,
    to,
    claim: VERIFICATION_CLAIM,
    createdAt: new Date().toISOString(),
  }
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
      makeTrustVerificationAttestation(BOB, ALICE, { claim: 'helped with groceries' }),
      makeTrustVerificationAttestation(ALICE, BOB, { claim: 'profile:name=Alice' }),
      makeTrustVerificationAttestation(BOB, ALICE, { claim: 'has public profile' }),
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
