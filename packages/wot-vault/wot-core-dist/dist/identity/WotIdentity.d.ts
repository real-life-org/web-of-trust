import { CryptoAdapter, EncryptedPayload } from '../ports/CryptoAdapter';
import { SeedStorageAdapter } from '../ports/SeedStorageAdapter';
/**
 * WotIdentity - BIP39-based identity with pluggable crypto and storage
 *
 * Security architecture:
 * - BIP39 Mnemonic (12 words, 128 bit entropy)
 * - Master Key derived via HKDF (non-extractable)
 * - Identity Private Key (non-extractable, Ed25519)
 * - Framework Keys (extractable for Evolu, etc.)
 *
 * Storage:
 * - Mnemonic: User must write down (never stored)
 * - Master Seed: Encrypted with PBKDF2(passphrase) + AES-GCM via SeedStorageAdapter
 * - Keys: All derived from master seed via HKDF
 */
export declare class WotIdentity {
    private masterKey;
    private identityKeyPair;
    private encKeyPair;
    private encKeyPairPromise;
    private did;
    private storage;
    private crypto;
    /**
     * @param storage - Seed storage adapter (default: IndexedDB-based SeedStorage)
     * @param cryptoAdapter - Crypto adapter (default: WebCryptoAdapter)
     */
    constructor(storage?: SeedStorageAdapter, cryptoAdapter?: CryptoAdapter);
    /**
     * Create a new identity with BIP39 mnemonic
     *
     * @param userPassphrase - User's passphrase for seed encryption
     * @param storeSeed - Store encrypted seed in IndexedDB (default: true)
     * @returns Mnemonic (12 words) and DID
     */
    create(userPassphrase: string, storeSeed?: boolean): Promise<{
        mnemonic: string;
        did: string;
    }>;
    /**
     * Unlock identity from mnemonic + passphrase
     *
     * @param mnemonic - 12 word BIP39 mnemonic
     * @param passphrase - User's passphrase
     * @param storeSeed - Store encrypted seed in IndexedDB (default: false)
     */
    unlock(mnemonic: string, passphrase: string, storeSeed?: boolean): Promise<void>;
    /**
     * Unlock identity from stored encrypted seed.
     * If no passphrase is provided, attempts to use a cached session key.
     *
     * @param passphrase - User's passphrase (optional if session key is cached)
     * @throws Error if no seed stored, wrong passphrase, or no active session
     */
    unlockFromStorage(passphrase?: string): Promise<void>;
    /**
     * Check if a valid session key exists (allows unlock without passphrase)
     */
    hasActiveSession(): Promise<boolean>;
    /**
     * Check if identity exists in storage
     */
    hasStoredIdentity(): Promise<boolean>;
    /**
     * Delete stored identity
     */
    deleteStoredIdentity(): Promise<void>;
    /**
     * Lock identity (clear all keys from memory and session cache)
     */
    lock(): Promise<void>;
    private ensureUnlocked;
    getDid(): string;
    signJws(payload: unknown): Promise<string>;
    sign(data: string): Promise<string>;
    deriveFrameworkKey(info: string): Promise<Uint8Array>;
    getPublicKey(): Promise<CryptoKey>;
    exportPublicKeyJwk(): Promise<JsonWebKey>;
    getPublicKeyMultibase(): Promise<string>;
    private ensureEncKeyPair;
    /**
     * Get the X25519 encryption key pair (derived via separate HKDF path).
     */
    getEncryptionKeyPair(): Promise<CryptoKeyPair>;
    /**
     * Get X25519 public key as raw bytes (32 bytes).
     */
    getEncryptionPublicKeyBytes(): Promise<Uint8Array>;
    /**
     * Encrypt data for a recipient using their X25519 public key.
     * Uses ephemeral ECDH + HKDF + AES-256-GCM (ECIES-like).
     */
    encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<EncryptedPayload>;
    /**
     * Decrypt data encrypted for this identity.
     */
    decryptForMe(payload: EncryptedPayload): Promise<Uint8Array>;
    /**
     * Initialize identity from a 32-byte seed.
     * Shared logic for create(), unlock(), and unlockFromStorage().
     */
    private initFromSeed;
}
//# sourceMappingURL=WotIdentity.d.ts.map