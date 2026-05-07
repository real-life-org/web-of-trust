import { ProtocolCryptoAdapter } from '../protocol/crypto/ports';
export declare class WebCryptoProtocolCryptoAdapter implements ProtocolCryptoAdapter {
    verifyEd25519(input: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
    sha256(input: Uint8Array): Promise<Uint8Array>;
    hkdfSha256(input: Uint8Array, info: string, length: number): Promise<Uint8Array>;
    x25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array>;
    x25519SharedSecret(privateSeed: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array>;
    aes256GcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
    aes256GcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
}
//# sourceMappingURL=web-crypto.d.ts.map