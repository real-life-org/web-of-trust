import { SeedStorageAdapter } from '../../ports/SeedStorageAdapter';
import { IdentitySeedVault } from '../../ports';
export declare class SeedStorageIdentityVault implements IdentitySeedVault {
    private readonly storage;
    constructor(storage?: SeedStorageAdapter);
    saveSeed(seed: Uint8Array, passphrase: string): Promise<void>;
    loadSeed(passphrase: string): Promise<Uint8Array | null>;
    loadSeedWithSessionKey(): Promise<Uint8Array | null>;
    deleteSeed(): Promise<void>;
    hasSeed(): Promise<boolean>;
    hasActiveSession(): Promise<boolean>;
    clearSessionKey(): Promise<void>;
    private encodeSeed;
    private decodeSeed;
}
//# sourceMappingURL=SeedStorageIdentityVault.d.ts.map