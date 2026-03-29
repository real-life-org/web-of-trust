/**
 * SeedStorage - Encrypted storage for master seed
 *
 * Security:
 * - Master seed encrypted with PBKDF2(passphrase) + AES-GCM
 * - Stored in IndexedDB
 * - Never stored unencrypted
 * - Session cache: non-extractable CryptoKey in IndexedDB with TTL
 */
export declare class SeedStorage {
    private static readonly DB_NAME;
    private static readonly STORE_NAME;
    private static readonly SESSION_STORE_NAME;
    private static readonly PBKDF2_ITERATIONS;
    private static readonly DEFAULT_SESSION_TTL;
    private db;
    /**
     * Initialize IndexedDB
     */
    init(): Promise<void>;
    /**
     * Store encrypted seed
     *
     * @param seed - Master seed (32 bytes)
     * @param passphrase - User's passphrase
     */
    storeSeed(seed: Uint8Array, passphrase: string): Promise<void>;
    /**
     * Load and decrypt seed using passphrase.
     * On success, caches the derived CryptoKey as session key.
     *
     * @param passphrase - User's passphrase
     * @returns Decrypted seed or null if not found
     */
    loadSeed(passphrase: string): Promise<Uint8Array | null>;
    /**
     * Load and decrypt seed using cached session key (no passphrase needed).
     * Returns null if no session key, session expired, or decryption fails.
     */
    loadSeedWithSessionKey(): Promise<Uint8Array | null>;
    /**
     * Check if a valid (non-expired) session key exists
     */
    hasActiveSession(): Promise<boolean>;
    /**
     * Check if seed exists in storage
     */
    hasSeed(): Promise<boolean>;
    /**
     * Delete stored seed and session key
     */
    deleteSeed(): Promise<void>;
    /**
     * Clear the cached session key
     */
    clearSessionKey(): Promise<void>;
    private storeSessionKey;
    private getSessionEntry;
    private getEncryptedSeed;
    private deriveEncryptionKey;
    private arrayBufferToBase64Url;
    private base64UrlToArrayBuffer;
}
//# sourceMappingURL=SeedStorage.d.ts.map