import { openDB, type IDBPDatabase } from 'idb'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type { KeyManagementPort } from '../../ports/key-management'

const DB_NAME = 'wot-key-management'
const DB_VERSION = 1
const CONTENT_KEYS_STORE = 'contentKeys'
const CAP_KEYPAIRS_STORE = 'capKeyPairs'
const OWN_CAPABILITIES_STORE = 'ownCapabilities'

/**
 * Cache slot for a (spaceId, generation). The trailing segment is always the
 * integer generation, so the mapping is injective for ANY spaceId string.
 */
function cacheKey(spaceId: string, generation: number): string {
  return `${spaceId}#${generation}`
}

function assertValidGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Key generation must be a non-negative safe integer')
  }
}

/**
 * Durable IndexedDB {@link KeyManagementPort} (Durable Wiring / D1 + K1).
 *
 * Mirrors {@link InMemoryKeyManagementAdapter} semantics exactly — one record per
 * (spaceId, generation) for content keys, capability key pairs, and own-capability
 * JWS — so a reload restores the group keys and a Space stays decryptable.
 *
 * ── K1: raw key material at rest ─────────────────────────────────────────────
 *
 * Content keys + capability signing seed/verification key are raw Uint8Array key
 * material, stored as base64url strings (the established Uint8Array↔at-rest
 * convention in this package, cf. IndexedDBDocLogStore PendingRemoval). The
 * capability JWS is a plain string.
 *
 * ── Wipe lifecycle (shares the log's fate, BLOCKER-1b) ───────────────────────
 *
 * The DB name is constructor-injected so the composition root can make it DID-
 * aware (e.g. `wot-key-management:<did>`). An identity switch / fresh-start wipes
 * this DB together with the doc-log DB: the deviceId goes fresh, the old space
 * ciphertexts are dead, so the old keys must go too. No durable key survives a
 * log wipe under a different identity.
 *
 * ── Cold-Start PR1 (#353): in-memory key-MATERIAL cache ──────────────────────
 *
 * A cold-start catch-up decrypts thousands of log entries under the same few
 * (spaceId, generation) pairs; without a cache every entry costs an IDB round-trip
 * for the SAME 32 bytes (measured: 3.968 get:contentKeys + 3.036 get:capKeyPairs
 * for one restore). The cache holds raw key BYTES only — never CryptoKey objects
 * (that is PR2) — and is:
 *  - POSITIVE-ONLY: a miss (null) is never cached, so material written by another
 *    IDB connection (another tab / a fresh adapter on the same DB) is still
 *    observed on the next read. A (spaceId, generation) content key is immutable
 *    under the protocol (set-if-absent), so a cached hit can only go stale via
 *    THIS adapter's own write/lifecycle paths, which all invalidate below.
 *  - INVALIDATED on EVERY write + lifecycle path of the underlying store:
 *    saveKey (key rotation / new generation / overwrite), saveCapabilityKeyPair,
 *    deleteSpaceKeys (space removal), clear (reset) and close (identity switch /
 *    logout wipe teardown). Invalidation happens BEFORE the IDB mutation, so a
 *    failed write can never leave a stale hit behind.
 *  - COPY-ON-READ: every read hands out a fresh buffer (the defensive-copy
 *    invariant this store already guaranteed), so a caller mutating a returned
 *    key never corrupts the cached material.
 *
 * Deliberately NOT cached: the CURRENT generation (getCurrentKey /
 * getCurrentGeneration). "Current" is the one answer that changes on a
 * space-rotate — including a rotation performed by ANOTHER tab on the same DB,
 * which this adapter's own invalidation can never see. The encryption path
 * derives its groupKey from getCurrentKey; a stale "current" after a
 * member-removal rotation would keep encrypting under the old generation.
 * Cursor cost stays O(log n) per call, and the restore hotpath never reads
 * "current" per entry (it resolves the entry's exact generation).
 */
export class IndexedDBKeyManagementAdapter implements KeyManagementPort {
  private dbPromise: Promise<IDBPDatabase> | null = null
  private readonly dbName: string
  /** (spaceId, generation) → raw content-key bytes. Positive hits only. */
  private readonly contentKeyCache = new Map<string, Uint8Array>()
  /** (spaceId, generation) → raw capability key-pair bytes. Positive hits only. */
  private readonly capKeyPairCache = new Map<string, { signingSeed: Uint8Array; verificationKey: Uint8Array }>()

  /**
   * @param dbName IndexedDB database name. Tests pass a unique name per case;
   *               the demo passes a DID-aware name so a DID switch wipes the keys.
   */
  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName
  }

  async init(): Promise<void> {
    await this.db()
  }

  /** Close the underlying IndexedDB connection (teardown, e.g. on identity switch). */
  async close(): Promise<void> {
    // Lifecycle invalidation (identity switch / logout wipe teardown): the cached
    // material must not outlive the connection it was read through.
    this.invalidateAll()
    if (!this.dbPromise) return
    const db = await this.dbPromise
    db.close()
    this.dbPromise = null
  }

  async saveKey(spaceId: string, generation: number, key: Uint8Array): Promise<void> {
    assertValidGeneration(generation)
    if (key.length !== 32) throw new Error('Space content key must be 32 bytes')
    // Invalidate BEFORE the write, so a failed put can never leave a stale hit.
    this.contentKeyCache.delete(cacheKey(spaceId, generation))
    const db = await this.db()
    await db.put(CONTENT_KEYS_STORE, { spaceId, generation, key: encodeBase64Url(key) })
  }

  async getCurrentKey(spaceId: string): Promise<Uint8Array | null> {
    const record = await this.maxGenerationRecord(spaceId)
    return record ? record.key.slice() : null
  }

  async getCurrentGeneration(spaceId: string): Promise<number> {
    const record = await this.maxGenerationRecord(spaceId)
    return record ? record.generation : -1
  }

  async getKeyByGeneration(spaceId: string, generation: number): Promise<Uint8Array | null> {
    assertValidGeneration(generation)
    const slot = cacheKey(spaceId, generation)
    const cached = this.contentKeyCache.get(slot)
    if (cached) return cached.slice()
    const db = await this.db()
    const record = (await db.get(CONTENT_KEYS_STORE, [spaceId, generation])) as
      | StoredContentKey
      | undefined
    if (!record) return null
    const key = decodeBase64Url(record.key)
    this.contentKeyCache.set(slot, key)
    return key.slice()
  }

  async saveCapabilityKeyPair(
    spaceId: string,
    generation: number,
    signingSeed: Uint8Array,
    verificationKey: Uint8Array,
  ): Promise<void> {
    assertValidGeneration(generation)
    if (signingSeed.length !== 32) throw new Error('Capability signing seed must be 32 bytes')
    if (verificationKey.length !== 32) throw new Error('Capability verification key must be 32 bytes')
    this.capKeyPairCache.delete(cacheKey(spaceId, generation))
    const db = await this.db()
    await db.put(CAP_KEYPAIRS_STORE, {
      spaceId,
      generation,
      signingSeed: encodeBase64Url(signingSeed),
      verificationKey: encodeBase64Url(verificationKey),
    })
  }

  async getCapabilitySigningSeed(spaceId: string, generation: number): Promise<Uint8Array | null> {
    const record = await this.capRecord(spaceId, generation)
    return record ? record.signingSeed.slice() : null
  }

  async getCapabilityVerificationKey(spaceId: string, generation: number): Promise<Uint8Array | null> {
    const record = await this.capRecord(spaceId, generation)
    return record ? record.verificationKey.slice() : null
  }

  async saveOwnCapability(spaceId: string, generation: number, capabilityJws: string): Promise<void> {
    assertValidGeneration(generation)
    const db = await this.db()
    await db.put(OWN_CAPABILITIES_STORE, { spaceId, generation, capabilityJws })
  }

  async getOwnCapability(spaceId: string, generation: number): Promise<string | null> {
    const db = await this.db()
    const record = (await db.get(OWN_CAPABILITIES_STORE, [spaceId, generation])) as
      | StoredOwnCapability
      | undefined
    return record ? record.capabilityJws : null
  }

  async deleteSpaceKeys(spaceId: string): Promise<void> {
    this.invalidateSpace(spaceId)
    const db = await this.db()
    const tx = db.transaction(
      [CONTENT_KEYS_STORE, CAP_KEYPAIRS_STORE, OWN_CAPABILITIES_STORE],
      'readwrite',
    )
    for (const storeName of [CONTENT_KEYS_STORE, CAP_KEYPAIRS_STORE, OWN_CAPABILITIES_STORE]) {
      const store = tx.objectStore(storeName)
      const range = IDBKeyRange.bound([spaceId], [spaceId, []])
      let cursor = await store.openCursor(range)
      while (cursor) {
        await cursor.delete()
        cursor = await cursor.continue()
      }
    }
    await tx.done
  }

  /** Drop ALL key material — test/reset helper; the production wipe deleteDatabase's the DID-aware DB. */
  async clear(): Promise<void> {
    this.invalidateAll()
    const db = await this.db()
    const tx = db.transaction(
      [CONTENT_KEYS_STORE, CAP_KEYPAIRS_STORE, OWN_CAPABILITIES_STORE],
      'readwrite',
    )
    await Promise.all([
      tx.objectStore(CONTENT_KEYS_STORE).clear(),
      tx.objectStore(CAP_KEYPAIRS_STORE).clear(),
      tx.objectStore(OWN_CAPABILITIES_STORE).clear(),
      tx.done,
    ])
  }

  /**
   * The highest-generation content-key record for a space (decoded), or undefined.
   * NEVER served from cache: "current" changes on space-rotate, possibly from
   * another tab (see class doc). The read still seeds the exact-generation slot —
   * that answer is immutable.
   */
  private async maxGenerationRecord(spaceId: string): Promise<{ generation: number; key: Uint8Array } | undefined> {
    const db = await this.db()
    // Reverse cursor over [spaceId, -∞..+∞] → first (highest) generation. O(log n).
    const range = IDBKeyRange.bound([spaceId], [spaceId, []])
    const cursor = await db
      .transaction(CONTENT_KEYS_STORE, 'readonly')
      .store.openCursor(range, 'prev')
    if (!cursor) return undefined
    const stored = cursor.value as StoredContentKey
    const record = { generation: stored.generation, key: decodeBase64Url(stored.key) }
    this.contentKeyCache.set(cacheKey(spaceId, stored.generation), record.key)
    return record
  }

  private async capRecord(
    spaceId: string,
    generation: number,
  ): Promise<{ signingSeed: Uint8Array; verificationKey: Uint8Array } | undefined> {
    assertValidGeneration(generation)
    const slot = cacheKey(spaceId, generation)
    const cached = this.capKeyPairCache.get(slot)
    if (cached) return cached
    const db = await this.db()
    const stored = (await db.get(CAP_KEYPAIRS_STORE, [spaceId, generation])) as StoredCapKeyPair | undefined
    if (!stored) return undefined
    const record = {
      signingSeed: decodeBase64Url(stored.signingSeed),
      verificationKey: decodeBase64Url(stored.verificationKey),
    }
    this.capKeyPairCache.set(slot, record)
    return record
  }

  /** Drop every cached slot (clear / close). */
  private invalidateAll(): void {
    this.contentKeyCache.clear()
    this.capKeyPairCache.clear()
  }

  /** Drop every cached slot of ONE space (deleteSpaceKeys). */
  private invalidateSpace(spaceId: string): void {
    const prefix = `${spaceId}#`
    for (const slot of [...this.contentKeyCache.keys()]) {
      if (slot.startsWith(prefix)) this.contentKeyCache.delete(slot)
    }
    for (const slot of [...this.capKeyPairCache.keys()]) {
      if (slot.startsWith(prefix)) this.capKeyPairCache.delete(slot)
    }
  }

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(this.dbName, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(CONTENT_KEYS_STORE)) {
            db.createObjectStore(CONTENT_KEYS_STORE, { keyPath: ['spaceId', 'generation'] })
          }
          if (!db.objectStoreNames.contains(CAP_KEYPAIRS_STORE)) {
            db.createObjectStore(CAP_KEYPAIRS_STORE, { keyPath: ['spaceId', 'generation'] })
          }
          if (!db.objectStoreNames.contains(OWN_CAPABILITIES_STORE)) {
            db.createObjectStore(OWN_CAPABILITIES_STORE, { keyPath: ['spaceId', 'generation'] })
          }
        },
      })
    }
    return this.dbPromise
  }
}

/** At-rest shape: raw key bytes as base64url, keyPath fields at top level. */
interface StoredContentKey {
  spaceId: string
  generation: number
  key: string
}

interface StoredCapKeyPair {
  spaceId: string
  generation: number
  signingSeed: string
  verificationKey: string
}

interface StoredOwnCapability {
  spaceId: string
  generation: number
  capabilityJws: string
}
