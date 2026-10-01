/**
 * Review #390 Runde 2, nachgestellt mit dem echten Hook: der Discovery-Abgleich
 * beim Mount startet mit altem Kontakt, ein profile-update aus der Inbox kommt
 * an, DANACH antwortet Discovery mit einem älteren Profil. Das neuere
 * Inbox-Profil und seine Zeitmarke müssen bleiben.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { Contact, PublicProfile } from '@web_of_trust/core/types'
import { createProfileUpdateListener } from '../src/services/profileUpdateListener'

const ANNA = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const contacts = new Map<string, Contact>([[ANNA, {
  did: ANNA, publicKey: 'z6Mk', name: 'Anna alt', status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}]])
const storage = {
  getContacts: async () => [...contacts.values()],
  getContact: async (did: string) => contacts.get(did) ?? null,
  updateContact: async (next: Contact) => { contacts.set(next.did, next) },
  getIdentity: async () => null,
}

let answerDiscovery!: (profile: PublicProfile) => void
const discoveryAnswer = new Promise<PublicProfile>((resolve) => { answerDiscovery = resolve })
const resolveProfile = vi.fn(async () => ({ profile: await discoveryAnswer, didDocument: null }))

vi.mock('../src/context', () => {
  const subscribable = { subscribe: () => () => {}, getValue: () => [] }
  return {
    useAdapters: () => ({
      storage,
      reactiveStorage: { watchReceivedAttestations: () => subscribable },
      discovery: { resolveProfile, publishProfile: async () => {}, publishAttestations: async () => {}, publishVerifications: async () => {} },
      graphCacheStore: {
        getCachedAttestations: async () => [],
        getCachedVerifications: async () => [],
        cacheEntry: async () => {},
      },
      syncDiscovery: async () => {},
      flushOutbox: async () => {},
      reconnectRelay: async () => {},
      attestationService: { sendProfileUpdate: async () => ({}) },
    }),
    useIdentity: () => ({ identity: null }),
  }
})

describe('useProfileSync — late discovery answer (review #390)', () => {
  it('keeps the newer inbox profile and its timestamp', async () => {
    const { useProfileSync } = await import('../src/hooks/useProfileSync')
    renderHook(() => useProfileSync())
    await waitFor(() => expect(resolveProfile).toHaveBeenCalledWith(ANNA))

    await createProfileUpdateListener({ storage })({
      profile: { name: 'new inbox', updatedAt: '2026-10-01T12:00:00Z' }, senderDid: ANNA, outerId: crypto.randomUUID(),
    })
    answerDiscovery({ did: ANNA, name: 'old discovery', updatedAt: '2026-09-01T12:00:00Z' })
    await new Promise((r) => setTimeout(r, 50))

    expect(contacts.get(ANNA)).toMatchObject({ name: 'new inbox', profileUpdatedAt: '2026-10-01T12:00:00Z' })
  })
})
