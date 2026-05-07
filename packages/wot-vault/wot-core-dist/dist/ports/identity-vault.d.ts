export interface IdentitySeedVault {
    saveSeed(seed: Uint8Array, passphrase: string): Promise<void>;
    loadSeed(passphrase: string): Promise<Uint8Array | null>;
    loadSeedWithSessionKey?(): Promise<Uint8Array | null>;
    deleteSeed(): Promise<void>;
    hasSeed(): Promise<boolean>;
    hasActiveSession?(): Promise<boolean>;
    clearSessionKey?(): Promise<void>;
}
//# sourceMappingURL=identity-vault.d.ts.map