import { useState, useCallback, useRef } from 'react'
import type { QrChallenge } from '@web_of_trust/core/protocol'
import { parseQrChallenge } from '@web_of_trust/core/protocol'
import { useAdapters } from '../context'
import { useIdentity } from '../context'
import { useConfetti } from '../context/PendingVerificationContext'
import { useContacts } from './useContacts'
import { useMessaging } from './useMessaging'
import { useProfileSync } from './useProfileSync'
import { isVerificationAttestation } from '../lib/verification-attestation'
import { verificationWorkflow } from '../services/verificationWorkflow'

type VerificationStep =
  | 'idle'
  | 'initiating'       // QR shown, waiting for scan
  | 'confirm-respond'  // Scanned QR, peer info shown, waiting for confirmation
  | 'responding'       // Creating verification + sending
  | 'done'
  | 'error'

/**
 * Hook for in-person verification flow using an unlocked identity session.
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
  const { storage, attestationService } = useAdapters()
  const { identity, did } = useIdentity()
  const { addContact } = useContacts()
  const { isConnected } = useMessaging()
  const { syncContactProfile } = useProfileSync()
  const { setChallengeNonce, pendingIncoming, setPendingIncoming } = useConfetti()

  const getProfileName = useCallback(async () => {
    const id = await storage.getIdentity()
    return id?.profile.name || ''
  }, [storage])

  const [step, setStep] = useState<VerificationStep>('idle')
  const [challenge, setChallenge] = useState<QrChallenge | null>(null)
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

      const profileName = await getProfileName()
      const name = profileName.trim() || identity.getDid()
      const result = await verificationWorkflow.createOnlineQrChallenge(identity, name)
      setChallenge(result.challenge)
      setChallengeNonce(result.challenge.nonce)

      return result.rawJson
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

        let decodedChallenge: QrChallenge
        try {
          decodedChallenge = parseQrChallenge(challengeCode)
          if (did && decodedChallenge.did === did) throw new Error('Cannot verify own identity')
        } catch (e) {
          if (e instanceof Error && e.message === 'Cannot verify own identity') {
            throw new Error('Du kannst dich nicht selbst verifizieren')
          }
          throw e
        }

        setChallenge(decodedChallenge)
        setPeerName(decodedChallenge.name || null)
        setPeerDid(decodedChallenge.did || null)

        pendingChallengeCodeRef.current = challengeCode
        setStep('confirm-respond')
      } catch (e) {
        const err = e instanceof Error ? e : new Error('Ungültiger Code')
        setError(err)
        setStep('error')
        throw err
      }
    },
    [did]
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

        const decodedChallenge = parseQrChallenge(challengeCode)

        // Add as contact
        await addContact(
          decodedChallenge.did,
          verificationWorkflow.publicKeyFromDid(decodedChallenge.did),
          decodedChallenge.name,
          'active'
        )
        syncContactProfile(decodedChallenge.did)

        const attestation = await verificationWorkflow.createVerificationAttestation({
          issuer: identity,
          subjectDid: decodedChallenge.did,
          challengeNonce: decodedChallenge.nonce,
        })
        await storage.saveAttestation(attestation)

        // K2 (Sync 003): Zustellung als inbox/1.0 {vcJws} — Inner-JWS + ECIES.
        // M-B: der Encryption-Key des Peers steht bereits im QR-Challenge-
        // Payload (Trust 002 `enc`) — kein Discovery-Roundtrip; offline landet
        // die Zustellung in der Outbox. Fehler markieren die Attestation als
        // 'failed' (Retry in der Attestation-Liste).
        attestationService.sendAttestation(identity, attestation, {
          recipientEncryptionKey: verificationWorkflow.base64UrlToBytes(decodedChallenge.enc),
        }).catch((error) => {
          console.warn('Verification attestation delivery failed (status failed, retry available):', error)
        })

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
    [identity, addContact, attestationService, syncContactProfile, storage, setChallengeNonce]
  )

  // Confirm incoming verification-attestation: add sender as contact + counter-verify
  const confirmIncoming = useCallback(
    async () => {
      if (!identity || !did || !pendingIncoming) {
        throw new Error('No pending incoming verification')
      }

      try {
        const { attestation } = pendingIncoming

        // Add sender as contact
        const publicKey = verificationWorkflow.publicKeyFromDid(attestation.from)
        await addContact(attestation.from, publicKey, undefined, 'active')
        syncContactProfile(attestation.from)

        const counter = await verificationWorkflow.createCounterVerificationAttestation({
          issuer: identity,
          subjectDid: attestation.from,
          inResponseTo: attestation.id,
        })
        await storage.saveAttestation(counter)

        // K2 (Sync 003): Zustellung als inbox/1.0 {vcJws} — Inner-JWS + ECIES.
        // M-B: kein Silent-Drop — Fehler setzen den Delivery-Status auf
        // 'failed' (Retry in der Attestation-Liste über retryAttestation).
        attestationService.sendAttestation(identity, counter).catch((error) => {
          console.warn('Counter-verification delivery failed (status failed, retry available):', error)
        })

        setPendingIncoming(null)
        setStep('done')
      } catch (e) {
        const err = e instanceof Error ? e : new Error('Counter-verification failed')
        setError(err)
        setStep('error')
        throw err
      }
    },
    [identity, did, pendingIncoming, addContact, syncContactProfile, storage, attestationService, setPendingIncoming]
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

      const publicKey = verificationWorkflow.publicKeyFromDid(targetDid)
      await addContact(targetDid, publicKey, name, 'active')
      syncContactProfile(targetDid)

      const receivedAttestations = await storage.getReceivedAttestations()
      const original = receivedAttestations
        .filter(attestation =>
          attestation.from === targetDid &&
          attestation.to === did &&
          isVerificationAttestation(attestation) &&
          !attestation.inResponseTo
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
      if (!original) {
        throw new Error('No incoming verification attestation found')
      }

      const counter = await verificationWorkflow.createCounterVerificationAttestation({
        issuer: identity,
        subjectDid: targetDid,
        inResponseTo: original.id,
      })
      await storage.saveAttestation(counter)

      // K2 (Sync 003): Zustellung als inbox/1.0 {vcJws} — Inner-JWS + ECIES.
      // M-B: kein Silent-Drop — Fehler setzen den Delivery-Status auf
      // 'failed' (Retry in der Attestation-Liste über retryAttestation).
      attestationService.sendAttestation(identity, counter).catch((error) => {
        console.warn('Counter-verification delivery failed (status failed, retry available):', error)
      })
    },
    [identity, did, addContact, syncContactProfile, storage, attestationService]
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
