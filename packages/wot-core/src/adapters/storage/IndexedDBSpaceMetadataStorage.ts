import { openDB, type IDBPDatabase } from 'idb'
import {
  groupKeyId,
  type SpaceMetadataStorage,
  type PersistedSpaceMetadata,
  type PersistedGroupKey,
  type PersistedCapabilitySigningSeed,
} from '../../ports/SpaceMetadataStorage'

const DB_NAME = 'wot-space-metadata'
// v2 (#234): adds the SEEDS_STORE for capability signing seeds.
const DB_VERSION = 2
const SPACES_STORE = 'spaces'
const KEYS_STORE = 'groupKeys'
const SEEDS_STORE = 'capabilitySigningSeeds'

interface StoredSpaceMetadata {
  info: PersistedSpaceMetadata['info']
  documentId: string
  documentUrl: string
  /** memberEncryptionKeys stored as Record<did, number[]> for IndexedDB compatibility */
  memberEncryptionKeys: Record<string, number[]>
}

interface StoredGroupKey {
  /** Composite key: spaceId + generation */
  id: string
  spaceId: string
  generation: number
  key: number[]
}

interface StoredCapabilitySigningSeed {
  /** Composite key: spaceId + generation */
  id: string
  spaceId: string
  generation: number
  seed: number[]
}


export class IndexedDBSpaceMetadataStorage implements SpaceMetadataStorage {
  private dbPromise: Promise<IDBPDatabase>

  constructor(dbName: string = DB_NAME) {
    this.dbPromise = openDB(dbName, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(SPACES_STORE)) {
          db.createObjectStore(SPACES_STORE, { keyPath: 'info.id' })
        }
        if (!db.objectStoreNames.contains(KEYS_STORE)) {
          const store = db.createObjectStore(KEYS_STORE, { keyPath: 'id' })
          store.createIndex('bySpaceId', 'spaceId')
        }
        // v2 (#234): capability signing seeds — separate store, own bySpaceId index.
        if (!db.objectStoreNames.contains(SEEDS_STORE)) {
          const store = db.createObjectStore(SEEDS_STORE, { keyPath: 'id' })
          store.createIndex('bySpaceId', 'spaceId')
        }
      },
    })
  }

  async saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void> {
    const db = await this.dbPromise
    const stored: StoredSpaceMetadata = {
      info: meta.info,
      documentId: meta.documentId,
      documentUrl: meta.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(meta.memberEncryptionKeys).map(
          ([did, key]) => [did, Array.from(key)]
        )
      ),
    }
    await db.put(SPACES_STORE, stored)
  }

  async loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null> {
    const db = await this.dbPromise
    const stored: StoredSpaceMetadata | undefined = await db.get(SPACES_STORE, spaceId)
    if (!stored) return null
    return this.deserialize(stored)
  }

  async loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]> {
    const db = await this.dbPromise
    const all: StoredSpaceMetadata[] = await db.getAll(SPACES_STORE)
    return all.map(s => this.deserialize(s))
  }

  async deleteSpaceMetadata(spaceId: string): Promise<void> {
    const db = await this.dbPromise
    await db.delete(SPACES_STORE, spaceId)
  }

  async saveGroupKey(key: PersistedGroupKey): Promise<void> {
    const db = await this.dbPromise
    const stored: StoredGroupKey = {
      id: groupKeyId(key.spaceId, key.generation),
      spaceId: key.spaceId,
      generation: key.generation,
      key: Array.from(key.key),
    }
    await db.put(KEYS_STORE, stored)
  }

  async loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]> {
    const db = await this.dbPromise
    const all: StoredGroupKey[] = await db.getAllFromIndex(KEYS_STORE, 'bySpaceId', spaceId)
    return all.map(k => ({
      spaceId: k.spaceId,
      generation: k.generation,
      key: new Uint8Array(k.key),
    }))
  }

  async deleteGroupKeys(spaceId: string): Promise<void> {
    const db = await this.dbPromise
    // #234: seeds die with the space — delete groupKeys AND signing seeds atomically.
    const keyIds = await db.getAllKeysFromIndex(KEYS_STORE, 'bySpaceId', spaceId)
    const seedIds = await db.getAllKeysFromIndex(SEEDS_STORE, 'bySpaceId', spaceId)
    const tx = db.transaction([KEYS_STORE, SEEDS_STORE], 'readwrite')
    for (const key of keyIds) await tx.objectStore(KEYS_STORE).delete(key)
    for (const key of seedIds) await tx.objectStore(SEEDS_STORE).delete(key)
    await tx.done
  }

  async saveCapabilitySigningSeed(seed: PersistedCapabilitySigningSeed): Promise<void> {
    const db = await this.dbPromise
    const id = groupKeyId(seed.spaceId, seed.generation)
    // set-if-absent (grow-only): never overwrite an existing seed.
    const tx = db.transaction(SEEDS_STORE, 'readwrite')
    const existing = await tx.store.get(id)
    if (!existing) {
      const stored: StoredCapabilitySigningSeed = {
        id,
        spaceId: seed.spaceId,
        generation: seed.generation,
        seed: Array.from(seed.seed),
      }
      await tx.store.put(stored)
    }
    await tx.done
  }

  async loadCapabilitySigningSeeds(spaceId: string): Promise<PersistedCapabilitySigningSeed[]> {
    const db = await this.dbPromise
    const all: StoredCapabilitySigningSeed[] = await db.getAllFromIndex(SEEDS_STORE, 'bySpaceId', spaceId)
    return all.map(s => ({
      spaceId: s.spaceId,
      generation: s.generation,
      seed: new Uint8Array(s.seed),
    }))
  }

  async clearAll(): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([SPACES_STORE, KEYS_STORE, SEEDS_STORE], 'readwrite')
    await tx.objectStore(SPACES_STORE).clear()
    await tx.objectStore(KEYS_STORE).clear()
    await tx.objectStore(SEEDS_STORE).clear()
    await tx.done
  }

  private deserialize(stored: StoredSpaceMetadata): PersistedSpaceMetadata {
    return {
      info: stored.info,
      documentId: stored.documentId,
      documentUrl: stored.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(stored.memberEncryptionKeys).map(
          ([did, arr]) => [did, new Uint8Array(arr)]
        )
      ),
    }
  }
}
