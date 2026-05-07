import { IdentitySession } from '../types/identity-session';
export interface VaultChange {
    seq: number;
    data: string;
    authorDid: string;
    createdAt: string;
}
export interface VaultSnapshot {
    data: string;
    upToSeq: number;
}
export interface VaultDocInfo {
    latestSeq: number;
    snapshotSeq: number | null;
    changeCount: number;
}
export interface VaultChangesResponse {
    docId: string;
    snapshot: VaultSnapshot | null;
    changes: VaultChange[];
}
export declare class VaultClient {
    private vaultUrl;
    private identity;
    private capabilityCache;
    private bearerToken;
    constructor(vaultUrl: string, identity: IdentitySession);
    /**
     * Push an encrypted change to the vault.
     * @returns The assigned sequence number.
     */
    pushChange(docId: string, encryptedData: Uint8Array): Promise<number>;
    /**
     * Get all changes (and optional snapshot) for a document.
     */
    getChanges(docId: string, since?: number): Promise<VaultChangesResponse>;
    /**
     * Store a compacted snapshot (replaces changes up to upToSeq).
     */
    putSnapshot(docId: string, encryptedData: Uint8Array, nonce: Uint8Array, upToSeq: number): Promise<void>;
    /**
     * Get document info (seq, change count).
     */
    getDocInfo(docId: string): Promise<VaultDocInfo | null>;
    /**
     * Delete a document from the vault.
     */
    deleteDoc(docId: string): Promise<void>;
    private authHeaders;
    private getOrCreateBearerToken;
    private getOrCreateCapability;
}
export { decodeBase64 as base64ToUint8 } from '../crypto/encoding';
//# sourceMappingURL=VaultClient.d.ts.map