import { createIdentityVaultUnlockHandle } from '../../application/identity/identity-vault-handle'
import { WebCryptoProtocolCryptoAdapter } from '../protocol-crypto'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type { ProtocolCryptoAdapter } from '../../protocol'
import type { IdentitySeedVault } from '../../ports'
import type { IdentityVaultUnlockHandle } from '../../types/identity-session'

const STORED_IDENTITY_SEED_TYPE = 'wot.identity.seed'
const STORED_IDENTITY_SEED_VERSION = 1
const STORED_IDENTITY_SEED_FORMAT = 'bip39-64-byte'
const IDENTITY_SEED_BYTE_LENGTH = 64
const INVALID_IDENTITY_SEED_ERROR = 'Identity seed must be exactly 64 bytes.'
const UNSUPPORTED_STORED_IDENTITY_SEED_ERROR =
  'Stored identity uses an unsupported local identity format. Create a new ID to continue.'

// Wire-compatible with the previous SeedStorage implementation: same database
// name, schema version, store names, record keys, PBKDF2 iteration count, and
// AES-GCM parameters. Existing browser users with stored seeds must continue
// to unlock through this vault.
const DB_NAME = 'wot-identity'
const DB_VERSION = 2
const SEED_STORE_NAME = 'seeds'
const SESSION_STORE_NAME = 'session'
const SEED_RECORD_KEY = 'master-seed'
const SESSION_RECORD_KEY = 'session-key'
const PBKDF2_ITERATIONS = 100000
const PBKDF2_SALT_BYTES = 16
const AES_GCM_IV_BYTES = 12
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

interface EncryptedSeedRecord {
  ciphertext: string
  salt: string
  iv: string
}

interface SessionRecord {
  key: CryptoKey
  expiresAt: number
}

interface StoredIdentitySeed {
  type: typeof STORED_IDENTITY_SEED_TYPE
  version: typeof STORED_IDENTITY_SEED_VERSION
  seedFormat: typeof STORED_IDENTITY_SEED_FORMAT
  seed: string
}

export interface IndexedDbIdentitySeedVaultOptions {
  crypto?: ProtocolCryptoAdapter
}

/**
 * Module-level registry of every {@link IndexedDbIdentitySeedVault} that currently holds
 * an OPEN connection to the `wot-identity` DB. The app's long-lived logged-in vault and
 * the per-call `createIdentityWorkflow()` vaults each open their own connection; an open
 * connection BLOCKS a whole-DB `deleteDatabase('wot-identity')` (the W2 full-wipe backstop).
 * Crucially the logged-in vault is NOT reachable through any single workflow chain, so the
 * full-wipe path cannot close it by hand — it closes them ALL through this registry instead.
 */
const openIdentitySeedVaults = new Set<IndexedDbIdentitySeedVault>()

export class IndexedDbIdentitySeedVault implements IdentitySeedVault {
  private readonly crypto: ProtocolCryptoAdapter
  private db: IDBDatabase | null = null
  /** In-flight open, shared by concurrent ensureDb() callers (single-flight — see ensureDb). */
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(options: IndexedDbIdentitySeedVaultOptions = {}) {
    this.crypto = options.crypto ?? new WebCryptoProtocolCryptoAdapter()
  }

  async saveSeed(seed: Uint8Array, passphrase: string): Promise<void> {
    if (seed.byteLength !== IDENTITY_SEED_BYTE_LENGTH) throw new Error(INVALID_IDENTITY_SEED_ERROR)
    await this.ensureDb()

    const payload = this.encodeSeed(seed)
    const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES))
    const encryptionKey = await deriveEncryptionKey(passphrase, salt)
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, payload)

    const record: EncryptedSeedRecord = {
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      salt: encodeBase64Url(salt),
      iv: encodeBase64Url(iv),
    }

    await this.put(SEED_STORE_NAME, SEED_RECORD_KEY, record)
  }

  async unlockWithPassphrase(passphrase: string): Promise<IdentityVaultUnlockHandle | null> {
    await this.ensureDb()
    const encrypted = await this.get<EncryptedSeedRecord>(SEED_STORE_NAME, SEED_RECORD_KEY)
    if (!encrypted) return null

    const salt = decodeBase64Url(encrypted.salt)
    const iv = decodeBase64Url(encrypted.iv)
    const ciphertext = decodeBase64Url(encrypted.ciphertext)
    const encryptionKey = await deriveEncryptionKey(passphrase, salt)

    let payload: ArrayBuffer
    try {
      payload = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encryptionKey, ciphertext)
    } catch {
      throw new Error('Invalid passphrase')
    }

    await this.storeSessionKey(encryptionKey)
    const seed = this.decodeSeed(new Uint8Array(payload))
    return createIdentityVaultUnlockHandle(seed, this.crypto)
  }

  async unlockWithSession(): Promise<IdentityVaultUnlockHandle | null> {
    await this.ensureDb()
    const session = await this.get<SessionRecord>(SESSION_STORE_NAME, SESSION_RECORD_KEY)
    if (!session) return null
    if (Date.now() > session.expiresAt) {
      await this.clearSessionKey()
      return null
    }

    const encrypted = await this.get<EncryptedSeedRecord>(SEED_STORE_NAME, SEED_RECORD_KEY)
    if (!encrypted) return null

    const iv = decodeBase64Url(encrypted.iv)
    const ciphertext = decodeBase64Url(encrypted.ciphertext)

    let payload: ArrayBuffer
    try {
      payload = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, session.key, ciphertext)
    } catch {
      await this.clearSessionKey()
      return null
    }

    await this.storeSessionKey(session.key)
    const seed = this.decodeSeed(new Uint8Array(payload))
    return createIdentityVaultUnlockHandle(seed, this.crypto)
  }

  async deleteSeed(): Promise<void> {
    await this.ensureDb()
    await this.clearSessionKey()
    await this.delete(SEED_STORE_NAME, SEED_RECORD_KEY)
  }

  async hasSeed(): Promise<boolean> {
    await this.ensureDb()
    const encrypted = await this.get<EncryptedSeedRecord>(SEED_STORE_NAME, SEED_RECORD_KEY)
    return encrypted !== null
  }

  async hasActiveSession(): Promise<boolean> {
    await this.ensureDb()
    const session = await this.get<SessionRecord>(SESSION_STORE_NAME, SESSION_RECORD_KEY)
    if (!session) return false
    if (Date.now() > session.expiresAt) {
      await this.clearSessionKey()
      return false
    }
    return true
  }

  async clearSessionKey(): Promise<void> {
    await this.ensureDb()
    await this.delete(SESSION_STORE_NAME, SESSION_RECORD_KEY)
  }

  /**
   * Close this vault's open connection so it can no longer block a whole-DB delete, and
   * reset state. Idempotent; a subsequent operation transparently reopens via ensureDb().
   * Synchronous: `IDBDatabase.close()` returns at once (the connection finishes closing
   * once its in-flight transactions complete) and there is nothing to await.
   */
  close(): void {
    openIdentitySeedVaults.delete(this)
    // Drop any in-flight/settled open so a later ensureDb() reopens a FRESH connection (a
    // stale promise would otherwise hand back the connection we just closed).
    this.dbPromise = null
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private async ensureDb(): Promise<void> {
    if (this.db) return
    // SINGLE-FLIGHT: concurrent first operations MUST share ONE open. Without this, two racing
    // ensureDb() calls each open a connection; this.db then tracks only the LAST, and
    // close()/closeOpenIdentitySeedVaultConnections() leaves the other connection OPEN — still
    // blocking deleteDatabase('wot-identity'). The shared app singleton makes this race real.
    if (!this.dbPromise) {
      const opening = openIdentityDb().then((db) => {
        // close() ran while we were opening (dbPromise was reset): adopt nothing — shut this
        // orphan so it cannot block a delete, and leave the instance closed.
        if (this.dbPromise !== opening) {
          db.close()
          return db
        }
        // Hygiene backstop bound to THIS concrete handle (the one that receives versionchange),
        // NOT to whatever this.db happens to be. Yield to a competing version change (the
        // full-wipe deleteDatabase); route through this.close() when it is the current handle so
        // this.db/dbPromise are reset (a bare close would leave a CLOSED this.db that ensureDb
        // still treats as live → InvalidStateError). The deterministic fix is still closeOpen.
        db.onversionchange = () => {
          if (this.db === db) this.close()
          else db.close()
        }
        this.db = db
        // Register the OPEN connection so the full-wipe path can close it (TC2).
        openIdentitySeedVaults.add(this)
        return db
      })
      // A failed open must not pin a rejected promise — allow a later retry.
      opening.catch(() => {
        if (this.dbPromise === opening) this.dbPromise = null
      })
      this.dbPromise = opening
    }
    await this.dbPromise
  }

  private storeSessionKey(key: CryptoKey, ttlMs: number = DEFAULT_SESSION_TTL_MS): Promise<void> {
    const entry: SessionRecord = { key, expiresAt: Date.now() + ttlMs }
    return this.put(SESSION_STORE_NAME, SESSION_RECORD_KEY, entry)
  }

  private put(storeName: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.put(value, key)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  private get<T>(storeName: string, key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.get(key)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    })
  }

  private delete(storeName: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.delete(key)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  private encodeSeed(seed: Uint8Array): Uint8Array {
    const storedSeed: StoredIdentitySeed = {
      type: STORED_IDENTITY_SEED_TYPE,
      version: STORED_IDENTITY_SEED_VERSION,
      seedFormat: STORED_IDENTITY_SEED_FORMAT,
      seed: encodeBase64Url(seed),
    }
    return new TextEncoder().encode(JSON.stringify(storedSeed))
  }

  private decodeSeed(storedSeed: Uint8Array): Uint8Array {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(storedSeed))
    } catch {
      throw new Error(UNSUPPORTED_STORED_IDENTITY_SEED_ERROR)
    }

    if (!isStoredIdentitySeed(parsed)) throw new Error(UNSUPPORTED_STORED_IDENTITY_SEED_ERROR)

    try {
      const seed = decodeBase64Url(parsed.seed)
      if (seed.byteLength !== IDENTITY_SEED_BYTE_LENGTH) throw new Error('Unsupported stored identity seed length')
      return seed
    } catch {
      throw new Error(UNSUPPORTED_STORED_IDENTITY_SEED_ERROR)
    }
  }
}

/**
 * Close EVERY open IndexedDbIdentitySeedVault connection to the `wot-identity` DB. The
 * full-wipe path (resetLocalAppData) MUST call this immediately before
 * `deleteDatabase('wot-identity')`: an open connection — above all the long-lived
 * logged-in vault, which no workflow chain can reach — would otherwise block the whole-DB
 * delete, leaving the encrypted seed on disk and the W5 recheck reporting "survived"
 * (the logout/delete hang this fixes). This is the DETERMINISTIC fix; the per-connection
 * `onversionchange` handler in {@link openIdentityDb} is the hygiene backstop. Single-tab
 * only — a second tab's connection can still block the delete (deferred hardening).
 */
export function closeOpenIdentitySeedVaultConnections(): void {
  // Snapshot: each close() removes itself from the live set (mutation during iteration).
  for (const vault of [...openIdentitySeedVaults]) vault.close()
}

function isStoredIdentitySeed(value: unknown): value is StoredIdentitySeed {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Record<string, unknown>
  return candidate.type === STORED_IDENTITY_SEED_TYPE
    && candidate.version === STORED_IDENTITY_SEED_VERSION
    && candidate.seedFormat === STORED_IDENTITY_SEED_FORMAT
    && typeof candidate.seed === 'string'
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(SEED_STORE_NAME)) {
        db.createObjectStore(SEED_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.createObjectStore(SESSION_STORE_NAME)
      }
    }
  })
}

async function deriveEncryptionKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  // ADR-0001 Layer-1/3: the at-rest AES-GCM key is derived non-extractable
  // (extractable=false), with usages restricted to encrypt/decrypt. The key
  // never leaves the adapter — there is no exportKey path, so the at-rest
  // encryption key material cannot be read back out of the WebCrypto store.
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passphraseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
