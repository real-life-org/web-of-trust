/**
 * Tests for the global verification listener.
 *
 * The listener:
 * 1. Receives a verification message
 * 2. Verifies the signature
 * 3. Saves it to storage
 * 4. If I'm the recipient, haven't verified the sender yet,
 *    AND the verification contains my active challenge nonce →
 *    set pendingIncoming for user confirmation
 *
 * Counter-verification (addContact + send) happens only after
 * user confirms in the UI (confirmIncoming in useVerification).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Verification, MessageEnvelope } from '@web_of_trust/core'

// --- Test helpers ---

const ALICE_DID = 'did:key:z6MkAlice'
const BOB_DID = 'did:key:z6MkBob'
const CHALLENGE_NONCE = 'test-nonce-12345'

function makeVerification(from: string, to: string, id?: string): Verification {
  return {
    id: id || `urn:uuid:ver-${Math.random()}`,
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

/** Creates a verification with an ID that contains the given nonce (as createVerificationFor does). */
function makeVerificationWithNonce(from: string, to: string, nonce: string): Verification {
  return makeVerification(from, to, `urn:uuid:ver-${nonce}-${from.slice(-8)}`)
}

function makeVerificationEnvelope(fromDid: string, toDid: string, verification: Verification): MessageEnvelope {
  return {
    v: 1,
    id: `ver-${crypto.randomUUID()}`,
    type: 'verification',
    fromDid,
    toDid,
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: JSON.stringify(verification),
    signature: '',
  }
}

/**
 * Simulates the verification listener logic from App.tsx.
 *
 * Receive → verify signature → save → if nonce matches → setPendingIncoming.
 * No auto counter-verification — that requires user confirmation.
 */
function createVerificationListener(deps: {
  myDid: string
  existingVerifications: Verification[]
  challengeNonce: string | null
  verifySignature: (verification: Verification) => Promise<boolean>
  saveVerification: (v: Verification) => Promise<void>
  setChallengeNonce: (nonce: string | null) => void
  setPendingIncoming: (pending: { verification: Verification; fromDid: string } | null) => void
}) {
  return async (envelope: MessageEnvelope) => {
    if (envelope.type !== 'verification') return

    let verification: Verification
    try {
      verification = JSON.parse(envelope.payload)
    } catch {
      return
    }

    if (!verification.id || !verification.from || !verification.to || !verification.proof) return

    try {
      const isValid = await deps.verifySignature(verification)
      if (!isValid) return

      await deps.saveVerification(verification)
    } catch {
      return
    }

    if (verification.to === deps.myDid) {
      const alreadyVerified = deps.existingVerifications.some(
        v => v.from === deps.myDid && v.to === verification.from
      )

      if (!alreadyVerified && deps.challengeNonce && verification.id.includes(deps.challengeNonce)) {
        deps.setChallengeNonce(null)
        deps.setPendingIncoming({ verification, fromDid: verification.from })
      }
    }
  }
}

// --- Tests ---

describe('Verification Listener', () => {
  let saveVerification: ReturnType<typeof vi.fn>
  let verifySignature: ReturnType<typeof vi.fn>
  let setChallengeNonce: ReturnType<typeof vi.fn>
  let setPendingIncoming: ReturnType<typeof vi.fn>

  beforeEach(() => {
    saveVerification = vi.fn().mockResolvedValue(undefined)
    verifySignature = vi.fn().mockResolvedValue(true)
    setChallengeNonce = vi.fn()
    setPendingIncoming = vi.fn()
  })

  function defaultDeps(overrides?: Partial<Parameters<typeof createVerificationListener>[0]>) {
    return {
      myDid: ALICE_DID,
      existingVerifications: [] as Verification[],
      challengeNonce: null as string | null,
      verifySignature,
      saveVerification,
      setChallengeNonce,
      setPendingIncoming,
      ...overrides,
    }
  }

  describe('receiving a valid verification', () => {
    it('should verify signature and save verification', async () => {
      const handler = createVerificationListener(defaultDeps())
      const verification = makeVerification(BOB_DID, ALICE_DID)

      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, verification))

      expect(verifySignature).toHaveBeenCalledWith(verification)
      expect(saveVerification).toHaveBeenCalledWith(verification)
    })
  })

  describe('pending incoming (nonce-gated)', () => {
    it('should set pendingIncoming when sender has valid nonce', async () => {
      const handler = createVerificationListener(defaultDeps({
        challengeNonce: CHALLENGE_NONCE,
      }))

      const bobVerifiesAlice = makeVerificationWithNonce(BOB_DID, ALICE_DID, CHALLENGE_NONCE)
      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, bobVerifiesAlice))

      expect(saveVerification).toHaveBeenCalledTimes(1)

      expect(setPendingIncoming).toHaveBeenCalledWith({
        verification: bobVerifiesAlice,
        fromDid: BOB_DID,
      })

      expect(setChallengeNonce).toHaveBeenCalledWith(null)
    })

    it('should REJECT sender without active nonce (spam)', async () => {
      const handler = createVerificationListener(defaultDeps({
        challengeNonce: null,
      }))

      const bobVerifiesAlice = makeVerification(BOB_DID, ALICE_DID)
      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, bobVerifiesAlice))

      expect(saveVerification).toHaveBeenCalledTimes(1)
      expect(setPendingIncoming).not.toHaveBeenCalled()
    })

    it('should REJECT sender with wrong nonce (spam)', async () => {
      const handler = createVerificationListener(defaultDeps({
        challengeNonce: CHALLENGE_NONCE,
      }))

      const bobVerifiesAlice = makeVerificationWithNonce(BOB_DID, ALICE_DID, 'wrong-nonce')
      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, bobVerifiesAlice))

      expect(saveVerification).toHaveBeenCalledTimes(1)
      expect(setPendingIncoming).not.toHaveBeenCalled()
    })

    it('should NOT set pending when already verified', async () => {
      const existingVerification = makeVerification(ALICE_DID, BOB_DID)

      const handler = createVerificationListener(defaultDeps({
        existingVerifications: [existingVerification],
        challengeNonce: CHALLENGE_NONCE,
      }))

      const bobVerifiesAlice = makeVerificationWithNonce(BOB_DID, ALICE_DID, CHALLENGE_NONCE)
      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, bobVerifiesAlice))

      expect(saveVerification).toHaveBeenCalledTimes(1)
      expect(setPendingIncoming).not.toHaveBeenCalled()
    })

    it('should NOT set pending when I am the sender', async () => {
      const handler = createVerificationListener(defaultDeps({
        challengeNonce: CHALLENGE_NONCE,
      }))

      const aliceVerifiesBob = makeVerification(ALICE_DID, BOB_DID)
      await handler(makeVerificationEnvelope(ALICE_DID, BOB_DID, aliceVerifiesBob))

      expect(saveVerification).toHaveBeenCalledTimes(1)
      expect(setPendingIncoming).not.toHaveBeenCalled()
    })
  })

  describe('rejecting invalid verifications', () => {
    it('should reject verification with invalid signature', async () => {
      verifySignature.mockResolvedValue(false)

      const handler = createVerificationListener(defaultDeps())
      const fakeVerification = makeVerification(BOB_DID, ALICE_DID)

      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, fakeVerification))

      expect(saveVerification).not.toHaveBeenCalled()
      expect(setPendingIncoming).not.toHaveBeenCalled()
    })

    it('should reject verification when verifySignature throws', async () => {
      verifySignature.mockRejectedValue(new Error('crypto error'))

      const handler = createVerificationListener(defaultDeps())
      const verification = makeVerification(BOB_DID, ALICE_DID)

      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, verification))

      expect(saveVerification).not.toHaveBeenCalled()
    })

    it('should reject payload missing required Verification fields', async () => {
      const handler = createVerificationListener(defaultDeps())

      const envelope: MessageEnvelope = {
        v: 1,
        id: 'msg-1',
        type: 'verification',
        fromDid: BOB_DID,
        toDid: ALICE_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify({ action: 'response', responseCode: 'abc' }),
        signature: '',
      }

      await handler(envelope)

      expect(saveVerification).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('should ignore non-verification messages', async () => {
      const handler = createVerificationListener(defaultDeps())

      const envelope: MessageEnvelope = {
        v: 1,
        id: 'msg-1',
        type: 'attestation',
        fromDid: BOB_DID,
        toDid: ALICE_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: '{}',
        signature: '',
      }

      await handler(envelope)

      expect(saveVerification).not.toHaveBeenCalled()
    })

    it('should handle malformed payload gracefully', async () => {
      const handler = createVerificationListener(defaultDeps())

      const envelope: MessageEnvelope = {
        v: 1,
        id: 'msg-1',
        type: 'verification',
        fromDid: BOB_DID,
        toDid: ALICE_DID,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: 'not-json',
        signature: '',
      }

      await handler(envelope)

      expect(saveVerification).not.toHaveBeenCalled()
    })

    it('should handle saveVerification failure gracefully', async () => {
      saveVerification.mockRejectedValue(new Error('storage full'))

      const handler = createVerificationListener(defaultDeps())
      const verification = makeVerification(BOB_DID, ALICE_DID)

      await handler(makeVerificationEnvelope(BOB_DID, ALICE_DID, verification))

      expect(saveVerification).toHaveBeenCalledTimes(1)
      expect(setPendingIncoming).not.toHaveBeenCalled()
    })
  })
})
