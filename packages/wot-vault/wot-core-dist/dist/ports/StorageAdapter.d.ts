import { Identity, Profile, Contact, Verification, Attestation, AttestationMetadata } from '../types';
/**
 * Storage adapter interface for persisting Web of Trust data.
 *
 * Framework-agnostic: Can be implemented with IndexedDB, SQLite,
 * Evolu, Jazz, or any other storage backend.
 *
 * Follows the Empfänger-Prinzip: Verifications and Attestations
 * are stored at the recipient (to), not the sender (from).
 */
export interface StorageAdapter {
    createIdentity(did: string, profile: Profile): Promise<Identity>;
    getIdentity(): Promise<Identity | null>;
    updateIdentity(identity: Identity): Promise<void>;
    addContact(contact: Contact): Promise<void>;
    getContacts(): Promise<Contact[]>;
    getContact(did: string): Promise<Contact | null>;
    updateContact(contact: Contact): Promise<void>;
    removeContact(did: string): Promise<void>;
    saveVerification(verification: Verification): Promise<void>;
    getReceivedVerifications(): Promise<Verification[]>;
    getAllVerifications(): Promise<Verification[]>;
    getVerification(id: string): Promise<Verification | null>;
    saveAttestation(attestation: Attestation): Promise<void>;
    getReceivedAttestations(): Promise<Attestation[]>;
    getAttestation(id: string): Promise<Attestation | null>;
    getAttestationMetadata(attestationId: string): Promise<AttestationMetadata | null>;
    setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void>;
    init(): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=StorageAdapter.d.ts.map