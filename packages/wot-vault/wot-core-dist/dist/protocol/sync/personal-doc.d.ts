import { ProtocolCryptoAdapter } from '../crypto/ports';
export interface PersonalDocMaterial {
    hkdfInfo: string;
    key: Uint8Array;
    docId: string;
}
export declare function derivePersonalDocFromSeedHex(bip39SeedHex: string, cryptoAdapter: ProtocolCryptoAdapter): Promise<PersonalDocMaterial>;
export declare function personalDocIdFromKey(key: Uint8Array): string;
//# sourceMappingURL=personal-doc.d.ts.map