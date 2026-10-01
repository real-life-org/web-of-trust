import { describe, it, expect } from 'vitest'
import type { Contact } from '@web_of_trust/core/types'
import { createProfileUpdateListener } from '../src/services/profileUpdateListener'

const ANNA = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

function storageWith(contact: Contact | null) {
  const contacts = new Map<string, Contact>(contact ? [[contact.did, contact]] : [])
  return {
    contacts,
    getContact: async (did: string) => contacts.get(did) ?? null,
    updateContact: async (next: Contact) => { contacts.set(next.did, next) },
  }
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    did: ANNA, publicKey: 'z6Mk', name: 'Anna alt', bio: 'alt', avatar: 'data:image/png;base64,ALT',
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const update = (profile: Record<string, unknown>, senderDid = ANNA) => ({
  profile: { name: 'Anna', updatedAt: '2026-10-01T12:00:00.000Z', ...profile } as never,
  senderDid,
  outerId: crypto.randomUUID(),
})

describe('profile-update listener (wot#386)', () => {
  it('takes over the whole profile of a known contact, clearing fields the sender removed', async () => {
    const storage = storageWith(contact())
    storage.contacts.set(ANNA, { ...storage.contacts.get(ANNA)!, needs: ['alt'] })
    await createProfileUpdateListener({ storage, now: () => new Date('2026-10-01T13:00:00.000Z') })(update({ bio: 'neu', offers: ['Werkzeug'] }))

    const stored = storage.contacts.get(ANNA)!
    expect(stored).toMatchObject({ name: 'Anna', bio: 'neu', offers: ['Werkzeug'], profileUpdatedAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T13:00:00.000Z' })
    expect(stored.avatar).toBeUndefined()
    expect(stored.needs).toBeUndefined()
    expect(stored.status).toBe('active')
  })

  it('ignores an older or repeated profile', async () => {
    const storage = storageWith(contact({ name: 'Anna neu', profileUpdatedAt: '2026-10-01T12:00:00.000Z' }))
    const listener = createProfileUpdateListener({ storage })
    await listener(update({ name: 'Anna alt', updatedAt: '2026-09-30T12:00:00.000Z' }))
    await listener(update({ name: 'Anna wiederholt' }))

    expect(storage.contacts.get(ANNA)!.name).toBe('Anna neu')
  })

  it('keeps the newer profile when an older one overlaps it (review #390: per-sender serialization)', async () => {
    const storage = storageWith(contact())
    // Both read the same old contact; the older update writes slowly and would
    // land last — without serialization it overwrites the newer profile.
    const realUpdate = storage.updateContact
    storage.updateContact = async (next: Contact) => {
      if (next.name === 'Anna alt') await new Promise((r) => setTimeout(r, 20))
      await realUpdate(next)
    }
    const listener = createProfileUpdateListener({ storage })

    await Promise.all([
      listener(update({ name: 'Anna neu', updatedAt: '2026-10-02T12:00:00.000Z' })),
      listener(update({ name: 'Anna alt', updatedAt: '2026-10-01T12:00:00.000Z' })),
    ])

    expect(storage.contacts.get(ANNA)).toMatchObject({ name: 'Anna neu', profileUpdatedAt: '2026-10-02T12:00:00.000Z' })
  })

  it('ignores a profile from someone who is not a contact', async () => {
    const storage = storageWith(null)
    await createProfileUpdateListener({ storage })(update({}))
    expect(storage.contacts.size).toBe(0)
  })
})
