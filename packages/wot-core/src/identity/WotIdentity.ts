import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import * as ed25519 from '@noble/ed25519'
import { SeedStorage } from './SeedStorage'
import { germanPositiveWordlist } from '../wordlists/german-positive'
import { signJws as signJwsUtil } from '../crypto/jws'
import type { EncryptedPayload } from '../adapters/interfaces/CryptoAdapter'

/**
 * WotIdentity - BIP39-based identity with native WebCrypto
 *
 * Security architecture:
 * - BIP39 Mnemonic (12 words, 128 bit entropy)
 * - Master Key derived via HKDF (non-extractable)
 * - Identity Private Key (non-extractable, Ed25519)
 * - Framework Keys (extractable for Evolu, etc.)
 *
 * Storage:
 * - Mnemonic: User must write down (never stored)
 * - Master Seed: Encrypted with PBKDF2(passphrase) + AES-GCM in IndexedDB
 * - Keys: All derived from master seed via HKDF
 */
export class WotIdentity {
  private masterKey: CryptoKey | null = null
  private identityKeyPair: CryptoKeyPair | null = null
  private encryptionKeyPair: CryptoKeyPair | null = null
  private did: string | null = null
  private storage: SeedStorage = new SeedStorage()

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

    // 3. Import Master Key (non-extractable!)
    this.masterKey = await crypto.subtle.importKey(
      'raw',
      seed.slice(0, 32), // First 32 bytes
      { name: 'HKDF' },
      false, // non-extractable!
      ['deriveKey', 'deriveBits']
    )

    // 4. Derive Identity Key Pair (Ed25519, non-extractable)
    await this.deriveIdentityKeyPair()

    // 5. Generate DID from public key
    this.did = await this.generateDID()

    return { mnemonic, did: this.did }
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

    // Import Master Key (non-extractable)
    this.masterKey = await crypto.subtle.importKey(
      'raw',
      seed.slice(0, 32),
      { name: 'HKDF' },
      false, // non-extractable!
      ['deriveKey', 'deriveBits']
    )

    // Derive Identity Key Pair
    await this.deriveIdentityKeyPair()

    // Generate DID
    this.did = await this.generateDID()
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

    // Import Master Key (non-extractable)
    this.masterKey = await crypto.subtle.importKey(
      'raw',
      seed,
      { name: 'HKDF' },
      false, // non-extractable!
      ['deriveKey', 'deriveBits']
    )

    // Derive Identity Key Pair
    await this.deriveIdentityKeyPair()

    // Generate DID
    this.did = await this.generateDID()
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
    this.encryptionKeyPair = null
    this.did = null
    await this.storage.clearSessionKey()
  }

  /**
   * Get DID (Decentralized Identifier)
   */
  getDid(): string {
    if (!this.did) {
      throw new Error('Identity not unlocked')
    }
    return this.did
  }

  /**
   * Sign a payload as JWS (JSON Web Signature) compact serialization
   *
   * @param payload - Data to sign (will be JSON-serialized)
   * @returns JWS compact serialization (header.payload.signature)
   */
  async signJws(payload: unknown): Promise<string> {
    if (!this.identityKeyPair) {
      throw new Error('Identity not unlocked')
    }
    return signJwsUtil(payload, this.identityKeyPair.privateKey)
  }

  /**
   * Sign data with identity private key
   *
   * @param data - Data to sign
   * @returns Signature as base64url string
   */
  async sign(data: string): Promise<string> {
    if (!this.identityKeyPair) {
      throw new Error('Identity not unlocked')
    }

    const encoder = new TextEncoder()
    const signature = await crypto.subtle.sign(
      'Ed25519',
      this.identityKeyPair.privateKey,
      encoder.encode(data)
    )

    return this.arrayBufferToBase64Url(signature)
  }

  /**
   * Derive framework-specific keys (extractable for Evolu, etc.)
   *
   * @param info - Context string (e.g., 'evolu-storage-v1')
   * @returns Derived key bytes
   */
  async deriveFrameworkKey(info: string): Promise<Uint8Array> {
    if (!this.masterKey) {
      throw new Error('Identity not unlocked')
    }

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: new TextEncoder().encode(info)
      },
      this.masterKey,
      256 // 32 bytes
    )

    return new Uint8Array(bits)
  }

  /**
   * Get public key (for DID Document, etc.)
   */
  async getPublicKey(): Promise<CryptoKey> {
    if (!this.identityKeyPair) {
      throw new Error('Identity not unlocked')
    }
    return this.identityKeyPair.publicKey
  }

  /**
   * Export public key as JWK
   */
  async exportPublicKeyJwk(): Promise<JsonWebKey> {
    const publicKey = await this.getPublicKey()
    return crypto.subtle.exportKey('jwk', publicKey)
  }

  /**
   * Get public key as multibase encoded string (same format as in DID)
   */
  async getPublicKeyMultibase(): Promise<string> {
    if (!this.identityKeyPair) {
      throw new Error('Identity not unlocked')
    }

    // Export public key
    const publicKeyJwk = await crypto.subtle.exportKey(
      'jwk',
      this.identityKeyPair.publicKey
    )

    // Encode as multibase (same as in DID generation)
    const publicKeyBytes = this.base64UrlToArrayBuffer(publicKeyJwk.x!)
    const multicodecPrefix = new Uint8Array([0xed, 0x01]) // Ed25519 public key
    const combined = new Uint8Array(multicodecPrefix.length + publicKeyBytes.byteLength)
    combined.set(multicodecPrefix)
    combined.set(new Uint8Array(publicKeyBytes), multicodecPrefix.length)

    return 'z' + this.base58Encode(combined)
  }

  // --- Encryption (X25519 ECDH + AES-GCM) ---

  /**
   * Get the X25519 encryption key pair (derived via separate HKDF path).
   * Lazily derived on first call, then cached.
   */
  async getEncryptionKeyPair(): Promise<CryptoKeyPair> {
    if (!this.masterKey) {
      throw new Error('Identity not unlocked')
    }
    if (!this.encryptionKeyPair) {
      await this.deriveEncryptionKeyPair()
    }
    return this.encryptionKeyPair!
  }

  /**
   * Get X25519 public key as raw bytes (32 bytes).
   * This is what others need to encrypt messages for this identity.
   */
  async getEncryptionPublicKeyBytes(): Promise<Uint8Array> {
    const kp = await this.getEncryptionKeyPair()
    const raw = await crypto.subtle.exportKey('raw', kp.publicKey)
    return new Uint8Array(raw)
  }

  /**
   * Encrypt data for a recipient using their X25519 public key.
   * Uses ephemeral ECDH + HKDF + AES-256-GCM (ECIES-like).
   */
  async encryptForRecipient(
    plaintext: Uint8Array,
    recipientPublicKeyBytes: Uint8Array,
  ): Promise<EncryptedPayload> {
    if (!this.masterKey) {
      throw new Error('Identity not unlocked')
    }

    // 1. Generate ephemeral X25519 key pair
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true, // extractable (need to send public key)
      ['deriveBits'],
    ) as CryptoKeyPair

    // 2. Import recipient's public key
    const recipientPub = await crypto.subtle.importKey(
      'raw',
      recipientPublicKeyBytes,
      { name: 'X25519' },
      true,
      [],
    )

    // 3. ECDH: ephemeral private × recipient public → shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: recipientPub },
      ephemeral.privateKey,
      256,
    )

    // 4. HKDF: shared secret → AES-GCM key
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'HKDF' },
      false,
      ['deriveKey'],
    )
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('wot-ecies-v1'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    )

    // 5. AES-GCM encrypt
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      plaintext,
    )

    // 6. Export ephemeral public key
    const ephemeralPubBytes = new Uint8Array(
      await crypto.subtle.exportKey('raw', ephemeral.publicKey),
    )

    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce,
      ephemeralPublicKey: ephemeralPubBytes,
    }
  }

  /**
   * Decrypt data encrypted for this identity.
   * Uses own X25519 private key + ephemeral public key from sender.
   */
  async decryptForMe(payload: EncryptedPayload): Promise<Uint8Array> {
    if (!this.masterKey) {
      throw new Error('Identity not unlocked')
    }
    if (!payload.ephemeralPublicKey) {
      throw new Error('Missing ephemeral public key')
    }

    const kp = await this.getEncryptionKeyPair()

    // 1. Import sender's ephemeral public key
    const ephemeralPub = await crypto.subtle.importKey(
      'raw',
      payload.ephemeralPublicKey,
      { name: 'X25519' },
      true,
      [],
    )

    // 2. ECDH: own private × ephemeral public → same shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: ephemeralPub },
      kp.privateKey,
      256,
    )

    // 3. HKDF: shared secret → AES-GCM key (same params as encrypt)
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'HKDF' },
      false,
      ['deriveKey'],
    )
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('wot-ecies-v1'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )

    // 4. AES-GCM decrypt
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.nonce },
      aesKey,
      payload.ciphertext,
    )

    return new Uint8Array(plaintext)
  }

  // Private methods

  private async deriveIdentityKeyPair(): Promise<void> {
    if (!this.masterKey) {
      throw new Error('Master key not initialized')
    }

    // Derive identity seed via HKDF (32 bytes)
    const identitySeed = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: new TextEncoder().encode('wot-identity-v1')
      },
      this.masterKey,
      256 // 32 bytes for Ed25519
    )

    // Derive Ed25519 key pair from seed using @noble/ed25519
    // This ensures deterministic key generation: same seed → same keys
    const privateKeyBytes = new Uint8Array(identitySeed)
    const publicKeyBytes = await ed25519.getPublicKeyAsync(privateKeyBytes)

    // Import into WebCrypto (keep private key non-extractable where possible)
    // Note: We need to use JWK format for proper Ed25519 import
    const privateKeyJwk: JsonWebKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: this.arrayBufferToBase64Url(publicKeyBytes.buffer),
      d: this.arrayBufferToBase64Url(privateKeyBytes.buffer),
      ext: false, // non-extractable
      key_ops: ['sign']
    }

    const publicKeyJwk: JsonWebKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: this.arrayBufferToBase64Url(publicKeyBytes.buffer),
      ext: true,
      key_ops: ['verify']
    }

    // Import keys
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      privateKeyJwk,
      'Ed25519',
      false, // non-extractable!
      ['sign']
    )

    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      'Ed25519',
      true, // public key can be extractable
      ['verify']
    )

    this.identityKeyPair = { privateKey, publicKey }
  }

  private async deriveEncryptionKeyPair(): Promise<void> {
    if (!this.masterKey) {
      throw new Error('Master key not initialized')
    }

    // Derive X25519 seed via HKDF with a DIFFERENT info string
    // This ensures cryptographic independence from the Ed25519 identity key
    const encryptionSeed = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: new TextEncoder().encode('wot-encryption-v1'),
      },
      this.masterKey,
      256, // 32 bytes for X25519
    )

    // Import as X25519 private key via PKCS8
    // X25519 raw import requires PKCS8 wrapping for private keys
    const pkcs8 = this.wrapX25519PrivateKey(new Uint8Array(encryptionSeed))
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'X25519' },
      false, // non-extractable
      ['deriveBits'],
    )

    // Derive public key by generating bits with a known base point
    // WebCrypto doesn't have a direct "get public key from private" for X25519
    // So we import as extractable, export JWK, and re-import
    const extractablePriv = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'X25519' },
      true, // extractable to get JWK
      ['deriveBits'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', extractablePriv)
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { name: 'X25519' },
      true,
      [],
    )

    this.encryptionKeyPair = { privateKey, publicKey }
  }

  /**
   * Wrap raw 32-byte X25519 private key in PKCS8 DER format.
   * PKCS8 = SEQUENCE { version, algorithm, key }
   */
  private wrapX25519PrivateKey(rawKey: Uint8Array): Uint8Array {
    // OID for X25519: 1.3.101.110
    const prefix = new Uint8Array([
      0x30, 0x2e, // SEQUENCE (46 bytes)
      0x02, 0x01, 0x00, // INTEGER version = 0
      0x30, 0x05, // SEQUENCE (5 bytes)
      0x06, 0x03, 0x2b, 0x65, 0x6e, // OID 1.3.101.110 (X25519)
      0x04, 0x22, // OCTET STRING (34 bytes)
      0x04, 0x20, // OCTET STRING (32 bytes) — the actual key
    ])
    const pkcs8 = new Uint8Array(prefix.length + rawKey.length)
    pkcs8.set(prefix)
    pkcs8.set(rawKey, prefix.length)
    return pkcs8
  }

  private async generateDID(): Promise<string> {
    if (!this.identityKeyPair) {
      throw new Error('Key pair not initialized')
    }

    // Export public key
    const publicKeyJwk = await crypto.subtle.exportKey(
      'jwk',
      this.identityKeyPair.publicKey
    )

    // Create did:key identifier (multibase encoded)
    // Format: did:key:z...
    const publicKeyBytes = this.base64UrlToArrayBuffer(publicKeyJwk.x!)
    const multicodecPrefix = new Uint8Array([0xed, 0x01]) // Ed25519 public key
    const combined = new Uint8Array(multicodecPrefix.length + publicKeyBytes.byteLength)
    combined.set(multicodecPrefix)
    combined.set(new Uint8Array(publicKeyBytes), multicodecPrefix.length)

    const base58 = this.base58Encode(combined)
    return `did:key:z${base58}`
  }

  // Utility methods

  private arrayBufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  }

  private base64UrlToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }

  private base58Encode(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    let result = ''

    // Convert to big integer
    let num = BigInt(0)
    for (const byte of bytes) {
      num = num * BigInt(256) + BigInt(byte)
    }

    // Convert to base58
    while (num > 0) {
      const remainder = num % BigInt(58)
      result = ALPHABET[Number(remainder)] + result
      num = num / BigInt(58)
    }

    // Handle leading zeros
    for (const byte of bytes) {
      if (byte === 0) {
        result = ALPHABET[0] + result
      } else {
        break
      }
    }

    return result
  }
}
