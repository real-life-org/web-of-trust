import { ProtocolCryptoAdapter } from '../crypto/ports';
export interface SpaceAdminKeyMaterial {
    hkdfInfo: string;
    ed25519Seed: Uint8Array;
    ed25519PublicKey: Uint8Array;
    did: string;
}
export declare function deriveSpaceAdminKeyFromSeedHex(bip39SeedHex: string, spaceId: string, cryptoAdapter: ProtocolCryptoAdapter): Promise<SpaceAdminKeyMaterial>;
//# sourceMappingURL=admin-key.d.ts.map