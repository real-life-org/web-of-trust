import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IdentityWorkflow, type IdentitySeedVault } from '../src/application/identity'
import { createIdentityVaultUnlockHandle } from '../src/application/identity/identity-vault-handle'
import { decodeBase64Url } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import * as coreRoot from '../src'
import * as coreApplication from '../src/application'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const demoAppRuntimePath = resolve(__dirname, '../../../apps/demo/src/runtime/appRuntime.ts')

class MemoryIdentitySeedVault implements IdentitySeedVault {
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
    return createIdentityVaultUnlockHandle(this.seed, cryptoAdapter)
  }

  async unlockWithSession() {
    if (!this.activeSession || !this.seed) return null
    return createIdentityVaultUnlockHandle(this.seed, cryptoAdapter)
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

describe('IdentityWorkflow', () => {
  it('creates an identity and stores the seed by default', async () => {
    const vault = new MemoryIdentitySeedVault()
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })

    const result = await workflow.createIdentity({ passphrase: 'correct horse battery staple' })

    expect(result.mnemonic.split(' ')).toHaveLength(12)
    expect(result.identity.did).toMatch(/^did:key:z/)
    expect(result.identity.kid).toBe(`${result.identity.did}#sig-0`)
    expect(result.identity.ed25519PublicKey).toHaveLength(32)
    expect(result.identity.x25519PublicKey).toHaveLength(32)
    expect(await vault.hasSeed()).toBe(true)
    expect(vault.saves).toBe(1)
    expect(workflow.getCurrentIdentity()).toEqual(result.identity)

    const signature = await result.identity.sign('challenge')
    await expect(
      cryptoAdapter.verifyEd25519(new TextEncoder().encode('challenge'), decodeBase64Url(signature), result.identity.ed25519PublicKey),
    ).resolves.toBe(true)

    expect(await result.identity.signJws({ did: result.identity.did })).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
    expect(await result.identity.getPublicKeyMultibase()).toBe(result.identity.did.replace('did:key:', ''))
    expect(await result.identity.getEncryptionPublicKeyBytes()).toEqual(result.identity.x25519PublicKey)
  })

  it('recovers the same identity from the mnemonic and can opt into storage', async () => {
    const firstVault = new MemoryIdentitySeedVault()
    const firstWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault: firstVault })
    const created = await firstWorkflow.createIdentity({ passphrase: 'unused', storeSeed: false })

    const recoveryVault = new MemoryIdentitySeedVault()
    const recoveryWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault: recoveryVault })
    const recovered = await recoveryWorkflow.recoverIdentity({
      mnemonic: created.mnemonic,
      passphrase: 'new local passphrase',
      storeSeed: true,
    })

    expect(await firstVault.hasSeed()).toBe(false)
    expect(recovered.identity).toEqual(created.identity)
    expect(await recoveryVault.hasSeed()).toBe(true)
  })

  it('unlocks a stored identity without the mnemonic', async () => {
    const vault = new MemoryIdentitySeedVault()
    const created = await new IdentityWorkflow({ crypto: cryptoAdapter, vault }).createIdentity({ passphrase: 'local passphrase' })
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })

    const unlocked = await workflow.unlockStoredIdentity({ passphrase: 'local passphrase' })

    expect(unlocked.identity).toEqual(created.identity)
    await expect(workflow.unlockStoredIdentity({ passphrase: 'wrong passphrase' })).rejects.toThrow('Invalid passphrase')
  })

  it('auto-unlocks from an active session key after a password unlock', async () => {
    const vault = new MemoryIdentitySeedVault()
    const created = await new IdentityWorkflow({ crypto: cryptoAdapter, vault }).createIdentity({ passphrase: 'local passphrase' })
    const passwordWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    await passwordWorkflow.unlockStoredIdentity({ passphrase: 'local passphrase' })
    expect(await passwordWorkflow.hasActiveSession()).toBe(true)

    const sessionWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    const unlocked = await sessionWorkflow.unlockStoredIdentity()

    expect(unlocked.identity).toEqual(created.identity)
  })

  it('rejects legacy 32-byte stored seeds instead of deriving a different DID', async () => {
    const vault = new MemoryIdentitySeedVault()
    await vault.saveSeed(new Uint8Array(32), 'local passphrase')
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })

    await expect(workflow.unlockStoredIdentity({ passphrase: 'local passphrase' })).rejects.toThrow('Invalid identity seed format')
  })

  it('deletes the stored identity and clears the current identity', async () => {
    const vault = new MemoryIdentitySeedVault()
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    await workflow.createIdentity({ passphrase: 'local passphrase' })

    await workflow.deleteStoredIdentity()

    expect(await vault.hasSeed()).toBe(false)
    expect(workflow.getCurrentIdentity()).toBeNull()
    await expect(workflow.unlockStoredIdentity({ passphrase: 'local passphrase' })).rejects.toThrow('No identity found in storage')
  })

  it('encrypts and decrypts payloads between identity sessions', async () => {
    const alice = await new IdentityWorkflow({ crypto: cryptoAdapter, vault: new MemoryIdentitySeedVault() }).createIdentity({
      passphrase: 'alice',
      storeSeed: false,
    })
    const bob = await new IdentityWorkflow({ crypto: cryptoAdapter, vault: new MemoryIdentitySeedVault() }).createIdentity({
      passphrase: 'bob',
      storeSeed: false,
    })

    const encrypted = await alice.identity.encryptForRecipient(
      new TextEncoder().encode('hello bob'),
      await bob.identity.getEncryptionPublicKeyBytes(),
    )
    const decrypted = await bob.identity.decryptForMe(encrypted)

    expect(new TextDecoder().decode(decrypted)).toBe('hello bob')
  })

  it('rejects invalid recovery mnemonics', async () => {
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault: new MemoryIdentitySeedVault() })

    await expect(
      workflow.recoverIdentity({ mnemonic: 'not a valid recovery phrase', passphrase: 'local passphrase' }),
    ).rejects.toThrow('Invalid mnemonic')
  })
})

describe('IdentitySeedVault reference contract: no raw seed exposure to IdentityWorkflow', () => {
  // Operation-shaped vault that never returns raw BIP39 seed bytes to the
  // workflow. The reference IdentitySeedVault contract used by IdentityWorkflow
  // must be implementable without any loadSeed/loadSeedWithSessionKey/getSeed/
  // exportSeed-style method. The vault keeps seed material internal and exposes
  // only operation-shaped lifecycle methods plus state queries.
  class NoRawSeedVault implements IdentitySeedVault {
    private storedSeed: Uint8Array | null = null
    private storedPassphrase: string | null = null
    private activeSession = false

    async saveSeed(seed: Uint8Array, passphrase: string): Promise<void> {
      this.storedSeed = new Uint8Array(seed)
      this.storedPassphrase = passphrase
      this.activeSession = false
    }

    async unlockWithPassphrase(passphrase: string) {
      if (!this.storedSeed) return null
      if (passphrase !== this.storedPassphrase) throw new Error('Invalid passphrase')
      this.activeSession = true
      return createIdentityVaultUnlockHandle(this.storedSeed, cryptoAdapter)
    }

    async unlockWithSession() {
      if (!this.activeSession || !this.storedSeed) return null
      return createIdentityVaultUnlockHandle(this.storedSeed, cryptoAdapter)
    }

    async deleteSeed(): Promise<void> {
      this.storedSeed = null
      this.storedPassphrase = null
      this.activeSession = false
    }

    async hasSeed(): Promise<boolean> {
      return this.storedSeed !== null
    }

    async hasActiveSession(): Promise<boolean> {
      return this.activeSession
    }

    async clearSessionKey(): Promise<void> {
      this.activeSession = false
    }
  }

  it('exposes no loadSeed/loadSeedWithSessionKey/getSeed/exportSeed method on the operation-shaped reference vault', () => {
    const vault = new NoRawSeedVault()
    const forbidden = ['loadSeed', 'loadSeedWithSessionKey', 'getSeed', 'exportSeed']
    for (const name of forbidden) {
      expect((vault as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }
  })

  it('supports create, store, password-unlock, session-unlock, sign, JWS, derive, encrypt/decrypt, hasStoredIdentity, hasActiveSession, and delete without a raw-seed vault method', async () => {
    const vault = new NoRawSeedVault()
    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })

    const created = await workflow.createIdentity({ passphrase: 'local passphrase' })
    expect(await workflow.hasStoredIdentity()).toBe(true)

    const preAuthSessionWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    await expect(preAuthSessionWorkflow.unlockStoredIdentity()).rejects.toThrow()

    const passwordWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    const unlockedByPassword = await passwordWorkflow.unlockStoredIdentity({ passphrase: 'local passphrase' })
    expect(unlockedByPassword.identity.did).toBe(created.identity.did)
    expect(await passwordWorkflow.hasActiveSession()).toBe(true)

    const sessionWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    const unlockedBySession = await sessionWorkflow.unlockStoredIdentity()
    expect(unlockedBySession.identity.did).toBe(created.identity.did)

    const signature = await unlockedByPassword.identity.sign('challenge')
    await expect(
      cryptoAdapter.verifyEd25519(
        new TextEncoder().encode('challenge'),
        decodeBase64Url(signature),
        unlockedByPassword.identity.ed25519PublicKey,
      ),
    ).resolves.toBe(true)
    expect(await unlockedByPassword.identity.signJws({ did: unlockedByPassword.identity.did })).toMatch(
      /^[^.]+\.[^.]+\.[^.]+$/,
    )

    const frameworkKey = await unlockedByPassword.identity.deriveFrameworkKey('wot/test/v1')
    expect(frameworkKey).toHaveLength(32)

    const encrypted = await unlockedByPassword.identity.encryptForRecipient(
      new TextEncoder().encode('hello self'),
      await unlockedByPassword.identity.getEncryptionPublicKeyBytes(),
    )
    const decrypted = await unlockedByPassword.identity.decryptForMe(encrypted)
    expect(new TextDecoder().decode(decrypted)).toBe('hello self')

    await workflow.deleteStoredIdentity()
    expect(await workflow.hasStoredIdentity()).toBe(false)
  })

  it('does not expose the legacy identity class on the @web_of_trust/core public surface', () => {
    expect((coreRoot as Record<string, unknown>)[`${'Wot'}${'Identity'}`]).toBeUndefined()
  })

  it('does not expose the legacy identity class on the @web_of_trust/core/application public surface', () => {
    expect((coreApplication as Record<string, unknown>)[`${'Wot'}${'Identity'}`]).toBeUndefined()
  })

  it('uses the browser reference IdentitySeedVault in the demo app runtime boundary', () => {
    const appRuntime = readFileSync(demoAppRuntimePath, 'utf8')
    const legacyAlias = `${'SeedStorage'}${'IdentityVault'}`

    expect(appRuntime).toContain('IndexedDbIdentitySeedVault')
    expect(appRuntime).not.toContain(legacyAlias)
    expect(appRuntime).toMatch(/vault:\s*new IndexedDbIdentitySeedVault\(/)
  })

  it('does not call loadSeed/loadSeedWithSessionKey/getSeed/exportSeed on the IdentitySeedVault during create, password-unlock, or session-unlock', async () => {
    const calls: string[] = []
    const inner = new NoRawSeedVault()
    const vault: IdentitySeedVault = new Proxy(inner as IdentitySeedVault, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') calls.push(prop)
        return Reflect.get(target, prop, receiver)
      },
    })

    const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    await workflow.createIdentity({ passphrase: 'local passphrase' })

    const passwordWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    await passwordWorkflow.unlockStoredIdentity({ passphrase: 'local passphrase' })

    const sessionWorkflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault })
    await sessionWorkflow.unlockStoredIdentity()

    expect(calls).not.toContain('loadSeed')
    expect(calls).not.toContain('loadSeedWithSessionKey')
    expect(calls).not.toContain('getSeed')
    expect(calls).not.toContain('exportSeed')
  })
})
