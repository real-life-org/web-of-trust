// What the identity runtime needs from the adapter that owns the holder (architecture §3.1): open and
// initialize the holder of a namespace, and the shutdown phases of §2.1 rule 9. The real adapter
// implements it over the library (runtime.ts, gate.ts, store-idb.ts, app-db.ts; still to build), the
// simulation over its world. Keys arrive as bytes and stay in the host while the session lives.

import type { InitInputs } from './sealed-init'

export interface HolderKeys {
  readonly rootIkm: Uint8Array
  readonly dek: Uint8Array
}

export interface HolderHost {
  /** IndexedDB names the host keeps for ns (inventory layers 1 and 2: holder store, app db) */
  databaseNames(ns: string): readonly string[]
  /** namespace of a database name of this host, or null (orphan detection at boot) */
  namespaceOf(databaseName: string): string | null
  /** opens or creates holder store and app db of ns, new session generation, first bundle;
   *  'other-writer' when the single-writer lock is held elsewhere */
  open(ns: string, keys: HolderKeys): Promise<'ok' | 'other-writer'>
  /** setProfile and acceptTerms with the journaled actIds (idempotent per actId) */
  init(ns: string, inputs: InitInputs): Promise<void>
  acceptTerms(ns: string, version: string, actId: string): Promise<void>
  /** short form of the own anchor for display ("Details"), null before open */
  anchorShort(ns: string): string | null
  /** S1 + S2: new work blocked, pending holder calls drained (at most 2 s) */
  quiesce(): Promise<void>
  /** S3: deregistration per relationship while the keys exist; skip counts all as failed */
  deregister(mode: 'run' | 'skip'): Promise<{ done: number; failed: number }>
  /** S4: store, app db and transport of the generation sealed */
  seal(): Promise<void>
  /** S5: holder reference dropped, connections closed, caches emptied */
  close(): Promise<void>
  /** drop what the host keeps in memory for ns (the databases are removed by the runtime) */
  forget(ns: string): void
}
