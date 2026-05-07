import { ProtocolCryptoAdapter } from '../crypto/ports';
export interface ProtocolIdentityMaterial {
    ed25519Seed: Uint8Array;
    ed25519PublicKey: Uint8Array;
    x25519Seed: Uint8Array;
    x25519PublicKey: Uint8Array;
    did: string;
    kid: string;
}
export declare function deriveProtocolIdentityFromSeedHex(bip39SeedHex: string, cryptoAdapter: ProtocolCryptoAdapter): Promise<ProtocolIdentityMaterial>;
//# sourceMappingURL=key-derivation.d.ts.map