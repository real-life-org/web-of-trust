import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Attestation } from '@web_of_trust/core/types'
import { useOptionalAdapters } from './AdapterContext'

/** Incoming verification awaiting user confirmation (from QR scan). */
export interface PendingIncoming {
  attestation: Attestation
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
  /**
   * Per-event unique invite message id (the inbox envelope's outerId) — the
   * notification identity. A per-space key would permanently block re-invites
   * of the same space after one resolve.
   */
  inviteMessageId: string
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

/**
 * Generic dialog lifecycle (multi-device):
 * - OPEN  iff a fresh event arrives AND the notification id is NOT in the
 *   synced dismissedNotifications map (checked synchronously at enqueue).
 * - CLOSE as soon as the id appears in dismissedNotifications — observed
 *   reactively, so a resolve on any device closes the dialog on all devices.
 * - Resolving (acting OR dismissing) writes the id into the synced map,
 *   additive to the domain action.
 * The adapter access is optional: outside an AdapterProvider (tests) the
 * queue degrades to the previous local-only behavior.
 */
export function ConfettiProvider({ children }: { children: ReactNode }) {
  const [confettiKey, setConfettiKey] = useState(0)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [challengeNonce, setChallengeNonce] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueuedNotification[]>([])

  const adapters = useOptionalAdapters()
  const storage = adapters?.storage ?? null
  const reactiveStorage = adapters?.reactiveStorage ?? null
  const resolutionSub = useMemo(
    () => reactiveStorage?.watchNotificationResolution() ?? null,
    [reactiveStorage],
  )

  // Refs so the stable callbacks read the CURRENT snapshot/queue synchronously.
  const resolutionSubRef = useRef(resolutionSub)
  resolutionSubRef.current = resolutionSub
  const storageRef = useRef(storage)
  storageRef.current = storage
  const queueRef = useRef(queue)
  queueRef.current = queue

  /** Synchronous OPEN gate: resolved ids never (re-)enter the queue. */
  const isResolved = useCallback((id: string): boolean => {
    const resolved = resolutionSubRef.current?.getValue()
    return resolved != null && id in resolved
  }, [])

  /** Returns true when the notification actually entered the queue. */
  const enqueue = useCallback((notification: QueuedNotification): boolean => {
    if (isResolved(notification.id)) return false
    setQueue(prev => prev.some(n => n.id === notification.id) ? prev : [...prev, notification])
    return true
  }, [isResolved])

  /**
   * Event-id-scoped dismiss: resolves + removes EXACTLY the notification the
   * caller saw, never "whatever is at the head now". A type-only scope races
   * async dialog handlers: while a handler awaits, a synced CLOSE can remove
   * the visible dialog A — a later head-based dismiss would then permanently
   * resolve the NEXT same-type notification B the user never handled. If the
   * id is already gone from the queue (remote close won the race) this is a
   * no-op; if it is already resolved, only the local removal runs (no echo
   * write that would extend the marker's GC-TTL).
   */
  const dismiss = useCallback((type: NotificationType, id: string) => {
    const target = queueRef.current.find(n => n.id === id)
    if (!target || target.type !== type) return
    if (!isResolved(id)) {
      storageRef.current?.markNotificationResolved(id).catch((error) => {
        console.warn('Failed to persist notification resolution:', error)
      })
    }
    setQueue(prev => prev.filter(n => n.id !== id))
  }, [isResolved])

  // CLOSE observe: a resolve synced from ANY device removes matching items.
  useEffect(() => {
    if (!resolutionSub) return
    const applyResolved = (resolved: Record<string, { resolvedAt: string }>) => {
      setQueue(prev => prev.some(n => n.id in resolved) ? prev.filter(n => !(n.id in resolved)) : prev)
    }
    applyResolved(resolutionSub.getValue())
    return resolutionSub.subscribe(applyResolved)
  }, [resolutionSub])

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

  // Render-scoped identity of the currently shown notification: the dismiss
  // wrappers close over THESE values, so an async handler that clicked on
  // dialog A keeps resolving A even if the queue head moved to B meanwhile.
  // Deliberately NOT a ref — a ref would read the latest head and reintroduce
  // the wrong-item race.
  const currentId = current?.id ?? null
  const currentType = current?.type ?? null

  // Wrapper functions — keep existing API stable for consumers

  const triggerConfetti = useCallback((message?: string) => {
    setConfettiKey(k => k + 1)
    setToastMessage(message ?? null)
  }, [])

  const triggerMutualDialog = useCallback((peer: MutualPeerInfo) => {
    // Per-contact id (INTENTIONAL, not per-event): the mutual dialog is the
    // one-time "you and X are connected!" celebration — it fires once per
    // contact, deliberately NOT again on a later re-verification.
    if (enqueue({ id: 'mutual-' + peer.did, type: 'mutual-verification', data: peer })) {
      setConfettiKey(k => k + 1)
    }
  }, [enqueue])

  const dismissMutualDialog = useCallback(() => {
    if (currentType === 'mutual-verification' && currentId !== null) dismiss('mutual-verification', currentId)
  }, [dismiss, currentType, currentId])

  const triggerAttestationDialog = useCallback((info: IncomingAttestationInfo) => {
    enqueue({ id: 'att-' + info.attestationId, type: 'incoming-attestation', data: info })
  }, [enqueue])

  const dismissAttestationDialog = useCallback(() => {
    if (currentType === 'incoming-attestation' && currentId !== null) dismiss('incoming-attestation', currentId)
  }, [dismiss, currentType, currentId])

  const triggerSpaceInviteDialog = useCallback((info: IncomingSpaceInviteInfo) => {
    enqueue({ id: 'space-' + info.inviteMessageId, type: 'space-invite', data: info })
  }, [enqueue])

  const dismissSpaceInviteDialog = useCallback(() => {
    if (currentType === 'space-invite' && currentId !== null) dismiss('space-invite', currentId)
  }, [dismiss, currentType, currentId])

  const setPendingIncoming = useCallback((pending: PendingIncoming | null) => {
    if (pending) {
      // Per-event id (attestation id) — a per-DID key would block every
      // future verification from the same contact after one resolve.
      enqueue({ id: 'ver-' + pending.attestation.id, type: 'incoming-verification', data: pending })
    } else if (currentType === 'incoming-verification' && currentId !== null) {
      // Callers like useVerification.reset() fire this unconditionally — the
      // type + id scope keeps them from resolving an unrelated dialog.
      dismiss('incoming-verification', currentId)
    }
  }, [enqueue, dismiss, currentType, currentId])

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
