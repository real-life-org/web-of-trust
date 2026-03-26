/**
 * Tests for reactive mutual verification detection.
 *
 * Instead of session-based confetti triggers (old: "complete" action → confetti),
 * confetti now triggers reactively when watchAllVerifications() detects a
 * transition to "mutual" status for any contact.
 *
 * This solves the edge case where:
 * - A verifies B, B cancels → later B verifies A → A should get confetti
 * - Even if A was offline or on a different page when B's verification arrived
 *
 * The detection logic:
 * - Track previous verification status per contact
 * - When status transitions to "mutual" → trigger confetti for that contact
 * - Only trigger once per contact (not on every re-render)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getVerificationStatus } from '../src/hooks/useVerificationStatus'
import type { Verification } from '@web.of.trust/core'

// --- Test helpers ---

const MY_DID = 'did:key:z6MkMe'
const BOB_DID = 'did:key:z6MkBob'
const CAROL_DID = 'did:key:z6MkCarol'

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

/**
 * Simulates the reactive mutual detection logic.
 *
 * Tracks previous status per contact. When a contact's status transitions
 * to "mutual", calls triggerConfetti. Only fires once per contact.
 */
function createMutualDetector(deps: {
  myDid: string
  contacts: Array<{ did: string; name?: string }>
  triggerConfetti: (message: string) => void
}) {
  const previousStatus = new Map<string, string>()

  return (verifications: Verification[]) => {
    for (const contact of deps.contacts) {
      const status = getVerificationStatus(deps.myDid, contact.did, verifications)
      const prev = previousStatus.get(contact.did) || 'none'

      if (status === 'mutual' && prev !== 'mutual') {
        const name = contact.name || 'Kontakt'
        deps.triggerConfetti(`${name} und du habt euch gegenseitig verifiziert!`)
      }

      previousStatus.set(contact.did, status)
    }
  }
}

// --- Tests ---

describe('Reactive Mutual Verification Detection', () => {
  let triggerConfetti: ReturnType<typeof vi.fn>

  beforeEach(() => {
    triggerConfetti = vi.fn()
  })

  describe('detecting mutual transition', () => {
    it('should trigger confetti when status transitions from none to mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      // Both verifications arrive at once (e.g. page load after both happened)
      detect([
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('should trigger confetti when status transitions from outgoing to mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      // First: only I verified Bob (outgoing)
      detect([makeVerification(MY_DID, BOB_DID)])
      expect(triggerConfetti).not.toHaveBeenCalled()

      // Then: Bob's verification arrives → mutual
      detect([
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('should trigger confetti when status transitions from incoming to mutual', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      // First: only Bob verified me (incoming)
      detect([makeVerification(BOB_DID, MY_DID)])
      expect(triggerConfetti).not.toHaveBeenCalled()

      // Then: I verify Bob → mutual
      detect([
        makeVerification(BOB_DID, MY_DID),
        makeVerification(MY_DID, BOB_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })
  })

  describe('no false triggers', () => {
    it('should NOT trigger confetti for outgoing-only', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([makeVerification(MY_DID, BOB_DID)])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })

    it('should NOT trigger confetti for incoming-only', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      detect([makeVerification(BOB_DID, MY_DID)])

      expect(triggerConfetti).not.toHaveBeenCalled()
    })

    it('should NOT trigger confetti twice for same contact', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID, name: 'Bob' }],
        triggerConfetti,
      })

      const verifications = [
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
      ]

      detect(verifications)
      detect(verifications) // re-render with same data

      expect(triggerConfetti).toHaveBeenCalledTimes(1)
    })

    it('should NOT trigger confetti when no verifications exist', () => {
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
    it('should trigger confetti independently for different contacts', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [
          { did: BOB_DID, name: 'Bob' },
          { did: CAROL_DID, name: 'Carol' },
        ],
        triggerConfetti,
      })

      // Bob becomes mutual
      detect([
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledTimes(1)
      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')

      // Carol becomes mutual too
      detect([
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
        makeVerification(MY_DID, CAROL_DID),
        makeVerification(CAROL_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledTimes(2)
      expect(triggerConfetti).toHaveBeenCalledWith('Carol und du habt euch gegenseitig verifiziert!')
    })

    it('should only trigger for the contact that became mutual, not others', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [
          { did: BOB_DID, name: 'Bob' },
          { did: CAROL_DID, name: 'Carol' },
        ],
        triggerConfetti,
      })

      // Bob outgoing, Carol none
      detect([makeVerification(MY_DID, BOB_DID)])
      expect(triggerConfetti).not.toHaveBeenCalled()

      // Bob becomes mutual, Carol still none
      detect([
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledTimes(1)
      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })
  })

  describe('edge case: the original bug scenario', () => {
    it('A verifies B, B cancels, later B verifies A → confetti on both sides', () => {
      // Alice's perspective
      const aliceDetect = createMutualDetector({
        myDid: 'did:key:z6MkAlice',
        contacts: [{ did: 'did:key:z6MkBob', name: 'Bob' }],
        triggerConfetti,
      })

      // Step 1: Alice verified Bob (outgoing)
      aliceDetect([makeVerification('did:key:z6MkAlice', 'did:key:z6MkBob')])
      expect(triggerConfetti).not.toHaveBeenCalled()

      // Step 2: Bob cancels his verification (nothing changes for Alice)
      // ... time passes ...

      // Step 3: Later, Bob verifies Alice → verification arrives via relay → saved
      aliceDetect([
        makeVerification('did:key:z6MkAlice', 'did:key:z6MkBob'),
        makeVerification('did:key:z6MkBob', 'did:key:z6MkAlice'),
      ])

      // Alice gets confetti! Even though she wasn't in an active session.
      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })

    it('Bob verifies Alice first, later Alice verifies Bob → confetti for Alice', () => {
      const aliceDetect = createMutualDetector({
        myDid: 'did:key:z6MkAlice',
        contacts: [{ did: 'did:key:z6MkBob', name: 'Bob' }],
        triggerConfetti,
      })

      // Step 1: Bob verified Alice (incoming for Alice)
      aliceDetect([makeVerification('did:key:z6MkBob', 'did:key:z6MkAlice')])
      expect(triggerConfetti).not.toHaveBeenCalled()

      // Step 2: Alice verifies Bob → now mutual
      aliceDetect([
        makeVerification('did:key:z6MkBob', 'did:key:z6MkAlice'),
        makeVerification('did:key:z6MkAlice', 'did:key:z6MkBob'),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Bob und du habt euch gegenseitig verifiziert!')
    })
  })

  describe('fallback name', () => {
    it('should use "Kontakt" if contact has no name', () => {
      const detect = createMutualDetector({
        myDid: MY_DID,
        contacts: [{ did: BOB_DID }], // no name
        triggerConfetti,
      })

      detect([
        makeVerification(MY_DID, BOB_DID),
        makeVerification(BOB_DID, MY_DID),
      ])

      expect(triggerConfetti).toHaveBeenCalledWith('Kontakt und du habt euch gegenseitig verifiziert!')
    })
  })
})
