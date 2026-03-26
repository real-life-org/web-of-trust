import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import type { Verification } from '@web.of.trust/core'

/** Incoming verification awaiting user confirmation (from QR scan). */
export interface PendingIncoming {
  verification: Verification
  fromDid: string
}

/** Info about the peer for the mutual verification dialog. */
export interface MutualPeerInfo {
  name: string
  did: string
}

/** Info about an incoming attestation for the dialog. */
export interface IncomingAttestationInfo {
  attestationId: string
  senderName: string
  senderDid: string
  claim: string
}

/** Info about an incoming space invite for the dialog. */
export interface IncomingSpaceInviteInfo {
  spaceId: string
  spaceName: string
  inviterName: string
  inviterDid: string
}

export type NotificationType = 'mutual-verification' | 'incoming-attestation' | 'incoming-verification' | 'space-invite'

export interface QueuedNotification {
  id: string
  type: NotificationType
  data: MutualPeerInfo | IncomingAttestationInfo | PendingIncoming | IncomingSpaceInviteInfo
}

interface ConfettiContextType {
  confettiKey: number
  toastMessage: string | null
  triggerConfetti: (message?: string) => void
  mutualPeer: MutualPeerInfo | null
  triggerMutualDialog: (peer: MutualPeerInfo) => void
  dismissMutualDialog: () => void
  incomingAttestation: IncomingAttestationInfo | null
  triggerAttestationDialog: (info: IncomingAttestationInfo) => void
  dismissAttestationDialog: () => void
  incomingSpaceInvite: IncomingSpaceInviteInfo | null
  triggerSpaceInviteDialog: (info: IncomingSpaceInviteInfo) => void
  dismissSpaceInviteDialog: () => void
  challengeNonce: string | null
  setChallengeNonce: (nonce: string | null) => void
  pendingIncoming: PendingIncoming | null
  setPendingIncoming: (pending: PendingIncoming | null) => void
}

const ConfettiContext = createContext<ConfettiContextType | null>(null)

export function ConfettiProvider({ children }: { children: ReactNode }) {
  const [confettiKey, setConfettiKey] = useState(0)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [challengeNonce, setChallengeNonce] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueuedNotification[]>([])

  const enqueue = useCallback((notification: QueuedNotification) => {
    setQueue(prev => prev.some(n => n.id === notification.id) ? prev : [...prev, notification])
  }, [])

  const dismiss = useCallback(() => {
    setQueue(prev => prev.slice(1))
  }, [])

  // Derive current dialog states from the first item in the queue
  const current = queue[0] ?? null
  const mutualPeer = useMemo(
    () => current?.type === 'mutual-verification' ? current.data as MutualPeerInfo : null,
    [current],
  )
  const incomingAttestation = useMemo(
    () => current?.type === 'incoming-attestation' ? current.data as IncomingAttestationInfo : null,
    [current],
  )
  const pendingIncoming = useMemo(
    () => current?.type === 'incoming-verification' ? current.data as PendingIncoming : null,
    [current],
  )
  const incomingSpaceInvite = useMemo(
    () => current?.type === 'space-invite' ? current.data as IncomingSpaceInviteInfo : null,
    [current],
  )

  // Wrapper functions — keep existing API stable for consumers

  const triggerConfetti = useCallback((message?: string) => {
    setConfettiKey(k => k + 1)
    setToastMessage(message ?? null)
  }, [])

  const triggerMutualDialog = useCallback((peer: MutualPeerInfo) => {
    setConfettiKey(k => k + 1)
    enqueue({ id: 'mutual-' + peer.did, type: 'mutual-verification', data: peer })
  }, [enqueue])

  const dismissMutualDialog = useCallback(() => {
    dismiss()
  }, [dismiss])

  const triggerAttestationDialog = useCallback((info: IncomingAttestationInfo) => {
    enqueue({ id: 'att-' + info.attestationId, type: 'incoming-attestation', data: info })
  }, [enqueue])

  const dismissAttestationDialog = useCallback(() => {
    dismiss()
  }, [dismiss])

  const triggerSpaceInviteDialog = useCallback((info: IncomingSpaceInviteInfo) => {
    enqueue({ id: 'space-' + info.spaceId, type: 'space-invite', data: info })
  }, [enqueue])

  const dismissSpaceInviteDialog = useCallback(() => {
    dismiss()
  }, [dismiss])

  const setPendingIncoming = useCallback((pending: PendingIncoming | null) => {
    if (pending) {
      enqueue({ id: 'ver-' + pending.fromDid, type: 'incoming-verification', data: pending })
    } else {
      dismiss()
    }
  }, [enqueue, dismiss])

  return (
    <ConfettiContext.Provider value={{
      confettiKey, toastMessage, triggerConfetti,
      mutualPeer, triggerMutualDialog, dismissMutualDialog,
      incomingAttestation, triggerAttestationDialog, dismissAttestationDialog,
      incomingSpaceInvite, triggerSpaceInviteDialog, dismissSpaceInviteDialog,
      challengeNonce, setChallengeNonce,
      pendingIncoming, setPendingIncoming,
    }}>
      {children}
    </ConfettiContext.Provider>
  )
}

export function useConfetti() {
  const ctx = useContext(ConfettiContext)
  if (!ctx) {
    throw new Error('useConfetti must be used within ConfettiProvider')
  }
  return ctx
}

// Legacy alias — will be removed after all consumers are migrated
export const PendingVerificationProvider = ConfettiProvider
export const usePendingVerification = useConfetti
