import { CryptoAdapter, EncryptedPayload } from '../interfaces/CryptoAdapter';
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
    generateMnemonic(): string;
    deriveKeyPairFromMnemonic(_mnemonic: string): Promise<KeyPair>;
    validateMnemonic(_mnemonic: string): boolean;
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
    encrypt(_plaintext: Uint8Array, _recipientPublicKey: Uint8Array): Promise<EncryptedPayload>;
    decrypt(_payload: EncryptedPayload, _privateKey: Uint8Array): Promise<Uint8Array>;
    generateNonce(): string;
    hashData(data: Uint8Array): Promise<Uint8Array>;
}
//# sourceMappingURL=WebCryptoAdapter.d.ts.map