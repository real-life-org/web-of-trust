/**
 * EncryptedSyncService — Encrypts/decrypts CRDT changes with a group key.
 *
 * Used for Encrypted Group Spaces: each change is AES-256-GCM encrypted
 * before being sent to other members. The server (relay) never sees plaintext.
 *
 * Pattern: Encrypt-then-sync (inspired by Keyhive/NextGraph)
 */
export interface EncryptedChange {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    spaceId: string;
    generation: number;
    fromDid: string;
}
export declare class EncryptedSyncService {
    /**
     * Encrypt a CRDT change with a group key.
     */
    static encryptChange(data: Uint8Array, groupKey: Uint8Array, spaceId: string, generation: number, fromDid: string): Promise<EncryptedChange>;
    /**
     * Decrypt a CRDT change with a group key.
     */
    static decryptChange(change: EncryptedChange, groupKey: Uint8Array): Promise<Uint8Array>;
}
//# sourceMappingURL=EncryptedSyncService.d.ts.map