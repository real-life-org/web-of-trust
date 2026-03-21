/**
 * LocalCacheStore — Simple IndexedDB key-value store for local-only cache data.
 *
 * Used for data that does NOT need multi-device sync:
 * - Graph cache (cached profiles of other users)
 * - Publish state (dirty flags for profile sync)
 *
 * Plain JSON — no Automerge, no CRDT overhead.
 * Separate from PersonalDoc so cache writes don't trigger vault pushes
 * or sync to other devices.
 */

type Listener = () => void

export class LocalCacheStore {
  private dbName: string
  private storeName: string
  private db: IDBDatabase | null = null
  private openPromise: Promise<void> | null = null
  private listeners = new Set<Listener>()

  constructor(dbName: string = 'wot-local-cache', storeName: string = 'cache') {
    this.dbName = dbName
    this.storeName = storeName
  }

  async open(): Promise<void> {
    if (this.db) return
    if (this.openPromise) return this.openPromise
    this.openPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName)
        }
      }
      req.onsuccess = () => {
        this.db = req.result
        resolve()
      }
      req.onerror = () => {
        this.openPromise = null
        reject(req.error)
      }
    })
    return this.openPromise
  }

  async get<T>(key: string): Promise<T | null> {
    const db = await this.ensureOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const req = store.get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  }

  async set<T>(key: string, value: T): Promise<void> {
    const db = await this.ensureOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const req = store.put(value, key)
      req.onsuccess = () => {
        this.notifyListeners()
        resolve()
      }
      req.onerror = () => reject(req.error)
    })
  }

  async delete(key: string): Promise<void> {
    const db = await this.ensureOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const req = store.delete(key)
      req.onsuccess = () => {
        this.notifyListeners()
        resolve()
      }
      req.onerror = () => reject(req.error)
    })
  }

  /** Get all entries whose key starts with the given prefix. */
  async getByPrefix<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const db = await this.ensureOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const req = store.openCursor()
      const results: Array<{ key: string; value: T }> = []
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const key = cursor.key as string
          if (key.startsWith(prefix)) {
            results.push({ key, value: cursor.value as T })
          }
          cursor.continue()
        } else {
          resolve(results)
        }
      }
      req.onerror = () => reject(req.error)
    })
  }

  /** Subscribe to any change. Returns unsubscribe function. */
  onChange(callback: Listener): () => void {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.listeners.clear()
  }

  /** Delete the entire database. */
  async destroy(): Promise<void> {
    this.close()
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(this.dbName)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  }

  private async ensureOpen(): Promise<IDBDatabase> {
    if (!this.db) await this.open()
    return this.db!
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* ignore */ }
    }
  }
}
