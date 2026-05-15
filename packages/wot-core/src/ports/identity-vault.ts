import type { IdentityVaultUnlockHandle } from '../types/identity-session'

// Reference IdentitySeedVault contract for wot-identity@0.1 (wot-spec PR #74 /
// ADR 0001). Persistence remains encrypted at rest, and unlock operations
// return an operation-shaped handle. The contract MUST NOT expose any
// loadSeed/loadSeedWithSessionKey/getSeed/exportSeed-style method returning
// raw BIP39 seed bytes to application code (IdentityWorkflow).
export interface IdentitySeedVault {
  saveSeed(seed: Uint8Array, passphrase: string): Promise<void>
  unlockWithPassphrase(passphrase: string): Promise<IdentityVaultUnlockHandle | null>
  unlockWithSession(): Promise<IdentityVaultUnlockHandle | null>
  deleteSeed(): Promise<void>
  hasSeed(): Promise<boolean>
  hasActiveSession(): Promise<boolean>
  clearSessionKey(): Promise<void>
}
