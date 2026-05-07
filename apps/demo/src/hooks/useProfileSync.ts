import { useEffect, useCallback, useRef } from 'react'
import type { PublicProfile, MessageEnvelope } from '@web_of_trust/core/types'
import { useAdapters } from '../context'
import { useIdentity } from '../context'

/**
 * Hook for syncing profiles via the DiscoveryAdapter.
 *
 * - Publishes the local profile, verifications, and attestations
 * - Fetches contact profiles and updates display names
 * - Retries pending syncs on online/visibility events
 *
 * The OfflineFirstDiscoveryAdapter handles dirty-flag tracking and caching.
 * This hook triggers publish operations and retry via syncDiscovery().
 */
export function useProfileSync() {
  const { storage, messaging, reactiveStorage, discovery, graphCacheStore, syncDiscovery, flushOutbox, reconnectRelay } = useAdapters()
  const { identity } = useIdentity()
  const fetchedRef = useRef(new Set<string>())
  const vaUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

    // Notify all contacts about the profile update via relay
    const contacts = await storage.getContacts()
    for (const contact of contacts) {
      const envelope: MessageEnvelope = {
        v: 1,
        id: crypto.randomUUID(),
        type: 'profile-update',
        fromDid: did,
        toDid: contact.did,
        createdAt: new Date().toISOString(),
        encoding: 'json',
        payload: JSON.stringify({ did, name: profile.name }),
        signature: '',
      }
      messaging.send(envelope).catch(() => {
        // Non-blocking — contact may be offline, relay will queue
      })
    }
  }, [identity, storage, messaging, discovery])

  /**
   * Fetch a contact's profile via DiscoveryAdapter.
   */
  const fetchContactProfile = useCallback(async (contactDid: string) => {
    return discovery.resolveProfile(contactDid).then(r => r.profile)
  }, [discovery])

  /**
   * Upload verifications and accepted attestations via DiscoveryAdapter.
   */
  const uploadVerificationsAndAttestations = useCallback(async () => {
    if (!identity) return

    const did = identity.getDid()

    // Upload verifications (deduplicated by sender — keep newest per from-DID)
    const allVerifications = await storage.getReceivedVerifications()
    const byFrom = new Map<string, typeof allVerifications[0]>()
    for (const v of allVerifications) {
      const existing = byFrom.get(v.from)
      if (!existing || v.timestamp > existing.timestamp) {
        byFrom.set(v.from, v)
      }
    }
    const verifications = [...byFrom.values()]
    if (verifications.length > 0) {
      await discovery.publishVerifications(
        { did, verifications, updatedAt: new Date().toISOString() },
        identity,
      )
    }

    // Upload accepted attestations only
    const allAttestations = await storage.getReceivedAttestations()
    const accepted = []
    for (const att of allAttestations) {
      const meta = await storage.getAttestationMetadata(att.id)
      if (meta?.accepted) accepted.push(att)
    }
    await discovery.publishAttestations(
      { did, attestations: accepted, updatedAt: new Date().toISOString() },
      identity,
    )
  }, [identity, storage, discovery])

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

        const profile = await fetchContactProfile(contact.did)
        if (profile && profile.name) {
          // Cache profile in GraphCacheStore (enables offline Space invites)
          // Preserve existing cached verifications/attestations
          const existingV = await graphCacheStore.getCachedVerifications(contact.did).catch(() => [])
          const existingA = await graphCacheStore.getCachedAttestations(contact.did).catch(() => [])
          graphCacheStore.cacheEntry(contact.did, profile, existingV, existingA).catch(() => {})

          const needsUpdate =
            profile.name !== contact.name ||
            profile.avatar !== contact.avatar ||
            profile.bio !== contact.bio
          if (needsUpdate) {
            await storage.updateContact({
              ...contact,
              name: profile.name,
              ...(profile.avatar ? { avatar: profile.avatar } : {}),
              ...(profile.bio ? { bio: profile.bio } : {}),
            })
          }
        }
      }
    }
    syncContacts()
  }, [storage, fetchContactProfile, graphCacheStore])

  /**
   * Listen for profile-update messages and re-fetch.
   */
  useEffect(() => {
    const unsubscribe = messaging.onMessage(async (envelope) => {
      if (envelope.type === 'profile-update') {
        fetchedRef.current.delete(envelope.fromDid)
        const profile = await fetchContactProfile(envelope.fromDid)
        if (profile && profile.name) {
          const contacts = await storage.getContacts()
          const contact = contacts.find((c) => c.did === envelope.fromDid)
          if (contact) {
            const needsUpdate =
              contact.name !== profile.name ||
              contact.avatar !== profile.avatar ||
              contact.bio !== profile.bio
            if (needsUpdate) {
              await storage.updateContact({
                ...contact,
                name: profile.name,
                ...(profile.avatar ? { avatar: profile.avatar } : {}),
                ...(profile.bio ? { bio: profile.bio } : {}),
              })
            }
          }
        }
      }
    })
    return unsubscribe
  }, [messaging, storage, fetchContactProfile])

  /**
   * Upload verifications + attestations on mount.
   */
  useEffect(() => {
    if (!identity) return
    uploadVerificationsAndAttestations()
  }, [identity, uploadVerificationsAndAttestations])

  /**
   * Re-upload when verifications or attestations change (debounced).
   */
  useEffect(() => {
    const debouncedUpload = () => {
      if (vaUploadTimerRef.current) clearTimeout(vaUploadTimerRef.current)
      vaUploadTimerRef.current = setTimeout(() => {
        uploadVerificationsAndAttestations()
      }, 2000)
    }

    const vSub = reactiveStorage.watchReceivedVerifications()
    const aSub = reactiveStorage.watchReceivedAttestations()

    let vSkipFirst = true
    let aSkipFirst = true

    const unsubV = vSub.subscribe(() => {
      if (vSkipFirst) { vSkipFirst = false; return }
      debouncedUpload()
    })
    const unsubA = aSub.subscribe(() => {
      if (aSkipFirst) { aSkipFirst = false; return }
      debouncedUpload()
    })

    return () => {
      unsubV()
      unsubA()
      if (vaUploadTimerRef.current) clearTimeout(vaUploadTimerRef.current)
    }
  }, [reactiveStorage, uploadVerificationsAndAttestations])

  /**
   * Fetch and store a contact's profile (avatar, bio, name) right after adding them.
   */
  const syncContactProfile = useCallback(async (contactDid: string) => {
    fetchedRef.current.add(contactDid)
    const profile = await fetchContactProfile(contactDid)
    if (!profile?.name) return

    // Cache profile in GraphCacheStore (enables offline Space invites)
    graphCacheStore.cacheEntry(contactDid, profile, [], []).catch(() => {})

    const contact = (await storage.getContacts()).find(c => c.did === contactDid)
    if (!contact) return

    const needsUpdate =
      profile.name !== contact.name ||
      profile.avatar !== contact.avatar ||
      profile.bio !== contact.bio
    if (needsUpdate) {
      await storage.updateContact({
        ...contact,
        name: profile.name,
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
        ...(profile.bio ? { bio: profile.bio } : {}),
      })
    }
  }, [fetchContactProfile, storage, graphCacheStore])

  return { uploadProfile, fetchContactProfile, syncContactProfile, uploadVerificationsAndAttestations }
}
