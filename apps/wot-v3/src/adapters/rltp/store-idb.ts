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
  const open = () => (db ??= openDb(opts.idb, opts.name, [OS]))
  return {
    async read(): Promise<StoreSnapshot> {
      const d = await open()
      const tx = d.transaction(OS, 'readonly')
      const row = (await req(tx.objectStore(OS).get(KEY))) as Row | undefined
      if (!row) return { state: null, version: null }
      return { state: await opts.sealer.open<unknown>(opts.name, row.blob), version: row.version }
    },
    async commit(version: string | null, next: HolderState): Promise<CommitResult> {
      if (opts.seal.sealed) throw new StoreSealedError(opts.name)
      // encryption is async and cannot run inside an IndexedDB transaction: seal first
      const blob = await opts.sealer.seal(opts.name, next)
      const d = await open()
      if (opts.seal.sealed) throw new StoreSealedError(opts.name)
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
      void db?.then((d) => d.close()).catch(() => undefined)
      db = null
    },
  }
}
