import type {
  Identity,
  Profile,
  Contact,
  Attestation,
  AttestationMetadata,
} from '../types'

/**
 * Storage adapter interface for persisting Web of Trust data.
 *
 * Framework-agnostic: Can be implemented with IndexedDB, SQLite,
 * Evolu, Jazz, or any other storage backend.
 *
 * Follows the Empfänger-Prinzip: Attestations are stored at the
 * recipient (to), not the sender (from).
 */
export interface StorageAdapter {
  // Identity (local, never synced)
  createIdentity(did: string, profile: Profile): Promise<Identity>
  getIdentity(): Promise<Identity | null>
  updateIdentity(identity: Identity): Promise<void>

  // Contacts (derived from verifications)
  addContact(contact: Contact): Promise<void>
  getContacts(): Promise<Contact[]>
  getContact(did: string): Promise<Contact | null>
  updateContact(contact: Contact): Promise<void>
  removeContact(did: string): Promise<void>

  // Attestations (Empfänger-Prinzip: I receive attestations about me)
  saveAttestation(attestation: Attestation): Promise<void>
  getReceivedAttestations(): Promise<Attestation[]>
  getAttestation(id: string): Promise<Attestation | null>

  // Attestation Metadata (local, not signed, not synced)
  getAttestationMetadata(attestationId: string): Promise<AttestationMetadata | null>
  setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void>

  // Lifecycle
  init(): Promise<void>
  clear(): Promise<void>
}
