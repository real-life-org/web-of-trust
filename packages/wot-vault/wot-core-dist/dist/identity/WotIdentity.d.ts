import { EncryptedPayload } from '../adapters/interfaces/CryptoAdapter';
/**
 * WotIdentity - BIP39-based identity with native WebCrypto
 *
 * Security architecture:
 * - BIP39 Mnemonic (12 words, 128 bit entropy)
 * - Master Key derived via HKDF (non-extractable)
 * - Identity Private Key (non-extractable, Ed25519)
 * - Framework Keys (extractable for Evolu, etc.)
 *
 * Storage:
 * - Mnemonic: User must write down (never stored)
 * - Master Seed: Encrypted with PBKDF2(passphrase) + AES-GCM in IndexedDB
 * - Keys: All derived from master seed via HKDF
 */
export declare class WotIdentity {
    private masterKey;
    private identityKeyPair;
    private encryptionKeyPair;
    private did;
    private storage;
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
    /**
     * Get DID (Decentralized Identifier)
     */
    getDid(): string;
    /**
     * Sign a payload as JWS (JSON Web Signature) compact serialization
     *
     * @param payload - Data to sign (will be JSON-serialized)
     * @returns JWS compact serialization (header.payload.signature)
     */
    signJws(payload: unknown): Promise<string>;
    /**
     * Sign data with identity private key
     *
     * @param data - Data to sign
     * @returns Signature as base64url string
     */
    sign(data: string): Promise<string>;
    /**
     * Derive framework-specific keys (extractable for Evolu, etc.)
     *
     * @param info - Context string (e.g., 'evolu-storage-v1')
     * @returns Derived key bytes
     */
    deriveFrameworkKey(info: string): Promise<Uint8Array>;
    /**
     * Get public key (for DID Document, etc.)
     */
    getPublicKey(): Promise<CryptoKey>;
    /**
     * Export public key as JWK
     */
    exportPublicKeyJwk(): Promise<JsonWebKey>;
    /**
     * Get public key as multibase encoded string (same format as in DID)
     */
    getPublicKeyMultibase(): Promise<string>;
    /**
     * Get the X25519 encryption key pair (derived via separate HKDF path).
     * Lazily derived on first call, then cached.
     */
    getEncryptionKeyPair(): Promise<CryptoKeyPair>;
    /**
     * Get X25519 public key as raw bytes (32 bytes).
     * This is what others need to encrypt messages for this identity.
     */
    getEncryptionPublicKeyBytes(): Promise<Uint8Array>;
    /**
     * Encrypt data for a recipient using their X25519 public key.
     * Uses ephemeral ECDH + HKDF + AES-256-GCM (ECIES-like).
     */
    encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<EncryptedPayload>;
    /**
     * Decrypt data encrypted for this identity.
     * Uses own X25519 private key + ephemeral public key from sender.
     */
    decryptForMe(payload: EncryptedPayload): Promise<Uint8Array>;
    private deriveIdentityKeyPair;
    private deriveEncryptionKeyPair;
    /**
     * Wrap raw 32-byte X25519 private key in PKCS8 DER format.
     * PKCS8 = SEQUENCE { version, algorithm, key }
     */
    private wrapX25519PrivateKey;
    private generateDID;
    private arrayBufferToBase64Url;
    private base64UrlToArrayBuffer;
    private base58Encode;
}
//# sourceMappingURL=WotIdentity.d.ts.map