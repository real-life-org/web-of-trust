import { openDB, type IDBPDatabase } from 'idb'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type {
  AppendLocalEntryParams,
  DocLogStore,
  LocalLogEntry,
  PendingRemoval,
  RecordRemoteAppliedEntry,
  StagedRemovalKeyMaterial,
} from '../../ports/DocLogStore'
import { pendingRemovalKey } from './pending-removal-key'
import { createSeqLock, type SeqLock } from './SeqLock'

const DB_NAME = 'wot-doc-log'
// v2: adds the `meta` key-value store that binds the deviceId to the log-store
//     lifecycle (BLOCKER-1b) so a wipe that empties the log also drops the deviceId.
// v3: adds the `pendingRemovals` store — the durable, crash-safe staging area
//     for two-phase member removals (Slice SR / VE-S0). The v2→v3 migration
//     keeps the existing entries + meta stores intact (additive only).
const DB_VERSION = 3
const ENTRIES_STORE = 'entries'
const PENDING_INDEX = 'byStatus'
const META_STORE = 'meta'
const DEVICE_ID_KEY = 'deviceId'
const PENDING_REMOVALS_STORE = 'pendingRemovals'
/** Bounded retry budget for the add-on-duplicate seq-reservation race (BLOCKER-1a). */
const MAX_SEQ_RETRIES = 64

/**
 * Durable IndexedDB {@link DocLogStore}.
 *
 * Schema: one object store `entries`, composite keyPath [docId, deviceId, seq]
 * (so a key range over [docId, deviceId, -∞..+∞] addresses exactly one device's
 * log within one doc), plus a `byStatus` index for cheap pending scans.
 *
 * ── Why the lock, not the IDB transaction, is the atomicity boundary ─────────
 *
 * appendLocalEntry must do: read max seq → build(seq) (async crypto) → persist.
 * An IDB transaction CANNOT span that, because it auto-closes on the first
 * microtask turn where it has no pending request — i.e. the moment we `await`
 * build(). So we use TWO short transactions (read, then write) and rely on the
 * injected {@link SeqLock} to serialize the whole section across tabs. With Web
 * Locks that serialization is origin-wide; the seq=k duplicate that would reuse
 * the deterministic AES-GCM nonce (SHA-256(deviceId | seq)[0:12]) can never
 * happen. (See DocLogStore for the full invariant statement.)
 *
 * ── Crash-scenario analysis (mirrors the port docs; proven by the tests) ─────
 *
 *  (a) Crash between readMaxSeq and persist (e.g. build() throws, or the tab
 *      dies mid-crypto): NOTHING is written, so seq is NOT consumed and nothing
 *      was sent. A fresh store re-reads the same maxSeq; reusing that seq with
 *      NEW plaintext is safe because no JWS for it ever hit the wire.
 *  (b) Crash after persist, before send: the entry is durably 'pending'. On
 *      reconnect, getPending() yields it and the retry sends the STORED JWS
 *      bit-for-bit (the broker dedups via contentHash). It is NEVER rebuilt, so
 *      the (key, nonce) pair is never reused with different bytes.
 */
export class IndexedDBDocLogStore implements DocLogStore {
  private dbPromise: Promise<IDBPDatabase> | null = null
  private readonly dbName: string
  private readonly lock: SeqLock

  /**
   * @param dbName  IndexedDB database name. Tests pass a unique name per case to
   *                isolate state — and reuse the SAME name across two instances
   *                to simulate a crash + restart on one durable DB.
   * @param lock    Seq-reservation lock. Defaults to {@link createSeqLock}
   *                (Web Locks when available, in-process otherwise).
   */
  constructor(dbName: string = DB_NAME, lock: SeqLock = createSeqLock()) {
    this.dbName = dbName
    this.lock = lock
  }

  async init(): Promise<void> {
    await this.db()
  }

  async appendLocalEntry(params: AppendLocalEntryParams): Promise<LocalLogEntry> {
    const { deviceId, docId, build } = params
    return this.lock.run(`doclog:${deviceId}:${docId}`, async () => {
      // BLOCKER-1a: the SeqLock is only an OPTIMIZATION here. The durable
      // backstop is the composite-key UNIQUE constraint enforced by db.add():
      // when Web Locks is unavailable the lock degrades to in-process and two
      // tabs could both read maxSeq=k and build seq=k+1 — but only ONE add() for
      // [docId,deviceId,k+1] succeeds; the loser hits a ConstraintError and
      // retries the whole read→build→add cycle with the next seq. The discarded
      // build is NEVER sent (persist-before-send), so no divergent (key,nonce)
      // pair ever reaches the wire.
      for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
        // ── short IDB txn 1: read the durable max seq for (docId, deviceId) ──
        const maxSeq = await this.readMaxSeq(docId, deviceId)
        const seq = maxSeq + 1

        // ── async crypto: NOT inside any IDB txn (it would have closed) ──
        // Build the encrypted+signed entry JWS for the reserved seq. If this
        // rejects, we fall straight out of the lock without persisting — the seq
        // stays free (crash case (a)).
        const entryJws = await build(seq)

        const entry: LocalLogEntry = {
          docId,
          deviceId,
          seq,
          entryJws,
          status: 'pending',
          createdAt: Date.now(),
        }
        // ── short IDB txn 2: durable INSERT (add, not put) BEFORE returning ──
        // add() throws ConstraintError if [docId,deviceId,seq] already exists —
        // the key-constraint backstop. On conflict, retry with the next seq.
        const db = await this.db()
        try {
          await db.add(ENTRIES_STORE, toStored(entry))
        } catch (err) {
          if (isConstraintError(err)) continue
          throw err
        }
        return { ...entry }
      }
      throw new Error(
        `appendLocalEntry: seq reservation kept colliding for (${docId}, ${deviceId}) after ${MAX_SEQ_RETRIES} attempts`,
      )
    })
  }

  async getOrCreateDeviceId(): Promise<string> {
    const db = await this.db()
    // Atomic mint-or-read in ONE readwrite txn so two concurrent first-callers in
    // the same context cannot both mint (the second reads the first's value).
    const tx = db.transaction(META_STORE, 'readwrite')
    const existing = (await tx.store.get(DEVICE_ID_KEY)) as string | undefined
    if (typeof existing === 'string' && existing.length > 0) {
      await tx.done
      return existing
    }
    const minted = mintDeviceId()
    await tx.store.put(minted, DEVICE_ID_KEY)
    await tx.done
    return minted
  }

  async setDeviceId(deviceId: string): Promise<void> {
    const db = await this.db()
    await db.put(META_STORE, deviceId, DEVICE_ID_KEY)
  }

  async recordRemoteApplied(entry: RecordRemoteAppliedEntry): Promise<void> {
    const { docId, deviceId, seq } = entry
    const db = await this.db()
    const tx = db.transaction(ENTRIES_STORE, 'readwrite')
    const existing = (await tx.store.get([docId, deviceId, seq])) as StoredLogEntry | undefined
    // Idempotent: never clobber an already-stored entry (especially never
    // overwrite a local 'pending'/'acked' JWS with empty remote bookkeeping).
    if (!existing) {
      await tx.store.put(
        toStored({
          docId,
          deviceId,
          seq,
          entryJws: entry.entryJws ?? '',
          status: 'acked',
          createdAt: Date.now(),
        }),
      )
    }
    await tx.done
  }

  async getKnownHeads(docId: string): Promise<Record<string, number>> {
    const db = await this.db()
    // Range over every (deviceId, seq) within this doc.
    const range = IDBKeyRange.bound([docId], [docId, [], []])
    const heads: Record<string, number> = {}
    let cursor = await db.transaction(ENTRIES_STORE, 'readonly').store.openCursor(range)
    while (cursor) {
      const stored = cursor.value as StoredLogEntry
      const current = heads[stored.deviceId]
      if (current === undefined || stored.seq > current) heads[stored.deviceId] = stored.seq
      cursor = await cursor.continue()
    }
    return heads
  }

  async getEntry(docId: string, deviceId: string, seq: number): Promise<LocalLogEntry | null> {
    const db = await this.db()
    const stored = (await db.get(ENTRIES_STORE, [docId, deviceId, seq])) as
      | StoredLogEntry
      | undefined
    return stored ? fromStored(stored) : null
  }

  async getPending(): Promise<LocalLogEntry[]> {
    const db = await this.db()
    const stored = (await db.getAllFromIndex(
      ENTRIES_STORE,
      PENDING_INDEX,
      'pending',
    )) as StoredLogEntry[]
    return stored.map(fromStored).sort(comparePending)
  }

  async markAcked(docId: string, deviceId: string, seq: number): Promise<void> {
    const db = await this.db()
    const tx = db.transaction(ENTRIES_STORE, 'readwrite')
    const stored = (await tx.store.get([docId, deviceId, seq])) as StoredLogEntry | undefined
    if (stored && stored.status !== 'acked') {
      await tx.store.put({ ...stored, status: 'acked' })
    }
    await tx.done
  }

  // ── Pending member-removal staging (Slice SR / VE-S0) ──────────────────────
  //
  // Durable, crash-safe staging for two-phase member removals. Stored in a
  // dedicated `pendingRemovals` object store under the composite string key
  // pendingRemovalKey(spaceId, removedDid). The Uint8Array key material is
  // base64url-encoded at rest (toStoredRemoval) and decoded on read
  // (fromStoredRemoval), so a crash + restart recovers byte-identical material.

  async putPendingRemoval(removal: PendingRemoval): Promise<void> {
    const db = await this.db()
    // Idempotent on (spaceId, removedDid): put() OVERWRITES any prior record for
    // the same removal wholesale — the retry / re-stage path.
    await db.put(
      PENDING_REMOVALS_STORE,
      toStoredRemoval(removal),
      pendingRemovalKey(removal.spaceId, removal.removedDid),
    )
  }

  async getPendingRemoval(spaceId: string, removedDid: string): Promise<PendingRemoval | null> {
    const db = await this.db()
    const stored = (await db.get(
      PENDING_REMOVALS_STORE,
      pendingRemovalKey(spaceId, removedDid),
    )) as StoredPendingRemoval | undefined
    return stored ? fromStoredRemoval(stored) : null
  }

  async markBrokerConfirmed(
    spaceId: string,
    removedDid: string,
    brokerUrl: string,
  ): Promise<void> {
    const db = await this.db()
    // One readwrite txn: read-modify-write so a confirmation is atomic against
    // the durable record. No-op if the record is gone, the URL is not part of the
    // (fixed) home-broker set, or it is already present. confirmedBrokerUrls thus
    // stays a subset of homeBrokerSet and grows monotonically — a stray confirm
    // for a non-home broker can never spoof enforcement completion.
    const tx = db.transaction(PENDING_REMOVALS_STORE, 'readwrite')
    const key = pendingRemovalKey(spaceId, removedDid)
    const stored = (await tx.store.get(key)) as StoredPendingRemoval | undefined
    if (
      stored &&
      stored.homeBrokerSet.includes(brokerUrl) &&
      !stored.confirmedBrokerUrls.includes(brokerUrl)
    ) {
      await tx.store.put(
        { ...stored, confirmedBrokerUrls: [...stored.confirmedBrokerUrls, brokerUrl] },
        key,
      )
    }
    await tx.done
  }

  async deletePendingRemoval(spaceId: string, removedDid: string): Promise<void> {
    const db = await this.db()
    // Selective db.delete (NOT a clear): only this (spaceId, removedDid) record;
    // other removals, the log, and the deviceId binding are untouched.
    await db.delete(PENDING_REMOVALS_STORE, pendingRemovalKey(spaceId, removedDid))
  }

  async listPendingRemovals(): Promise<PendingRemoval[]> {
    const db = await this.db()
    const stored = (await db.getAll(PENDING_REMOVALS_STORE)) as StoredPendingRemoval[]
    return stored.map(fromStoredRemoval)
  }

  async clear(): Promise<void> {
    const db = await this.db()
    await db.clear(ENTRIES_STORE)
    // BLOCKER-1b: a wipe that empties the log MUST also drop the deviceId so the
    // next getOrCreateDeviceId() mints a FRESH nonce namespace (no seq=0 reuse).
    await db.clear(META_STORE)
    // VE-S0: a wipe drops staged removals too — same store lifecycle.
    await db.clear(PENDING_REMOVALS_STORE)
  }

  /**
   * Durable max seq for one (docId, deviceId) log, or -1 if none. Opens a
   * reverse cursor on the [docId, deviceId, -∞..+∞] key range and reads the
   * first (highest) key — O(log n), no full scan. Short read-only txn.
   */
  private async readMaxSeq(docId: string, deviceId: string): Promise<number> {
    const db = await this.db()
    const range = IDBKeyRange.bound([docId, deviceId], [docId, deviceId, []])
    const cursor = await db
      .transaction(ENTRIES_STORE, 'readonly')
      .store.openCursor(range, 'prev')
    if (!cursor) return -1
    const key = cursor.key as [string, string, number]
    return key[2]
  }

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(this.dbName, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
            const store = db.createObjectStore(ENTRIES_STORE, {
              keyPath: ['docId', 'deviceId', 'seq'],
            })
            store.createIndex(PENDING_INDEX, 'status')
          }
          // v2 (BLOCKER-1b): key-value store binding the deviceId to this DB's
          // lifecycle. Created on a fresh DB AND on a v1→v2 migration (an existing
          // log keeps its entries; the deviceId is minted lazily on first use).
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE)
          }
          // v3 (Slice SR / VE-S0): key-value store for two-phase member-removal
          // staging, keyed by pendingRemovalKey(spaceId, removedDid). Created on a
          // fresh DB AND on a v2→v3 migration — the guard makes the whole upgrade
          // hook additive, so an existing DB keeps its entries + meta (deviceId)
          // and only GAINS this store (no data loss).
          if (!db.objectStoreNames.contains(PENDING_REMOVALS_STORE)) {
            db.createObjectStore(PENDING_REMOVALS_STORE)
          }
        },
      })
    }
    return this.dbPromise
  }
}

/**
 * Stored shape. keyPath fields (docId, deviceId, seq) live at the top level so
 * IndexedDB can index them; the entry is otherwise stored verbatim.
 */
interface StoredLogEntry {
  docId: string
  deviceId: string
  seq: number
  entryJws: string
  status: 'pending' | 'acked'
  createdAt: number
}

function toStored(entry: LocalLogEntry): StoredLogEntry {
  return {
    docId: entry.docId,
    deviceId: entry.deviceId,
    seq: entry.seq,
    entryJws: entry.entryJws,
    status: entry.status,
    createdAt: entry.createdAt,
  }
}

function fromStored(stored: StoredLogEntry): LocalLogEntry {
  return {
    docId: stored.docId,
    deviceId: stored.deviceId,
    seq: stored.seq,
    entryJws: stored.entryJws,
    status: stored.status,
    createdAt: stored.createdAt,
  }
}

/**
 * Persisted shape of a {@link PendingRemoval} (Slice SR / VE-S0). The Uint8Array
 * key material is stored as base64url strings (the established Uint8Array↔at-rest
 * convention in this package), and the broker lists as plain string[]. Keyed
 * out-of-line by pendingRemovalKey(spaceId, removedDid).
 */
interface StoredPendingRemoval {
  spaceId: string
  removedDid: string
  homeBrokerSet: string[]
  confirmedBrokerUrls: string[]
  newGeneration: number
  stagedKeyMaterial: {
    contentKey: string
    capSigningSeed: string
    capVerificationKey: string
  }
  createdAt: number
}

function toStoredRemoval(removal: PendingRemoval): StoredPendingRemoval {
  return {
    spaceId: removal.spaceId,
    removedDid: removal.removedDid,
    // Defensive copy + normalize to string[] (if a caller passed something
    // Set-like, [...] still yields the array form the store persists).
    homeBrokerSet: [...removal.homeBrokerSet],
    confirmedBrokerUrls: [...removal.confirmedBrokerUrls],
    newGeneration: removal.newGeneration,
    stagedKeyMaterial: {
      contentKey: encodeBase64Url(removal.stagedKeyMaterial.contentKey),
      capSigningSeed: encodeBase64Url(removal.stagedKeyMaterial.capSigningSeed),
      capVerificationKey: encodeBase64Url(removal.stagedKeyMaterial.capVerificationKey),
    },
    createdAt: removal.createdAt,
  }
}

function fromStoredRemoval(stored: StoredPendingRemoval): PendingRemoval {
  const stagedKeyMaterial: StagedRemovalKeyMaterial = {
    contentKey: decodeBase64Url(stored.stagedKeyMaterial.contentKey),
    capSigningSeed: decodeBase64Url(stored.stagedKeyMaterial.capSigningSeed),
    capVerificationKey: decodeBase64Url(stored.stagedKeyMaterial.capVerificationKey),
  }
  return {
    spaceId: stored.spaceId,
    removedDid: stored.removedDid,
    homeBrokerSet: [...stored.homeBrokerSet],
    confirmedBrokerUrls: [...stored.confirmedBrokerUrls],
    newGeneration: stored.newGeneration,
    stagedKeyMaterial,
    createdAt: stored.createdAt,
  }
}

/** Stable pending order: by deviceId, then seq, then createdAt. */
function comparePending(a: LocalLogEntry, b: LocalLogEntry): number {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.createdAt - b.createdAt
}

/**
 * True when an IndexedDB write failed because the composite key already exists.
 * idb surfaces the native DOMException (name 'ConstraintError'); we also accept a
 * structural match so the fake-IndexedDB used in tests is covered.
 */
function isConstraintError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err) {
    return (err as { name?: unknown }).name === 'ConstraintError'
  }
  return false
}

/** Mint a canonical lowercase UUID-v4 deviceId (Sync 003 register format). */
function mintDeviceId(): string {
  return globalThis.crypto.randomUUID()
}
