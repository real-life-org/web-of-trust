import { useEffect, useCallback, useRef } from 'react'
import type { Attestation, PublicProfile } from '@web_of_trust/core/types'
import { useAdapters } from '../context'
import { useIdentity } from '../context'
import { protocolCrypto } from '../runtime/appRuntime'
import { splitAcceptedAttestations } from '../lib/publish-split'
import { applyContactProfile } from '../services/contactProfileWriter'

/**
 * Hook for syncing profiles via the DiscoveryAdapter.
 *
 * - Publishes the local profile and accepted attestations
 * - Fetches contact profiles and updates display names
 * - Retries pending syncs on online/visibility events
 *
 * The OfflineFirstDiscoveryAdapter handles dirty-flag tracking and caching.
 * This hook triggers publish operations and retry via syncDiscovery().
 */
export function useProfileSync() {
  const { storage, reactiveStorage, discovery, graphCacheStore, syncDiscovery, flushOutbox, reconnectRelay, attestationService } = useAdapters()
  const { identity } = useIdentity()
  const fetchedRef = useRef(new Set<string>())
  const attestationUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Upload the current user's profile via DiscoveryAdapter.
   * Called after profile changes in Identity page.
   *
   * The OfflineFirstDiscoveryAdapter marks dirty on failure
   * and retries via syncPending().
   */
  const uploadProfile = useCallback(async () => {
    if (!identity) return

    const localIdentity = await storage.getIdentity()
    if (!localIdentity) return

    const did = identity.getDid()
    const profile: PublicProfile = {
      did,
      name: localIdentity.profile.name,
      ...(localIdentity.profile.bio ? { bio: localIdentity.profile.bio } : {}),
      ...(localIdentity.profile.avatar ? { avatar: localIdentity.profile.avatar } : {}),
      ...(localIdentity.profile.offers?.length ? { offers: localIdentity.profile.offers } : {}),
      ...(localIdentity.profile.needs?.length ? { needs: localIdentity.profile.needs } : {}),
      updatedAt: new Date().toISOString(),
    }

    await discovery.publishProfile(profile, identity)

    // wot#386: das Profil selbst verschlüsselt an jeden Kontakt (inbox/1.0) —
    // Kontakte bleiben so auch ohne öffentlichen Profil-Dienst auf dem Stand.
    // Pro Kontakt best-effort: ein Kontakt ohne veröffentlichten
    // Encryption-Key hält die übrigen nicht auf; die Outbox stellt Offline-
    // Empfängern später zu.
    const contacts = await storage.getContacts()
    await Promise.all(contacts.map((contact) =>
      attestationService.sendProfileUpdate(contact.did, profile).catch((error) => {
        console.warn(`[ProfileSync] profile-update to ${contact.did.slice(0, 24)}… not sent:`, error)
      }),
    ))
  }, [identity, storage, discovery, attestationService])

  /**
   * Fetch a contact's profile via DiscoveryAdapter.
   */
  const fetchContactProfile = useCallback(async (contactDid: string) => {
    const r = await discovery.resolveProfile(contactDid)
    return { profile: r.profile, didDocument: r.didDocument ?? null }
  }, [discovery])

  /**
   * Upload accepted attestations via DiscoveryAdapter (Sync 004 Z.24-32).
   *
   * The accepted set is split DISJOINTLY by the canonical `WotVerification`
   * `type` marker (VE-2/VE-7): verification-attestations are published to `/v`
   * via `publishVerifications`, all other accepted attestations to `/a` via
   * `publishAttestations`. Both lists carry the same publish-consent filter
   * (`meta.accepted`). The split discriminator is the verified VC `type`, never
   * the human `claim` label — so it matches the adapter's disjoint resolve
   * filter exactly. The resource `version` is the adapter's persistent monotonic
   * counter (VE-6), not a wall clock.
   */
  const uploadAttestations = useCallback(async () => {
    if (!identity) return

    const did = identity.getDid()

    // Upload accepted attestations only
    const allAttestations = await storage.getReceivedAttestations()
    const accepted: Attestation[] = []
    for (const att of allAttestations) {
      const meta = await storage.getAttestationMetadata(att.id)
      if (meta?.accepted) accepted.push(att)
    }

    const { verifications, attestations } = await splitAcceptedAttestations(accepted, {
      crypto: protocolCrypto,
    })
    const updatedAt = new Date().toISOString()
    await discovery.publishVerifications({ did, verifications, updatedAt }, identity)
    await discovery.publishAttestations({ did, attestations, updatedAt }, identity)
  }, [identity, storage, discovery])

  const uploadAttestationsSafely = useCallback(() => {
    uploadAttestations().catch((error) => {
      console.warn('Failed to publish accepted attestations:', error)
    })
  }, [uploadAttestations])

  /**
   * Retry all pending discovery syncs.
   * Called on mount, online event, and visibility change.
   */
  useEffect(() => {
    if (!identity) return

    // Sync pending on mount
    syncDiscovery()
    flushOutbox()

    const handleReconnect = async () => {
      await reconnectRelay()
      syncDiscovery()
      flushOutbox()
    }
    const handleOnline = () => { handleReconnect() }
    const handleVisible = () => {
      if (document.visibilityState === 'visible') handleReconnect()
    }

    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisible)

    return () => {
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisible)
    }
  }, [identity, syncDiscovery, flushOutbox, reconnectRelay])

  // Note: No unconditional uploadProfile() on mount.
  // syncDiscovery() above already retries dirty flags.
  // Blind upload would overwrite server data with stale local data
  // when local sync hasn't finished yet (e.g. second browser).

  /**
   * Sync all contact profiles on mount.
   */
  useEffect(() => {
    async function syncContacts() {
      const contacts = await storage.getContacts()
      for (const contact of contacts) {
        if (fetchedRef.current.has(contact.did)) continue
        fetchedRef.current.add(contact.did)

        const { profile, didDocument } = await fetchContactProfile(contact.did)
        if (profile && profile.name) {
          // Cache profile in GraphCacheStore (enables offline Space invites).
          // Preserve cached attestations + verifications; the `/v` resolve path
          // is wired in Step 3, so we keep whatever is already cached here.
          // didDocument carries the keyAgreement key for offline ECIES delivery.
          const existingA = await graphCacheStore.getCachedAttestations(contact.did).catch(() => [])
          const existingV = await graphCacheStore.getCachedVerifications(contact.did).catch(() => [])
          graphCacheStore.cacheEntry(contact.did, { profile, attestations: existingA, verifications: existingV, didDocument }).catch(() => {})

          // Review #390: über die gemeinsame, je Kontakt serialisierte Schreibstelle —
          // sie liest den Kontakt neu und übernimmt nur ein neueres Profil (der
          // Snapshot von vor dem Abruf darf ein inzwischen eingetroffenes
          // profile-update nicht überschreiben).
          await applyContactProfile(storage, contact.did, profile)
        }
      }
    }
    syncContacts()
  }, [storage, fetchContactProfile, graphCacheStore])

  /**
   * Upload accepted attestations on mount.
   */
  useEffect(() => {
    if (!identity) return
    uploadAttestationsSafely()
  }, [identity, uploadAttestationsSafely])

  /**
   * Re-upload when received attestations change (debounced).
   */
  useEffect(() => {
    const debouncedUpload = () => {
      if (attestationUploadTimerRef.current) clearTimeout(attestationUploadTimerRef.current)
      attestationUploadTimerRef.current = setTimeout(() => {
        uploadAttestationsSafely()
      }, 2000)
    }

    const aSub = reactiveStorage.watchReceivedAttestations()

    // Re-upload on EVERY received-attestations change (debounced). Kein Skip-First:
    // bei einer frischen Identität ist die erste Änderung das erste echte Ereignis
    // (z.B. eine eben eingegangene, auto-akzeptierte Verifikation) — würde sie
    // übersprungen, käme die Verifikation nie ohne manuellen Toggle auf /v. Der
    // Mount-Upload publiziert bereits den Initialstand; ein zusätzlicher, durch
    // die Hydration ausgelöster Upload ist idempotent (monotoner Version-Zähler)
    // und heilt zudem Multi-Device (fließt später mehr Synced-State ein, wird der
    // vollere Satz nachpubliziert statt bis zur ZWEITEN Änderung zu warten).
    const unsubA = aSub.subscribe(() => {
      debouncedUpload()
    })

    return () => {
      unsubA()
      if (attestationUploadTimerRef.current) clearTimeout(attestationUploadTimerRef.current)
    }
  }, [reactiveStorage, uploadAttestationsSafely])

  /**
   * Fetch and store a contact's profile (avatar, bio, name) right after adding them.
   */
  const syncContactProfile = useCallback(async (contactDid: string) => {
    fetchedRef.current.add(contactDid)
    const { profile, didDocument } = await fetchContactProfile(contactDid)
    if (!profile?.name) return

    // Cache profile in GraphCacheStore (enables offline Space invites).
    // didDocument carries the keyAgreement key for offline ECIES delivery.
    const cachedAttestations = await graphCacheStore.getCachedAttestations(contactDid).catch(() => [])
    const cachedVerifications = await graphCacheStore.getCachedVerifications(contactDid).catch(() => [])
    graphCacheStore.cacheEntry(contactDid, { profile, attestations: cachedAttestations, verifications: cachedVerifications, didDocument }).catch(() => {})

    // Review #390: gemeinsame Schreibstelle (nur Neueres, Kontakt frisch gelesen).
    await applyContactProfile(storage, contactDid, profile)
  }, [fetchContactProfile, storage, graphCacheStore])

  return { uploadProfile, fetchContactProfile, syncContactProfile, uploadAttestations }
}
