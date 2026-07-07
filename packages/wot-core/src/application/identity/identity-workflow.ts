import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist as englishBip39Wordlist } from '@scure/bip39/wordlists/english.js'
import { createJcsEd25519JwsWithSigner, encodeBase64Url } from '../../protocol'
import type { JsonValue, ProtocolCryptoAdapter } from '../../protocol'
import type { IdentitySeedVault } from '../../ports'
import type { IdentityEncryptedPayload, IdentityVaultUnlockHandle, PublicIdentitySession } from '../../types/identity-session'
import { createIdentityVaultUnlockHandle, encryptForRecipientUsingX25519 } from './identity-vault-handle'

export interface IdentityWorkflowOptions {
  crypto: ProtocolCryptoAdapter
  vault?: IdentitySeedVault
  wordlist?: string[]
  generateMnemonic?: () => string
}

export interface CreateIdentityInput {
  passphrase: string
  storeSeed?: boolean
}

export interface RecoverIdentityInput {
  mnemonic: string
  passphrase: string
  storeSeed?: boolean
}

export interface UnlockStoredIdentityInput {
  passphrase?: string
}

export interface CreateIdentityResult {
  mnemonic: string
  identity: PublicIdentitySession
}

export interface IdentityResult {
  identity: PublicIdentitySession
}

class ProtocolIdentitySession implements PublicIdentitySession {
  readonly did: string
  readonly kid: string
  readonly ed25519PublicKey: Uint8Array
  readonly x25519PublicKey: Uint8Array
  #crypto: ProtocolCryptoAdapter
  #handle: IdentityVaultUnlockHandle
  #deleteStoredIdentity: () => Promise<void>

  constructor(
    handle: IdentityVaultUnlockHandle,
    cryptoAdapter: ProtocolCryptoAdapter,
    deleteStoredIdentity: () => Promise<void>,
  ) {
    this.did = handle.did
    this.kid = handle.kid
    this.ed25519PublicKey = new Uint8Array(handle.ed25519PublicKey)
    this.x25519PublicKey = new Uint8Array(handle.x25519PublicKey)
    this.#handle = handle
    this.#crypto = cryptoAdapter
    this.#deleteStoredIdentity = deleteStoredIdentity
  }

  getDid(): string {
    return this.did
  }

  async sign(data: string): Promise<string> {
    const signature = await this.#handle.signEd25519(new TextEncoder().encode(data))
    return encodeBase64Url(signature)
  }

  async signEd25519(data: Uint8Array): Promise<Uint8Array> {
    return this.#handle.signEd25519(data)
  }

  async signJws(payload: unknown): Promise<string> {
    return createJcsEd25519JwsWithSigner(
      { alg: 'EdDSA', kid: this.kid },
      payload as JsonValue,
      (signingInput) => this.#handle.signEd25519(signingInput),
    )
  }

  async deriveFrameworkKey(info: string): Promise<Uint8Array> {
    return this.#handle.deriveFrameworkKey(info, 32)
  }

  async getPublicKeyMultibase(): Promise<string> {
    return this.did.replace('did:key:', '')
  }

  async getEncryptionPublicKeyBytes(): Promise<Uint8Array> {
    return new Uint8Array(this.x25519PublicKey)
  }

  async encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<IdentityEncryptedPayload> {
    return encryptForRecipientUsingX25519(this.#crypto, plaintext, recipientPublicKeyBytes)
  }

  async decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array> {
    return this.#handle.decryptForMe(payload)
  }

  async deleteStoredIdentity(): Promise<void> {
    await this.#deleteStoredIdentity()
  }
}

export class IdentityWorkflow {
  private readonly crypto: ProtocolCryptoAdapter
  private readonly vault: IdentitySeedVault | null
  private readonly wordlist: string[]
  private readonly createMnemonic: () => string
  private currentIdentity: PublicIdentitySession | null = null

  constructor(options: IdentityWorkflowOptions) {
    this.crypto = options.crypto
    this.vault = options.vault ?? null
    this.wordlist = options.wordlist ?? englishBip39Wordlist
    this.createMnemonic = options.generateMnemonic ?? (() => generateMnemonic(this.wordlist, 128))
  }

  async createIdentity(input: CreateIdentityInput): Promise<CreateIdentityResult> {
    const mnemonic = this.createMnemonic()
    const identity = await this.recoverFromMnemonic(mnemonic)

    if (input.storeSeed ?? true) {
      await this.requireVault().saveSeed(this.seedFromMnemonic(mnemonic), input.passphrase)
    }

    this.currentIdentity = identity
    return { mnemonic, identity }
  }

  async recoverIdentity(input: RecoverIdentityInput): Promise<IdentityResult> {
    const identity = await this.recoverFromMnemonic(input.mnemonic)

    if (input.storeSeed ?? false) {
      await this.requireVault().saveSeed(this.seedFromMnemonic(input.mnemonic), input.passphrase)
    }

    this.currentIdentity = identity
    return { identity }
  }

  async unlockStoredIdentity(input: UnlockStoredIdentityInput = {}): Promise<IdentityResult> {
    const vault = this.requireVault()
    const handle = input.passphrase !== undefined
      ? await vault.unlockWithPassphrase(input.passphrase)
      : await vault.unlockWithSession()
    if (!handle) throw new Error(input.passphrase !== undefined ? 'No identity found in storage' : 'Session expired')

    const identity = this.identityFromHandle(handle)
    this.currentIdentity = identity
    return { identity }
  }

  async hasStoredIdentity(): Promise<boolean> {
    return this.requireVault().hasSeed()
  }

  async hasActiveSession(): Promise<boolean> {
    return this.requireVault().hasActiveSession?.() ?? false
  }

  async deleteStoredIdentity(): Promise<void> {
    await this.requireVault().deleteSeed()
    this.currentIdentity = null
  }

  lockIdentity(): void {
    this.currentIdentity = null
  }

  getCurrentIdentity(): PublicIdentitySession | null {
    return this.currentIdentity
  }

  private async recoverFromMnemonic(mnemonic: string): Promise<PublicIdentitySession> {
    if (!validateMnemonic(mnemonic, this.wordlist)) throw new Error('Invalid mnemonic')
    return this.identityFromSeed(this.seedFromMnemonic(mnemonic))
  }

  private async identityFromSeed(seed: Uint8Array): Promise<PublicIdentitySession> {
    return this.identityFromHandle(await createIdentityVaultUnlockHandle(seed, this.crypto))
  }

  private identityFromHandle(handle: IdentityVaultUnlockHandle): PublicIdentitySession {
    return new ProtocolIdentitySession(handle, this.crypto, () => this.deleteStoredIdentity())
  }

  private seedFromMnemonic(mnemonic: string): Uint8Array {
    return mnemonicToSeedSync(mnemonic, '')
  }

  private requireVault(): IdentitySeedVault {
    if (!this.vault) throw new Error('Identity seed vault is required')
    return this.vault
  }
}
