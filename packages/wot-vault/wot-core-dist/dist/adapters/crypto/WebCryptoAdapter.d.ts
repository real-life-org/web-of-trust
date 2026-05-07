import { CryptoAdapter, MasterKeyHandle, EncryptionKeyPair, EncryptedPayload } from '../../ports/CryptoAdapter';
import { KeyPair } from '../../types';
export declare class WebCryptoAdapter implements CryptoAdapter {
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
    generateNonce(): string;
    hashData(data: Uint8Array): Promise<Uint8Array>;
    importMasterKey(seed: Uint8Array): Promise<MasterKeyHandle>;
    deriveBits(masterKey: MasterKeyHandle, info: string, bits: number): Promise<Uint8Array>;
    deriveKeyPairFromSeed(seed: Uint8Array): Promise<KeyPair>;
    deriveEncryptionKeyPair(seed: Uint8Array): Promise<EncryptionKeyPair>;
    private deriveEciesKey;
    exportEncryptionPublicKey(keyPair: EncryptionKeyPair): Promise<Uint8Array>;
    encryptAsymmetric(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<EncryptedPayload>;
    decryptAsymmetric(payload: EncryptedPayload, keyPair: EncryptionKeyPair): Promise<Uint8Array>;
    randomBytes(length: number): Uint8Array;
}
//# sourceMappingURL=WebCryptoAdapter.d.ts.map