import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getVerificationStatus } from '../src/hooks/useVerificationStatus'
import type { Attestation } from '@web_of_trust/core/types'

vi.mock('../src/context', () => ({
  useAdapters: () => ({ reactiveStorage: {} }),
  useIdentity: () => ({ did: null }),
}))

const MY_DID = 'did:key:z6MkMe'
const BOB_DID = 'did:key:z6MkBob'
const CAROL_DID = 'did:key:z6MkCarol'
const VERIFICATION_CLAIM = 'in-person verifiziert'

function makeTrustVerificationAttestation(
  from: string,
  to: string,
  options: Partial<Pick<Attestation, 'claim' | 'vcJws' | 'inResponseTo'>> = {},
): Attestation {
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

function makeUnsignedTrustVerificationAttestation(from: string, to: string): Attestation {
  const attestation = makeTrustVerificationAttestation(from, to)
  delete (attestation as Partial<Attestation>).vcJws
  return attestation
}

function createMutualDetector(deps: {
  myDid: string
  contacts: Array<{ did: string; name?: string }>
  triggerConfetti: (message: string) => void
}) {
  const previousStatus = new Map<string, string>()

  return (attestations: Attestation[]) => {
    for (const contact of deps.contacts) {
      const status = getVerificationStatus(deps.myDid, contact.did, attestations)
      const prev = previousStatus.get(contact.did) || 'none'

      if (status === 'mutual' && prev !== 'mutual') {
        const name = contact.name || 'Kontakt'
        deps.triggerConfetti(`${name} und du habt euch gegenseitig verifiziert!`)
      }

      previousStatus.set(contact.did, status)
    }
  }
}

describe('Reactive Mutual Verification Detection', () => {
  let triggerConfetti: ReturnType<typeof vi.fn>

  beforeEach(() => {
    triggerConfetti = vi.fn()
  })

  describe('detecting mutual transition from Trust 002 attestations', () => {
    it('triggers confetti when status transitions from none to mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('triggers confetti when status transitions from outgoing to mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([makeTrustVerificationAttestation(MY_DID, BOB_DID)])
      expect(triggerConfetti).not.toHaveBeenCalled()

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('triggers confetti when status transitions from incoming to mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([makeTrustVerificationAttestation(BOB_DID, MY_DID)])
      expect(triggerConfetti).not.toHaveBeenCalled()

      detect([
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('counts counter-attestations by wrapper direction when inResponseTo is present', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })
      const incoming = makeTrustVerificationAttestation(BOB_DID, MY_DID)
      const outgoingCounter = makeTrustVerificationAttestation(MY_DID, BOB_DID, {
        inResponseTo: incoming.id,
      })

      detect([incoming, outgoingCounter])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })
  })

  describe('no false triggers', () => {
    it('does not trigger confetti for outgoing-only', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([makeTrustVerificationAttestation(MY_DID, BOB_DID)])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })

    it('does not trigger confetti for incoming-only', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([makeTrustVerificationAttestation(BOB_DID, MY_DID)])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })

    it('does not trigger confetti for generic or profile attestations', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID, { claim: 'profile:name=Me' }),
        makeTrustVerificationAttestation(BOB_DID, MY_DID, { claim: 'helped with groceries' }),
      ])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })

    it('does not trigger confetti for verification-claim attestations without a VC-JWS', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([
        makeUnsignedTrustVerificationAttestation(MY_DID, BOB_DID),
        makeUnsignedTrustVerificationAttestation(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })

    it('does not trigger confetti twice for same contact', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })
      const attestations = [
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
      ]

      detect(attestations)
      detect(attestations)

      expect(triggerConfetti).toHaveBeenCalledTimes(1)
    })

    it('does not trigger confetti when no attestations exist', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })
  })

  describe('multi-contact scenarios', () => {
    it('triggers confetti independently for different contacts', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [
          { did: BOB_DID, name: 'Bob' },
          { did: CAROL_DID, name: 'Carol' },
        ],
        triggerConfetti,
      })

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledTimes(1)
      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
        makeTrustVerificationAttestation(MY_DID, CAROL_DID),
        makeTrustVerificationAttestation(CAROL_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledTimes(2)
      expect(triggerConfetti).toHaveBeenCalledWith('Carol und du habt euch gegenseitig verifiziert!')
    })

    it('only triggers for the contact that became mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [
          { did: BOB_DID, name: 'Bob' },
          { did: CAROL_DID, name: 'Carol' },
        ],
        triggerConfetti,
      })

      detect([makeTrustVerificationAttestation(MY_DID, BOB_DID)])
      expect(triggerConfetti).not.toHaveBeenCalled()

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledTimes(1)
      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })
  })

  describe('edge case: deferred counter-verification', () => {
    it('Alice verifies Bob, then Bob later verifies Alice', () => {
      const aliceDetect = createMutualDetector({
        myDid: 'did:key:z6MkAlice',
        contacts: [{ did: 'did:key:z6MkBob', name: 'Bob' }],
        triggerConfetti,
      })

      aliceDetect([makeTrustVerificationAttestation('did:key:z6MkAlice', 'did:key:z6MkBob')])
      expect(triggerConfetti).not.toHaveBeenCalled()

      aliceDetect([
        makeTrustVerificationAttestation('did:key:z6MkAlice', 'did:key:z6MkBob'),
        makeTrustVerificationAttestation('did:key:z6MkBob', 'did:key:z6MkAlice'),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('Bob verifies Alice first, then Alice counter-attests Bob with inResponseTo', () => {
      const aliceDetect = createMutualDetector({
        myDid: 'did:key:z6MkAlice',
        contacts: [{ did: 'did:key:z6MkBob', name: 'Bob' }],
        triggerConfetti,
      })
      const incoming = makeTrustVerificationAttestation('did:key:z6MkBob', 'did:key:z6MkAlice')

      aliceDetect([incoming])
      expect(triggerConfetti).not.toHaveBeenCalled()

      aliceDetect([
        incoming,
        makeTrustVerificationAttestation('did:key:z6MkAlice', 'did:key:z6MkBob', {
          inResponseTo: incoming.id,
        }),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })
  })

  describe('fallback name', () => {
    it('uses "Kontakt" if contact has no name', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID }],
        triggerConfetti,
      })

      detect([
        makeTrustVerificationAttestation(MY_DID, BOB_DID),
        makeTrustVerificationAttestation(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Kontakt und du habt euch gegenseitig verifiziert!')
    })
  })
})
