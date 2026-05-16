import { IdentityVaultUnlockHandle } from '../types/identity-session';
export interface IdentitySeedVault {
    saveSeed(seed: Uint8Array, passphrase: string): Promise<void>;
    unlockWithPassphrase(passphrase: string): Promise<IdentityVaultUnlockHandle | null>;
    unlockWithSession(): Promise<IdentityVaultUnlockHandle | null>;
    deleteSeed(): Promise<void>;
    hasSeed(): Promise<boolean>;
    hasActiveSession(): Promise<boolean>;
    clearSessionKey(): Promise<void>;
}
//# sourceMappingURL=identity-vault.d.ts.map