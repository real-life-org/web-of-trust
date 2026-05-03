import { describe, it, expect } from 'vitest'
import { getVerificationStatus } from '../src/hooks/useVerificationStatus'
import type { Verification } from '@web_of_trust/core/types'

const ALICE = 'did:key:z6MkAlice'
const BOB = 'did:key:z6MkBob'
const CAROL = 'did:key:z6MkCarol'

function makeVerification(from: string, to: string): Verification {
  return {
    id: `urn:uuid:ver-${Math.random()}`,
    from,
    to,
    timestamp: new Date().toISOString(),
    proof: {
      type: 'Ed25519Signature2020',
      verificationMethod: `${from}#key-1`,
      created: new Date().toISOString(),
      proofPurpose: 'authentication',
      proofValue: 'test-signature',
    },
  }
}

describe('getVerificationStatus', () => {
  it('should return "none" when no verifications exist', () => {
    expect(getVerificationStatus(ALICE, BOB, [])).toBe('none')
  })

  it('should return "incoming" when only peer verified me', () => {
    const verifications = [makeVerification(BOB, ALICE)]
    expect(getVerificationStatus(ALICE, BOB, verifications)).toBe('incoming')
  })

  it('should return "outgoing" when only I verified peer', () => {
    const verifications = [makeVerification(ALICE, BOB)]
    expect(getVerificationStatus(ALICE, BOB, verifications)).toBe('outgoing')
  })

  it('should return "mutual" when both directions exist', () => {
    const verifications = [
      makeVerification(ALICE, BOB),
      makeVerification(BOB, ALICE),
    ]
    expect(getVerificationStatus(ALICE, BOB, verifications)).toBe('mutual')
  })

  it('should ignore verifications involving other contacts', () => {
    const verifications = [
      makeVerification(CAROL, ALICE), // Carol verified Alice, irrelevant to Bob
      makeVerification(ALICE, CAROL), // Alice verified Carol, irrelevant to Bob
    ]
    expect(getVerificationStatus(ALICE, BOB, verifications)).toBe('none')
  })

  it('should work with mixed verifications for multiple contacts', () => {
    const verifications = [
      makeVerification(ALICE, BOB),   // Alice → Bob
      makeVerification(CAROL, ALICE), // Carol → Alice (irrelevant)
      makeVerification(BOB, ALICE),   // Bob → Alice
    ]
    expect(getVerificationStatus(ALICE, BOB, verifications)).toBe('mutual')
    expect(getVerificationStatus(ALICE, CAROL, verifications)).toBe('incoming')
  })

  it('should return "mutual" regardless of order', () => {
    // Bob→Alice first, then Alice→Bob
    const verifications = [
      makeVerification(BOB, ALICE),
      makeVerification(ALICE, BOB),
    ]
    expect(getVerificationStatus(ALICE, BOB, verifications)).toBe('mutual')
  })
})
