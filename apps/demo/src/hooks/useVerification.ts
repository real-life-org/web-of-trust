import { useState, useCallback, useRef, useMemo } from 'react'
import type { QrChallenge } from '@web_of_trust/core/protocol'
import { parseQrChallenge } from '@web_of_trust/core/protocol'
import { findOriginalVerificationAttestation } from '@web_of_trust/core/application'
import { useAdapters } from '../context'
import { useIdentity } from '../context'
import { useConfetti } from '../context/PendingVerificationContext'
import { useContacts } from './useContacts'
import { useMessaging } from './useMessaging'
import { useProfileSync } from './useProfileSync'
import { verificationWorkflow, bindVerificationDelivery } from '../services/verificationWorkflow'

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
  const { storage } = useAdapters()
  const { identity, did } = useIdentity()
  const { addContact } = useContacts()
  const { send, isConnected } = useMessaging()
  const { syncContactProfile } = useProfileSync()
  const { setChallengeNonce, pendingIncoming, setPendingIncoming } = useConfetti()

  // Framework-free verification-delivery-workflow: owns the relay-envelope
  // construction + signing + fire-and-forget send. The deprecated legacy
  // envelope-auth helper (wot-spec#96) is bound inside bindVerificationDelivery
  // (runtime), so its import never reaches this hook. Contact/persist stay
  // inline below (contact: undefined, persist: false) to keep the exact existing
  // side-effect order; createdAt is left at the workflow default (now()), which
  // matches the hook's previous new Date().toISOString() for byte parity.
  // transitional — modernized to DIDComm in 1.B.3 (Sync 003).
  const deliveryWorkflow = useMemo(
    () =>
      bindVerificationDelivery({
        send,
        // Read storage lazily at call time (the workflow only calls these ports
        // inside deliverAttestation, never at hook-render time).
        saveAttestation: (attestation) => storage.saveAttestation(attestation),
        addContact: async (did, publicKey, name, status) => {
          await addContact(did, publicKey, name, status)
        },
        syncContactProfile,
        sign: identity ? (data) => identity.sign(data) : () => Promise.reject(new Error('No identity found')),
      }),
    [send, storage, addContact, syncContactProfile, identity],
  )

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

        // Contact + profile-sync + persistence already ran inline above (exact
        // legacy order); delegate only envelope build + sign + fire-and-forget
        // send to the workflow.
        await deliveryWorkflow.deliverAttestation({
          attestation,
          fromDid: did!,
          toDid: decodedChallenge.did,
          persist: false,
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
    [identity, addContact, did, syncContactProfile, storage, deliveryWorkflow]
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

        await deliveryWorkflow.deliverAttestation({
          attestation: counter,
          fromDid: did,
          toDid: attestation.from,
          persist: false,
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
    [identity, did, pendingIncoming, addContact, syncContactProfile, storage, deliveryWorkflow, setPendingIncoming]
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
      const original = findOriginalVerificationAttestation(receivedAttestations, {
        targetDid,
        localDid: did,
      })
      if (!original) {
        throw new Error('No incoming verification attestation found')
      }

      const counter = await verificationWorkflow.createCounterVerificationAttestation({
        issuer: identity,
        subjectDid: targetDid,
        inResponseTo: original.id,
      })
      await storage.saveAttestation(counter)

      await deliveryWorkflow.deliverAttestation({
        attestation: counter,
        fromDid: did,
        toDid: targetDid,
        persist: false,
      })
    },
    [identity, did, addContact, syncContactProfile, storage, deliveryWorkflow]
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
