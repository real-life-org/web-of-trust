import { IdentityWorkflow, type IdentitySeedVault, type PublicIdentitySession } from '../../src/application/identity'
import { createIdentityVaultUnlockHandle } from '../../src/application/identity/identity-vault-handle'
import { WebCryptoProtocolCryptoAdapter } from '../../src/protocol-adapters'

export const testCryptoAdapter = new WebCryptoProtocolCryptoAdapter()

export class MemoryIdentitySeedVault implements IdentitySeedVault {
  private seed: Uint8Array | null = null
  private passphrase: string | null = null
  private activeSession = false
  saves = 0

  async saveSeed(seed: Uint8Array, passphrase: string): Promise<void> {
    this.seed = new Uint8Array(seed)
    this.passphrase = passphrase
    this.saves += 1
  }

  async unlockWithPassphrase(passphrase: string) {
    if (!this.seed) return null
    if (passphrase !== this.passphrase) throw new Error('Invalid passphrase')
    this.activeSession = true
    return createIdentityVaultUnlockHandle(this.seed, testCryptoAdapter)
  }

  async unlockWithSession() {
    if (!this.activeSession || !this.seed) return null
    return createIdentityVaultUnlockHandle(this.seed, testCryptoAdapter)
  }

  async deleteSeed(): Promise<void> {
    this.seed = null
    this.passphrase = null
    this.activeSession = false
  }

  async hasSeed(): Promise<boolean> {
    return this.seed !== null
  }

  async hasActiveSession(): Promise<boolean> {
    return this.activeSession
  }

  async clearSessionKey(): Promise<void> {
    this.activeSession = false
  }
}

export interface TestIdentityResult {
  identity: PublicIdentitySession
  mnemonic: string
}

export async function createTestIdentity(passphrase = 'test-passphrase'): Promise<TestIdentityResult> {
  return new IdentityWorkflow({ crypto: testCryptoAdapter }).createIdentity({
    passphrase,
    storeSeed: false,
  })
}

export async function recoverTestIdentity(mnemonic: string, passphrase = 'test-passphrase'): Promise<PublicIdentitySession> {
  const result = await new IdentityWorkflow({ crypto: testCryptoAdapter }).recoverIdentity({
    mnemonic,
    passphrase,
    storeSeed: false,
  })
  return result.identity
}
