import { ProtocolCryptoAdapter } from '../crypto/ports';
export interface EciesMessage {
    epk: string;
    nonce: string;
    ciphertext: string;
}
export interface EciesMaterial {
    ephemeralPublicKey: Uint8Array;
    sharedSecret: Uint8Array;
    aesKey: Uint8Array;
}
export interface DeriveEciesMaterialOptions {
    crypto: ProtocolCryptoAdapter;
    ephemeralPrivateSeed: Uint8Array;
    recipientPublicKey: Uint8Array;
}
export interface EncryptEciesOptions extends DeriveEciesMaterialOptions {
    nonce: Uint8Array;
    plaintext: Uint8Array;
}
export interface DecryptEciesOptions {
    crypto: ProtocolCryptoAdapter;
    recipientPrivateSeed: Uint8Array;
    message: EciesMessage;
}
export interface EncryptLogPayloadOptions {
    crypto: ProtocolCryptoAdapter;
    spaceContentKey: Uint8Array;
    deviceId: string;
    seq: number;
    plaintext: Uint8Array;
}
export interface LogPayloadEncryptionResult {
    nonce: Uint8Array;
    ciphertextTag: Uint8Array;
    blob: Uint8Array;
    blobBase64Url: string;
}
export interface DecryptLogPayloadOptions {
    crypto: ProtocolCryptoAdapter;
    spaceContentKey: Uint8Array;
    blob: Uint8Array;
}
export declare function deriveEciesMaterial(options: DeriveEciesMaterialOptions): Promise<EciesMaterial>;
export declare function encryptEcies(options: EncryptEciesOptions): Promise<EciesMessage>;
export declare function decryptEcies(options: DecryptEciesOptions): Promise<Uint8Array>;
export declare function deriveLogPayloadNonce(cryptoAdapter: ProtocolCryptoAdapter, deviceId: string, seq: number): Promise<Uint8Array>;
export declare function encryptLogPayload(options: EncryptLogPayloadOptions): Promise<LogPayloadEncryptionResult>;
export declare function decryptLogPayload(options: DecryptLogPayloadOptions): Promise<Uint8Array>;
//# sourceMappingURL=encryption.d.ts.map