// IndexedDB backend of the seed vault (`wot-v3-vault`, architecture §5.2). One connection per
// database, kept in a registry so a full delete can close every open connection first (an open
// connection blocks deleteDatabase; legacy `closeOpenIdentitySeedVaultConnections`).

import type { VaultBackend, VaultStore, VaultTx } from './vault'

export const VAULT_DB_NAME = 'wot-v3-vault'
const DB_VERSION = 1

// keyed by factory and name, so tests with separate fake factories do not share connections
const registry = new Map<IDBFactory, Map<string, Promise<IDBDatabase>>>()

function connectionsOf(factory: IDBFactory): Map<string, Promise<IDBDatabase>> {
  let m = registry.get(factory)
  if (!m) {
    m = new Map()
    registry.set(factory, m)
  }
  return m
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

function connect(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const connections = connectionsOf(factory)
  let db = connections.get(name)
  if (!db) {
    db = new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(name, DB_VERSION)
      r.onupgradeneeded = () => {
        const d = r.result
        if (!d.objectStoreNames.contains('vaults')) d.createObjectStore('vaults')
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta')
      }
      r.onsuccess = () => {
        const d = r.result
        // another context deletes or upgrades the database: let go so it is not blocked
        d.onversionchange = () => {
          d.close()
          connections.delete(name)
        }
        // the browser closed it (site data cleared, storage pressure): the next call reopens
        d.onclose = () => {
          connections.delete(name)
        }
        resolve(d)
      }
      r.onerror = () => {
        connections.delete(name)
        reject(r.error ?? new Error('IndexedDB open failed'))
      }
      r.onblocked = () => {
        connections.delete(name)
        reject(new Error('IndexedDB open blocked'))
      }
    })
    connections.set(name, db)
  }
  return db
}

/** Closes every vault connection this context holds (delete phase S5, architecture §4.2). */
export async function closeVaultConnections(): Promise<void> {
  const open = [...registry.values()].flatMap((m) => [...m.values()])
  registry.clear()
  for (const p of open) {
    try {
      ;(await p).close()
    } catch {
      // a failed open has nothing to close
    }
  }
}

function txOf(t: IDBTransaction): VaultTx {
  return {
    get: (store, key) => request(t.objectStore(store).get(key)),
    keys: async (store) => (await request(t.objectStore(store).getAllKeys())).map(String),
    put: (store, key, value) => void t.objectStore(store).put(value, key),
    delete: (store, key) => void t.objectStore(store).delete(key),
  }
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (tx: VaultTx) => Promise<T>): Promise<T> {
  const stores: VaultStore[] = ['vaults', 'meta']
  const t = db.transaction(stores, mode)
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'))
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'))
  })
  const result = fn(txOf(t)).then(
    (v) => v,
    (e: unknown) => {
      try {
        t.abort()
      } catch {
        // already finished
      }
      throw e
    },
  )
  // resolves after the commit (oncomplete), so the caller knows the write is durable
  return Promise.all([result, done]).then(([v]) => v)
}

export function idbVaultBackend(factory: IDBFactory = indexedDB, name = VAULT_DB_NAME): VaultBackend {
  return {
    read: async (fn) => run(await connect(factory, name), 'readonly', fn),
    write: async (fn) => run(await connect(factory, name), 'readwrite', fn),
  }
}
