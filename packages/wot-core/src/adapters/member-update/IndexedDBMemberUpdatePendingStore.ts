import { openDB, type IDBPDatabase } from 'idb'
import type { MemberUpdatePendingStore } from '../../ports/MemberUpdatePendingStore'
import type {
  MemberUpdateSignal,
  SeenMemberUpdateSignal,
} from '../../protocol/sync/member-update-disposition'

const DB_NAME = 'wot-member-update-pending'
const DB_VERSION = 1
const SEEN_STORE = 'seen'
const FUTURE_STORE = 'future'

/**
 * Durable IndexedDB {@link MemberUpdatePendingStore} (Durable Wiring / D1) so
 * pending + future-buffered member-update signals survive a reload. Mirrors
 * {@link InMemoryMemberUpdatePendingStore} semantics exactly.
 *
 * Signals carry NO raw key material (spaceId/action/memberDid/generation/signerDid
 * + a storedDisposition string), so JSON-safe persistence suffices — no base64
 * round-trip.
 *
 * - `seen`: composite key [spaceId, action, memberDid, effectiveKeyGeneration] —
 *   exactly ONE pending record per tuple (Sync 005 Z.179); a higher-authority
 *   signal UPGRADES the disposition in place, never adds a second row.
 * - `future`: composite key [spaceId, action, memberDid, effectiveKeyGeneration,
 *   signerDid] — multiple rows per tuple (one per distinct signer), as the future
 *   buffer dedups on tuple+signer.
 *
 * The DB name is constructor-injected so the composition root can make it DID-aware.
 */
export class IndexedDBMemberUpdatePendingStore implements MemberUpdatePendingStore {
  private dbPromise: Promise<IDBPDatabase> | null = null
  private readonly dbName: string

  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName
  }

  async init(): Promise<void> {
    await this.db()
  }

  async savePending(signal: SeenMemberUpdateSignal): Promise<void> {
    const db = await this.db()
    // Exactly one pending record per tuple: read-then-insert in ONE txn so a
    // concurrent save cannot create a duplicate, and an existing record (possibly
    // a DIFFERENT signer) is PRESERVED — never overwritten (signer provenance).
    const tx = db.transaction(SEEN_STORE, 'readwrite')
    const existing = await tx.store.get(seenKey(signal))
    if (existing === undefined) await tx.store.put(toSeenRecord(signal))
    await tx.done
  }

  async upgradePending(signal: SeenMemberUpdateSignal): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(SEEN_STORE, 'readwrite')
    const existing = (await tx.store.get(seenKey(signal))) as SeenMemberUpdateSignal | undefined
    if (existing !== undefined) {
      // Upgrade ONLY the disposition; preserve the original signer provenance.
      await tx.store.put({ ...existing, storedDisposition: signal.storedDisposition })
    }
    await tx.done
  }

  async bufferFuture(signal: MemberUpdateSignal): Promise<void> {
    const db = await this.db()
    // Dedup on tuple + signerDid (the composite key) — idempotent re-buffer.
    const tx = db.transaction(FUTURE_STORE, 'readwrite')
    const existing = await tx.store.get(futureKey(signal))
    if (existing === undefined) await tx.store.put(toFutureRecord(signal))
    await tx.done
  }

  async listSeenForSpace(spaceId: string): Promise<readonly SeenMemberUpdateSignal[]> {
    const db = await this.db()
    const records = (await db.getAll(SEEN_STORE, spaceRange(spaceId))) as SeenMemberUpdateSignal[]
    // Defensive copies (parity with InMemoryMemberUpdatePendingStore) so a caller
    // mutating a returned record/array cannot affect a later read.
    return records.map(toSeenRecord)
  }

  async listFutureForSpace(spaceId: string): Promise<readonly MemberUpdateSignal[]> {
    const db = await this.db()
    const records = (await db.getAll(FUTURE_STORE, spaceRange(spaceId))) as MemberUpdateSignal[]
    return records.map(toFutureRecord)
  }

  async resolvePending(spaceId: string, signal: MemberUpdateSignal): Promise<void> {
    const db = await this.db()
    // The tuple is unique in `seen`, so a single keyed delete removes it.
    await db.delete(SEEN_STORE, seenKey({ ...signal, spaceId }))
  }

  async resolveFuture(spaceId: string, signal: MemberUpdateSignal): Promise<void> {
    const db = await this.db()
    // resolveFuture drops EVERY future row matching the tuple, regardless of signer
    // (mirrors the in-memory filter on sameTuple). Range over the tuple prefix.
    const tx = db.transaction(FUTURE_STORE, 'readwrite')
    let cursor = await tx.store.openCursor(tupleRange({ ...signal, spaceId }))
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
    await tx.done
  }

  /** Drop ALL pending + future state — test/reset helper; the production wipe deleteDatabase's the DB. */
  async clear(): Promise<void> {
    const db = await this.db()
    const tx = db.transaction([SEEN_STORE, FUTURE_STORE], 'readwrite')
    await Promise.all([
      tx.objectStore(SEEN_STORE).clear(),
      tx.objectStore(FUTURE_STORE).clear(),
      tx.done,
    ])
  }

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(this.dbName, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(SEEN_STORE)) {
            db.createObjectStore(SEEN_STORE, {
              keyPath: ['spaceId', 'action', 'memberDid', 'effectiveKeyGeneration'],
            })
          }
          if (!db.objectStoreNames.contains(FUTURE_STORE)) {
            db.createObjectStore(FUTURE_STORE, {
              keyPath: ['spaceId', 'action', 'memberDid', 'effectiveKeyGeneration', 'signerDid'],
            })
          }
        },
      })
    }
    return this.dbPromise
  }
}

/** A SeenMemberUpdateSignal stored verbatim (the keyPath fields live at top level). */
function toSeenRecord(signal: SeenMemberUpdateSignal): SeenMemberUpdateSignal {
  return {
    spaceId: signal.spaceId,
    action: signal.action,
    memberDid: signal.memberDid,
    effectiveKeyGeneration: signal.effectiveKeyGeneration,
    signerDid: signal.signerDid,
    storedDisposition: signal.storedDisposition,
  }
}

function toFutureRecord(signal: MemberUpdateSignal): MemberUpdateSignal {
  return {
    spaceId: signal.spaceId,
    action: signal.action,
    memberDid: signal.memberDid,
    effectiveKeyGeneration: signal.effectiveKeyGeneration,
    signerDid: signal.signerDid,
  }
}

function seenKey(s: MemberUpdateSignal): [string, string, string, number] {
  return [s.spaceId, s.action, s.memberDid, s.effectiveKeyGeneration]
}

function futureKey(s: MemberUpdateSignal): [string, string, string, number, string] {
  return [s.spaceId, s.action, s.memberDid, s.effectiveKeyGeneration, s.signerDid]
}

/** Range over every record for a spaceId (the empty array sorts above any real field). */
function spaceRange(spaceId: string): IDBKeyRange {
  return IDBKeyRange.bound([spaceId], [spaceId, []])
}

/** Range over every `future` record matching a tuple, across all signers. */
function tupleRange(s: MemberUpdateSignal): IDBKeyRange {
  return IDBKeyRange.bound(
    [s.spaceId, s.action, s.memberDid, s.effectiveKeyGeneration],
    [s.spaceId, s.action, s.memberDid, s.effectiveKeyGeneration, []],
  )
}
