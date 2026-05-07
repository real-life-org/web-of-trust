import { describe, expect, it } from 'vitest'
import { IdentityWorkflow, type IdentitySeedVault } from '../src/application/identity'
import { decodeBase64Url } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

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
}

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

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
