// Small promise helpers over IndexedDB for the adapter's two databases (holder store, app-db).
// The factory is injected: the browser's indexedDB in the app, fake-indexeddb in tests.

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

/** Opens (and on first use creates) a database with the given object stores (out-of-line keys). */
export function openDb(idb: IDBFactory, name: string, stores: readonly string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(name, 1)
    r.onupgradeneeded = () => {
      for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error(`cannot open ${name}`))
    r.onblocked = () => reject(new Error(`opening ${name} is blocked`))
  })
}

/** A generation's seal (architecture §2.1 rule 9, S4): once set, no write of this generation starts. */
export interface Seal {
  sealed: boolean
}

export class StoreSealedError extends Error {
  constructor(what: string) {
    super(`${what}: store sealed`)
    this.name = 'StoreSealedError'
  }
}
