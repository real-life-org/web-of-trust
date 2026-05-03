import { openDB, type IDBPDatabase } from 'idb'
import type { StorageAdapter } from '../../ports/StorageAdapter'
import type { Identity, Profile, Contact, Verification, Attestation, AttestationMetadata } from '../../types'

const DB_NAME = 'web-of-trust'
const DB_VERSION = 2

interface WoTDB {
  identity: {
    key: string
    value: Identity
  }
  contacts: {
    key: string
    value: Contact
    indexes: { 'by-status': string }
  }
  verifications: {
    key: string
    value: Verification
    indexes: { 'by-from': string }
  }
  attestations: {
    key: string
    value: Attestation
    indexes: { 'by-from': string }
  }
  attestationMetadata: {
    key: string
    value: AttestationMetadata
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  private db: IDBPDatabase<WoTDB> | null = null

  async init(): Promise<void> {
    this.db = await openDB<WoTDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Identity store (single record)
        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'did' })
        }

        // Contacts store
        if (!db.objectStoreNames.contains('contacts')) {
          const contactStore = db.createObjectStore('contacts', { keyPath: 'did' })
          contactStore.createIndex('by-status', 'status')
        }

        // Verifications store (Empfänger-Prinzip: indexed by 'from')
        if (!db.objectStoreNames.contains('verifications')) {
          const verificationStore = db.createObjectStore('verifications', { keyPath: 'id' })
          verificationStore.createIndex('by-from', 'from')
        }

        // Attestations store (Empfänger-Prinzip: indexed by 'from')
        if (!db.objectStoreNames.contains('attestations')) {
          const attestationStore = db.createObjectStore('attestations', { keyPath: 'id' })
          attestationStore.createIndex('by-from', 'from')
        }

        // Attestation metadata (local, not synced)
        if (!db.objectStoreNames.contains('attestationMetadata')) {
          db.createObjectStore('attestationMetadata', { keyPath: 'attestationId' })
        }
      },
    })
  }

  private ensureDb(): IDBPDatabase<WoTDB> {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.')
    }
    return this.db
  }

  // Identity methods
  async createIdentity(did: string, profile: Profile): Promise<Identity> {
    const db = this.ensureDb()
    const now = new Date().toISOString()
    const identity: Identity = {
      did,
      profile,
      createdAt: now,
      updatedAt: now,
    }
    await db.put('identity', identity)
    return identity
  }

  async getIdentity(): Promise<Identity | null> {
    const db = this.ensureDb()
    const all = await db.getAll('identity')
    return all[0] || null
  }

  async updateIdentity(identity: Identity): Promise<void> {
    const db = this.ensureDb()
    identity.updatedAt = new Date().toISOString()
    await db.put('identity', identity)
  }

  // Contact methods
  async addContact(contact: Contact): Promise<void> {
    const db = this.ensureDb()
    await db.put('contacts', contact)
  }

  async getContacts(): Promise<Contact[]> {
    const db = this.ensureDb()
    return db.getAll('contacts')
  }

  async getContact(did: string): Promise<Contact | null> {
    const db = this.ensureDb()
    return (await db.get('contacts', did)) || null
  }

  async updateContact(contact: Contact): Promise<void> {
    const db = this.ensureDb()
    contact.updatedAt = new Date().toISOString()
    await db.put('contacts', contact)
  }

  async removeContact(did: string): Promise<void> {
    const db = this.ensureDb()
    await db.delete('contacts', did)
  }

  // Verification methods (Empfänger-Prinzip)
  async saveVerification(verification: Verification): Promise<void> {
    const db = this.ensureDb()
    // Overwrite existing verification from the same from→to pair (renewal)
    const all = await db.getAll('verifications')
    for (const existing of all) {
      if (existing.from === verification.from && existing.to === verification.to && existing.id !== verification.id) {
        await db.delete('verifications', existing.id)
      }
    }
    await db.put('verifications', verification)
  }

  async getReceivedVerifications(): Promise<Verification[]> {
    const db = this.ensureDb()
    const identity = await this.getIdentity()
    if (!identity) return []
    const all = await db.getAll('verifications')
    return all.filter(v => v.to === identity.did)
  }

  async getAllVerifications(): Promise<Verification[]> {
    const db = this.ensureDb()
    return db.getAll('verifications')
  }

  async getVerification(id: string): Promise<Verification | null> {
    const db = this.ensureDb()
    return (await db.get('verifications', id)) || null
  }

  // Attestation methods (Empfänger-Prinzip)
  async saveAttestation(attestation: Attestation): Promise<void> {
    const db = this.ensureDb()
    await db.put('attestations', attestation)
    // Create default metadata if not exists
    const existing = await db.get('attestationMetadata', attestation.id)
    if (!existing) {
      await db.put('attestationMetadata', {
        attestationId: attestation.id,
        accepted: false,
      })
    }
  }

  async getReceivedAttestations(): Promise<Attestation[]> {
    const db = this.ensureDb()
    return db.getAll('attestations')
  }

  async getAttestation(id: string): Promise<Attestation | null> {
    const db = this.ensureDb()
    return (await db.get('attestations', id)) || null
  }

  // Attestation Metadata methods
  async getAttestationMetadata(attestationId: string): Promise<AttestationMetadata | null> {
    const db = this.ensureDb()
    return (await db.get('attestationMetadata', attestationId)) || null
  }

  async setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void> {
    const db = this.ensureDb()
    const metadata: AttestationMetadata = {
      attestationId,
      accepted,
      ...(accepted ? { acceptedAt: new Date().toISOString() } : {}),
    }
    await db.put('attestationMetadata', metadata)
  }

  // Lifecycle
  async clear(): Promise<void> {
    const db = this.ensureDb()
    await Promise.all([
      db.clear('identity'),
      db.clear('contacts'),
      db.clear('verifications'),
      db.clear('attestations'),
      db.clear('attestationMetadata'),
    ])
  }
}
