import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { User, ShieldCheck, UserPlus, Copy, Check, AlertCircle, Loader2, LogIn, Award, Users, WifiOff, Share2, Link as LinkIcon } from 'lucide-react'
import { HttpDiscoveryAdapter, type PublicProfile as PublicProfileType, type Verification, type Attestation, type Contact, type Identity, type Subscribable } from '@real-life/wot-core'
import { Avatar } from '../components/shared'
import { Tooltip } from '../components/ui/Tooltip'
import { useLanguage, plural } from '../i18n'
import { useIdentity, useOptionalAdapters } from '../context'
import { useSubscribable } from '../hooks/useSubscribable'

/** Keep only the newest verification per sender DID */
function deduplicateByFrom(verifications: Verification[]): Verification[] {
  const byFrom = new Map<string, Verification>()
  for (const v of verifications) {
    const existing = byFrom.get(v.from)
    if (!existing || v.timestamp > existing.timestamp) {
      byFrom.set(v.from, v)
    }
  }
  return [...byFrom.values()]
}

const PROFILE_SERVICE_URL = import.meta.env.VITE_PROFILE_SERVICE_URL ?? 'http://localhost:8788'
const fallbackDiscovery = new HttpDiscoveryAdapter(PROFILE_SERVICE_URL)

const EMPTY_CONTACTS: Subscribable<Contact[]> = { subscribe: () => () => {}, getValue: () => [] }
const EMPTY_IDENTITY: Subscribable<Identity | null> = { subscribe: () => () => {}, getValue: () => null }

type LoadState = 'loading' | 'loaded' | 'loaded-offline' | 'not-found' | 'offline' | 'error'

function shortDidLabel(did: string): string {
  return did.length > 24
    ? `${did.slice(0, 12)}...${did.slice(-6)}`
    : did
}

export function PublicProfile() {
  const { did } = useParams<{ did: string }>()
  const { t, fmt, formatDate } = useLanguage()
  const { identity, did: myDid } = useIdentity()
  const isLoggedIn = identity !== null
  const adapters = useOptionalAdapters()
  const discovery = useMemo(() => adapters?.discovery ?? fallbackDiscovery, [adapters])
  const [profile, setProfile] = useState<PublicProfileType | null>(null)
  const [verifications, setVerifications] = useState<Verification[]>([])
  const [attestations, setAttestations] = useState<Attestation[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [copiedDid, setCopiedDid] = useState(false)
  const [shared, setShared] = useState(false)
  const [resolvedProfiles, setResolvedProfiles] = useState<Map<string, { name: string; avatar?: string }>>(new Map())
  const [mutualContacts, setMutualContacts] = useState<string[]>([])

  const decodedDid = did ? decodeURIComponent(did) : ''
  const isMyProfile = myDid === decodedDid

  // Reactive local data (contacts + own identity)
  const contactsSubscribable = useMemo(() => adapters?.reactiveStorage.watchContacts() ?? EMPTY_CONTACTS, [adapters])
  const contacts = useSubscribable(contactsSubscribable)
  const identitySubscribable = useMemo(() => adapters?.reactiveStorage.watchIdentity() ?? EMPTY_IDENTITY, [adapters])
  const localIdentity = useSubscribable(identitySubscribable)

  const isContact = useMemo(() => contacts.some(c => c.did === decodedDid), [contacts, decodedDid])

  // Local received verifications (they verified me)
  const EMPTY_VERIFICATIONS: Subscribable<Verification[]> = { subscribe: () => () => {}, getValue: () => [] }
  const receivedVerificationsSubscribable = useMemo(
    () => adapters?.reactiveStorage.watchReceivedVerifications() ?? EMPTY_VERIFICATIONS,
    [adapters],
  )
  const receivedVerifications = useSubscribable(receivedVerificationsSubscribable)

  const tryLocalFallback = useCallback((): boolean => {
    // Try own profile
    if (decodedDid === myDid && localIdentity) {
      setProfile({
        did: decodedDid,
        name: localIdentity.profile.name,
        ...(localIdentity.profile.bio ? { bio: localIdentity.profile.bio } : {}),
        ...(localIdentity.profile.avatar ? { avatar: localIdentity.profile.avatar } : {}),
        ...(localIdentity.profile.offers?.length ? { offers: localIdentity.profile.offers } : {}),
        ...(localIdentity.profile.needs?.length ? { needs: localIdentity.profile.needs } : {}),
        updatedAt: new Date().toISOString(),
      })
      setState('loaded-offline')
      return true
    }

    // Try contact data
    const contact = contacts.find(c => c.did === decodedDid)
    if (contact?.name) {
      setProfile({
        did: decodedDid,
        name: contact.name,
        ...(contact.bio ? { bio: contact.bio } : {}),
        ...(contact.avatar ? { avatar: contact.avatar } : {}),
        updatedAt: contact.updatedAt,
      })
      setState('loaded-offline')
      return true
    }

    return false
  }, [decodedDid, myDid, localIdentity, contacts])


  // Ref to access tryLocalFallback inside useEffect without it being a dependency.
  // This prevents reactive data changes (contacts, localIdentity) from re-triggering fetchAll.
  const tryLocalFallbackRef = useRef(tryLocalFallback)
  tryLocalFallbackRef.current = tryLocalFallback

  useEffect(() => {
    if (!decodedDid) {
      setState('error')
      return
    }

    async function fetchAll() {
      setState('loading')

      try {
        const [profileResult, vData, aData] = await Promise.all([
          discovery.resolveProfile(decodedDid),
          discovery.resolveVerifications(decodedDid),
          discovery.resolveAttestations(decodedDid),
        ])

        if (!profileResult.profile) {
          if (profileResult.fromCache) {
            // Offline + no cache → try local data (own identity / contacts)
            if (tryLocalFallbackRef.current()) return
            setState('offline')
          } else {
            setState('not-found')
          }
          return
        }

        setProfile(profileResult.profile)
        // Deduplicate verifications by sender (keep newest per from-DID)
        const uniqueV = deduplicateByFrom(vData)
        setVerifications(uniqueV)
        setAttestations(aData)
        setState(profileResult.fromCache ? 'loaded-offline' : 'loaded')

        // Cache fresh data for offline use
        if (!profileResult.fromCache && adapters?.graphCacheStore) {
          adapters.graphCacheStore.cacheEntry(decodedDid, profileResult.profile, vData, aData).catch(() => {})
        }
      } catch {
        if (tryLocalFallbackRef.current()) return
        setState('error')
      }
    }

    fetchAll()
  }, [decodedDid, discovery, adapters?.graphCacheStore])

  // Resolve DID names and mutual contacts after data loads
  useEffect(() => {
    if (verifications.length === 0 && attestations.length === 0) return

    let cancelled = false

    async function resolveGraph() {
      const allDids = new Set<string>()
      for (const v of verifications) allDids.add(v.from)
      for (const a of attestations) allDids.add(a.from)
      // Remove DIDs we already know names for (contacts, own identity)
      if (myDid) allDids.delete(myDid)
      for (const c of contacts) allDids.delete(c.did)

      if (allDids.size === 0 && !adapters?.graphCacheStore) return

      const profiles = new Map<string, { name: string; avatar?: string }>()

      // 1. Try local graph cache first
      if (adapters?.graphCacheStore && allDids.size > 0) {
        const cached = await adapters.graphCacheStore.resolveNames([...allDids])
        for (const [did, name] of cached) profiles.set(did, { name })
      }

      // 2. For remaining unknown DIDs, fetch from profile service
      const unknownDids = [...allDids].filter(d => !profiles.has(d))
      if (unknownDids.length > 0) {
        const resolveOne = async (did: string) => {
          try {
            const result = await discovery.resolveProfile(did)
            if (result.profile?.name) profiles.set(did, { name: result.profile.name, ...(result.profile.avatar ? { avatar: result.profile.avatar } : {}) })
          } catch { /* ignore */ }
        }
        await Promise.all(unknownDids.map(resolveOne))
      }

      if (!cancelled && profiles.size > 0) setResolvedProfiles(profiles)

      if (adapters?.graphCacheStore && decodedDid && !isMyProfile) {
        const contactDids = contacts.filter(c => c.status === 'active').map(c => c.did)
        if (contactDids.length > 0) {
          const mutual = await adapters.graphCacheStore.findMutualContacts(decodedDid, contactDids)
          if (!cancelled) setMutualContacts(mutual)
        }
      }
    }

    resolveGraph()
    return () => { cancelled = true }
  }, [verifications, attestations, adapters?.graphCacheStore, decodedDid, isMyProfile, contacts, myDid, discovery])

  const handleCopyDid = async () => {
    await navigator.clipboard.writeText(decodedDid)
    setCopiedDid(true)
    setTimeout(() => setCopiedDid(false), 2000)
  }

  const handleShareProfile = async () => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    const profileUrl = `${window.location.origin}${base}/p/${encodeURIComponent(decodedDid)}`
    if (navigator.share) {
      try {
        await navigator.share({ title: profile?.name || 'Profil', text: profileUrl, url: profileUrl })
        return
      } catch (e) {
        // User cancelled share dialog — don't fall through to clipboard
        if (e instanceof Error && e.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(profileUrl)
      setShared(true)
      setTimeout(() => setShared(false), 2000)
    } catch { /* clipboard blocked — ignore silently */ }
  }

  const resolveContact = useCallback((targetDid: string): { name: string; avatar?: string; isSelf: boolean; isContact: boolean } => {
    const isSelf = targetDid === myDid
    // Check if it's one of my contacts (they have local names)
    const contact = contacts.find(c => c.did === targetDid)
    if (contact?.name) return { name: contact.name, ...(contact.avatar ? { avatar: contact.avatar } : {}), isSelf, isContact: contact.status === 'active' }
    // Check if it's my own identity
    if (isSelf && localIdentity?.profile.name) {
      return { name: localIdentity.profile.name, ...(localIdentity.profile.avatar ? { avatar: localIdentity.profile.avatar } : {}), isSelf, isContact: false }
    }
    // Check resolved profiles (graph cache / discovery)
    const cached = resolvedProfiles.get(targetDid)
    if (cached) return { name: cached.name, ...(cached.avatar ? { avatar: cached.avatar } : {}), isSelf, isContact: false }
    // Fall back to short DID
    return { name: shortDidLabel(targetDid), isSelf, isContact: false }
  }, [contacts, resolvedProfiles, myDid, localIdentity])

  // Verification status between me and profile owner
  const verificationStatus = useMemo(() => {
    if (!myDid || isMyProfile) return null
    // Public verifications of profile owner — contains from=myDid if I verified them
    const iVerifiedThem = verifications.some(v => v.from === myDid)
    // Local received verifications — contains from=decodedDid if they verified me
    const theyVerifiedMe = receivedVerifications.some(v => v.from === decodedDid)
    if (iVerifiedThem && theyVerifiedMe) return 'mutual' as const
    if (theyVerifiedMe) return 'incoming' as const
    if (iVerifiedThem) return 'outgoing' as const
    return null
  }, [myDid, isMyProfile, verifications, receivedVerifications, decodedDid])

  const shortDid = decodedDid.length > 30
    ? `${decodedDid.slice(0, 16)}...${decodedDid.slice(-8)}`
    : decodedDid

  if (state === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500">
        <Loader2 size={32} className="animate-spin mb-3" />
        <p className="text-sm">{t.publicProfile.loading}</p>
      </div>
    )
  }

  if (state === 'not-found') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">{t.publicProfile.title}</h1>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-6 text-center">
          <User size={48} className="mx-auto text-slate-300 mb-4" />
          <h2 className="text-lg font-medium text-slate-700 mb-2">{t.publicProfile.notFoundTitle}</h2>
          <p className="text-sm text-slate-500 mb-4">
            {t.publicProfile.notFoundDescription}
          </p>
          <p className="text-xs text-slate-400 font-mono break-all">{decodedDid}</p>
        </div>
      </div>
    )
  }

  if (state === 'offline') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">{t.publicProfile.title}</h1>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-6 text-center">
          <WifiOff size={48} className="mx-auto text-slate-300 mb-4" />
          <h2 className="text-lg font-medium text-slate-700 mb-2">{t.publicProfile.offlineTitle}</h2>
          <p className="text-sm text-slate-500 mb-4">
            {t.publicProfile.offlineDescription}
          </p>
          <p className="text-xs text-slate-400 font-mono break-all">{decodedDid}</p>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">{t.publicProfile.title}</h1>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-6 text-center">
          <AlertCircle size={48} className="mx-auto text-red-300 mb-4" />
          <h2 className="text-lg font-medium text-slate-700 mb-2">{t.publicProfile.errorTitle}</h2>
          <p className="text-sm text-slate-500">
            {t.publicProfile.errorDescription}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">{t.publicProfile.publicTitle}</h1>
      </div>

      {/* Profile Card */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div>
          {/* Header: Avatar + Name + Actions */}
          <div className="flex items-start gap-4">
            <Avatar name={profile?.name} avatar={profile?.avatar} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-slate-900 truncate">
                      {profile?.name || <span className="text-slate-400 italic font-normal">{t.publicProfile.unknown}</span>}
                    </h2>
                    {state === 'loaded' && (
                      <Tooltip content={t.publicProfile.verifiedBanner}>
                        <ShieldCheck size={16} className="text-green-500" />
                      </Tooltip>
                    )}
                  </div>
                  {verificationStatus && (
                    <span className={`inline-block text-xs px-2 py-0.5 rounded-full whitespace-nowrap mt-1 ${
                      verificationStatus === 'mutual' ? 'bg-green-100 text-green-700' :
                      verificationStatus === 'incoming' ? 'bg-blue-100 text-blue-700' :
                      'bg-amber-100 text-amber-700'
                    }`}>
                      {verificationStatus === 'mutual' ? t.contacts.statusMutual :
                       verificationStatus === 'incoming' ? t.contacts.statusIncoming :
                       t.contacts.statusOutgoing}
                    </span>
                  )}
                </div>
                <button
                  onClick={handleShareProfile}
                  className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
                  title="Profil teilen"
                >
                  {shared ? <Check size={15} className="text-green-500" /> : <Share2 size={15} />}
                </button>
              </div>
              {profile?.bio && (
                <p className="text-sm text-slate-600 leading-relaxed mt-0.5">{profile.bio}</p>
              )}
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-slate-400 font-mono truncate flex-1 min-w-0">{shortDid}</p>
                <button
                  onClick={handleCopyDid}
                  className="text-slate-400 hover:text-blue-600 transition-colors flex-shrink-0 p-1.5"
                  title={t.publicProfile.copyDid}
                >
                  {copiedDid ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          </div>

          {/* Offers & Needs */}
          {((profile?.offers && profile.offers.length > 0) || (profile?.needs && profile.needs.length > 0)) && (
            <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {profile?.offers && profile.offers.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1.5">Angebote</p>
                  <div className="flex flex-wrap gap-1.5">
                    {profile.offers.map((tag) => (
                      <span key={tag} className="inline-block px-2.5 py-1 bg-green-50 text-green-700 text-xs rounded-full border border-green-200">{tag}</span>
                    ))}
                  </div>
                </div>
              )}
              {profile?.needs && profile.needs.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1.5">Bedürfnisse</p>
                  <div className="flex flex-wrap gap-1.5">
                    {profile.needs.map((tag) => (
                      <span key={tag} className="inline-block px-2.5 py-1 bg-amber-50 text-amber-700 text-xs rounded-full border border-amber-200">{tag}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Offline banner */}
      {state === 'loaded-offline' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start space-x-3">
            <WifiOff className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              {t.publicProfile.offlineBanner}
            </div>
          </div>
        </div>
      )}

      {/* Mutual contacts */}
      {mutualContacts.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start space-x-3">
            <Users className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">
              {mutualContacts.length === 1
                ? fmt(t.publicProfile.mutualContactSingular, { name: resolveContact(mutualContacts[0]).name })
                : fmt(t.publicProfile.mutualContactPlural, { count: mutualContacts.length, names: mutualContacts.map(d => resolveContact(d).name).join(', ') })
              }
            </div>
          </div>
        </div>
      )}

      {/* Verifications */}
      {verifications.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users size={16} className="text-blue-600" />
            <h3 className="text-sm font-medium text-slate-900">
              {fmt(t.publicProfile.verifiedByCount, { count: verifications.length, personLabel: plural(verifications.length, t.common.personOne, t.common.personMany) })}
            </h3>
          </div>
          <div className="space-y-2">
            {verifications.map((v) => {
              const resolved = resolveContact(v.from)
              return (
                <div key={v.id} className="flex items-center justify-between">
                  <Link
                    to={`/p/${encodeURIComponent(v.from)}`}
                    className="flex items-center gap-2 min-w-0 hover:text-primary-600 transition-colors"
                  >
                    <Avatar name={resolved.name} avatar={resolved.avatar} size="xs" />
                    <span className={`text-sm truncate ${resolved.isContact || resolved.isSelf ? 'text-slate-800 font-medium' : 'text-slate-600'}`}>
                      {resolved.name}
                    </span>
                    {resolved.isSelf && <span className="text-xs text-slate-400">{t.publicProfile.youSuffix}</span>}
                    {resolved.isContact && !resolved.isSelf && <span className="text-xs text-blue-500">{t.publicProfile.contactBadge}</span>}
                  </Link>
                  <span className="text-xs text-slate-400 shrink-0 ml-2">
                    {formatDate(new Date(v.timestamp))}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Attestations */}
      {attestations.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Award size={16} className="text-amber-600" />
            <h3 className="text-sm font-medium text-slate-900">
              {fmt(t.publicProfile.attestationCount, { count: attestations.length, attestationLabel: plural(attestations.length, t.common.attestationOne, t.common.attestationMany) })}
            </h3>
          </div>
          <div className="space-y-3">
            {attestations.map((a) => {
              const resolved = resolveContact(a.from)
              return (
                <div key={a.id} className={`border-l-2 pl-3 ${resolved.isContact || resolved.isSelf ? 'border-green-300' : 'border-amber-200'}`}>
                  <p className="text-sm text-slate-700">&ldquo;{a.claim}&rdquo;</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Avatar name={resolved.name} avatar={resolved.avatar} size="xs" />
                    <p className="text-xs text-slate-400">
                      {t.common.from}{' '}
                      <Link
                        to={`/p/${encodeURIComponent(a.from)}`}
                        className={`hover:text-primary-600 transition-colors ${resolved.isContact || resolved.isSelf ? 'text-slate-700 font-medium' : ''}`}
                      >
                        {resolved.name}
                      </Link>
                      {resolved.isSelf && <span className="text-slate-400 ml-1">{t.publicProfile.youSuffix}</span>}
                      {resolved.isContact && !resolved.isSelf && <span className="text-green-600 ml-1">{t.publicProfile.yourContactBadge}</span>}
                      {' '}&middot; {formatDate(new Date(a.createdAt))}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      {!isLoggedIn && (
        <div className="bg-primary-50 border border-primary-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LogIn size={16} className="text-primary-600" />
              <span className="text-sm text-primary-800">
                {t.publicProfile.joinCta}
              </span>
            </div>
            <Link
              to="/"
              className="text-sm font-medium text-primary-600 hover:text-primary-800 transition-colors"
            >
              {t.publicProfile.joinButton}
            </Link>
          </div>
        </div>
      )}
      {isLoggedIn && !isMyProfile && !isContact && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserPlus size={16} className="text-slate-500" />
              <span className="text-sm text-slate-600">
                {t.publicProfile.verifyPerson}
              </span>
            </div>
            <Link
              to="/verify"
              className="text-sm text-primary-600 hover:text-primary-800 transition-colors"
            >
              {t.publicProfile.verifyButton}
            </Link>
          </div>
        </div>
      )}
      {isLoggedIn && !isMyProfile && isContact && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Award size={16} className="text-blue-600" />
              <span className="text-sm text-blue-800">
                {t.publicProfile.attestPerson}
              </span>
            </div>
            <Link
              to={`/attestations/new?to=${encodeURIComponent(decodedDid)}`}
              className="text-sm font-medium text-blue-700 hover:text-blue-900 transition-colors"
            >
              {t.publicProfile.attestButton}
            </Link>
          </div>
        </div>
      )}

      {/* Share toast */}
      {shared && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-toast-in">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 text-white text-sm rounded-lg shadow-lg">
            <LinkIcon size={14} />
            <span>Link kopiert</span>
          </div>
        </div>
      )}
    </div>
  )
}
