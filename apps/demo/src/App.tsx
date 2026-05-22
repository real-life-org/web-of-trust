import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { AdapterProvider, IdentityProvider, useIdentity, useAdapters, ConfettiProvider, useConfetti } from './context'
import { AppShell, IdentityManagement, Confetti } from './components'
import { Avatar } from './components/shared/Avatar'
import { X, Award, Users } from 'lucide-react'
import { Home, Identity, Contacts, Verify, Attestations, PublicProfile, Spaces, Network } from './pages'
import { useProfileSync, useMessaging, useContacts, useVerification, useLocalIdentity } from './hooks'
import { useVerificationStatus, getVerificationStatus } from './hooks/useVerificationStatus'
import type { Attestation, PublicProfile as PublicProfileType } from '@web_of_trust/core/types'
import { LanguageProvider, useLanguage } from './i18n'
import { DebugPanel } from './components/debug/DebugPanel'
import { verificationWorkflow } from './services/verificationWorkflow'
import type { AttestationVcPayload } from '@web_of_trust/core/protocol'

/**
 * Mounts useProfileSync globally so profile-update listeners
 * and initial contact sync run on every page, not just /identity.
 */
function ProfileSyncEffect() {
  useProfileSync()
  return null
}

/**
 * Global listener for incoming attestation relay messages.
 * Must be global (not inside useAttestations) so attestations are received
 * regardless of which page is currently rendered.
 */
function AttestationListenerEffect() {
  const { onMessage } = useMessaging()
  const { attestationService, messaging } = useAdapters()
  const { identity, did } = useIdentity()
  const { triggerAttestationDialog, setChallengeNonce, setPendingIncoming } = useConfetti()
  const { activeContacts } = useContacts()

  const didRef = useRef(did)
  didRef.current = did
  const identityRef = useRef(identity)
  identityRef.current = identity
  const messagingRef = useRef(messaging)
  messagingRef.current = messaging
  const activeContactsRef = useRef(activeContacts)
  activeContactsRef.current = activeContacts

  useEffect(() => {
    const unsubscribe = onMessage(async (envelope) => {
      if (envelope.type !== 'attestation') return
      try {
        const attestation: Attestation = JSON.parse(envelope.payload)
        if (!attestation.id || !attestation.from || !attestation.to ||
            !attestation.claim || !attestation.createdAt || !attestation.vcJws) return

        const localDid = didRef.current
        const localIdentity = identityRef.current

        let payload: AttestationVcPayload | null = null
        try {
          payload = await attestationService.verifyAttestationVcJws(attestation.vcJws)
        } catch {
          payload = null
        }

        const payloadClaimsVerification = payload !== null && isVerificationAttestationPayload(payload)
        const wrapperClaimsVerification = attestation.claim === VERIFICATION_ATTESTATION_CLAIM
        if (payloadClaimsVerification || wrapperClaimsVerification) {
          if (!payload || !payloadClaimsVerification || !wrapperClaimsVerification) return
          if (!payloadMatchesAttestation(payload, attestation)) return

          const verifiedPayload = payload
          if (!localDid || !localIdentity) return
          if (attestation.to !== localDid || verifiedPayload.sub !== localDid || verifiedPayload.credentialSubject.id !== localDid) return

          const decision = verifiedPayload.inResponseTo
            ? await verificationWorkflow.acceptVerifiedCounterVerification(localIdentity, verifiedPayload)
            : await verificationWorkflow.acceptVerifiedVerificationAttestation(localIdentity, verifiedPayload)

          if (decision.decision === 'accept-in-person') {
            let isNew = true
            try {
              await attestationService.saveIncomingAttestation(attestation)
            } catch {
              isNew = false
            }
            setChallengeNonce(null)
            if (isNew) setPendingIncoming({ attestation, fromDid: attestation.from })
            sendAttestationAck(attestation, localDid, messagingRef.current)
          } else if (decision.decision === 'accept-mutual-in-person') {
            try {
              await attestationService.saveIncomingAttestation(attestation)
            } catch {
              // Duplicate counter-verifications can still be acknowledged.
            }
            sendAttestationAck(attestation, localDid, messagingRef.current)
          }
          return
        }

        // Try to save — may throw on duplicate or invalid signature
        let isNew = true
        try {
          await attestationService.saveIncomingAttestation(attestation)
        } catch {
          isNew = false
        }

        // Always send ACK (even for duplicates — so sender gets acknowledged status)
        sendAttestationAck(attestation, didRef.current, messagingRef.current)

        // Only show dialog for new attestations
        if (isNew) {
          const contact = activeContactsRef.current.find(c => c.did === attestation.from)
          const name = contact?.name || 'Kontakt'
          triggerAttestationDialog({
            attestationId: attestation.id,
            senderName: name,
            senderDid: attestation.from,
            claim: attestation.claim,
          })
        }
      } catch (error) {
        console.debug('Incoming attestation skipped:', error)
      }
    })
    return unsubscribe
  }, [onMessage, attestationService, triggerAttestationDialog, setChallengeNonce, setPendingIncoming])

  return null
}

const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

function isVerificationAttestationPayload(payload: AttestationVcPayload): boolean {
  return (
    payload.type.includes('VerifiableCredential') &&
    payload.type.includes('WotAttestation') &&
    payload.credentialSubject.claim === VERIFICATION_ATTESTATION_CLAIM
  )
}

function payloadMatchesAttestation(payload: AttestationVcPayload, attestation: Attestation): boolean {
  return (
    payload.issuer === attestation.from &&
    payload.iss === attestation.from &&
    payload.sub === attestation.to &&
    payload.credentialSubject.id === attestation.to &&
    payload.credentialSubject.claim === attestation.claim &&
    payload.validFrom === attestation.createdAt &&
    (payload.inResponseTo == null ? attestation.inResponseTo == null : payload.inResponseTo === attestation.inResponseTo) &&
    (payload.jti == null || payload.jti === attestation.id) &&
    (payload.id == null || payload.id === attestation.id)
  )
}

function sendAttestationAck(attestation: Attestation, fromDid: string | null | undefined, messaging: ReturnType<typeof useAdapters>['messaging'] | null): void {
  if (!fromDid || !messaging) return
  messaging.send({
    v: 1,
    id: `ack-${attestation.id}`,
    type: 'attestation-ack',
    fromDid,
    toDid: attestation.from,
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: JSON.stringify({ attestationId: attestation.id }),
    signature: '',
  }).catch(() => {})
}

/**
 * Reactive mutual verification detection.
 *
 * Watches all verifications and triggers confetti when a contact's
 * status transitions to "mutual". No session state needed.
 */
function MutualVerificationEffect() {
  const { triggerMutualDialog } = useConfetti()
  const { did } = useIdentity()
  const { activeContacts } = useContacts()
  const { allVerifications } = useVerificationStatus()
  const { t } = useLanguage()

  // Track which mutual-DIDs we already showed confetti for.
  const shownRef = useRef<Set<string>>(new Set())
  // On first data load, seed with all existing mutuals (don't show confetti for old ones).
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!did || activeContacts.length === 0) return

    // First time we have data: mark all existing mutuals as already seen
    if (!initializedRef.current) {
      initializedRef.current = true
      for (const contact of activeContacts) {
        const status = getVerificationStatus(did, contact.did, allVerifications)
        if (status === 'mutual') {
          shownRef.current.add(contact.did)
        }
      }
      return
    }

    for (const contact of activeContacts) {
      const status = getVerificationStatus(did, contact.did, allVerifications)
      if (status === 'mutual' && !shownRef.current.has(contact.did)) {
        shownRef.current.add(contact.did)
        triggerMutualDialog({ name: contact.name || t.app.contactFallback, did: contact.did })
      }
    }
  }, [did, activeContacts, allVerifications, triggerMutualDialog])

  return null
}

/**
 * Dialog shown when mutual verification is detected.
 * Extracted so hooks are only called when mutualPeer exists.
 */
function MutualVerificationDialog() {
  const { mutualPeer, dismissMutualDialog } = useConfetti()
  const { discovery } = useAdapters()
  const localIdentity = useLocalIdentity()
  const navigate = useNavigate()
  const { t, fmt } = useLanguage()
  const [peerProfile, setPeerProfile] = useState<PublicProfileType | null>(null)

  useEffect(() => {
    if (!mutualPeer) { setPeerProfile(null); return }
    let cancelled = false
    discovery.resolveProfile(mutualPeer.did)
      .then((r) => { if (!cancelled && r.profile) setPeerProfile(r.profile) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [mutualPeer, discovery])

  if (!mutualPeer) return null

  const peerName = peerProfile?.name || mutualPeer.name

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="mutual-dialog-title">
      <div className="bg-background rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 animate-toast-in relative">
        <button
          onClick={dismissMutualDialog}
          className="absolute top-3 right-3 p-2 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
          aria-label={t.aria.closeDialog}
        >
          <X size={20} />
        </button>
        <div className="flex flex-col items-center gap-3 py-2">
          <div className="flex items-center -space-x-3">
            <Avatar
              name={localIdentity?.profile?.name}
              avatar={localIdentity?.profile?.avatar}
              size="lg"
            />
            <Avatar
              name={peerProfile?.name || mutualPeer.name}
              avatar={peerProfile?.avatar}
              size="lg"
            />
          </div>
          <h3 id="mutual-dialog-title" className="text-lg font-bold text-foreground text-center">
            {fmt(t.app.mutualFriendsTitle, { name: peerName })}
          </h3>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={() => {
              dismissMutualDialog()
              navigate(`/attestations/new?to=${encodeURIComponent(mutualPeer.did)}`)
            }}
            className="flex-1 px-4 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
          >
            {t.app.createAttestation}
          </button>
          <button
            onClick={() => {
              dismissMutualDialog()
              navigate(`/p/${encodeURIComponent(mutualPeer.did)}`)
            }}
            className="flex-1 px-4 py-3 border-2 border-border text-foreground/80 font-medium rounded-xl hover:bg-background transition-colors"
          >
            {t.app.viewProfile}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Dialog shown when an incoming attestation is received.
 */
function IncomingAttestationDialog() {
  const { incomingAttestation, dismissAttestationDialog } = useConfetti()
  const { attestationService } = useAdapters()
  const { uploadVerificationsAndAttestations } = useProfileSync()
  const { t, fmt } = useLanguage()

  if (!incomingAttestation) return null

  const handlePublish = async () => {
    await attestationService.setAttestationAccepted(incomingAttestation.attestationId, true)
    uploadVerificationsAndAttestations()
    dismissAttestationDialog()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="attestation-dialog-title">
      <div className="bg-background rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 animate-toast-in relative">
        <button
          onClick={dismissAttestationDialog}
          className="absolute top-3 right-3 p-2 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
          aria-label={t.aria.closeDialog}
        >
          <X size={20} />
        </button>
        <h3 id="attestation-dialog-title" className="text-lg font-bold text-foreground">
          {fmt(t.app.newAttestationFrom, { name: incomingAttestation.senderName })}
        </h3>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
            <Award className="w-6 h-6 text-amber-600" />
          </div>
          <p className="text-sm text-muted-foreground">
            &ldquo;{incomingAttestation.claim}&rdquo;
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={dismissAttestationDialog}
            className="flex-1 px-4 py-3 border-2 border-border text-foreground/80 font-medium rounded-xl hover:bg-background transition-colors"
          >
            {t.common.close}
          </button>
          <button
            onClick={handlePublish}
            className="flex-1 px-4 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
          >
            {t.common.publish}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Global listener for incoming space-invite relay messages.
 * Triggers a dialog so the user knows they were added to a space.
 */
function SpaceInviteListenerEffect() {
  const { onMessage } = useMessaging()
  const { triggerSpaceInviteDialog } = useConfetti()
  const { activeContacts } = useContacts()
  const { t } = useLanguage()

  const activeContactsRef = useRef(activeContacts)
  activeContactsRef.current = activeContacts

  useEffect(() => {
    const unsubscribe = onMessage(async (envelope) => {
      if (envelope.type !== 'space-invite') return
      try {
        const payload = JSON.parse(envelope.payload)
        const contact = activeContactsRef.current.find(c => c.did === envelope.fromDid)
        const inviterName = contact?.name || t.app.contactFallback
        triggerSpaceInviteDialog({
          spaceId: payload.spaceId,
          spaceName: payload.spaceInfo?.name || payload.spaceName || t.spaces.unnamed,
          inviterName,
          inviterDid: envelope.fromDid,
        })
      } catch {
        // Invalid payload — ignore
      }
    })
    return unsubscribe
  }, [onMessage, triggerSpaceInviteDialog])

  return null
}

function IncomingSpaceInviteDialog() {
  const { incomingSpaceInvite, dismissSpaceInviteDialog } = useConfetti()
  const { t, fmt } = useLanguage()
  const navigate = useNavigate()

  if (!incomingSpaceInvite) return null

  const handleOpen = () => {
    dismissSpaceInviteDialog()
    navigate(`/chats/${incomingSpaceInvite.spaceId}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="space-invite-dialog-title">
      <div className="bg-background rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 animate-toast-in relative">
        <button
          onClick={dismissSpaceInviteDialog}
          className="absolute top-3 right-3 p-2 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
          aria-label={t.aria.closeDialog}
        >
          <X size={20} />
        </button>
        <h3 id="space-invite-dialog-title" className="text-lg font-bold text-foreground">
          {t.app.spaceInviteTitle}
        </h3>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
            <Users className="w-6 h-6 text-primary-600" />
          </div>
          <p className="text-sm text-muted-foreground">
            {fmt(t.app.spaceInviteMessage, { name: incomingSpaceInvite.inviterName, spaceName: incomingSpaceInvite.spaceName })}
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={dismissSpaceInviteDialog}
            className="flex-1 px-4 py-3 border-2 border-border text-foreground/80 font-medium rounded-xl hover:bg-background transition-colors"
          >
            {t.common.close}
          </button>
          <button
            onClick={handleOpen}
            className="flex-1 px-4 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
          >
            {t.app.openSpace}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Renders global confetti + mutual verification dialog.
 */
function GlobalConfetti() {
  const { confettiKey } = useConfetti()

  if (confettiKey === 0) return null

  return (
    <>
      <Confetti key={confettiKey} />
      <MutualVerificationDialog />
    </>
  )
}

/**
 * Global overlay dialog for incoming verification requests.
 * Shows "Stehst du vor dieser Person?" regardless of current page.
 */
function IncomingVerificationDialog() {
  const { pendingIncoming } = useConfetti()
  const { confirmIncoming, rejectIncoming } = useVerification()
  const { discovery } = useAdapters()
  const { t } = useLanguage()
  const [profile, setProfile] = useState<PublicProfileType | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!pendingIncoming) { setProfile(null); return }
    let cancelled = false
    discovery.resolveProfile(pendingIncoming.fromDid)
      .then((r) => { if (!cancelled && r.profile) setProfile(r.profile) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [pendingIncoming, discovery])

  if (!pendingIncoming) return null

  const incomingDid = pendingIncoming.fromDid
  const name = profile?.name || incomingDid.slice(-12)

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      await confirmIncoming()
    } catch (e) {
      console.error('Counter-verification failed:', e)
    }
    setConfirming(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="verification-dialog-title">
      <div className="bg-background rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
        <h3 id="verification-dialog-title" className="text-lg font-bold text-foreground text-center">
          {t.verification.confirmQuestion}
        </h3>

        <div className="flex flex-col items-center gap-3 py-2">
          <Avatar name={profile?.name} avatar={profile?.avatar} size="lg" />
          <div className="text-center">
            <p className="text-xl font-semibold text-foreground">{name}</p>
            {profile?.bio && (
              <p className="text-sm text-muted-foreground mt-1">{profile.bio}</p>
            )}
            <p className="text-xs text-muted-foreground/70 font-mono mt-1 max-w-[280px] truncate">
              {incomingDid}
            </p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground text-center">
          {t.verification.confirmHint}
        </p>

        <div className="flex gap-3 pt-2">
          <button
            onClick={rejectIncoming}
            className="flex-1 px-4 py-3 border-2 border-destructive/30 text-destructive font-medium rounded-xl hover:bg-destructive/10 transition-colors"
          >
            {t.app.reject}
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="flex-1 px-4 py-3 bg-success text-white font-medium rounded-xl hover:bg-success/80 transition-colors disabled:opacity-50"
          >
            {confirming ? t.app.sending : t.common.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * RequireIdentity gate - shows onboarding if no unlocked identity.
 * Once identity is unlocked, it renders AdapterProvider and the rest of the app.
 */
function RequireIdentity({ children }: { children: React.ReactNode }) {
  const { identity, did, hasStoredIdentity, setIdentity } = useIdentity()
  const { t } = useLanguage()

  // Still checking if identity exists in storage
  if (hasStoredIdentity === null) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-muted-foreground">{t.common.loading}</p>
        </div>
      </div>
    )
  }

  // Identity not unlocked yet (but might be stored)
  if (!identity || !did) {
    return (
      <div className="h-full overflow-y-auto flex items-center justify-center p-4">
        <IdentityManagement
          onComplete={(newIdentity, newDid, initialProfile) => {
            setIdentity(newIdentity, newDid, initialProfile)
          }}
        />
      </div>
    )
  }

  // Identity is unlocked -> initialize adapters
  return (
    <AdapterProvider identity={identity}>
      <ConfettiProvider>
        <ProfileSyncEffect />
        <AttestationListenerEffect />
        <SpaceInviteListenerEffect />
        <MutualVerificationEffect />
        <GlobalConfetti />
        <IncomingVerificationDialog />
        <IncomingAttestationDialog />
        <IncomingSpaceInviteDialog />
        {children}
        {import.meta.env.DEV && <DebugPanel />}
      </ConfettiProvider>
    </AdapterProvider>
  )
}

/**
 * Standalone wrapper for /p/:did when not logged in.
 */
function PublicProfileStandalone() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <PublicProfile />
      </div>
    </div>
  )
}

/**
 * Top-level router: /p/:did is public (no login required).
 * All other routes go through RequireIdentity.
 * When logged in, /p/:did renders inside AppShell with navigation.
 */
function AppRoutes() {
  const { identity, hasStoredIdentity } = useIdentity()

  // Still initializing or auto-unlocking — don't flash the standalone layout.
  // hasStoredIdentity === null means check hasn't finished yet.
  // hasStoredIdentity === true && !identity means auto-unlock failed, passphrase needed.
  // In both cases, go through RequireIdentity (which shows loading or passphrase prompt).
  if (!identity && hasStoredIdentity !== false) {
    return (
      <RequireIdentity>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Home />} />
            <Route path="/identity" element={<Identity />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/verify" element={<Verify />} />
            <Route path="/attestations/*" element={<Attestations />} />
            <Route path="/chats/*" element={<Spaces />} />
            <Route path="/network" element={<Network />} />
            <Route path="/p/:did" element={<PublicProfile />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </RequireIdentity>
    )
  }

  // Definitely not logged in (no stored identity): /p/:did is standalone, rest goes to onboarding
  if (!identity) {
    return (
      <Routes>
        <Route path="/p/:did" element={<PublicProfileStandalone />} />
        <Route path="*" element={
          <RequireIdentity>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </RequireIdentity>
        } />
      </Routes>
    )
  }

  // Logged in: all routes inside AppShell
  return (
    <RequireIdentity>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/identity" element={<Identity />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/attestations/*" element={<Attestations />} />
          <Route path="/chats/*" element={<Spaces />} />
          <Route path="/network" element={<Network />} handle={{ fullscreen: true }} />
          <Route path="/p/:did" element={<PublicProfile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </RequireIdentity>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <LanguageProvider>
        <IdentityProvider>
          <AppRoutes />
        </IdentityProvider>
      </LanguageProvider>
    </BrowserRouter>
  )
}
