import { useState, useCallback, useRef } from 'react'
import { VerificationHelper } from '@web.of.trust/core'
import type { VerificationChallenge, MessageEnvelope } from '@web.of.trust/core'
import { useAdapters } from '../context'
import { useIdentity } from '../context'
import { useConfetti } from '../context/PendingVerificationContext'
import { useContacts } from './useContacts'
import { useMessaging } from './useMessaging'
import { useProfileSync } from './useProfileSync'

type VerificationStep =
  | 'idle'
  | 'initiating'       // QR shown, waiting for scan
  | 'confirm-respond'  // Scanned QR, peer info shown, waiting for confirmation
  | 'responding'       // Creating verification + sending
  | 'done'
  | 'error'

/**
 * Hook for in-person verification flow using WotIdentity.
 *
 * Simplified flow (no session state):
 * 1. createChallenge() → show QR code
 * 2. prepareResponse(challengeCode) → show peer info for confirmation
 * 3. confirmAndRespond() → create verification, add contact, send via relay
 * 4. done
 *
 * Confetti is handled by MutualVerificationEffect in App.tsx
 * (reactive, watches allVerifications for mutual transitions).
 */
export function useVerification() {
  const { verificationService, storage } = useAdapters()
  const { identity, did } = useIdentity()
  const { addContact } = useContacts()
  const { send, isConnected } = useMessaging()
  const { syncContactProfile } = useProfileSync()
  const { setChallengeNonce, pendingIncoming, setPendingIncoming } = useConfetti()

  const getProfileName = useCallback(async () => {
    const id = await storage.getIdentity()
    return id?.profile.name || ''
  }, [storage])

  const [step, setStep] = useState<VerificationStep>('idle')
  const [challenge, setChallenge] = useState<VerificationChallenge | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [peerName, setPeerName] = useState<string | null>(null)
  const [peerDid, setPeerDid] = useState<string | null>(null)

  const pendingChallengeCodeRef = useRef<string | null>(null)

  const createChallenge = useCallback(async () => {
    if (!identity) {
      throw new Error('No identity found')
    }

    try {
      setStep('initiating')
      setError(null)

      const name = await getProfileName()
      const challengeCode = await VerificationHelper.createChallenge(identity, name)
      const decodedChallenge = JSON.parse(atob(challengeCode))
      setChallenge(decodedChallenge)
      setChallengeNonce(decodedChallenge.nonce)

      return challengeCode
    } catch (e) {
      const err = e instanceof Error ? e : new Error('Failed to create challenge')
      setError(err)
      setStep('error')
      throw err
    }
  }, [identity, getProfileName, setChallengeNonce])

  // Decode challenge and show peer info for confirmation
  const prepareResponse = useCallback(
    async (challengeCode: string) => {
      try {
        setError(null)

        const decodedChallenge = JSON.parse(atob(challengeCode))
        setChallenge(decodedChallenge)
        setPeerName(decodedChallenge.fromName || null)
        setPeerDid(decodedChallenge.fromDid || null)

        pendingChallengeCodeRef.current = challengeCode
        setStep('confirm-respond')
      } catch (e) {
        const err = e instanceof Error ? e : new Error('Ungültiger Code')
        setError(err)
        setStep('error')
        throw err
      }
    },
    []
  )

  // After confirmation: create verification, add contact, send via relay
  const confirmAndRespond = useCallback(
    async () => {
      if (!identity) {
        throw new Error('No identity found')
      }

      const challengeCode = pendingChallengeCodeRef.current
      if (!challengeCode) {
        throw new Error('No pending challenge')
      }

      try {
        setStep('responding')
        setError(null)

        const decodedChallenge = JSON.parse(atob(challengeCode))

        // Add as contact
        await addContact(
          decodedChallenge.fromDid,
          decodedChallenge.fromPublicKey,
          decodedChallenge.fromName,
          'active'
        )
        syncContactProfile(decodedChallenge.fromDid)

        // Create verification (Empfänger-Prinzip: from=me, to=peer)
        const verification = await VerificationHelper.createVerificationFor(
          identity,
          decodedChallenge.fromDid,
          decodedChallenge.nonce
        )
        await verificationService.saveVerification(verification)

        // Send via relay (non-blocking — outbox handles retry if offline)
        const envelope: MessageEnvelope = {
          v: 1,
          id: verification.id,
          type: 'verification',
          fromDid: did!,
          toDid: decodedChallenge.fromDid,
          createdAt: new Date().toISOString(),
          encoding: 'json',
          payload: JSON.stringify(verification),
          signature: verification.proof.proofValue,
        }
        send(envelope).catch(() => {})

        pendingChallengeCodeRef.current = null
        setChallengeNonce(null)
        setStep('done')
      } catch (e) {
        const err = e instanceof Error ? e : new Error('Failed to respond to challenge')
        setError(err)
        setStep('error')
        throw err
      }
    },
    [identity, addContact, isConnected, send, did, syncContactProfile, verificationService]
  )

  // Confirm incoming verification: add sender as contact + counter-verify
  const confirmIncoming = useCallback(
    async () => {
      if (!identity || !did || !pendingIncoming) {
        throw new Error('No pending incoming verification')
      }

      try {
        const { verification } = pendingIncoming

        // Add sender as contact
        const publicKey = VerificationHelper.publicKeyFromDid(verification.from)
        await addContact(verification.from, publicKey, undefined, 'active')
        syncContactProfile(verification.from)

        // Create + send counter-verification
        const nonce = crypto.randomUUID()
        const counter = await VerificationHelper.createVerificationFor(identity, verification.from, nonce)
        await verificationService.saveVerification(counter)

        // Send counter-verification via relay (non-blocking — outbox handles retry)
        const envelope: MessageEnvelope = {
          v: 1,
          id: counter.id,
          type: 'verification',
          fromDid: did,
          toDid: verification.from,
          createdAt: new Date().toISOString(),
          encoding: 'json',
          payload: JSON.stringify(counter),
          signature: counter.proof.proofValue,
        }
        send(envelope).catch(() => {})

        setPendingIncoming(null)
        setStep('done')
      } catch (e) {
        const err = e instanceof Error ? e : new Error('Counter-verification failed')
        setError(err)
        setStep('error')
        throw err
      }
    },
    [identity, did, pendingIncoming, addContact, syncContactProfile, verificationService, isConnected, send, setPendingIncoming]
  )

  const rejectIncoming = useCallback(() => {
    setPendingIncoming(null)
  }, [setPendingIncoming])

  // Counter-verify a DID directly (without QR scan).
  // Used for deferred counter-verification from the contacts list.
  const counterVerify = useCallback(
    async (targetDid: string, name?: string) => {
      if (!identity || !did) {
        throw new Error('No identity found')
      }

      const publicKey = VerificationHelper.publicKeyFromDid(targetDid)
      await addContact(targetDid, publicKey, name, 'active')
      syncContactProfile(targetDid)

      const nonce = crypto.randomUUID()
      const counter = await VerificationHelper.createVerificationFor(identity, targetDid, nonce)
      await verificationService.saveVerification(counter)

      const envelope: MessageEnvelope = {
        v: 1,
        id: counter.id,
        type: 'verification',
        fromDid: did,
        toDid: targetDid,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(counter),
        signature: counter.proof.proofValue,
      }
      send(envelope).catch(() => {})
    },
    [identity, did, addContact, syncContactProfile, verificationService, send]
  )

  const reset = useCallback(() => {
    setStep('idle')
    setChallenge(null)
    setError(null)
    setPeerName(null)
    setPeerDid(null)
    pendingChallengeCodeRef.current = null
    setChallengeNonce(null)
    setPendingIncoming(null)
  }, [setChallengeNonce, setPendingIncoming])

  return {
    step,
    challenge,
    error,
    peerName,
    peerDid,
    isConnected,
    pendingIncoming,
    createChallenge,
    prepareResponse,
    confirmAndRespond,
    confirmIncoming,
    rejectIncoming,
    counterVerify,
    reset,
  }
}
