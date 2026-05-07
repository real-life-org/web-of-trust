import { ProtocolCryptoAdapter } from '../../protocol';
import { IdentitySeedVault } from '../../ports';
import { PublicIdentitySession } from '../../types/identity-session';
export interface IdentityWorkflowOptions {
    crypto: ProtocolCryptoAdapter;
    vault?: IdentitySeedVault;
    generateMnemonic?: () => string;
}
export interface CreateIdentityInput {
    passphrase: string;
    storeSeed?: boolean;
}
export interface RecoverIdentityInput {
    mnemonic: string;
    passphrase: string;
    storeSeed?: boolean;
}
export interface UnlockStoredIdentityInput {
    passphrase?: string;
}
export interface CreateIdentityResult {
    mnemonic: string;
    identity: PublicIdentitySession;
}
export interface IdentityResult {
    identity: PublicIdentitySession;
}
export declare class IdentityWorkflow {
    private readonly crypto;
    private readonly vault;
    private readonly createMnemonic;
    private currentIdentity;
    constructor(options: IdentityWorkflowOptions);
    createIdentity(input: CreateIdentityInput): Promise<CreateIdentityResult>;
    recoverIdentity(input: RecoverIdentityInput): Promise<IdentityResult>;
    unlockStoredIdentity(input?: UnlockStoredIdentityInput): Promise<IdentityResult>;
    hasStoredIdentity(): Promise<boolean>;
    hasActiveSession(): Promise<boolean>;
    deleteStoredIdentity(): Promise<void>;
    lockIdentity(): void;
    getCurrentIdentity(): PublicIdentitySession | null;
    private recoverFromMnemonic;
    private identityFromSeed;
    private loadSeedWithSessionKey;
    private seedFromMnemonic;
    private requireVault;
}
//# sourceMappingURL=identity-workflow.d.ts.map