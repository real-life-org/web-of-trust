import { StorageAdapter } from '../../ports/StorageAdapter';
import { Identity, Profile, Contact, Verification, Attestation, AttestationMetadata } from '../../types';
export declare class LocalStorageAdapter implements StorageAdapter {
    private db;
    init(): Promise<void>;
    private ensureDb;
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
    clear(): Promise<void>;
}
//# sourceMappingURL=LocalStorageAdapter.d.ts.map