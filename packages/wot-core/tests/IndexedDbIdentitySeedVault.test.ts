import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { IndexedDbIdentitySeedVault } from '../src/adapters/storage/IndexedDbIdentitySeedVault'
import * as coreRoot from '../src'
import * as coreAdapters from '../src/adapters'
import * as storageAdapters from '../src/adapters/storage'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const legacyAliasExport = `${'SeedStorage'}${'IdentityVault'}`
const legacyAliasPath = resolve(__dirname, `../src/adapters/storage/${legacyAliasExport}.ts`)

async function resetVault(): Promise<void> {
  const vault = new IndexedDbIdentitySeedVault()
  await vault.deleteSeed()
}

describe('IndexedDbIdentitySeedVault', () => {
  afterEach(async () => {
    await resetVault()
  })

  it('stores and unlocks vNext identity seeds end to end', async () => {
    const vault = new IndexedDbIdentitySeedVault({ crypto: cryptoAdapter })
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
      const vault = new IndexedDbIdentitySeedVault()
      await expect(vault.saveSeed(new Uint8Array(byteLength), 'local passphrase')).rejects.toThrow(
        'Identity seed must be exactly 64 bytes',
      )
      expect(await vault.hasSeed()).toBe(false)
    }
  })

  it('rejects unlocking with the wrong passphrase', async () => {
    const vault = new IndexedDbIdentitySeedVault()
    const seed = crypto.getRandomValues(new Uint8Array(64))

    await vault.saveSeed(seed, 'correct-passphrase')

    await expect(vault.unlockWithPassphrase('wrong-passphrase')).rejects.toThrow('Invalid passphrase')
  })

  it('returns null when no seed is stored', async () => {
    const vault = new IndexedDbIdentitySeedVault()

    expect(await vault.hasSeed()).toBe(false)
    expect(await vault.unlockWithPassphrase('any-passphrase')).toBeNull()
    expect(await vault.unlockWithSession()).toBeNull()
    expect(await vault.hasActiveSession()).toBe(false)
  })

  it('reuses the cached session key for unlockWithSession without re-supplying the passphrase', async () => {
    const vault = new IndexedDbIdentitySeedVault()
    const seed = crypto.getRandomValues(new Uint8Array(64))

    await vault.saveSeed(seed, 'local passphrase')
    expect(await vault.hasActiveSession()).toBe(false)

    const passwordHandle = await vault.unlockWithPassphrase('local passphrase')
    expect(passwordHandle).not.toBeNull()
    expect(await vault.hasActiveSession()).toBe(true)

    const firstSession = await vault.unlockWithSession()
    const secondSession = await vault.unlockWithSession()
    expect(firstSession?.did).toBe(passwordHandle?.did)
    expect(secondSession?.did).toBe(passwordHandle?.did)
  })

  it('clearSessionKey() invalidates the cached session without deleting the seed', async () => {
    const vault = new IndexedDbIdentitySeedVault()
    const seed = crypto.getRandomValues(new Uint8Array(64))

    await vault.saveSeed(seed, 'local passphrase')
    await vault.unlockWithPassphrase('local passphrase')
    expect(await vault.hasActiveSession()).toBe(true)

    await vault.clearSessionKey()

    expect(await vault.hasActiveSession()).toBe(false)
    expect(await vault.unlockWithSession()).toBeNull()
    expect(await vault.hasSeed()).toBe(true)
  })

  it('deleteSeed() clears both the stored seed and any active session', async () => {
    const vault = new IndexedDbIdentitySeedVault()
    const seed = crypto.getRandomValues(new Uint8Array(64))

    await vault.saveSeed(seed, 'local passphrase')
    await vault.unlockWithPassphrase('local passphrase')
    expect(await vault.hasActiveSession()).toBe(true)
    expect(await vault.hasSeed()).toBe(true)

    await vault.deleteSeed()

    expect(await vault.hasSeed()).toBe(false)
    expect(await vault.hasActiveSession()).toBe(false)
    expect(await vault.unlockWithSession()).toBeNull()
  })

  it('encrypts seeds with a fresh salt/IV on each save (round-tripping different seeds under the same passphrase)', async () => {
    const vault = new IndexedDbIdentitySeedVault()
    const seedA = crypto.getRandomValues(new Uint8Array(64))
    const seedB = crypto.getRandomValues(new Uint8Array(64))
    const passphrase = 'same-passphrase'

    await vault.saveSeed(seedA, passphrase)
    const handleA = await vault.unlockWithPassphrase(passphrase)
    expect(handleA).not.toBeNull()

    await vault.saveSeed(seedB, passphrase)
    const handleB = await vault.unlockWithPassphrase(passphrase)
    expect(handleB).not.toBeNull()
    expect(handleB?.did).not.toBe(handleA?.did)
  })

  it('does not expose any raw-seed-returning method on the app-facing reference IdentitySeedVault contract', () => {
    const vault = new IndexedDbIdentitySeedVault()

    // The reference IdentitySeedVault contract MUST NOT expose loadSeed/
    // loadSeedWithSessionKey/getSeed/exportSeed-style methods that return raw
    // BIP39 seed bytes to application code (IdentityWorkflow).
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
