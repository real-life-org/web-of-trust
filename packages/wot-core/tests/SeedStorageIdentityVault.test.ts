import { describe, expect, it } from 'vitest'
import { SeedStorageIdentityVault } from '../src/adapters/storage/SeedStorageIdentityVault'
import type { SeedStorageAdapter } from '../src/ports/SeedStorageAdapter'
import { encodeBase64Url } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

class MemorySeedStorage implements SeedStorageAdapter {
  private seed: Uint8Array | null = null
  private passphrase: string | null = null
  private activeSession = false

  async storeSeed(seed: Uint8Array, passphrase: string): Promise<void> {
    this.seed = new Uint8Array(seed)
    this.passphrase = passphrase
    this.activeSession = false
  }

  async loadSeed(passphrase: string): Promise<Uint8Array | null> {
    if (!this.seed) return null
    if (passphrase !== this.passphrase) throw new Error('Invalid passphrase')
    this.activeSession = true
    return new Uint8Array(this.seed)
  }

  async loadSeedWithSessionKey(): Promise<Uint8Array | null> {
    if (!this.activeSession || !this.seed) return null
    return new Uint8Array(this.seed)
  }

  async hasActiveSession(): Promise<boolean> {
    return this.activeSession
  }

  async hasSeed(): Promise<boolean> {
    return this.seed !== null
  }

  async deleteSeed(): Promise<void> {
    this.seed = null
    this.passphrase = null
    this.activeSession = false
  }

  async clearSessionKey(): Promise<void> {
    this.activeSession = false
  }
}

const unsupportedLegacySeedMessage = 'Stored identity uses an unsupported legacy seed format'
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

describe('SeedStorageIdentityVault', () => {
  it('stores and unlocks vNext identity seeds through the encrypted seed storage', async () => {
    const storage = new MemorySeedStorage()
    const vault = new SeedStorageIdentityVault({ storage, crypto: cryptoAdapter })
    const seed = crypto.getRandomValues(new Uint8Array(64))

    await vault.saveSeed(seed, 'local passphrase')

    const passwordHandle = await vault.unlockWithPassphrase('local passphrase')
    expect(passwordHandle).not.toBeNull()
    const sessionHandle = await vault.unlockWithSession()
    expect(sessionHandle).not.toBeNull()
    expect(sessionHandle?.did).toBe(passwordHandle?.did)
    await expect(passwordHandle!.deriveFrameworkKey('wot/test/v1')).resolves.toEqual(
      await cryptoAdapter.hkdfSha256(seed, 'wot/test/v1', 32),
    )
  })

  it('rejects unversioned legacy stored seeds', async () => {
    const storage = new MemorySeedStorage()
    const vault = new SeedStorageIdentityVault(storage)

    await storage.storeSeed(new Uint8Array(64), 'local passphrase')

    await expect(vault.unlockWithPassphrase('local passphrase')).rejects.toThrow(unsupportedLegacySeedMessage)
  })

  it('rejects unsupported stored seed vault versions', async () => {
    const storage = new MemorySeedStorage()
    const vault = new SeedStorageIdentityVault(storage)
    const unsupportedPayload = new TextEncoder().encode(JSON.stringify({
      type: 'wot.identity.seed',
      version: 0,
      seed: encodeBase64Url(new Uint8Array(64)),
    }))

    await storage.storeSeed(unsupportedPayload, 'local passphrase')

    await expect(vault.unlockWithPassphrase('local passphrase')).rejects.toThrow(unsupportedLegacySeedMessage)
  })

  it('does not expose any raw-seed-returning method on the app-facing reference IdentitySeedVault contract', () => {
    const storage = new MemorySeedStorage()
    const vault = new SeedStorageIdentityVault(storage)

    // The reference IdentitySeedVault contract MUST NOT expose loadSeed/
    // loadSeedWithSessionKey/getSeed/exportSeed-style methods that return raw
    // BIP39 seed bytes to application code (IdentityWorkflow). Raw seed handling
    // may remain confined to adapter-internal or legacy-only paths, but it must
    // not be part of the public reference vault surface used by the workflow.
    const forbidden = ['loadSeed', 'loadSeedWithSessionKey', 'getSeed', 'exportSeed']
    for (const name of forbidden) {
      expect((vault as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }
  })
})
