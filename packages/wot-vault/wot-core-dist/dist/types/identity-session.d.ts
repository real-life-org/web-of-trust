export interface IdentityEncryptedPayload {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    ephemeralPublicKey?: Uint8Array;
}
export interface PublicIdentityMaterial {
    did: string;
    kid: string;
    ed25519PublicKey: Uint8Array;
    x25519PublicKey: Uint8Array;
}
export interface IdentitySession {
    getDid(): string;
    sign(data: string): Promise<string>;
    signJws(payload: unknown): Promise<string>;
    deriveFrameworkKey(info: string): Promise<Uint8Array>;
    getPublicKeyMultibase(): Promise<string>;
    getEncryptionPublicKeyBytes(): Promise<Uint8Array>;
    encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<IdentityEncryptedPayload>;
    decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array>;
    deleteStoredIdentity(): Promise<void>;
}
export type PublicIdentitySession = IdentitySession & PublicIdentityMaterial;
export interface IdentityVaultUnlockHandle extends PublicIdentityMaterial {
    signEd25519(data: Uint8Array): Promise<Uint8Array>;
    decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array>;
    deriveFrameworkKey(info: string, length?: number): Promise<Uint8Array>;
}
//# sourceMappingURL=identity-session.d.ts.map