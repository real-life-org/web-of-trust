// app-db (architecture §3.1): the adapter's own encrypted IndexedDB `wot-v3-app-<ns>` beside the holder
// store. Object stores: `kv` (applied commit mark, app sequence, clock high mark, encounter cache,
// projection ledger), `intents` (the intent journal, §3.4), `log` (conversation lines the adapter owns:
// system lines, later messages). Every value is sealed under the DEK with AAD `<db>/<store>/<key>`.
// Writes go in one transaction per call; `readAll` reads every store in one read transaction, so a
// projection bundle sees the app part on one state (§3.1 "Projektion", N1). Sealable per generation.

import { done, openDb, req, StoreSealedError, type Seal } from './idb'
import type { SealedBlob, Sealer } from './sealed'

export const APP_STORES = ['kv', 'intents', 'log'] as const
export type AppStoreName = (typeof APP_STORES)[number]

export interface AppWrite {
  readonly store: AppStoreName
  readonly key: string
  /** null deletes */
  readonly value: unknown
}

export interface AppSnapshot {
  readonly kv: ReadonlyMap<string, unknown>
  readonly intents: ReadonlyMap<string, unknown>
  readonly log: ReadonlyMap<string, unknown>
}

export interface AppDb {
  readonly name: string
  readAll(): Promise<AppSnapshot>
  get<T>(store: AppStoreName, key: string): Promise<T | undefined>
  write(writes: readonly AppWrite[]): Promise<void>
  close(): void
}

export function idbAppDb(opts: { idb: IDBFactory; name: string; sealer: Sealer; seal: Seal }): AppDb {
  let db: Promise<IDBDatabase> | null = null
  /** closed for good: never reopens (and so never recreates) its database (review 420 R1-2) */
  let closed = false
  const guard = (write: boolean) => {
    if (closed || (write && opts.seal.sealed)) throw new StoreSealedError(opts.name)
  }
  const open = () => {
    guard(false)
    return (db ??= openDb(opts.idb, opts.name, APP_STORES))
  }
  const aad = (store: string, key: string) => `${opts.name}/${store}/${key}`
  return {
    name: opts.name,
    async readAll() {
      const d = await open()
      const tx = d.transaction([...APP_STORES], 'readonly')
      const raw = await Promise.all(
        APP_STORES.map(async (s) => {
          const os = tx.objectStore(s)
          const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())])
          return [s, keys as string[], values as SealedBlob[]] as const
        }),
      )
      const out = {} as Record<AppStoreName, Map<string, unknown>>
      for (const [s, keys, values] of raw) {
        const m = new Map<string, unknown>()
        for (let i = 0; i < keys.length; i++) m.set(keys[i] as string, await opts.sealer.open(aad(s, keys[i] as string), values[i] as SealedBlob))
        out[s] = m
      }
      return out
    },
    async get<T>(store: AppStoreName, key: string) {
      const d = await open()
      const blob = (await req(d.transaction(store, 'readonly').objectStore(store).get(key))) as SealedBlob | undefined
      return blob === undefined ? undefined : opts.sealer.open<T>(aad(store, key), blob)
    },
    async write(writes) {
      guard(true)
      const sealed = await Promise.all(writes.map(async (w) => ({ w, blob: w.value === null ? null : await opts.sealer.seal(aad(w.store, w.key), w.value) })))
      guard(true)
      const d = await open()
      guard(true)
      const stores = [...new Set(writes.map((w) => w.store))]
      if (stores.length === 0) return
      const tx = d.transaction(stores, 'readwrite')
      for (const { w, blob } of sealed) {
        const os = tx.objectStore(w.store)
        if (blob === null) os.delete(w.key)
        else os.put(blob, w.key)
      }
      await done(tx)
    },
    close() {
      closed = true
      void db?.then((d) => d.close()).catch(() => undefined)
      db = null
    },
  }
}
