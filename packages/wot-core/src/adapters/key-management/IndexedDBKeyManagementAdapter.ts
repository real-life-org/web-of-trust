import { openDB, type IDBPDatabase } from 'idb'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type { KeyManagementPort } from '../../ports/key-management'

const DB_NAME = 'wot-key-management'
const DB_VERSION = 1
const CONTENT_KEYS_STORE = 'contentKeys'
const CAP_KEYPAIRS_STORE = 'capKeyPairs'
const OWN_CAPABILITIES_STORE = 'ownCapabilities'

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
 */
export class IndexedDBKeyManagementAdapter implements KeyManagementPort {
  private dbPromise: Promise<IDBPDatabase> | null = null
  private readonly dbName: string

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

  async saveKey(spaceId: string, generation: number, key: Uint8Array): Promise<void> {
    assertValidGeneration(generation)
    if (key.length !== 32) throw new Error('Space content key must be 32 bytes')
    const db = await this.db()
    await db.put(CONTENT_KEYS_STORE, { spaceId, generation, key: encodeBase64Url(key) })
  }

  async getCurrentKey(spaceId: string): Promise<Uint8Array | null> {
    const record = await this.maxGenerationRecord(spaceId)
    return record ? decodeBase64Url(record.key) : null
  }

  async getCurrentGeneration(spaceId: string): Promise<number> {
    const record = await this.maxGenerationRecord(spaceId)
    return record ? record.generation : -1
  }

  async getKeyByGeneration(spaceId: string, generation: number): Promise<Uint8Array | null> {
    assertValidGeneration(generation)
    const db = await this.db()
    const record = (await db.get(CONTENT_KEYS_STORE, [spaceId, generation])) as
      | StoredContentKey
      | undefined
    return record ? decodeBase64Url(record.key) : null
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
    return record ? decodeBase64Url(record.signingSeed) : null
  }

  async getCapabilityVerificationKey(spaceId: string, generation: number): Promise<Uint8Array | null> {
    const record = await this.capRecord(spaceId, generation)
    return record ? decodeBase64Url(record.verificationKey) : null
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

  /** Drop ALL key material — test/reset helper; the production wipe deleteDatabase's the DID-aware DB. */
  async clear(): Promise<void> {
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

  /** The highest-generation content-key record for a space, or undefined. */
  private async maxGenerationRecord(spaceId: string): Promise<StoredContentKey | undefined> {
    const db = await this.db()
    // Reverse cursor over [spaceId, -∞..+∞] → first (highest) generation. O(log n).
    const range = IDBKeyRange.bound([spaceId], [spaceId, []])
    const cursor = await db
      .transaction(CONTENT_KEYS_STORE, 'readonly')
      .store.openCursor(range, 'prev')
    return cursor ? (cursor.value as StoredContentKey) : undefined
  }

  private async capRecord(
    spaceId: string,
    generation: number,
  ): Promise<StoredCapKeyPair | undefined> {
    assertValidGeneration(generation)
    const db = await this.db()
    return (await db.get(CAP_KEYPAIRS_STORE, [spaceId, generation])) as StoredCapKeyPair | undefined
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
