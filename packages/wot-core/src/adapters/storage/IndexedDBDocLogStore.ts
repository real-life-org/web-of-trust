import { openDB, type IDBPDatabase } from 'idb'
import { decodeBase64Url, encodeBase64Url } from '../../protocol'
import type {
  AppendLocalEntryParams,
  DocLogStore,
  GapRepair,
  LocalLogEntry,
  PendingRemoval,
  RecordRemoteAppliedEntry,
  StagedRemovalKeyMaterial,
} from '../../ports/DocLogStore'
import { OrphanedLogRepairError } from '../../ports/DocLogStore'
import { pendingRemovalKey } from './pending-removal-key'
import { contiguousHeadAbove, strictContiguousHead } from './InMemoryDocLogStore'
import { createSeqLock, type SeqLock } from './SeqLock'

const DB_NAME = 'wot-doc-log'
// v2: adds the `meta` key-value store that binds the deviceId to the log-store
//     lifecycle (BLOCKER-1b) so a wipe that empties the log also drops the deviceId.
// v3: adds the `pendingRemovals` store — the durable, crash-safe staging area
//     for two-phase member removals (Slice SR / VE-S0). The v2→v3 migration
//     keeps the existing entries + meta stores intact (additive only).
// v4: adds the `gapRepairs` store (Slice B / VE-B2) — durable seq-gap state +
//     GapRepair backoff schedule, with a `byNextDueAt` index for O(log n) due-scans.
//     The v3→v4 migration keeps entries + meta + pendingRemovals intact (additive only).
// v5: adds the `byDeviceId` index on `entries` (Durable Wiring / N2) — an O(log n)
//     "has this deviceId authored ANY entry?" probe that drives the partial-meta-only
//     namespace-rotate in resolveConnectDeviceId. The v4→v5 migration builds the index
//     over existing entries and keeps entries + meta + pendingRemovals + gapRepairs
//     intact (additive only).
const DB_VERSION = 5
const ENTRIES_STORE = 'entries'
const PENDING_INDEX = 'byStatus'
const DEVICE_INDEX = 'byDeviceId'
const META_STORE = 'meta'
const DEVICE_ID_KEY = 'deviceId'
const PENDING_REMOVALS_STORE = 'pendingRemovals'
const GAP_REPAIRS_STORE = 'gapRepairs'
const GAP_DUE_INDEX = 'byNextDueAt'
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

  /** Close the underlying IndexedDB connection (teardown, e.g. on identity switch). */
  async close(): Promise<void> {
    if (!this.dbPromise) return
    const db = await this.dbPromise
    db.close()
    this.dbPromise = null
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

  async resolveConnectDeviceId(): Promise<string> {
    const db = await this.db()
    // ONE readwrite txn over META + ENTRIES so the read-decide-write is atomic
    // against a concurrent first caller (no parallel getOrCreateDeviceId can race
    // the mint/rotate/repair). mintDeviceId() is synchronous, so the txn never
    // auto-closes across an external await.
    const tx = db.transaction([META_STORE, ENTRIES_STORE], 'readwrite')
    const metaStore = tx.objectStore(META_STORE)
    const entries = tx.objectStore(ENTRIES_STORE)
    const existing = (await metaStore.get(DEVICE_ID_KEY)) as string | undefined

    if (typeof existing === 'string' && existing.length > 0) {
      // deviceId present → normal-resume vs partial-meta-only. O(log n) probe:
      // does the byDeviceId index hold ANY entry authored under `existing`?
      const ownKey = await entries.index(DEVICE_INDEX).getKey(existing)
      if (ownKey !== undefined) {
        await tx.done
        return existing // normal resume — its log is (at least partly) intact
      }
      // partial-meta-only: the deviceId survived but its log is gone (eviction /
      // the non-atomic-clear race). ATOMIC namespace-ROTATE — never seq=0 under the
      // old id, whose earlier seqs may already be on the wire.
      const minted = mintDeviceId()
      await metaStore.put(minted, DEVICE_ID_KEY)
      await tx.done
      return minted
    }

    // deviceId ABSENT → cold-start OR orphaned-log (E1/Repair). Unsent 'pending'
    // entries under a lost deviceId must NOT be stranded by minting fresh.
    const pending = (await entries.index(PENDING_INDEX).getAll('pending')) as StoredLogEntry[]
    if (pending.length > 0) {
      const devices = [...new Set(pending.map((e) => e.deviceId))]
      if (devices.length > 1) {
        await tx.done
        throw new OrphanedLogRepairError(devices)
      }
      // Re-bind the pending entries' deviceId so resendPending can still flush them.
      const recovered = devices[0]
      await metaStore.put(recovered, DEVICE_ID_KEY)
      await tx.done
      return recovered
    }
    // cold-start: nothing persisted, nothing pending → mint a fresh namespace.
    const minted = mintDeviceId()
    await metaStore.put(minted, DEVICE_ID_KEY)
    await tx.done
    return minted
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
    // VE-B2 auto-resolve: a stored seq may have closed (or healed past) a tracked
    // gap — drop every GapRepair for this (docId, device) at/below the new strict head.
    await this.autoResolveGaps(docId, deviceId)
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

  async getStrictContiguousHeads(docId: string): Promise<Record<string, number>> {
    const byDevice = await this.seqsByDevice(docId)
    const heads: Record<string, number> = {}
    for (const [device, seqs] of byDevice) heads[device] = strictContiguousHead(seqs)
    return heads
  }

  async getSyncRequestHeads(docId: string): Promise<Record<string, number>> {
    const byDevice = await this.seqsByDevice(docId)
    const heads: Record<string, number> = {}
    for (const [device, seqs] of byDevice) heads[device] = strictContiguousHead(seqs)
    // Advance the cursor past durable soft-skip markers (same logic as InMemory).
    // ASCENDING firstMissing order so stacked soft-skips fold in one pass and this store
    // stays byte-for-byte consistent with InMemory (Opus minor — no order-dependent drift).
    const gaps = (await this.allGapRepairs())
      .filter((g) => g.docId === docId && g.softSkipped)
      .sort((a, b) => a.firstMissing - b.firstMissing)
    for (const gap of gaps) {
      const seqs = byDevice.get(gap.device)
      if (!seqs) continue
      const strict = heads[gap.device] ?? strictContiguousHead(seqs)
      if (gap.firstMissing !== strict + 1) continue
      heads[gap.device] = contiguousHeadAbove(seqs, gap.firstMissing)
    }
    return heads
  }

  async recordGapObservation(
    docId: string,
    device: string,
    firstMissing: number,
    observedMax: number,
    connectionEpoch: number,
    now: number,
  ): Promise<void> {
    const db = await this.db()
    const key = gapKey(docId, device, firstMissing)
    const tx = db.transaction(GAP_REPAIRS_STORE, 'readwrite')
    let stored = (await tx.store.get(key)) as StoredGapRepair | undefined
    if (!stored) {
      stored = {
        docId,
        device,
        firstMissing,
        observedMax,
        observations: 0,
        observedEpochs: [],
        lastObservedEpoch: -1,
        firstSeenAt: now,
        softSkipped: false,
        nextDueAt: 0,
        attempts: 0,
      }
    }
    stored.observations += 1
    if (observedMax > stored.observedMax) stored.observedMax = observedMax
    if (stored.lastObservedEpoch !== connectionEpoch) {
      if (!stored.observedEpochs.includes(connectionEpoch)) stored.observedEpochs.push(connectionEpoch)
      stored.lastObservedEpoch = connectionEpoch
    }
    await tx.store.put(stored, key)
    await tx.done
  }

  async markGapSoftSkipped(docId: string, device: string, firstMissing: number): Promise<void> {
    const db = await this.db()
    const key = gapKey(docId, device, firstMissing)
    const tx = db.transaction(GAP_REPAIRS_STORE, 'readwrite')
    const stored = (await tx.store.get(key)) as StoredGapRepair | undefined
    if (stored) {
      stored.softSkipped = true
      await tx.store.put(stored, key)
    }
    await tx.done
  }

  async listDueGapRepairs(now: number): Promise<GapRepair[]> {
    const db = await this.db()
    // O(log n) due-scan via the byNextDueAt index: every record with nextDueAt <= now.
    const range = IDBKeyRange.upperBound(now)
    const stored = (await db.getAllFromIndex(
      GAP_REPAIRS_STORE,
      GAP_DUE_INDEX,
      range,
    )) as StoredGapRepair[]
    return stored.map(fromStoredGap)
  }

  async markGapRepairAttempt(
    docId: string,
    device: string,
    firstMissing: number,
    nextDueAt: number,
  ): Promise<void> {
    const db = await this.db()
    const key = gapKey(docId, device, firstMissing)
    const tx = db.transaction(GAP_REPAIRS_STORE, 'readwrite')
    const stored = (await tx.store.get(key)) as StoredGapRepair | undefined
    if (stored) {
      stored.attempts += 1
      stored.nextDueAt = nextDueAt
      await tx.store.put(stored, key)
    }
    await tx.done
  }

  async deleteGapRepair(docId: string, device: string, firstMissing: number): Promise<void> {
    const db = await this.db()
    await db.delete(GAP_REPAIRS_STORE, gapKey(docId, device, firstMissing))
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
    // Durable Wiring / N2 (structural entries↔meta coupling): clear ENTRIES and
    // META (the deviceId binding) in ONE readwrite txn so the wipe is all-or-
    // nothing. A crash mid-clear can therefore NEVER leave entries empty while the
    // deviceId survives — which would re-enter seq=0 under a stale nonce namespace
    // (BLOCKER-1b). The four separate db.clear() calls this replaces were each
    // their own implicit txn (a non-atomic window between the entries- and meta-
    // clear). pendingRemovals (VE-S0) + gapRepairs (VE-B2) share the same wipe.
    //
    // Residual in-flight race (Row 11): clear() carries no (deviceId, docId), so it
    // cannot take the per-(deviceId, docId) SeqLock that serializes appendLocalEntry.
    // A clear() that interleaves an in-flight append (after its readMaxSeq, before
    // its db.add) can leave ONE orphaned entry under a now-meta-less deviceId. That
    // is nonce-SAFE (the entry sits at its reserved seq, never reused with new
    // bytes) and SELF-HEALING: resolveConnectDeviceId's orphaned-log branch re-binds
    // that deviceId from the pending entry on the next connect, so resendPending can
    // still flush it. Covered by an adversarial test.
    const tx = db.transaction(
      [ENTRIES_STORE, META_STORE, PENDING_REMOVALS_STORE, GAP_REPAIRS_STORE],
      'readwrite',
    )
    await Promise.all([
      tx.objectStore(ENTRIES_STORE).clear(),
      tx.objectStore(META_STORE).clear(),
      tx.objectStore(PENDING_REMOVALS_STORE).clear(),
      tx.objectStore(GAP_REPAIRS_STORE).clear(),
      tx.done,
    ])
  }

  /** VE-B2: sorted ascending seq list per device for one doc (one forward cursor). */
  private async seqsByDevice(docId: string): Promise<Map<string, number[]>> {
    const db = await this.db()
    const range = IDBKeyRange.bound([docId], [docId, [], []])
    const byDevice = new Map<string, number[]>()
    // The composite keyPath [docId, deviceId, seq] yields a cursor already ordered
    // by (deviceId ASC, seq ASC), so each device's list is built sorted.
    let cursor = await db.transaction(ENTRIES_STORE, 'readonly').store.openCursor(range)
    while (cursor) {
      const stored = cursor.value as StoredLogEntry
      const list = byDevice.get(stored.deviceId)
      if (list) list.push(stored.seq)
      else byDevice.set(stored.deviceId, [stored.seq])
      cursor = await cursor.continue()
    }
    return byDevice
  }

  private async allGapRepairs(): Promise<GapRepair[]> {
    const db = await this.db()
    const stored = (await db.getAll(GAP_REPAIRS_STORE)) as StoredGapRepair[]
    return stored.map(fromStoredGap)
  }

  /** VE-B2: drop GapRepairs whose hole has been filled past the new strict head. */
  private async autoResolveGaps(docId: string, device: string): Promise<void> {
    const seqs = (await this.seqsByDevice(docId)).get(device)
    if (!seqs) return
    const strict = strictContiguousHead(seqs)
    const db = await this.db()
    const tx = db.transaction(GAP_REPAIRS_STORE, 'readwrite')
    let cursor = await tx.store.openCursor()
    while (cursor) {
      const g = cursor.value as StoredGapRepair
      if (g.docId === docId && g.device === device && g.firstMissing <= strict) {
        await cursor.delete()
      }
      cursor = await cursor.continue()
    }
    await tx.done
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
        upgrade(db, _oldVersion, _newVersion, tx) {
          if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
            const store = db.createObjectStore(ENTRIES_STORE, {
              keyPath: ['docId', 'deviceId', 'seq'],
            })
            store.createIndex(PENDING_INDEX, 'status')
            // v5 (Durable Wiring / N2): "has this deviceId authored anything?" probe.
            store.createIndex(DEVICE_INDEX, 'deviceId')
          } else {
            // v<5 → v5 migration: add the byDeviceId index to the EXISTING entries
            // store (built over current rows by IndexedDB). createIndex must run
            // inside this versionchange txn.
            const store = tx.objectStore(ENTRIES_STORE)
            if (!store.indexNames.contains(DEVICE_INDEX)) {
              store.createIndex(DEVICE_INDEX, 'deviceId')
            }
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
          // v4 (Slice B / VE-B2): durable seq-gap state + GapRepair backoff schedule,
          // keyed out-of-line by gapKey(docId, device, firstMissing). The byNextDueAt
          // index serves listDueGapRepairs as an O(log n) due-scan. Created on a fresh
          // DB AND on a v3→v4 migration — the guard makes the whole upgrade hook
          // additive, so an existing DB keeps entries + meta + pendingRemovals and only
          // GAINS this store (no data loss). The createIndex MUST run inside this
          // upgrade txn (cannot createIndex outside an upgrade).
          if (!db.objectStoreNames.contains(GAP_REPAIRS_STORE)) {
            const gapStore = db.createObjectStore(GAP_REPAIRS_STORE)
            gapStore.createIndex(GAP_DUE_INDEX, 'nextDueAt')
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
  phase?: PendingRemoval['phase']
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
  activityEntry?: Record<string, unknown>
  kind?: 'canonical-self-removal-rotation'
  committed?: boolean
  adminRemoveConfirmedBrokerUrls?: string[]
}

function toStoredRemoval(removal: PendingRemoval): StoredPendingRemoval {
  return {
    phase: removal.phase,
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
    activityEntry: removal.activityEntry === undefined ? undefined : JSON.parse(JSON.stringify(removal.activityEntry)),
    kind: removal.kind,
    committed: removal.committed,
    adminRemoveConfirmedBrokerUrls: removal.adminRemoveConfirmedBrokerUrls === undefined ? undefined : [...removal.adminRemoveConfirmedBrokerUrls],
  }
}

function fromStoredRemoval(stored: StoredPendingRemoval): PendingRemoval {
  const stagedKeyMaterial: StagedRemovalKeyMaterial = {
    contentKey: decodeBase64Url(stored.stagedKeyMaterial.contentKey),
    capSigningSeed: decodeBase64Url(stored.stagedKeyMaterial.capSigningSeed),
    capVerificationKey: decodeBase64Url(stored.stagedKeyMaterial.capVerificationKey),
  }
  return {
    // v3/v4 records predate phases.  Infer the furthest durable boundary; this
    // migration is deliberately read-time so old databases need no rewrite pass.
    phase: stored.phase ?? (stored.committed ? 'committed' : stored.confirmedBrokerUrls.length > 0 ? 'broker-confirmed' : 'staged'),
    spaceId: stored.spaceId,
    removedDid: stored.removedDid,
    homeBrokerSet: [...stored.homeBrokerSet],
    confirmedBrokerUrls: [...stored.confirmedBrokerUrls],
    newGeneration: stored.newGeneration,
    stagedKeyMaterial,
    createdAt: stored.createdAt,
    activityEntry: stored.activityEntry === undefined ? undefined : JSON.parse(JSON.stringify(stored.activityEntry)),
    kind: stored.kind,
    committed: stored.committed,
    adminRemoveConfirmedBrokerUrls: stored.adminRemoveConfirmedBrokerUrls === undefined ? undefined : [...stored.adminRemoveConfirmedBrokerUrls],
  }
}

/** Stable pending order: by deviceId, then seq, then createdAt. */
function comparePending(a: LocalLogEntry, b: LocalLogEntry): number {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.createdAt - b.createdAt
}

/**
 * Persisted shape of a {@link GapRepair} (Slice B / VE-B2). All fields are plain
 * JSON-safe primitives/arrays — IDB cannot persist a Set, so observedEpochs is a
 * number[] (the port's GapRepair also models it as number[]). nextDueAt is the
 * indexed field (byNextDueAt). No Uint8Array, so no base64 round-trip is needed.
 */
interface StoredGapRepair {
  docId: string
  device: string
  firstMissing: number
  observedMax: number
  observations: number
  observedEpochs: number[]
  lastObservedEpoch: number
  firstSeenAt: number
  softSkipped: boolean
  nextDueAt: number
  attempts: number
}

function fromStoredGap(stored: StoredGapRepair): GapRepair {
  return {
    docId: stored.docId,
    device: stored.device,
    firstMissing: stored.firstMissing,
    observedMax: stored.observedMax,
    observations: stored.observations,
    observedEpochs: [...stored.observedEpochs],
    lastObservedEpoch: stored.lastObservedEpoch,
    firstSeenAt: stored.firstSeenAt,
    softSkipped: stored.softSkipped,
    nextDueAt: stored.nextDueAt,
    attempts: stored.attempts,
  }
}

/** VE-B2 out-of-line key for a GapRepair record (mirrors the at-rest separator convention). */
function gapKey(docId: string, device: string, firstMissing: number): string {
  return `${docId}\u0000${device}\u0000${firstMissing}`
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
