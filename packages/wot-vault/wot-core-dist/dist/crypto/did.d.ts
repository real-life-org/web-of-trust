/**
 * Create a did:key from Ed25519 public key bytes
 * Format: did:key:z<base58btc-encoded-multicodec-pubkey>
 */
export declare function createDid(publicKeyBytes: Uint8Array): string;
/**
 * Extract Ed25519 public key bytes from did:key
 */
export declare function didToPublicKeyBytes(did: string): Uint8Array;
/**
 * Validate did:key format
 */
export declare function isValidDid(did: string): boolean;
/**
 * Generate a short display name from a DID
 * Format: "User-{6chars}" from the end of the DID
 */
export declare function getDefaultDisplayName(did: string): string;
//# sourceMappingURL=did.d.ts.map