/**
 * SeedStorage - Encrypted storage for master seed
 *
 * Security:
 * - Master seed encrypted with PBKDF2(passphrase) + AES-GCM
 * - Stored in IndexedDB
 * - Never stored unencrypted
 * - Session cache: non-extractable CryptoKey in IndexedDB with TTL
 */

import { encodeBase64Url, decodeBase64Url } from '../crypto/encoding'
import type { SeedStorageAdapter } from '../adapters/interfaces/SeedStorageAdapter'

interface EncryptedSeed {
  ciphertext: string // base64url
  salt: string // base64url for PBKDF2
  iv: string // base64url for AES-GCM
}

interface SessionEntry {
  key: CryptoKey // non-extractable AES-GCM
  expiresAt: number // Date.now() + ttl
}

export class SeedStorage implements SeedStorageAdapter {
  private static readonly DB_NAME = 'wot-identity'
  private static readonly STORE_NAME = 'seeds'
  private static readonly SESSION_STORE_NAME = 'session'
  private static readonly PBKDF2_ITERATIONS = 100000
  private static readonly DEFAULT_SESSION_TTL = 30 * 60 * 1000 // 30 minutes
  private db: IDBDatabase | null = null

  /**
   * Initialize IndexedDB
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SeedStorage.DB_NAME, 2)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(SeedStorage.STORE_NAME)) {
          db.createObjectStore(SeedStorage.STORE_NAME)
        }
        if (!db.objectStoreNames.contains(SeedStorage.SESSION_STORE_NAME)) {
          db.createObjectStore(SeedStorage.SESSION_STORE_NAME)
        }
      }
    })
  }

  /**
   * Store encrypted seed
   *
   * @param seed - Master seed bytes; the caller owns the seed format/version.
   * @param passphrase - User's passphrase
   */
  async storeSeed(seed: Uint8Array, passphrase: string): Promise<void> {
    if (!this.db) {
      await this.init()
    }

    // Generate salt for PBKDF2
    const salt = crypto.getRandomValues(new Uint8Array(16))

    // Derive encryption key from passphrase
    const encryptionKey = await this.deriveEncryptionKey(passphrase, salt)

    // Generate IV for AES-GCM
    const iv = crypto.getRandomValues(new Uint8Array(12))

    // Encrypt seed
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      seed
    )

    // Store encrypted data
    const encrypted: EncryptedSeed = {
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      salt: encodeBase64Url(salt),
      iv: encodeBase64Url(iv)
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([SeedStorage.STORE_NAME], 'readwrite')
      const store = transaction.objectStore(SeedStorage.STORE_NAME)
      const request = store.put(encrypted, 'master-seed')

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Load and decrypt seed using passphrase.
   * On success, caches the derived CryptoKey as session key.
   *
   * @param passphrase - User's passphrase
   * @returns Decrypted seed or null if not found
   */
  async loadSeed(passphrase: string): Promise<Uint8Array | null> {
    if (!this.db) {
      await this.init()
    }

    // Load encrypted data
    const encrypted = await this.getEncryptedSeed()
    if (!encrypted) {
      return null
    }

    try {
      // Derive encryption key from passphrase
      const salt = decodeBase64Url(encrypted.salt)
      const encryptionKey = await this.deriveEncryptionKey(passphrase, salt)

      // Decrypt seed
      const iv = decodeBase64Url(encrypted.iv)
      const ciphertext = decodeBase64Url(encrypted.ciphertext)

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        ciphertext
      )

      // Cache session key for reload-without-passphrase
      await this.storeSessionKey(encryptionKey)

      return new Uint8Array(decrypted)
    } catch (error) {
      // Decryption failed - wrong passphrase
      throw new Error('Invalid passphrase')
    }
  }

  /**
   * Load and decrypt seed using cached session key (no passphrase needed).
   * Returns null if no session key, session expired, or decryption fails.
   */
  async loadSeedWithSessionKey(): Promise<Uint8Array | null> {
    if (!this.db) {
      await this.init()
    }

    // Load session key
    const session = await this.getSessionEntry()
    if (!session) {
      return null
    }

    // Check expiry
    if (Date.now() > session.expiresAt) {
      await this.clearSessionKey()
      return null
    }

    // Load encrypted seed
    const encrypted = await this.getEncryptedSeed()
    if (!encrypted) {
      return null
    }

    try {
      const iv = decodeBase64Url(encrypted.iv)
      const ciphertext = decodeBase64Url(encrypted.ciphertext)

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        session.key,
        ciphertext
      )

      // Refresh session TTL on successful use
      await this.storeSessionKey(session.key)

      return new Uint8Array(decrypted)
    } catch {
      // Session key invalid (seed re-encrypted with different passphrase?)
      await this.clearSessionKey()
      return null
    }
  }

  /**
   * Check if a valid (non-expired) session key exists
   */
  async hasActiveSession(): Promise<boolean> {
    if (!this.db) {
      await this.init()
    }

    const session = await this.getSessionEntry()
    if (!session) {
      return false
    }

    if (Date.now() > session.expiresAt) {
      await this.clearSessionKey()
      return false
    }

    return true
  }

  /**
   * Check if seed exists in storage
   */
  async hasSeed(): Promise<boolean> {
    if (!this.db) {
      await this.init()
    }
    const encrypted = await this.getEncryptedSeed()
    return encrypted !== null
  }

  /**
   * Delete stored seed and session key
   */
  async deleteSeed(): Promise<void> {
    if (!this.db) {
      await this.init()
    }

    await this.clearSessionKey()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([SeedStorage.STORE_NAME], 'readwrite')
      const store = transaction.objectStore(SeedStorage.STORE_NAME)
      const request = store.delete('master-seed')

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Clear the cached session key
   */
  async clearSessionKey(): Promise<void> {
    if (!this.db) {
      await this.init()
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([SeedStorage.SESSION_STORE_NAME], 'readwrite')
      const store = transaction.objectStore(SeedStorage.SESSION_STORE_NAME)
      const request = store.delete('session-key')

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  // Private methods

  private async storeSessionKey(
    key: CryptoKey,
    ttlMs: number = SeedStorage.DEFAULT_SESSION_TTL
  ): Promise<void> {
    const entry: SessionEntry = {
      key,
      expiresAt: Date.now() + ttlMs
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([SeedStorage.SESSION_STORE_NAME], 'readwrite')
      const store = transaction.objectStore(SeedStorage.SESSION_STORE_NAME)
      const request = store.put(entry, 'session-key')

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  private async getSessionEntry(): Promise<SessionEntry | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([SeedStorage.SESSION_STORE_NAME], 'readonly')
      const store = transaction.objectStore(SeedStorage.SESSION_STORE_NAME)
      const request = store.get('session-key')

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  private async getEncryptedSeed(): Promise<EncryptedSeed | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([SeedStorage.STORE_NAME], 'readonly')
      const store = transaction.objectStore(SeedStorage.STORE_NAME)
      const request = store.get('master-seed')

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  private async deriveEncryptionKey(
    passphrase: string,
    salt: Uint8Array
  ): Promise<CryptoKey> {
    // Import passphrase as key material
    const passphraseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    )

    // Derive AES key using PBKDF2
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: SeedStorage.PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      passphraseKey,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    )
  }

}
