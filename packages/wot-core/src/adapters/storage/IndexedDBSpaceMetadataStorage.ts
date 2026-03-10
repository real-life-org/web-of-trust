import { openDB, type IDBPDatabase } from 'idb'
import type {
  SpaceMetadataStorage,
  PersistedSpaceMetadata,
  PersistedGroupKey,
} from '../interfaces/SpaceMetadataStorage'

const DB_NAME = 'wot-space-metadata'
const DB_VERSION = 1
const SPACES_STORE = 'spaces'
const KEYS_STORE = 'groupKeys'

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

function groupKeyId(spaceId: string, generation: number): string {
  return `${spaceId}:${generation}`
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
    const keys = await db.getAllKeysFromIndex(KEYS_STORE, 'bySpaceId', spaceId)
    const tx = db.transaction(KEYS_STORE, 'readwrite')
    for (const key of keys) {
      await tx.store.delete(key)
    }
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
