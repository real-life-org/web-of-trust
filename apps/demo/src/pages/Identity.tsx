import { useIdentity, useConfetti } from '../context'
import { useAdapters } from '../context'
import { useLanguage, plural } from '../i18n'
import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Check, ShieldCheck, Trash2, Pencil, ChevronDown, ChevronRight, Users, Award, Globe, GlobeLock, Share2, Link as LinkIcon, ArrowRight, Fingerprint } from 'lucide-react'
import { Avatar, AvatarUpload, TagInput } from '../components/shared'
import { Tooltip } from '../components/ui/Tooltip'
// personalDocManager functions loaded dynamically to keep WASM out of default bundle
import { useProfile, useProfileSync, useAttestations, useContacts } from '../hooks'
import { isVerificationAttestation } from '../hooks/useVerificationStatus'
import { BiometricService } from '../services/BiometricService'
import { createIdentityWorkflow } from '../services/identityWorkflow'
import { resetLocalAppData, findSurvivingWipeTier } from '../services/resetLocalAppData'
import { getCurrentBundleId, getLastUpdatedAt } from '../live-update'
import { copyToClipboard } from '../lib/clipboard'

export function Identity() {
  const { t, fmt, formatDate } = useLanguage()
  const { identity, did, clearIdentity, biometricEnrolled, refreshBiometricStatus } = useIdentity()
  const { storage } = useAdapters()
  const { uploadProfile, uploadAttestations } = useProfileSync()
  const syncedProfile = useProfile()
  const { receivedAttestations, setAttestationAccepted } = useAttestations()
  const { contacts } = useContacts()
  const { incomingAttestation } = useConfetti()

  const verificationAttestations = useMemo(() => {
    // Ein Gerät/DID kann mich mehrfach verifiziert haben — in „Verbunden mit …"
    // pro Peer-DID nur EINMAL zeigen (neueste Verifikation gewinnt), damit die
    // Anzahl echte Menschen/Geräte zählt, nicht Verifikations-Ereignisse.
    const all = receivedAttestations.filter(isVerificationAttestation)
    const byPeer = new Map<string, (typeof all)[number]>()
    for (const a of all) {
      const cur = byPeer.get(a.from)
      if (!cur || Date.parse(a.createdAt) > Date.parse(cur.createdAt)) byPeer.set(a.from, a)
    }
    return Array.from(byPeer.values())
  }, [receivedAttestations])
  const genericReceivedAttestations = useMemo(
    () => receivedAttestations.filter(a => !isVerificationAttestation(a)),
    [receivedAttestations],
  )

  // Attestation accepted state
  const [acceptedMap, setAcceptedMap] = useState<Record<string, boolean>>({})
  const [copiedDid, setCopiedDid] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [profileBio, setProfileBio] = useState('')
  const [profileAvatar, setProfileAvatar] = useState<string | undefined>(undefined)
  const [profileOffers, setProfileOffers] = useState<string[]>([])
  const [profileNeeds, setProfileNeeds] = useState<string[]>([])
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [shared, setShared] = useState(false)
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [biometricToggling, setBiometricToggling] = useState(false)
  const [bundleId, setBundleId] = useState<string | null>(null)
  const lastUpdatedAt = getLastUpdatedAt()

  // Check biometric hardware availability
  useEffect(() => {
    BiometricService.isAvailable().then(setBiometricAvailable)
    getCurrentBundleId().then(setBundleId)
  }, [])

  // Sync profile reactively — updates when synced from other device
  // Skip when justSaved is true to avoid overwriting with stale snapshot
  useEffect(() => {
    if (!isEditingProfile && !justSaved) {
      setProfileName(syncedProfile.name)
      setProfileBio(syncedProfile.bio || '')
      setProfileAvatar(syncedProfile.avatar)
      setProfileOffers(syncedProfile.offers || [])
      setProfileNeeds(syncedProfile.needs || [])
    }
  }, [syncedProfile, isEditingProfile, justSaved])

  // Load accepted state for received attestations
  // Re-runs when attestation dialog closes (incomingAttestation → null)
  useEffect(() => {
    async function loadAccepted() {
      const map: Record<string, boolean> = {}
      for (const att of receivedAttestations) {
        const meta = await storage.getAttestationMetadata(att.id)
        map[att.id] = meta?.accepted ?? false
      }
      setAcceptedMap(map)
    }
    loadAccepted()
  }, [receivedAttestations, storage, incomingAttestation])

  const handleToggleAttestation = async (attestationId: string, publish: boolean) => {
    try {
      await setAttestationAccepted(attestationId, publish)
      setAcceptedMap(prev => ({ ...prev, [attestationId]: publish }))
      await uploadAttestations()
    } catch (error) {
      console.warn('Failed to update attestation visibility:', error)
    }
  }

  const getContactName = (contactDid: string) => {
    if (contactDid === did) return t.identity.self
    return contacts.find(c => c.did === contactDid)?.name
  }

  const isKnownContact = (targetDid: string): boolean => {
    if (targetDid === did) return true
    return contacts.some(c => c.did === targetDid && c.status === 'active')
  }

  const handleSaveProfile = async () => {
    const existing = await storage.getIdentity()
    if (existing) {
      await storage.updateIdentity({
        ...existing,
        profile: {
          name: profileName.trim(),
          ...(profileBio.trim() ? { bio: profileBio.trim() } : {}),
          ...(profileAvatar ? { avatar: profileAvatar } : {}),
          ...(profileOffers.length ? { offers: profileOffers } : {}),
          ...(profileNeeds.length ? { needs: profileNeeds } : {}),
        },
      })
    }
    setIsEditingProfile(false)
    setProfileSaved(true)
    setJustSaved(true)
    setTimeout(() => setProfileSaved(false), 2000)
    // Allow reactive sync to take over again after a short delay
    setTimeout(() => setJustSaved(false), 500)

    // Upload to profile service (non-blocking)
    uploadProfile().catch(() => {})

  }

  if (!identity || !did) {
    return null
  }

  const handleCopyDid = async () => {
    if (await copyToClipboard(did)) {
      setCopiedDid(true)
      setTimeout(() => setCopiedDid(false), 2000)
    }
  }

  const handleDeleteIdentity = async () => {
    if (!identity) return

    try {
      setIsDeleting(true)
      setDeleteError(null)
      // W1 — route through the single cross-tier wipe orchestrator (seed + personal-doc
      // DBs + browser-storage + seed-vault + native keystore); no inline duplicate.
      await resetLocalAppData()
      // W5 — verify ALL security-critical tiers actually cleared before redirecting.
      // The orchestrator is best-effort, so a surviving seed (multi-tab / blocked
      // delete) or a stale keystore enrollment must fail closed, not read as success.
      const surviving = await findSurvivingWipeTier()
      if (surviving) {
        console.error('Identity delete incomplete:', surviving)
        setDeleteError(t.identity.deleteError)
        setIsDeleting(false)
        return
      }
      // Hard redirect — don't wait for React state cleanup (respect the deploy base path)
      window.location.href = import.meta.env.BASE_URL || '/'
    } catch (error) {
      console.error('Failed to delete identity:', error)
      // Keep the confirm panel OPEN so the error (rendered only inside it) stays
      // visible — same as the W5 survivor path. Collapsing it would silently swallow
      // the failure, leaving key material on disk with no signal to the user.
      setDeleteError(t.identity.deleteError)
      setIsDeleting(false)
    }
  }

  const handleShareProfile = async () => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    const profileUrl = `${window.location.origin}${base}/p/${encodeURIComponent(did)}`
    if (navigator.share) {
      try {
        await navigator.share({ title: profileName || 'Profil', url: profileUrl })
        return
      } catch { /* user cancelled or not supported */ }
    }
    if (await copyToClipboard(profileUrl)) {
      setShared(true)
      setTimeout(() => setShared(false), 2000)
    }
  }

  // Full DID — use break-all so it wraps instead of truncating

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t.identity.title}</h1>
        {!isEditingProfile && (
          <button
            onClick={() => setIsEditingProfile(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/80 transition-colors flex-shrink-0"
          >
            <Pencil size={16} />
            {t.identity.editProfile}
          </button>
        )}
      </div>

      <div className="space-y-4">
        {/* Profile Card */}
        <div className="bg-card border border-border rounded-lg p-6">
          {isEditingProfile ? (
            <div>
              {/* Header: Avatar + Name/Bio fields */}
              <div className="flex items-start gap-4">
                <AvatarUpload
                  name={profileName}
                  avatar={profileAvatar}
                  onAvatarChange={setProfileAvatar}
                />
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t.identity.nameLabel}</label>
                    <input
                      type="text"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setIsEditingProfile(false)
                      }}
                      className="w-full px-3 py-2 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                      placeholder={t.identity.namePlaceholder}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t.identity.aboutLabel}</label>
                    <textarea
                      value={profileBio}
                      onChange={(e) => setProfileBio(e.target.value)}
                      className="w-full px-3 py-2 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                      rows={2}
                      placeholder={t.identity.aboutPlaceholder}
                    />
                  </div>
                </div>
              </div>

              {/* Offers & Needs fields */}
              <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t.identity.offersLabel}</label>
                  <TagInput
                    tags={profileOffers}
                    onChange={setProfileOffers}
                    placeholder={t.identity.offersPlaceholder}
                    color="green"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t.identity.needsLabel}</label>
                  <TagInput
                    tags={profileNeeds}
                    onChange={setProfileNeeds}
                    placeholder={t.identity.needsPlaceholder}
                    color="amber"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border">
                <button
                  onClick={handleSaveProfile}
                  className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded-lg hover:bg-primary/80 transition-colors"
                >
                  {t.common.save}
                </button>
                <button
                  onClick={() => setIsEditingProfile(false)}
                  className="px-4 py-2 text-muted-foreground text-sm hover:text-foreground transition-colors"
                >
                  {t.common.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div>
              {/* Header: Avatar + Name + Actions */}
              <div className="flex items-start gap-4">
                <Avatar name={profileName} avatar={profileAvatar} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h3 className="text-lg font-semibold text-foreground truncate">
                      {profileName || <span className="text-muted-foreground/70 italic font-normal">{t.identity.noNameSet}</span>}
                    </h3>
                    <Tooltip content={t.identity.securityInfo}>
                      <ShieldCheck size={16} className="text-success" />
                    </Tooltip>
                    {profileSaved && <Check size={16} className="text-success flex-shrink-0" />}
                    <button
                      onClick={handleShareProfile}
                      className="p-2 text-muted-foreground/70 hover:text-primary hover:bg-muted rounded-lg transition-colors ml-auto flex-shrink-0"
                      aria-label={t.aria.shareProfile}
                    >
                      {shared ? <Check size={15} className="text-success" /> : <Share2 size={15} />}
                    </button>
                  </div>
                  {profileBio && (
                    <p className="text-sm text-muted-foreground leading-relaxed">{profileBio}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-xs text-muted-foreground/70 font-mono flex-1 min-w-0 truncate md:whitespace-normal md:break-all">{did}</p>
                    <button
                      onClick={handleCopyDid}
                      className="text-muted-foreground/70 hover:text-primary transition-colors flex-shrink-0 p-2"
                      aria-label={t.aria.copyDid}
                    >
                      {copiedDid ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Offers & Needs */}
              {(profileOffers.length > 0 || profileNeeds.length > 0) && (
                <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 gap-3">
                  {profileOffers.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">{t.identity.offersLabel}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {profileOffers.map((tag) => (
                          <span key={tag} className="inline-block px-2.5 py-1 bg-success/10 text-success text-xs rounded-full border border-success/30">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {profileNeeds.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">{t.identity.needsLabel}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {profileNeeds.map((tag) => (
                          <span key={tag} className="inline-block px-2.5 py-1 bg-warning/10 text-warning text-xs rounded-full border border-warning/20">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Verifications */}
        {verificationAttestations.length > 0 && (
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Users size={16} className="text-primary" />
              <h3 className="text-sm font-medium text-foreground">
                {fmt(t.identity.verifiedByCount, { count: verificationAttestations.length, personLabel: plural(verificationAttestations.length, t.common.personOne, t.common.personMany) })}
              </h3>
            </div>
            <div className="space-y-2">
              {verificationAttestations.map((a) => {
                const name = getContactName(a.from)
                const shortDid = a.from.length > 24
                  ? `${a.from.slice(0, 12)}...${a.from.slice(-6)}`
                  : a.from
                const isPublic = acceptedMap[a.id] ?? false
                return (
                  <div key={a.id} className="flex items-center justify-between gap-3 text-sm">
                    <Link
                      to={`/p/${encodeURIComponent(a.from)}`}
                      className="text-foreground/80 hover:text-primary transition-colors min-w-0"
                    >
                      {name || <span className="font-mono text-xs">{shortDid}</span>}
                    </Link>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-muted-foreground/70">
                        {formatDate(new Date(a.createdAt))}
                      </span>
                      <button
                        onClick={() => handleToggleAttestation(a.id, !isPublic)}
                        className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                          isPublic
                            ? 'text-success hover:text-success hover:bg-success/10'
                            : 'text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted'
                        }`}
                        title={isPublic ? t.identity.attestationPublicTitle : t.identity.attestationPrivateTitle}
                        aria-label={isPublic ? t.identity.attestationPublicTitle : t.identity.attestationPrivateTitle}
                        aria-pressed={isPublic}
                      >
                        {isPublic ? <Globe size={16} /> : <GlobeLock size={16} />}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Received Attestations */}
        {genericReceivedAttestations.length > 0 && (
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <Award size={16} className="text-warning" />
              <h3 className="text-sm font-medium text-foreground">
                {fmt(t.identity.attestationsAboutMe, { count: genericReceivedAttestations.length, attestationLabel: plural(genericReceivedAttestations.length, t.common.attestationOne, t.common.attestationMany) })}
              </h3>
            </div>
            <p className="text-xs text-muted-foreground/70 mb-3 ml-6">
              {t.identity.publishedAttestationsHint}
            </p>
            <div className="space-y-2">
              {genericReceivedAttestations.map((a) => {
                const fromName = getContactName(a.from)
                const shortFrom = a.from.length > 24
                  ? `${a.from.slice(0, 12)}...${a.from.slice(-6)}`
                  : a.from
                const isPublic = acceptedMap[a.id] ?? false
                return (
                  <div key={a.id} className={`flex items-center gap-3 border-l-2 pl-3 ${isKnownContact(a.from) ? 'border-success' : 'border-warning'}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground/80">&ldquo;{a.claim}&rdquo;</p>
                      <p className="text-xs text-muted-foreground/70 mt-0.5">
                        {t.common.from}{' '}
                        <Link
                          to={`/p/${encodeURIComponent(a.from)}`}
                          className="hover:text-primary transition-colors"
                        >
                          {fromName || shortFrom}
                        </Link>
                        {' '}&middot; {formatDate(new Date(a.createdAt))}
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggleAttestation(a.id, !isPublic)}
                      className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                        isPublic
                          ? 'text-success hover:text-success hover:bg-success/10'
                          : 'text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted'
                      }`}
                      title={isPublic ? t.identity.attestationPublicTitle : t.identity.attestationPrivateTitle}
                      aria-label={isPublic ? t.identity.attestationPublicTitle : t.identity.attestationPrivateTitle}
                      aria-pressed={isPublic}
                    >
                      {isPublic ? <Globe size={16} /> : <GlobeLock size={16} />}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Details (collapsible) — DID + Maintenance + Danger Zone */}
        <div className="bg-card border border-border rounded-lg">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="w-full flex items-center justify-between p-4 text-sm font-medium text-foreground/80 hover:bg-muted transition-colors rounded-lg"
          >
            <span>{t.identity.detailsAndMaintenance}</span>
            {showDetails ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>
          {showDetails && (
            <div className="px-4 pb-4 space-y-5 border-t border-border pt-4">
              {/* App Version */}
              {bundleId && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t.identity.appVersion}</p>
                  <p className="text-sm font-mono text-foreground">{bundleId}</p>
                  {lastUpdatedAt && (
                    <p className="text-xs text-muted-foreground">
                      {t.identity.lastUpdated}: {formatDate(lastUpdatedAt)}
                    </p>
                  )}
                </div>
              )}
              {/* Biometric Toggle */}
              {biometricAvailable && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Fingerprint size={18} className="text-primary" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t.biometric.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {biometricEnrolled ? t.biometric.enabled : t.biometric.disabled}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      setBiometricToggling(true)
                      try {
                        if (biometricEnrolled) {
                          await BiometricService.unenroll()
                        } else {
                          // Need passphrase to enroll — prompt user
                          const passphrase = prompt(t.unlock.passwordLabel)
                          if (passphrase) {
                            // Verify passphrase works before enrolling
                            await createIdentityWorkflow().unlockStoredIdentity({ passphrase })
                            await BiometricService.enroll(passphrase)
                          }
                        }
                        await refreshBiometricStatus()
                      } catch {
                        // Failed — silently ignore
                      } finally {
                        setBiometricToggling(false)
                      }
                    }}
                    disabled={biometricToggling}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      biometricEnrolled ? 'bg-success' : 'bg-muted-foreground/30'
                    } ${biometricToggling ? 'opacity-50' : ''}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      biometricEnrolled ? 'translate-x-6' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
              )}

              {/* Delete Identity */}
              <div className="space-y-2">
                <p className="text-sm text-destructive">
                  {t.identity.deleteWarning}
                </p>

                {!showDeleteConfirm ? (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center space-x-2 px-4 py-2 bg-destructive text-white text-sm rounded-lg hover:bg-destructive/90 transition-colors"
                  >
                    <Trash2 size={16} />
                    <span>{t.identity.deleteButton}</span>
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="p-3 bg-destructive/15 border border-destructive/40 rounded-lg">
                      <p className="text-sm text-destructive font-medium">
                        {t.identity.deleteConfirmTitle}
                      </p>
                      <p className="text-sm text-destructive mt-1">
                        {t.identity.deleteConfirmHint}
                      </p>
                    </div>
                    {deleteError && (
                      <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                        {deleteError}
                      </div>
                    )}
                    <div className="flex space-x-3">
                      <button
                        onClick={handleDeleteIdentity}
                        disabled={isDeleting}
                        className="flex items-center space-x-2 px-4 py-2 bg-destructive text-white text-sm rounded-lg hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isDeleting ? (
                          <><div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" /><span>{t.identity.deleting}</span></>
                        ) : (
                          <><Trash2 size={16} /><span>{t.identity.deleteConfirmButton}</span></>
                        )}
                      </button>
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        disabled={isDeleting}
                        className="px-4 py-2 bg-muted text-foreground/80 text-sm rounded-lg hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t.common.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Share toast */}
      {shared && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-toast-in">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-foreground text-white text-sm rounded-lg shadow-lg">
            <LinkIcon size={14} />
            <span>Link kopiert</span>
          </div>
        </div>
      )}
    </div>
  )
}
