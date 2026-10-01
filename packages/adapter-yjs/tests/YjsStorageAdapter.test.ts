import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { YjsStorageAdapter } from '../src/YjsStorageAdapter'
import {
  initYjsPersonalDoc,
  resetYjsPersonalDoc,
  deleteYjsPersonalDocDB,
  changeYjsPersonalDoc,
} from '../src/YjsPersonalDocManager'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import type { Contact, Verification, Attestation } from '@web_of_trust/core/types'

const TEST_DID = 'did:key:z6MkTestUser'
const OTHER_DID = 'did:key:z6MkOtherUser'

function createTestContact(overrides: Partial<Contact> = {}): Contact {
  const now = new Date().toISOString()
  return {
    did: OTHER_DID,
    publicKey: 'testkey123',
    name: 'Alice',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createTestVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: 'ver-1',
    from: TEST_DID,
    to: OTHER_DID,
    timestamp: new Date().toISOString(),
    proof: { type: 'Ed25519Signature2020', signatureValue: 'abc' },
    ...overrides,
  }
}

function createTestAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'att-1',
    from: TEST_DID,
    to: OTHER_DID,
    claim: 'I know this person',
    createdAt: new Date().toISOString(),
    proof: { type: 'Ed25519Signature2020', signatureValue: 'def' },
    ...overrides,
  }
}

describe('YjsStorageAdapter', () => {
  let adapter: YjsStorageAdapter
  let identity: PublicIdentitySession

  beforeEach(async () => {
    identity = (await createTestIdentity('test-identity')).identity
    await initYjsPersonalDoc(identity, null as any)
    adapter = new YjsStorageAdapter(TEST_DID)
  })

  afterEach(async () => {
    await resetYjsPersonalDoc()
    await deleteYjsPersonalDocDB()
  })

  // --- Identity ---

  describe('Identity', () => {
    it('returns null when no identity exists', async () => {
      expect(await adapter.getIdentity()).toBeNull()
    })

    it('creates and retrieves identity', async () => {
      const result = await adapter.createIdentity(TEST_DID, { name: 'Bob' })
      expect(result.did).toBe(TEST_DID)
      expect(result.profile.name).toBe('Bob')

      const retrieved = await adapter.getIdentity()
      expect(retrieved?.did).toBe(TEST_DID)
      expect(retrieved?.profile.name).toBe('Bob')
    })

    it('updates identity', async () => {
      const created = await adapter.createIdentity(TEST_DID, { name: 'Bob' })
      created.profile.name = 'Robert'
      await adapter.updateIdentity(created)

      // Clear cache to test persistence
      await adapter.clear()
      const retrieved = await adapter.getIdentity()
      expect(retrieved?.profile.name).toBe('Robert')
    })
  })

  // --- Contacts ---

  describe('Contacts', () => {
    it('starts with no contacts', async () => {
      const contacts = await adapter.getContacts()
      expect(contacts).toEqual([])
    })

    it('adds and retrieves a contact', async () => {
      const contact = createTestContact()
      await adapter.addContact(contact)

      const contacts = await adapter.getContacts()
      expect(contacts).toHaveLength(1)
      expect(contacts[0].did).toBe(OTHER_DID)
      expect(contacts[0].name).toBe('Alice')
    })

    it('gets a single contact by DID', async () => {
      await adapter.addContact(createTestContact())

      const contact = await adapter.getContact(OTHER_DID)
      expect(contact?.name).toBe('Alice')

      const missing = await adapter.getContact('did:key:nonexistent')
      expect(missing).toBeNull()
    })

    it('updates a contact', async () => {
      const contact = createTestContact()
      await adapter.addContact(contact)

      contact.name = 'Alice Updated'
      contact.status = 'active'
      await adapter.updateContact(contact)

      const updated = await adapter.getContact(OTHER_DID)
      expect(updated?.name).toBe('Alice Updated')
      expect(updated?.status).toBe('active')
    })

    it('keeps profileUpdatedAt across add and update (wot#386 profile-update)', async () => {
      await adapter.addContact(createTestContact({ profileUpdatedAt: '2026-10-01T12:00:00.000Z' }))
      expect((await adapter.getContact(OTHER_DID))?.profileUpdatedAt).toBe('2026-10-01T12:00:00.000Z')

      const contact = (await adapter.getContact(OTHER_DID))!
      await adapter.updateContact({ ...contact, name: 'Neu', profileUpdatedAt: '2026-10-02T08:00:00.000Z' })
      expect((await adapter.getContact(OTHER_DID))?.profileUpdatedAt).toBe('2026-10-02T08:00:00.000Z')
    })

    it('reads a contact without profileUpdatedAt (existing documents)', async () => {
      await adapter.addContact(createTestContact())
      expect((await adapter.getContact(OTHER_DID))?.profileUpdatedAt).toBeUndefined()
    })

    it('removes a contact', async () => {
      await adapter.addContact(createTestContact())
      expect(await adapter.getContacts()).toHaveLength(1)

      await adapter.removeContact(OTHER_DID)
      expect(await adapter.getContacts()).toHaveLength(0)
    })
  })

  // --- Contacts: der Schlüssel IST die Identität ---

  describe('Kontakt-Identität', () => {
    /** Schreibt roh in die Kontakt-Map, am Adapter vorbei. */
    function writeRawContact(key: string, record: Record<string, unknown>): void {
      changeYjsPersonalDoc(doc => {
        ;(doc.contacts as Record<string, unknown>)[key] = record
      })
    }

    it('liest die DID aus dem Schlüssel, nicht aus dem Feld', async () => {
      // Zwei Kopien derselben Aussage können auseinanderlaufen. Verbindlich ist
      // die, unter der der Eintrag liegt — sonst zeigt die Anwendung eine
      // Identität an, unter der sie den Kontakt nie wiederfindet.
      writeRawContact(OTHER_DID, {
        did: 'did:key:z6MkStaleCopy',
        publicKey: 'k',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })

      const [contact] = await adapter.getContacts()
      expect(contact.did).toBe(OTHER_DID)
    })

    it('liefert eine löschbare DID, auch wenn das Feld fehlt', async () => {
      writeRawContact(OTHER_DID, {
        publicKey: 'k',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })

      const [contact] = await adapter.getContacts()
      // Das ist die Bedingung, an der die Kontaktliste abgestürzt ist: ein
      // `undefined` hier trifft jeden Aufrufer, der eine DID erwartet.
      expect(contact.did).toBe(OTHER_DID)

      await adapter.removeContact(contact.did)
      expect(await adapter.getContacts()).toHaveLength(0)
    })

    it('reicht einen Eintrag unter dem Schlüssel „undefined" nicht als Kontakt nach oben', async () => {
      // So sieht der Schaden aus, den `contacts[undefined] = …` hinterlässt:
      // ein Eintrag, den niemand adressieren kann. Er darf die Liste nicht
      // vergiften — der Rest muss weiter angezeigt werden.
      writeRawContact('undefined', { publicKey: 'k', status: 'active', createdAt: '', updatedAt: '' })
      await adapter.addContact(createTestContact())

      const contacts = await adapter.getContacts()
      expect(contacts.map(c => c.did)).toEqual([OTHER_DID])
    })

    it('weist eine fehlende DID beim Schreiben ab, statt sie abzulegen', async () => {
      // Ein solcher Eintrag überlebt jeden Reload und ist nicht mehr löschbar.
      // Der Fehler zeigt auf den Aufrufer, der die DID verloren hat.
      await expect(
        adapter.addContact(createTestContact({ did: undefined as unknown as string })),
      ).rejects.toThrow(/DID is required/)
      await expect(
        adapter.updateContact(createTestContact({ did: '' })),
      ).rejects.toThrow(/DID is required/)

      expect(await adapter.getContacts()).toHaveLength(0)
    })

    it('gibt beim Einzelabruf einen unbrauchbaren Schlüssel nicht heraus', async () => {
      // Sonst gilt die Invariante nur dort, wo niemand gezielt nachfragt: der
      // Sammelpfad verschweigt den Schaden, der Einzelabruf reicht ihn weiter.
      writeRawContact('undefined', { publicKey: 'k', status: 'active', createdAt: '', updatedAt: '' })
      writeRawContact('   ', { publicKey: 'k', status: 'active', createdAt: '', updatedAt: '' })

      expect(await adapter.getContact('undefined')).toBeNull()
      expect(await adapter.getContact('   ')).toBeNull()
      expect(await adapter.getContact('')).toBeNull()
    })

    it('behandelt einen Schlüssel aus Leerzeichen wie einen leeren', async () => {
      // `"   "` ist genauso unadressierbar wie `""`, nur schwerer zu sehen.
      writeRawContact('   ', { publicKey: 'k', status: 'active', createdAt: '', updatedAt: '' })
      await adapter.addContact(createTestContact())

      expect((await adapter.getContacts()).map(c => c.did)).toEqual([OTHER_DID])
      expect(adapter.watchContacts().getValue().map(c => c.did)).toEqual([OTHER_DID])
      await expect(adapter.addContact(createTestContact({ did: '   ' }))).rejects.toThrow(/DID is required/)
    })

    it('gilt genauso für den reaktiven Lesepfad', async () => {
      // watchContacts hatte dieselbe Zeile ein zweites Mal — die Kontaktliste
      // liest über diesen Pfad, nicht über getContacts().
      writeRawContact(OTHER_DID, {
        did: undefined,
        publicKey: 'k',
        status: 'active',
        createdAt: '',
        updatedAt: '',
      })

      const watched = adapter.watchContacts().getValue()
      expect(watched.map(c => c.did)).toEqual([OTHER_DID])
    })
  })

  // --- Verifications ---

  describe('Verifications', () => {
    it('keeps saveVerification as a no-op compatibility stub', async () => {
      await adapter.saveVerification(createTestVerification())

      const all = await adapter.getAllVerifications()
      expect(all).toEqual([])
    })

    it('returns an empty received verification snapshot', async () => {
      await adapter.saveVerification(createTestVerification({ id: 'v1', from: TEST_DID, to: OTHER_DID }))
      await adapter.saveVerification(createTestVerification({ id: 'v2', from: OTHER_DID, to: TEST_DID }))

      const received = await adapter.getReceivedVerifications()
      expect(received).toEqual([])
    })

    it('returns null for verification lookup by ID', async () => {
      await adapter.saveVerification(createTestVerification({ id: 'v1' }))

      expect(await adapter.getVerification('v1')).toBeNull()
      expect(await adapter.getVerification('nonexistent')).toBeNull()
    })
  })

  // --- Attestations ---

  describe('Attestations', () => {
    it('saves and retrieves attestations', async () => {
      await adapter.saveAttestation(createTestAttestation())

      const att = await adapter.getAttestation('att-1')
      expect(att?.claim).toBe('I know this person')
    })

    it('filters received attestations (to=me)', async () => {
      await adapter.saveAttestation(createTestAttestation({ id: 'a1', from: TEST_DID, to: OTHER_DID }))
      await adapter.saveAttestation(createTestAttestation({ id: 'a2', from: OTHER_DID, to: TEST_DID }))

      const received = await adapter.getReceivedAttestations()
      expect(received).toHaveLength(1)
      expect(received[0].from).toBe(OTHER_DID)
    })

    it('creates empty metadata on attestation save', async () => {
      await adapter.saveAttestation(createTestAttestation())

      const meta = await adapter.getAttestationMetadata('att-1')
      expect(meta).not.toBeNull()
      expect(meta?.accepted).toBe(false)
    })
  })

  // --- Attestation Metadata ---

  describe('Attestation Metadata', () => {
    it('sets and gets acceptance status', async () => {
      await adapter.saveAttestation(createTestAttestation())
      await adapter.setAttestationAccepted('att-1', true)

      const meta = await adapter.getAttestationMetadata('att-1')
      expect(meta?.accepted).toBe(true)
      expect(meta?.acceptedAt).toBeDefined()
    })

    it('sets delivery status', async () => {
      await adapter.saveAttestation(createTestAttestation())
      await adapter.setDeliveryStatus('att-1', 'delivered')

      const statuses = await adapter.getAllDeliveryStatuses()
      expect(statuses.get('att-1')).toBe('delivered')
    })

    it('creates metadata on-the-fly for unknown attestation', async () => {
      await adapter.setAttestationAccepted('unknown-att', true)

      const meta = await adapter.getAttestationMetadata('unknown-att')
      expect(meta?.accepted).toBe(true)
    })
  })

  // --- Reactive (Subscribable) ---

  describe('Reactive — watchContacts', () => {
    it('returns current contacts via getValue()', async () => {
      await adapter.addContact(createTestContact())

      const sub = adapter.watchContacts()
      expect(sub.getValue()).toHaveLength(1)
    })

    it('notifies on contact add', async () => {
      const sub = adapter.watchContacts()
      const updates: Contact[][] = []
      sub.subscribe(contacts => updates.push(contacts))

      await adapter.addContact(createTestContact())

      expect(updates).toHaveLength(1)
      expect(updates[0]).toHaveLength(1)
      expect(updates[0][0].name).toBe('Alice')
    })

    it('does not notify when nothing changed', async () => {
      const sub = adapter.watchContacts()
      const updates: Contact[][] = []
      sub.subscribe(contacts => updates.push(contacts))

      // Trigger a PersonalDoc change that doesn't affect contacts
      await adapter.createIdentity(TEST_DID, { name: 'Bob' })

      // Should not have triggered a contact update
      expect(updates).toHaveLength(0)
    })
  })

  describe('Reactive — watchAllVerifications', () => {
    it('exposes a stable empty snapshot for legacy verification watchers', async () => {
      const sub = adapter.watchAllVerifications()
      const updates: Verification[][] = []
      sub.subscribe(vs => updates.push(vs))

      expect(sub.getValue()).toEqual([])
      await adapter.saveVerification(createTestVerification())

      expect(sub.getValue()).toEqual([])
      expect(updates).toEqual([])
    })

    it('keeps received verification watcher empty for received legacy records', async () => {
      const sub = adapter.watchReceivedVerifications()
      const updates: Verification[][] = []
      sub.subscribe(vs => updates.push(vs))

      expect(sub.getValue()).toEqual([])
      await adapter.saveVerification(createTestVerification({ from: OTHER_DID, to: TEST_DID }))

      expect(sub.getValue()).toEqual([])
      expect(updates).toEqual([])
    })
  })

  describe('Reactive — watchAllAttestations', () => {
    it('notifies on attestation add', async () => {
      const sub = adapter.watchAllAttestations()
      const updates: Attestation[][] = []
      sub.subscribe(as => updates.push(as))

      await adapter.saveAttestation(createTestAttestation())

      // May fire more than once (attestation + metadata in same transaction)
      expect(updates.length).toBeGreaterThanOrEqual(1)
      const lastUpdate = updates[updates.length - 1]
      expect(lastUpdate).toHaveLength(1)
      expect(lastUpdate[0].id).toBe('att-1')
    })
  })

  describe('Reactive — watchIdentity', () => {
    it('returns identity after creation via getValue()', async () => {
      await adapter.createIdentity(TEST_DID, { name: 'Bob' })
      const sub = adapter.watchIdentity()
      const value = sub.getValue()
      expect(value).not.toBeNull()
      expect(value?.profile.name).toBe('Bob')
    })

    it('notifies on identity update', async () => {
      await adapter.createIdentity(TEST_DID, { name: 'Bob' })
      const sub = adapter.watchIdentity()
      const updates: any[] = []
      sub.subscribe(id => updates.push(id))

      const identity = (await adapter.getIdentity())!
      identity.profile.name = 'Robert'
      await adapter.updateIdentity(identity)

      expect(updates.length).toBeGreaterThanOrEqual(1)
      const last = updates[updates.length - 1]
      expect(last?.profile.name).toBe('Robert')
    })
  })
})
