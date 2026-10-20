// The library's Store port over IndexedDB (architecture §3.1 "Speicher"): the holder state as an
// opaque JSON value, sealed under the DEK (AAD = database name), compare-and-swap on a version token
// that is a fresh UUID per commit (never reused, no ABA). One writer per holder is the adapter's job
// (identity runtime + Web Lock). Sealable per generation: after seal() no commit starts.

import type { CommitResult, HolderState, Store, StoreSnapshot } from '@real-life/trust-protocol'
import { done, openDb, req, StoreSealedError, type Seal } from './idb'
import type { SealedBlob, Sealer } from './sealed'

const OS = 'holder'
const KEY = 'state'

interface Row {
  readonly version: string
  readonly blob: SealedBlob
}

export interface HolderStore extends Store {
  close(): void
}

export function idbHolderStore(opts: { idb: IDBFactory; name: string; sealer: Sealer; uuid: () => string; seal: Seal }): HolderStore {
  let db: Promise<IDBDatabase> | null = null
  /** closed for good: a closed store never opens its database again (a late writer must not recreate
   *  a database the wipe removed, review 420 R1-2) */
  let closed = false
  const guard = (write: boolean) => {
    if (closed || (write && opts.seal.sealed)) throw new StoreSealedError(opts.name)
  }
  const open = () => {
    guard(false)
    return (db ??= openDb(opts.idb, opts.name, [OS]))
  }
  return {
    async read(): Promise<StoreSnapshot> {
      const d = await open()
      const tx = d.transaction(OS, 'readonly')
      const row = (await req(tx.objectStore(OS).get(KEY))) as Row | undefined
      if (!row) return { state: null, version: null }
      return { state: await opts.sealer.open<unknown>(opts.name, row.blob), version: row.version }
    },
    async commit(version: string | null, next: HolderState): Promise<CommitResult> {
      guard(true)
      // encryption is async and cannot run inside an IndexedDB transaction: seal first, then check
      // the seal again before the database is touched
      const blob = await opts.sealer.seal(opts.name, next)
      guard(true)
      const d = await open()
      guard(true)
      const tx = d.transaction(OS, 'readwrite')
      const os = tx.objectStore(OS)
      const current = (await req(os.get(KEY))) as Row | undefined
      if ((current?.version ?? null) !== version) {
        tx.abort()
        await done(tx).catch(() => undefined)
        return { ok: false, reason: 'conflict' }
      }
      const fresh = opts.uuid()
      os.put({ version: fresh, blob } satisfies Row, KEY)
      await done(tx)
      return { ok: true, version: fresh }
    },
    close() {
      closed = true
      void db?.then((d) => d.close()).catch(() => undefined)
      db = null
    },
  }
}
