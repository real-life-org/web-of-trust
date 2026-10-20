// What the identity runtime needs from the adapter that owns the holder (architecture §3.1): open and
// initialize the holder of a namespace, and the shutdown phases of §2.1 rule 9. Every lifecycle call
// takes the handle of one opening, never a bare namespace: during a restore the old and the staged
// new holder exist side by side (review of #414, finding 3), and a late cleanup of an old opening of
// the same namespace must only close what it opened (review of #414 at 81c90012). The real adapter
// implements it over the library (runtime.ts, gate.ts, store-idb.ts, app-db.ts; still to build), the
// simulation over its world. Keys arrive as bytes and stay in the host while the session lives.

import type { InitInputs } from './sealed-init'

export interface HolderKeys {
  readonly rootIkm: Uint8Array
  readonly dek: Uint8Array
}

/** One opening of the holder of a namespace, returned by open. It is the only way to the lifecycle
 *  of that opening: whoever holds it closes it, and closing it never touches another opening of the
 *  same namespace (review of #414 at 81c90012). Calls with a closed handle do nothing. */
export interface HolderHandle {
  readonly ns: string
  readonly kind: 'holder-handle'
}

export interface HolderHost {
  /** IndexedDB names the host keeps for ns (inventory layers 1 and 2: holder store, app db) */
  databaseNames(ns: string): readonly string[]
  /** namespace of a database name of this host, or null (orphan detection at boot) */
  namespaceOf(databaseName: string): string | null
  /** opens or creates holder store and app db of ns, new session generation, first bundle; the
   *  handle owns this opening. 'other-writer' when the single-writer lock is held elsewhere */
  open(ns: string, keys: HolderKeys): Promise<{ readonly kind: 'ok'; readonly holder: HolderHandle } | { readonly kind: 'other-writer' }>
  /** setProfile and acceptTerms with the journaled actIds (idempotent per actId) */
  init(holder: HolderHandle, inputs: InitInputs): Promise<void>
  acceptTerms(holder: HolderHandle, version: string, actId: string): Promise<void>
  /** short form of the own anchor for display ("Details"), null before the first open */
  anchorShort(ns: string): string | null
  /** S1 + S2 for this opening: new work blocked, pending holder calls drained (at most 2 s) */
  quiesce(holder: HolderHandle): Promise<void>
  /** S3: deregistration per relationship while the keys exist; skip counts all as failed */
  deregister(holder: HolderHandle, mode: 'run' | 'skip'): Promise<{ done: number; failed: number }>
  /** S4: store, app db and transport of this opening sealed */
  seal(holder: HolderHandle): Promise<void>
  /** S5: this opening dropped, connections closed, caches emptied */
  close(holder: HolderHandle): Promise<void>
  /** drop what the host keeps in memory for ns (the databases are removed by the runtime) */
  forget(ns: string): void
  /** the restore switched to this opening (rec.switch): it becomes the identity in use. Until then a
   *  staged opening beside the current one stays in the background (review 420 R2-2) */
  activate?(holder: HolderHandle): void
  /** the delete of ns was verified clean (after S6): the host may let go of what it held for the
   *  delete, the single-writer lock included (architecture §2.1 rule 9) */
  wiped?(ns: string): void
}
