import { describe, it, expect } from 'vitest'
import type { Contact } from '../src/types/contact'
import { applyContactNameSummary, applyContactProfile } from '../src/application'

/**
 * Review #390 Runde 2: Inbox (profile-update) und Discovery schreiben dasselbe
 * Kontaktprofil. Beide müssen dieselbe Aktualitätsregel einhalten und dürfen
 * nicht mit einem vor dem Netzwerkabruf gelesenen Snapshot zurückschreiben.
 */
const ANNA = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

function storageWith(contact: Contact) {
  const contacts = new Map<string, Contact>([[contact.did, contact]])
  return {
    contacts,
    getContact: async (did: string) => contacts.get(did) ?? null,
    updateContact: async (next: Contact) => { contacts.set(next.did, next) },
  }
}

const baseContact: Contact = {
  did: ANNA, publicKey: 'z6Mk', name: 'Anna alt', status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('contact profile writer (review #390)', () => {
  it('a late discovery answer with an older profile keeps the newer inbox profile and its timestamp', async () => {
    const storage = storageWith(baseContact)
    const inbox = (u: { profile: { name: string; updatedAt: string }; senderDid: string; outerId: string }) => applyContactProfile(storage, u.senderDid, u.profile)

    // Discovery started earlier (old snapshot), answers after the inbox update.
    await inbox({ profile: { name: 'new inbox', updatedAt: '2026-10-01T12:00:00Z' }, senderDid: ANNA, outerId: crypto.randomUUID() })
    await applyContactProfile(storage, ANNA, { name: 'old discovery', updatedAt: '2026-09-01T12:00:00Z' })

    expect(storage.contacts.get(ANNA)).toMatchObject({ name: 'new inbox', profileUpdatedAt: '2026-10-01T12:00:00Z' })
  })

  it('a newer discovery profile is taken over, full-profile semantics, with its timestamp', async () => {
    const storage = storageWith({ ...baseContact, bio: 'alt', profileUpdatedAt: '2026-10-01T12:00:00Z' })
    const applied = await applyContactProfile(storage, ANNA, { name: 'Anna neu', offers: ['Werkzeug'], updatedAt: '2026-10-02T12:00:00Z' })

    expect(applied).toBe(true)
    const stored = storage.contacts.get(ANNA)!
    expect(stored).toMatchObject({ name: 'Anna neu', offers: ['Werkzeug'], profileUpdatedAt: '2026-10-02T12:00:00Z' })
    expect(stored.bio).toBeUndefined()
  })

  it('a profile without a valid timestamp never replaces a timestamped one', async () => {
    const storage = storageWith({ ...baseContact, profileUpdatedAt: '2026-10-01T12:00:00Z' })
    expect(await applyContactProfile(storage, ANNA, { name: 'ohne Zeit' })).toBe(false)
    expect(await applyContactProfile(storage, ANNA, { name: 'lokale Zeit', updatedAt: '2026-10-05T12:00:00' })).toBe(false)
    expect(storage.contacts.get(ANNA)!.name).toBe('Anna alt')
  })

  it('a contact without a stored timestamp takes a first profile even without one', async () => {
    const storage = storageWith(baseContact)
    expect(await applyContactProfile(storage, ANNA, { name: 'erstes Profil' })).toBe(true)
    expect(storage.contacts.get(ANNA)).toMatchObject({ name: 'erstes Profil' })
    expect(storage.contacts.get(ANNA)!.profileUpdatedAt).toBeUndefined()
  })

  it('overlapping writes from inbox and discovery for one contact never move the timestamp backwards', async () => {
    const storage = storageWith(baseContact)
    const realUpdate = storage.updateContact
    storage.updateContact = async (next: Contact) => {
      if (next.name === 'old discovery') await new Promise((r) => setTimeout(r, 20))
      await realUpdate(next)
    }
    const inbox = (u: { profile: { name: string; updatedAt: string }; senderDid: string; outerId: string }) => applyContactProfile(storage, u.senderDid, u.profile)
    await Promise.all([
      applyContactProfile(storage, ANNA, { name: 'old discovery', updatedAt: '2026-09-01T12:00:00Z' }),
      inbox({ profile: { name: 'new inbox', updatedAt: '2026-10-01T12:00:00Z' }, senderDid: ANNA, outerId: crypto.randomUUID() }),
    ])
    expect(storage.contacts.get(ANNA)).toMatchObject({ name: 'new inbox', profileUpdatedAt: '2026-10-01T12:00:00Z' })
  })

  it('a name-only summary updates the name but keeps avatar and bio, and never beats a timestamped profile', async () => {
    const storage = storageWith({ ...baseContact, bio: 'alt', avatar: 'data:image/png;base64,ALT' })
    expect(await applyContactNameSummary(storage, ANNA, 'Anna aus Zusammenfassung')).toBe(true)
    expect(storage.contacts.get(ANNA)).toMatchObject({ name: 'Anna aus Zusammenfassung', bio: 'alt', avatar: 'data:image/png;base64,ALT' })

    storage.contacts.set(ANNA, { ...storage.contacts.get(ANNA)!, profileUpdatedAt: '2026-10-01T12:00:00Z' })
    expect(await applyContactNameSummary(storage, ANNA, 'veraltet')).toBe(false)
    expect(storage.contacts.get(ANNA)!.name).toBe('Anna aus Zusammenfassung')
  })
})
