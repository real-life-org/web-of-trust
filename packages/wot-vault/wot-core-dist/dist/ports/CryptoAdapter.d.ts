import { KeyPair } from '../types';
/**
 * Encrypted payload structure for E2E encryption
 */
export interface EncryptedPayload {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    ephemeralPublicKey?: Uint8Array;
}
/**
 * Opaque handle for a master key used in HKDF derivation.
 * In Web Crypto: CryptoKey. In Rust: opaque handle or byte array.
 */
export interface MasterKeyHandle {
    readonly _brand: 'MasterKeyHandle';
}
/**
 * Opaque handle for an X25519 encryption key pair.
 * Kept separate from Ed25519 KeyPair to enforce type safety.
 */
export interface EncryptionKeyPair {
    readonly _brand: 'EncryptionKeyPair';
}
/**
 * Crypto adapter interface for all cryptographic operations.
 *
 * Framework-agnostic: Can be implemented with Web Crypto API,
 * noble/ed25519, libsodium, or any other crypto library.
 */
export interface CryptoAdapter {
    generateKeyPair(): Promise<KeyPair>;
    exportKeyPair(keyPair: KeyPair): Promise<{
        publicKey: string;
        privateKey: string;
    }>;
    importKeyPair(exported: {
        publicKey: string;
        privateKey: string;
    }): Promise<KeyPair>;
    exportPublicKey(publicKey: CryptoKey): Promise<string>;
    importPublicKey(exported: string): Promise<CryptoKey>;
    /** Import a 32-byte seed as HKDF master key */
    importMasterKey(seed: Uint8Array): Promise<MasterKeyHandle>;
    /** Derive deterministic bits from master key via HKDF-SHA256 */
    deriveBits(masterKey: MasterKeyHandle, info: string, bits: number): Promise<Uint8Array>;
    /** Derive a deterministic Ed25519 key pair from a 32-byte seed */
    deriveKeyPairFromSeed(seed: Uint8Array): Promise<KeyPair>;
    createDid(publicKey: CryptoKey): Promise<string>;
    didToPublicKey(did: string): Promise<CryptoKey>;
    sign(data: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array>;
    verify(data: Uint8Array, signature: Uint8Array, publicKey: CryptoKey): Promise<boolean>;
    signString(data: string, privateKey: CryptoKey): Promise<string>;
    verifyString(data: string, signature: string, publicKey: CryptoKey): Promise<boolean>;
    generateSymmetricKey(): Promise<Uint8Array>;
    encryptSymmetric(plaintext: Uint8Array, key: Uint8Array): Promise<{
        ciphertext: Uint8Array;
        nonce: Uint8Array;
    }>;
    decryptSymmetric(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
    /** Derive an X25519 encryption key pair from a 32-byte seed */
    deriveEncryptionKeyPair(seed: Uint8Array): Promise<EncryptionKeyPair>;
    /** Export X25519 public key as 32 raw bytes */
    exportEncryptionPublicKey(keyPair: EncryptionKeyPair): Promise<Uint8Array>;
    /** Encrypt for a recipient using their X25519 public key (ECIES) */
    encryptAsymmetric(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<EncryptedPayload>;
    /** Decrypt data encrypted for this key pair (ECIES) */
    decryptAsymmetric(payload: EncryptedPayload, keyPair: EncryptionKeyPair): Promise<Uint8Array>;
    generateNonce(): string;
    randomBytes(length: number): Uint8Array;
    hashData(data: Uint8Array): Promise<Uint8Array>;
}
//# sourceMappingURL=CryptoAdapter.d.ts.map