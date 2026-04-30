import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import * as ed25519 from '@noble/ed25519'
import { germanPositiveWordlist } from '../../wordlists/german-positive'
import {
  bytesToHex,
  decodeBase64Url,
  decryptEcies,
  deriveProtocolIdentityFromSeedHex,
  encodeBase64Url,
  encryptEcies,
} from '../../protocol'
import type { ProtocolCryptoAdapter, ProtocolIdentityMaterial } from '../../protocol'
import type { IdentitySeedVault } from '../../ports'

const BIP39_SEED_LENGTH = 64

export interface IdentityEncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
  ephemeralPublicKey?: Uint8Array
}

export interface PublicIdentityMaterial {
  did: string
  kid: string
  ed25519PublicKey: Uint8Array
  x25519PublicKey: Uint8Array
}

export interface IdentitySession {
  getDid(): string
  sign(data: string): Promise<string>
  signJws(payload: unknown): Promise<string>
  deriveFrameworkKey(info: string): Promise<Uint8Array>
  getPublicKeyMultibase(): Promise<string>
  getEncryptionPublicKeyBytes(): Promise<Uint8Array>
  encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<IdentityEncryptedPayload>
  decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array>
  deleteStoredIdentity(): Promise<void>
}

export type PublicIdentitySession = IdentitySession & PublicIdentityMaterial

export interface IdentityWorkflowOptions {
  crypto: ProtocolCryptoAdapter
  vault?: IdentitySeedVault
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
  #bip39Seed: Uint8Array
  #ed25519Seed: Uint8Array
  #x25519Seed: Uint8Array
  #crypto: ProtocolCryptoAdapter
  #deleteStoredIdentity: () => Promise<void>

  constructor(
    material: ProtocolIdentityMaterial,
    bip39Seed: Uint8Array,
    cryptoAdapter: ProtocolCryptoAdapter,
    deleteStoredIdentity: () => Promise<void>,
  ) {
    this.did = material.did
    this.kid = material.kid
    this.ed25519PublicKey = new Uint8Array(material.ed25519PublicKey)
    this.x25519PublicKey = new Uint8Array(material.x25519PublicKey)
    this.#bip39Seed = new Uint8Array(bip39Seed)
    this.#ed25519Seed = new Uint8Array(material.ed25519Seed)
    this.#x25519Seed = new Uint8Array(material.x25519Seed)
    this.#crypto = cryptoAdapter
    this.#deleteStoredIdentity = deleteStoredIdentity
  }

  getDid(): string {
    return this.did
  }

  async sign(data: string): Promise<string> {
    const signature = await ed25519.signAsync(new TextEncoder().encode(data), this.#ed25519Seed)
    return encodeBase64Url(signature)
  }

  async signJws(payload: unknown): Promise<string> {
    const header = { alg: 'EdDSA', typ: 'JWT' }
    const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)))
    const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signature = await ed25519.signAsync(new TextEncoder().encode(signingInput), this.#ed25519Seed)
    return `${signingInput}.${encodeBase64Url(signature)}`
  }

  async deriveFrameworkKey(info: string): Promise<Uint8Array> {
    return this.#crypto.hkdfSha256(this.#bip39Seed, info, 32)
  }

  async getPublicKeyMultibase(): Promise<string> {
    return this.did.replace('did:key:', '')
  }

  async getEncryptionPublicKeyBytes(): Promise<Uint8Array> {
    return new Uint8Array(this.x25519PublicKey)
  }

  async encryptForRecipient(plaintext: Uint8Array, recipientPublicKeyBytes: Uint8Array): Promise<IdentityEncryptedPayload> {
    const ephemeralPrivateSeed = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const message = await encryptEcies({
      crypto: this.#crypto,
      ephemeralPrivateSeed,
      recipientPublicKey: recipientPublicKeyBytes,
      nonce,
      plaintext,
    })
    return {
      ciphertext: decodeBase64Url(message.ciphertext),
      nonce: decodeBase64Url(message.nonce),
      ephemeralPublicKey: decodeBase64Url(message.epk),
    }
  }

  async decryptForMe(payload: IdentityEncryptedPayload): Promise<Uint8Array> {
    if (!payload.ephemeralPublicKey) throw new Error('Missing ephemeral public key')
    return decryptEcies({
      crypto: this.#crypto,
      recipientPrivateSeed: this.#x25519Seed,
      message: {
        epk: encodeBase64Url(payload.ephemeralPublicKey),
        nonce: encodeBase64Url(payload.nonce),
        ciphertext: encodeBase64Url(payload.ciphertext),
      },
    })
  }

  async deleteStoredIdentity(): Promise<void> {
    await this.#deleteStoredIdentity()
  }
}

export class IdentityWorkflow {
  private readonly crypto: ProtocolCryptoAdapter
  private readonly vault: IdentitySeedVault | null
  private readonly createMnemonic: () => string
  private currentIdentity: PublicIdentitySession | null = null

  constructor(options: IdentityWorkflowOptions) {
    this.crypto = options.crypto
    this.vault = options.vault ?? null
    this.createMnemonic = options.generateMnemonic ?? (() => generateMnemonic(germanPositiveWordlist, 128))
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
    const seed = input.passphrase !== undefined
      ? await vault.loadSeed(input.passphrase)
      : await this.loadSeedWithSessionKey(vault)
    if (!seed) throw new Error(input.passphrase !== undefined ? 'No identity found in storage' : 'Session expired')

    const identity = await this.identityFromSeed(seed)
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
    if (!validateMnemonic(mnemonic, germanPositiveWordlist)) throw new Error('Invalid mnemonic')
    return this.identityFromSeed(this.seedFromMnemonic(mnemonic))
  }

  private async identityFromSeed(seed: Uint8Array): Promise<PublicIdentitySession> {
    if (seed.length !== BIP39_SEED_LENGTH) throw new Error('Invalid identity seed format')
    const material = await deriveProtocolIdentityFromSeedHex(bytesToHex(seed), this.crypto)
    return new ProtocolIdentitySession(material, seed, this.crypto, () => this.deleteStoredIdentity())
  }

  private async loadSeedWithSessionKey(vault: IdentitySeedVault): Promise<Uint8Array | null> {
    if (!vault.loadSeedWithSessionKey) throw new Error('Session unlock is not supported')
    return vault.loadSeedWithSessionKey()
  }

  private seedFromMnemonic(mnemonic: string): Uint8Array {
    return mnemonicToSeedSync(mnemonic, '')
  }

  private requireVault(): IdentitySeedVault {
    if (!this.vault) throw new Error('Identity seed vault is required')
    return this.vault
  }
}
