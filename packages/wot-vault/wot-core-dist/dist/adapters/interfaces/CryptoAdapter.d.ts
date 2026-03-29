import { KeyPair } from '../../types';
/**
 * Encrypted payload structure for E2E encryption
 */
export interface EncryptedPayload {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    ephemeralPublicKey?: Uint8Array;
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
    generateMnemonic(): string;
    deriveKeyPairFromMnemonic(mnemonic: string): Promise<KeyPair>;
    validateMnemonic(mnemonic: string): boolean;
    createDid(publicKey: CryptoKey): Promise<string>;
    didToPublicKey(did: string): Promise<CryptoKey>;
    sign(data: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array>;
    verify(data: Uint8Array, signature: Uint8Array, publicKey: CryptoKey): Promise<boolean>;
    signString(data: string, privateKey: CryptoKey): Promise<string>;
    verifyString(data: string, signature: string, publicKey: CryptoKey): Promise<boolean>;
    encrypt(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Promise<EncryptedPayload>;
    decrypt(payload: EncryptedPayload, privateKey: Uint8Array): Promise<Uint8Array>;
    generateSymmetricKey(): Promise<Uint8Array>;
    encryptSymmetric(plaintext: Uint8Array, key: Uint8Array): Promise<{
        ciphertext: Uint8Array;
        nonce: Uint8Array;
    }>;
    decryptSymmetric(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array>;
    generateNonce(): string;
    hashData(data: Uint8Array): Promise<Uint8Array>;
}
//# sourceMappingURL=CryptoAdapter.d.ts.map