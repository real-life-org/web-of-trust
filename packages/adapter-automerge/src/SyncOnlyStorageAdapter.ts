/**
 * SyncOnlyStorageAdapter — automerge-repo StorageAdapter that only persists sync-state.
 *
 * Filters all keys: only those containing "sync-state" are saved to IndexedDB.
 * Doc data (snapshots, incrementals) is silently ignored.
 * This prevents the chunk accumulation that causes WASM OOM crashes.
 *
 * Uses its own IDB database with a 'sync-states' object store.
 * Keys are stored as their JSON-serialized string[] form.
 */

import type { StorageAdapterInterface } from '@automerge/automerge-repo'

type StorageKey = string[]
type Chunk = { key: StorageKey; data: Uint8Array | undefined }

export class SyncOnlyStorageAdapter implements StorageAdapterInterface {
  private dbName: string
  private db: IDBDatabase | null = null
  private readyPromise: Promise<void>

  constructor(dbName: string = 'wot-sync-states') {
    this.dbName = dbName
    this.readyPromise = this.open()
  }

  /** Wait until the IDB is open. */
  async ready(): Promise<void> {
    return this.readyPromise
  }

  private async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)

      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('sync-states')) {
          db.createObjectStore('sync-states')
        }
      }

      req.onsuccess = () => {
        this.db = req.result
        resolve()
      }

      req.onerror = () => reject(req.error)
    })
  }

  private isSyncState(key: StorageKey): boolean {
    return key.some(part => part === 'sync-state')
  }

  private keyToString(key: StorageKey): string {
    return JSON.stringify(key)
  }

  private stringToKey(s: string): StorageKey {
    return JSON.parse(s)
  }

  private keyMatchesPrefix(key: StorageKey, prefix: StorageKey): boolean {
    if (key.length < prefix.length) return false
    for (let i = 0; i < prefix.length; i++) {
      if (key[i] !== prefix[i]) return false
    }
    return true
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    if (!this.isSyncState(key)) return undefined
    await this.readyPromise
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync-states', 'readonly')
      const store = tx.objectStore('sync-states')
      const req = store.get(this.keyToString(key))
      req.onsuccess = () => resolve(req.result ?? undefined)
      req.onerror = () => reject(req.error)
    })
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    if (!this.isSyncState(key)) return
    await this.readyPromise
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync-states', 'readwrite')
      const store = tx.objectStore('sync-states')
      const req = store.put(data, this.keyToString(key))
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  async remove(key: StorageKey): Promise<void> {
    if (!this.isSyncState(key)) return
    await this.readyPromise
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync-states', 'readwrite')
      const store = tx.objectStore('sync-states')
      const req = store.delete(this.keyToString(key))
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    // If the prefix itself doesn't indicate sync-state, we still need to check
    // because loadRange([docId]) should return sync-states for that doc
    await this.readyPromise
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync-states', 'readonly')
      const store = tx.objectStore('sync-states')
      const chunks: Chunk[] = []
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const key = this.stringToKey(cursor.key as string)
          if (this.keyMatchesPrefix(key, keyPrefix)) {
            chunks.push({ key, data: cursor.value })
          }
          cursor.continue()
        } else {
          resolve(chunks)
        }
      }
      req.onerror = () => reject(req.error)
    })
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    // No filter needed — only sync-state keys exist in our store.
    // A prefix like [docId] will correctly match [docId, "sync-state", peerId].
    await this.readyPromise
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync-states', 'readwrite')
      const store = tx.objectStore('sync-states')
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const key = this.stringToKey(cursor.key as string)
          if (this.keyMatchesPrefix(key, keyPrefix)) {
            cursor.delete()
          }
          cursor.continue()
        } else {
          resolve()
        }
      }
      req.onerror = () => reject(req.error)
    })
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}
