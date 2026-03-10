import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { AdapterProvider, IdentityProvider, useIdentity, useAdapters, PendingVerificationProvider, usePendingVerification } from './context'
import { useConfetti } from './context/PendingVerificationContext'
import { AppShell, IdentityManagement, Confetti } from './components'
import { Avatar } from './components/shared/Avatar'
import { X, Award } from 'lucide-react'
import { Home, Identity, Contacts, Verify, Attestations, PublicProfile, Spaces } from './pages'
import { useProfileSync, useMessaging, useContacts, useVerification, useLocalIdentity } from './hooks'
import { useVerificationStatus, getVerificationStatus } from './hooks/useVerificationStatus'
import { VerificationHelper } from '@real-life/wot-core'
import type { Attestation, Verification, PublicProfile as PublicProfileType } from '@real-life/wot-core'
import { LanguageProvider, useLanguage } from './i18n'

/**
 * Mounts useProfileSync globally so profile-update listeners
 * and initial contact sync run on every page, not just /identity.
 */
function ProfileSyncEffect() {
  useProfileSync()
  return null
}

/**
 * Global listener for verification relay messages.
 *
 * receive → verify signature → save → auto counter-verification if needed.
 *
 * Counter-verification: when I receive a verification from a contact
 * and I haven't verified them yet, automatically create + send one back.
 * This makes the flow symmetric: B scans A's QR → both get verified.
 */
function VerificationListenerEffect() {
  const { onMessage } = useMessaging()
  const { verificationService } = useAdapters()
  const { did } = useIdentity()
  const { challengeNonce, setChallengeNonce, setPendingIncoming } = useConfetti()

  // Use ref so the onMessage callback always sees current nonce
  // without needing to re-subscribe (which can lose messages).
  const challengeNonceRef = useRef(challengeNonce)
  challengeNonceRef.current = challengeNonce

  useEffect(() => {
    const unsubscribe = onMessage(async (envelope) => {
      if (envelope.type !== 'verification') return

      let verification: Verification
      try {
        verification = JSON.parse(envelope.payload)
      } catch {
        return
      }

      if (!verification.id || !verification.from || !verification.to || !verification.proof) return

      try {
        const isValid = await VerificationHelper.verifySignature(verification)
        if (!isValid) return

        await verificationService.saveVerification(verification)
      } catch {
        return
      }

      // Counter-verification: if I'm the recipient and the verification
      // contains my active challenge nonce (proves physical QR scan)
      // → show confirmation UI. Re-verification is allowed (renewal).
      if (did && verification.to === did) {
        const nonce = challengeNonceRef.current

        if (nonce && verification.id.includes(nonce)) {
          setChallengeNonce(null) // Nonce consumed
          setPendingIncoming({ verification, fromDid: verification.from })
        }
      }
    })
    return unsubscribe
  }, [onMessage, verificationService, did, setChallengeNonce, setPendingIncoming])

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
  const { did } = useIdentity()
  const { triggerAttestationDialog } = usePendingVerification()
  const { activeContacts } = useContacts()

  const didRef = useRef(did)
  didRef.current = did
  const messagingRef = useRef(messaging)
  messagingRef.current = messaging
  const activeContactsRef = useRef(activeContacts)
  activeContactsRef.current = activeContacts

  useEffect(() => {
    const unsubscribe = onMessage(async (envelope) => {
      if (envelope.type !== 'attestation') return
      try {
        const attestation: Attestation = JSON.parse(envelope.payload)

        // Try to save — may throw on duplicate or invalid signature
        let isNew = true
        try {
          await attestationService.saveIncomingAttestation(attestation)
        } catch {
          isNew = false
        }

        // Always send ACK (even for duplicates — so sender gets acknowledged status)
        if (didRef.current && messagingRef.current) {
          messagingRef.current.send({
            v: 1,
            id: `ack-${attestation.id}`,
            type: 'attestation-ack',
            fromDid: didRef.current,
            toDid: attestation.from,
            createdAt: new Date().toISOString(),
            encoding: 'json',
            payload: JSON.stringify({ attestationId: attestation.id }),
            signature: '',
          }).catch(() => {}) // best-effort
        }

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
  }, [onMessage, attestationService, triggerAttestationDialog])

  return null
}

/**
 * Reactive mutual verification detection.
 *
 * Watches all verifications and triggers confetti when a contact's
 * status transitions to "mutual". No session state needed.
 */
function MutualVerificationEffect() {
  const { triggerMutualDialog } = usePendingVerification()
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
  const { mutualPeer, dismissMutualDialog } = usePendingVerification()
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 animate-toast-in relative">
        <button
          onClick={dismissMutualDialog}
          className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-slate-600 transition-colors"
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
          <h3 className="text-lg font-bold text-slate-900 text-center">
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
            className="flex-1 px-4 py-3 border-2 border-slate-200 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
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
  const { incomingAttestation, dismissAttestationDialog } = usePendingVerification()
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 animate-toast-in relative">
        <button
          onClick={dismissAttestationDialog}
          className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X size={20} />
        </button>
        <h3 className="text-lg font-bold text-slate-900">
          {fmt(t.app.newAttestationFrom, { name: incomingAttestation.senderName })}
        </h3>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
            <Award className="w-6 h-6 text-amber-600" />
          </div>
          <p className="text-sm text-slate-600">
            &ldquo;{incomingAttestation.claim}&rdquo;
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={dismissAttestationDialog}
            className="flex-1 px-4 py-3 border-2 border-slate-200 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
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
 * Renders global confetti + mutual verification dialog.
 */
function GlobalConfetti() {
  const { confettiKey } = usePendingVerification()

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
        <h3 className="text-lg font-bold text-slate-900 text-center">
          {t.verification.confirmQuestion}
        </h3>

        <div className="flex flex-col items-center gap-3 py-2">
          <Avatar name={profile?.name} avatar={profile?.avatar} size="lg" />
          <div className="text-center">
            <p className="text-xl font-semibold text-slate-900">{name}</p>
            {profile?.bio && (
              <p className="text-sm text-slate-500 mt-1">{profile.bio}</p>
            )}
            <p className="text-xs text-slate-400 font-mono mt-1 max-w-[280px] truncate">
              {incomingDid}
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-600 text-center">
          {t.verification.confirmHint}
        </p>

        <div className="flex gap-3 pt-2">
          <button
            onClick={rejectIncoming}
            className="flex-1 px-4 py-3 border-2 border-red-200 text-red-600 font-medium rounded-xl hover:bg-red-50 transition-colors"
          >
            {t.app.reject}
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="flex-1 px-4 py-3 bg-green-600 text-white font-medium rounded-xl hover:bg-green-700 transition-colors disabled:opacity-50"
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
 * Once identity is unlocked, it renders AdapterProvider (which inits Evolu)
 * and then the rest of the app.
 */
function RequireIdentity({ children }: { children: React.ReactNode }) {
  const { identity, did, hasStoredIdentity, setIdentity } = useIdentity()
  const { t } = useLanguage()

  // Still checking if identity exists in storage
  if (hasStoredIdentity === null) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-gray-600">{t.common.loading}</p>
        </div>
      </div>
    )
  }

  // Identity not unlocked yet (but might be stored)
  if (!identity || !did) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <IdentityManagement
          onComplete={(newIdentity, newDid, initialProfile) => {
            setIdentity(newIdentity, newDid, initialProfile)
          }}
        />
      </div>
    )
  }

  // Identity is unlocked -> initialize Evolu with identity-derived keys
  return (
    <AdapterProvider identity={identity}>
      <PendingVerificationProvider>
        <ProfileSyncEffect />
        <VerificationListenerEffect />
        <AttestationListenerEffect />
        <MutualVerificationEffect />
        <GlobalConfetti />
        <IncomingVerificationDialog />
        <IncomingAttestationDialog />
        {children}
      </PendingVerificationProvider>
    </AdapterProvider>
  )
}

/**
 * Standalone wrapper for /p/:did when not logged in.
 */
function PublicProfileStandalone() {
  return (
    <div className="min-h-screen bg-slate-50">
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
            <Route path="/spaces/*" element={<Spaces />} />
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
          <Route path="/spaces/*" element={<Spaces />} />
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
