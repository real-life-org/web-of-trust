/**
 * CompactStorageManager — Single-snapshot-per-doc IndexedDB store.
 *
 * Unlike automerge-repo's IndexedDBStorageAdapter (which accumulates chunks),
 * this store keeps exactly ONE Automerge.save() snapshot per docId.
 * Saves overwrite — no accumulation, no OOM.
 *
 * IDB: database name is configurable, object store 'snapshots'.
 */

export class CompactStorageManager {
  private dbName: string
  private db: IDBDatabase | null = null

  constructor(dbName: string = 'wot-compact-store') {
    this.dbName = dbName
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)

      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots')
        }
      }

      req.onsuccess = () => {
        this.db = req.result
        resolve()
      }

      req.onerror = () => {
        reject(req.error)
      }
    })
  }

  async save(docId: string, binary: Uint8Array): Promise<void> {
    const db = this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite')
      const store = tx.objectStore('snapshots')
      const req = store.put(binary, docId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  async load(docId: string): Promise<Uint8Array | null> {
    const db = this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly')
      const store = tx.objectStore('snapshots')
      const req = store.get(docId)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  }

  async delete(docId: string): Promise<void> {
    const db = this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite')
      const store = tx.objectStore('snapshots')
      const req = store.delete(docId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  async list(): Promise<string[]> {
    const db = this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly')
      const store = tx.objectStore('snapshots')
      const keys: string[] = []
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          keys.push(cursor.key as string)
          cursor.continue()
        } else {
          resolve(keys)
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

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error('CompactStorageManager not opened. Call open() first.')
    return this.db
  }
}
