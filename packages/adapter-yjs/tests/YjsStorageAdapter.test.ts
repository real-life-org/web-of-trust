import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { YjsStorageAdapter } from '../src/YjsStorageAdapter'
import {
  initYjsPersonalDoc,
  resetYjsPersonalDoc,
  deleteYjsPersonalDocDB,
} from '../src/YjsPersonalDocManager'
import { WotIdentity } from '@web_of_trust/core/application'
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
  let identity: WotIdentity

  beforeEach(async () => {
    identity = new WotIdentity()
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

    it('removes a contact', async () => {
      await adapter.addContact(createTestContact())
      expect(await adapter.getContacts()).toHaveLength(1)

      await adapter.removeContact(OTHER_DID)
      expect(await adapter.getContacts()).toHaveLength(0)
    })
  })

  // --- Verifications ---

  describe('Verifications', () => {
    it('saves and retrieves verifications', async () => {
      await adapter.saveVerification(createTestVerification())

      const all = await adapter.getAllVerifications()
      expect(all).toHaveLength(1)
      expect(all[0].from).toBe(TEST_DID)
      expect(all[0].to).toBe(OTHER_DID)
    })

    it('filters received verifications (to=me)', async () => {
      await adapter.saveVerification(createTestVerification({ id: 'v1', from: TEST_DID, to: OTHER_DID }))
      await adapter.saveVerification(createTestVerification({ id: 'v2', from: OTHER_DID, to: TEST_DID }))

      const received = await adapter.getReceivedVerifications()
      expect(received).toHaveLength(1)
      expect(received[0].from).toBe(OTHER_DID)
    })

    it('deduplicates verifications from same pair', async () => {
      await adapter.saveVerification(createTestVerification({ id: 'v-old' }))
      await adapter.saveVerification(createTestVerification({ id: 'v-new' }))

      const all = await adapter.getAllVerifications()
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe('v-new')
    })

    it('gets verification by ID', async () => {
      await adapter.saveVerification(createTestVerification({ id: 'v1' }))

      expect(await adapter.getVerification('v1')).not.toBeNull()
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
    it('notifies on verification add', async () => {
      const sub = adapter.watchAllVerifications()
      const updates: Verification[][] = []
      sub.subscribe(vs => updates.push(vs))

      await adapter.saveVerification(createTestVerification())

      expect(updates).toHaveLength(1)
      expect(updates[0]).toHaveLength(1)
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
