import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IndexedDbIdentitySeedVault } from '../src/adapters/storage/IndexedDbIdentitySeedVault'
import * as coreRoot from '../src'
import * as coreAdapters from '../src/adapters'
import * as storageAdapters from '../src/adapters/storage'
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

const unsupportedLocalIdentityMessage = 'Stored identity uses an unsupported local identity format'
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const legacyAliasExport = `${'SeedStorage'}${'IdentityVault'}`
const legacyAliasPath = resolve(__dirname, `../src/adapters/storage/${legacyAliasExport}.ts`)

describe('IndexedDbIdentitySeedVault', () => {
  it('stores and unlocks vNext identity seeds through the encrypted seed storage', async () => {
    const storage = new MemorySeedStorage()
    const vault = new IndexedDbIdentitySeedVault({ storage, crypto: cryptoAdapter })
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

  it('rejects saving identity seeds with unsupported byte lengths', async () => {
    const unsupportedLengths = [63, 65]

    for (const byteLength of unsupportedLengths) {
      const storage = new MemorySeedStorage()
      const vault = new IndexedDbIdentitySeedVault(storage)

      await expect(vault.saveSeed(new Uint8Array(byteLength), 'local passphrase')).rejects.toThrow(
        'Identity seed must be exactly 64 bytes',
      )
      await expect(storage.hasSeed()).resolves.toBe(false)
    }
  })

  it('rejects unversioned legacy stored seeds', async () => {
    const storage = new MemorySeedStorage()
    const vault = new IndexedDbIdentitySeedVault(storage)

    await storage.storeSeed(new Uint8Array(64), 'local passphrase')

    await expect(vault.unlockWithPassphrase('local passphrase')).rejects.toThrow(unsupportedLocalIdentityMessage)
  })

  it('rejects unsupported stored seed vault versions', async () => {
    const storage = new MemorySeedStorage()
    const vault = new IndexedDbIdentitySeedVault(storage)
    const unsupportedPayload = new TextEncoder().encode(JSON.stringify({
      type: 'wot.identity.seed',
      version: 0,
      seed: encodeBase64Url(new Uint8Array(64)),
    }))

    await storage.storeSeed(unsupportedPayload, 'local passphrase')

    await expect(vault.unlockWithPassphrase('local passphrase')).rejects.toThrow(unsupportedLocalIdentityMessage)
  })

  it('rejects stored identity seeds with unsupported byte lengths', async () => {
    const unsupportedLengths = [63, 65]

    for (const byteLength of unsupportedLengths) {
      const storage = new MemorySeedStorage()
      const vault = new IndexedDbIdentitySeedVault(storage)
      const unsupportedPayload = new TextEncoder().encode(JSON.stringify({
        type: 'wot.identity.seed',
        version: 1,
        seedFormat: 'bip39-64-byte',
        seed: encodeBase64Url(new Uint8Array(byteLength)),
      }))

      await storage.storeSeed(unsupportedPayload, 'local passphrase')

      await expect(vault.unlockWithPassphrase('local passphrase')).rejects.toThrow(unsupportedLocalIdentityMessage)
    }
  })

  it('does not expose any raw-seed-returning method on the app-facing reference IdentitySeedVault contract', () => {
    const storage = new MemorySeedStorage()
    const vault = new IndexedDbIdentitySeedVault(storage)

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

  it('publishes the browser reference IdentitySeedVault from the public adapter boundaries', () => {
    expect((storageAdapters as Record<string, unknown>).IndexedDbIdentitySeedVault).toBeTypeOf('function')
    expect((coreAdapters as Record<string, unknown>).IndexedDbIdentitySeedVault).toBe(
      (storageAdapters as Record<string, unknown>).IndexedDbIdentitySeedVault,
    )
    expect((coreRoot as Record<string, unknown>).IndexedDbIdentitySeedVault).toBe(
      (storageAdapters as Record<string, unknown>).IndexedDbIdentitySeedVault,
    )
  })
})

describe('deprecated identity seed vault compatibility alias removal', () => {
  it('removes the deprecated alias file and public exports', () => {
    expect(existsSync(legacyAliasPath)).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(storageAdapters, legacyAliasExport)).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(coreAdapters, legacyAliasExport)).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(coreRoot, legacyAliasExport)).toBe(false)
  })
})
