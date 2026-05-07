import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { SeedStorage } from './SeedStorage'
import { WebCryptoAdapter } from '../adapters/crypto/WebCryptoAdapter'
import { germanPositiveWordlist } from '../wordlists/german-positive'
import { signJws as signJwsUtil } from '../crypto/jws'
import type { CryptoAdapter, EncryptedPayload, MasterKeyHandle, EncryptionKeyPair } from '../ports/CryptoAdapter'
import type { SeedStorageAdapter } from '../ports/SeedStorageAdapter'

/**
 * WotIdentity - BIP39-based identity with pluggable crypto and storage
 *
 * Security architecture:
 * - BIP39 Mnemonic (12 words, 128 bit entropy)
 * - Master Key derived via HKDF (non-extractable)
 * - Identity Private Key (non-extractable, Ed25519)
 * - Framework Keys (extractable for Evolu, etc.)
 *
 * Storage:
 * - Mnemonic: User must write down (never stored)
 * - Master Seed: Encrypted with PBKDF2(passphrase) + AES-GCM via SeedStorageAdapter
 * - Keys: All derived from master seed via HKDF
 */
export class WotIdentity {
  private masterKey: MasterKeyHandle | null = null
  private identityKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey } | null = null
  private encKeyPair: EncryptionKeyPair | null = null
  private encKeyPairPromise: Promise<EncryptionKeyPair> | null = null
  private did: string | null = null
  private storage: SeedStorageAdapter
  private crypto: CryptoAdapter

  /**
   * @param storage - Seed storage adapter (default: IndexedDB-based SeedStorage)
   * @param cryptoAdapter - Crypto adapter (default: WebCryptoAdapter)
   */
  constructor(storage?: SeedStorageAdapter, cryptoAdapter?: CryptoAdapter) {
    this.storage = storage ?? new SeedStorage()
    this.crypto = cryptoAdapter ?? new WebCryptoAdapter()
  }

  /**
   * Create a new identity with BIP39 mnemonic
   *
   * @param userPassphrase - User's passphrase for seed encryption
   * @param storeSeed - Store encrypted seed in IndexedDB (default: true)
   * @returns Mnemonic (12 words) and DID
   */
  async create(userPassphrase: string, storeSeed: boolean = true): Promise<{
    mnemonic: string
    did: string
  }> {
    // 1. Generate BIP39 Mnemonic (12 words = 128 bit entropy)
    const mnemonic = generateMnemonic(germanPositiveWordlist, 128)
    // Empty BIP39 passphrase: same mnemonic = same identity regardless of device password
    // The userPassphrase is only used for local seed encryption, not seed derivation
    const seed = mnemonicToSeedSync(mnemonic, '')

    // 2. Store encrypted seed (optional)
    if (storeSeed) {
      await this.storage.storeSeed(new Uint8Array(seed.slice(0, 32)), userPassphrase)
    }

    // 3. Import Master Key via adapter
    await this.initFromSeed(new Uint8Array(seed.slice(0, 32)))

    return { mnemonic, did: this.did! }
  }

  /**
   * Unlock identity from mnemonic + passphrase
   *
   * @param mnemonic - 12 word BIP39 mnemonic
   * @param passphrase - User's passphrase
   * @param storeSeed - Store encrypted seed in IndexedDB (default: false)
   */
  async unlock(mnemonic: string, passphrase: string, storeSeed: boolean = false): Promise<void> {
    // Validate mnemonic
    if (!validateMnemonic(mnemonic, germanPositiveWordlist)) {
      throw new Error('Invalid mnemonic')
    }

    // Derive seed - empty BIP39 passphrase so same mnemonic always yields same identity
    const seed = mnemonicToSeedSync(mnemonic, '')

    // Store encrypted seed (optional)
    if (storeSeed) {
      await this.storage.storeSeed(new Uint8Array(seed.slice(0, 32)), passphrase)
    }

    await this.initFromSeed(new Uint8Array(seed.slice(0, 32)))
  }


  /**
   * Unlock identity from stored encrypted seed.
   * If no passphrase is provided, attempts to use a cached session key.
   *
   * @param passphrase - User's passphrase (optional if session key is cached)
   * @throws Error if no seed stored, wrong passphrase, or no active session
   */
  async unlockFromStorage(passphrase?: string): Promise<void> {
    let seed: Uint8Array | null = null

    if (!passphrase) {
      // Try session key (no passphrase needed)
      seed = await this.storage.loadSeedWithSessionKey()
      if (!seed) {
        throw new Error('Session expired')
      }
    } else {
      // Normal flow: decrypt with passphrase (also caches session key)
      seed = await this.storage.loadSeed(passphrase)
      if (!seed) {
        throw new Error('No identity found in storage')
      }
    }

    await this.initFromSeed(seed)
  }

  /**
   * Check if a valid session key exists (allows unlock without passphrase)
   */
  async hasActiveSession(): Promise<boolean> {
    return this.storage.hasActiveSession()
  }

  /**
   * Check if identity exists in storage
   */
  async hasStoredIdentity(): Promise<boolean> {
    return this.storage.hasSeed()
  }

  /**
   * Delete stored identity
   */
  async deleteStoredIdentity(): Promise<void> {
    await this.storage.deleteSeed()
    await this.lock()
  }

  /**
   * Lock identity (clear all keys from memory and session cache)
   */
  async lock(): Promise<void> {
    this.masterKey = null
    this.identityKeyPair = null
    this.encKeyPair = null
    this.did = null
    await this.storage.clearSessionKey()
  }

  private ensureUnlocked() {
    if (!this.did || !this.masterKey || !this.identityKeyPair) {
      throw new Error('Identity not unlocked')
    }
    return { did: this.did, masterKey: this.masterKey, keyPair: this.identityKeyPair }
  }

  getDid(): string {
    return this.ensureUnlocked().did
  }

  async signJws(payload: unknown): Promise<string> {
    return signJwsUtil(payload, this.ensureUnlocked().keyPair.privateKey)
  }

  async sign(data: string): Promise<string> {
    return this.crypto.signString(data, this.ensureUnlocked().keyPair.privateKey)
  }

  async deriveFrameworkKey(info: string): Promise<Uint8Array> {
    return this.crypto.deriveBits(this.ensureUnlocked().masterKey, info, 256)
  }

  async getPublicKey(): Promise<CryptoKey> {
    return this.ensureUnlocked().keyPair.publicKey
  }

  async exportPublicKeyJwk(): Promise<JsonWebKey> {
    return crypto.subtle.exportKey('jwk', this.ensureUnlocked().keyPair.publicKey)
  }

  async getPublicKeyMultibase(): Promise<string> {
    return this.ensureUnlocked().did.replace('did:key:', '')
  }

  // --- Encryption (X25519 ECDH + AES-GCM) ---

  private ensureEncKeyPair(): Promise<EncryptionKeyPair> {
    this.ensureUnlocked()
    if (this.encKeyPair) return Promise.resolve(this.encKeyPair)
    if (!this.encKeyPairPromise) {
      this.encKeyPairPromise = (async () => {
        const encSeed = await this.crypto.deriveBits(this.masterKey!, 'wot-encryption-v1', 256)
        this.encKeyPair = await this.crypto.deriveEncryptionKeyPair(encSeed)
        return this.encKeyPair
      })()
    }
    return this.encKeyPairPromise
  }

  /**
   * Get the X25519 encryption key pair (derived via separate HKDF path).
   */
  async getEncryptionKeyPair(): Promise<CryptoKeyPair> {
    const handle = await this.ensureEncKeyPair()
    // Web Crypto specific — will change when CryptoKey becomes opaque
    return (handle as unknown as { keyPair: CryptoKeyPair }).keyPair
  }

  /**
   * Get X25519 public key as raw bytes (32 bytes).
   */
  async getEncryptionPublicKeyBytes(): Promise<Uint8Array> {
    const encKeyPair = await this.ensureEncKeyPair()
    return this.crypto.exportEncryptionPublicKey(encKeyPair)
  }

  /**
   * Encrypt data for a recipient using their X25519 public key.
   * Uses ephemeral ECDH + HKDF + AES-256-GCM (ECIES-like).
   */
  async encryptForRecipient(
    plaintext: Uint8Array,
    recipientPublicKeyBytes: Uint8Array,
  ): Promise<EncryptedPayload> {
    this.ensureUnlocked()
    return this.crypto.encryptAsymmetric(plaintext, recipientPublicKeyBytes)
  }

  /**
   * Decrypt data encrypted for this identity.
   */
  async decryptForMe(payload: EncryptedPayload): Promise<Uint8Array> {
    if (!payload.ephemeralPublicKey) throw new Error('Missing ephemeral public key')
    const encKeyPair = await this.ensureEncKeyPair()
    return this.crypto.decryptAsymmetric(payload, encKeyPair)
  }

  // --- Private methods ---

  /**
   * Initialize identity from a 32-byte seed.
   * Shared logic for create(), unlock(), and unlockFromStorage().
   */
  private async initFromSeed(seed: Uint8Array): Promise<void> {
    // 1. Import master key via adapter
    this.masterKey = await this.crypto.importMasterKey(seed)

    // 2. Derive identity seed via HKDF, then derive Ed25519 key pair
    const identitySeed = await this.crypto.deriveBits(this.masterKey, 'wot-identity-v1', 256)
    const identityKeyPair = await this.crypto.deriveKeyPairFromSeed(identitySeed)
    this.identityKeyPair = identityKeyPair

    // 3. Generate DID from public key
    this.did = await this.crypto.createDid(identityKeyPair.publicKey)
  }
}
