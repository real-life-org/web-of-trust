import { ProtocolCryptoAdapter } from '../../protocol';
import { SeedStorageAdapter } from '../../ports/SeedStorageAdapter';
import { IdentitySeedVault } from '../../ports';
import { IdentityVaultUnlockHandle } from '../../types/identity-session';
export interface SeedStorageIdentityVaultOptions {
    storage?: SeedStorageAdapter;
    crypto?: ProtocolCryptoAdapter;
}
export declare class SeedStorageIdentityVault implements IdentitySeedVault {
    private readonly storage;
    private readonly crypto;
    constructor(storageOrOptions?: SeedStorageAdapter | SeedStorageIdentityVaultOptions);
    saveSeed(seed: Uint8Array, passphrase: string): Promise<void>;
    unlockWithPassphrase(passphrase: string): Promise<IdentityVaultUnlockHandle | null>;
    unlockWithSession(): Promise<IdentityVaultUnlockHandle | null>;
    deleteSeed(): Promise<void>;
    hasSeed(): Promise<boolean>;
    hasActiveSession(): Promise<boolean>;
    clearSessionKey(): Promise<void>;
    private encodeSeed;
    private decodeSeed;
}
//# sourceMappingURL=SeedStorageIdentityVault.d.ts.map