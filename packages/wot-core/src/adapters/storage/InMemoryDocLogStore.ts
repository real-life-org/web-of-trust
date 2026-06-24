import type {
  AppendLocalEntryParams,
  DocLogStore,
  LocalLogEntry,
  PendingRemoval,
  RecordRemoteAppliedEntry,
} from '../../ports/DocLogStore'
import { pendingRemovalKey } from './pending-removal-key'
import { InProcessSeqLock, type SeqLock } from './SeqLock'

/** Bounded retry budget for the add-on-duplicate seq-reservation race (BLOCKER-1a). */
const MAX_SEQ_RETRIES = 64

/**
 * In-memory {@link DocLogStore} for tests. Mirrors {@link IndexedDBDocLogStore}
 * semantics — same seq derivation (maxSeq + 1, starting at 0), the same
 * persist-before-return ordering inside the SeqLock, and the same heads/pending
 * bookkeeping — but without IndexedDB.
 *
 * The SeqLock is injectable so a test can drive the same cross-tab atomicity
 * proof here as against the durable adapter; it defaults to {@link InProcessSeqLock}.
 */
export class InMemoryDocLogStore implements DocLogStore {
  /** Composite key `${docId}\u0000${deviceId}\u0000${seq}` → entry. */
  private readonly entries = new Map<string, LocalLogEntry>()
  /**
   * Pending member-removals (Slice SR / VE-S0) keyed by the composite
   * (spaceId, removedDid). Cleared by clear() alongside the log + deviceId.
   */
  private readonly pendingRemovals = new Map<string, PendingRemoval>()
  private readonly lock: SeqLock
  /** deviceId bound to this store's lifecycle (BLOCKER-1b); cleared by clear(). */
  private deviceId: string | null = null

  constructor(lock: SeqLock = new InProcessSeqLock()) {
    this.lock = lock
  }

  async init(): Promise<void> {
    // Nothing to open.
  }

  async appendLocalEntry(params: AppendLocalEntryParams): Promise<LocalLogEntry> {
    const { deviceId, docId, build } = params
    return this.lock.run(`doclog:${deviceId}:${docId}`, async () => {
      // BLOCKER-1a parity with the durable adapter (add, not put): the seq is
      // only durably consumed by the set below. If a second writer running
      // WITHOUT a shared lock consumed this seq across our `await build()`, the
      // key is already occupied — detect it and retry with the next seq. The
      // discarded build is NEVER returned (and thus never sent).
      for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
        const seq = this.maxSeq(docId, deviceId) + 1
        // build() (the async crypto) runs INSIDE the lock but is NOT covered by an
        // IDB transaction here either — parity with the durable adapter, where the
        // lock (not a txn) is the atomicity boundary across the await.
        const entryJws = await build(seq)
        const key = this.key(docId, deviceId, seq)
        if (this.entries.has(key)) continue // lost the race → next seq (add, not put)
        const entry: LocalLogEntry = {
          docId,
          deviceId,
          seq,
          entryJws,
          status: 'pending',
          createdAt: Date.now(),
        }
        // Persist BEFORE returning (and thus before any send): only here is the
        // seq durably consumed. If build() threw above, nothing is stored and the
        // seq stays free for the next attempt.
        this.entries.set(key, entry)
        return { ...entry }
      }
      throw new Error(
        `appendLocalEntry: seq reservation kept colliding for (${docId}, ${deviceId}) after ${MAX_SEQ_RETRIES} attempts`,
      )
    })
  }

  async getOrCreateDeviceId(): Promise<string> {
    if (this.deviceId === null) this.deviceId = globalThis.crypto.randomUUID()
    return this.deviceId
  }

  async setDeviceId(deviceId: string): Promise<void> {
    this.deviceId = deviceId
  }

  async recordRemoteApplied(entry: RecordRemoteAppliedEntry): Promise<void> {
    const { docId, deviceId, seq } = entry
    const key = this.key(docId, deviceId, seq)
    const existing = this.entries.get(key)
    // Idempotent: a re-applied remote entry must not clobber an already-stored
    // one (especially never downgrade a local 'pending'/'acked' JWS).
    if (existing) return
    this.entries.set(key, {
      docId,
      deviceId,
      seq,
      entryJws: entry.entryJws ?? '',
      status: 'acked',
      createdAt: Date.now(),
    })
  }

  async getKnownHeads(docId: string): Promise<Record<string, number>> {
    const heads: Record<string, number> = {}
    for (const entry of this.entries.values()) {
      if (entry.docId !== docId) continue
      const current = heads[entry.deviceId]
      if (current === undefined || entry.seq > current) heads[entry.deviceId] = entry.seq
    }
    return heads
  }

  async getEntry(docId: string, deviceId: string, seq: number): Promise<LocalLogEntry | null> {
    const entry = this.entries.get(this.key(docId, deviceId, seq))
    return entry ? { ...entry } : null
  }

  async getPending(): Promise<LocalLogEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.status === 'pending')
      .sort(comparePending)
      .map((entry) => ({ ...entry }))
  }

  async markAcked(docId: string, deviceId: string, seq: number): Promise<void> {
    const key = this.key(docId, deviceId, seq)
    const entry = this.entries.get(key)
    if (!entry || entry.status === 'acked') return
    this.entries.set(key, { ...entry, status: 'acked' })
  }

  // ── Pending member-removal staging (Slice SR / VE-S0) ──────────────────────

  async putPendingRemoval(removal: PendingRemoval): Promise<void> {
    // Idempotent on (spaceId, removedDid): a re-stage OVERWRITES the prior
    // record wholesale. Deep-clone so the stored copy is decoupled from the
    // caller's arrays/Uint8Arrays (mirrors the durable adapter's serialization).
    this.pendingRemovals.set(
      this.removalKey(removal.spaceId, removal.removedDid),
      cloneRemoval(removal),
    )
  }

  async getPendingRemoval(spaceId: string, removedDid: string): Promise<PendingRemoval | null> {
    const removal = this.pendingRemovals.get(this.removalKey(spaceId, removedDid))
    return removal ? cloneRemoval(removal) : null
  }

  async markBrokerConfirmed(
    spaceId: string,
    removedDid: string,
    brokerUrl: string,
  ): Promise<void> {
    const key = this.removalKey(spaceId, removedDid)
    const removal = this.pendingRemovals.get(key)
    // No-op if no staging record exists, the URL is not part of the (fixed)
    // home-broker set, or it is already confirmed. confirmedBrokerUrls is thus
    // always a subset of homeBrokerSet and grows monotonically — a stray confirm
    // for a non-home broker can never spoof enforcement completion.
    if (!removal || !removal.homeBrokerSet.includes(brokerUrl)) return
    if (removal.confirmedBrokerUrls.includes(brokerUrl)) return
    removal.confirmedBrokerUrls.push(brokerUrl)
  }

  async deletePendingRemoval(spaceId: string, removedDid: string): Promise<void> {
    // Selective delete (NOT a clear): only this (spaceId, removedDid) record.
    this.pendingRemovals.delete(this.removalKey(spaceId, removedDid))
  }

  async listPendingRemovals(): Promise<PendingRemoval[]> {
    return [...this.pendingRemovals.values()].map(cloneRemoval)
  }

  async clear(): Promise<void> {
    this.entries.clear()
    // VE-S0: a wipe drops staged removals too — the staging area shares the
    // log-store lifecycle.
    this.pendingRemovals.clear()
    // BLOCKER-1b: a wipe that empties the log MUST also drop the deviceId so the
    // next getOrCreateDeviceId() mints a FRESH nonce namespace (no seq=0 reuse).
    this.deviceId = null
  }

  private maxSeq(docId: string, deviceId: string): number {
    let max = -1
    for (const entry of this.entries.values()) {
      if (entry.docId === docId && entry.deviceId === deviceId && entry.seq > max) {
        max = entry.seq
      }
    }
    return max
  }

  /**
   * Composite key for a pending removal. Delegates to the shared
   * {@link pendingRemovalKey}, whose separator is the LITERAL escape token
   * (backslash-u-0000), NOT a raw NUL byte; any occurrence of that token inside
   * spaceId is itself escaped so a crafted spaceId can never forge the separator
   * and collide with another removal's key. (Matches the IndexedDB adapter.)
   */
  private removalKey(spaceId: string, removedDid: string): string {
    return pendingRemovalKey(spaceId, removedDid)
  }

  private key(docId: string, deviceId: string, seq: number): string {
    return `${docId}\u0000${deviceId}\u0000${seq}`
  }
}

/** Stable pending order: by deviceId, then seq, then createdAt. */
function comparePending(a: LocalLogEntry, b: LocalLogEntry): number {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.createdAt - b.createdAt
}

/**
 * Deep-clone a {@link PendingRemoval} so stored and returned copies are fully
 * decoupled from the caller (and from each other): arrays are copied and the
 * Uint8Array key material is copied byte-for-byte. This mirrors the IndexedDB
 * adapter, where serialization naturally produces an independent copy.
 */
function cloneRemoval(removal: PendingRemoval): PendingRemoval {
  return {
    spaceId: removal.spaceId,
    removedDid: removal.removedDid,
    homeBrokerSet: [...removal.homeBrokerSet],
    confirmedBrokerUrls: [...removal.confirmedBrokerUrls],
    newGeneration: removal.newGeneration,
    stagedKeyMaterial: {
      contentKey: Uint8Array.from(removal.stagedKeyMaterial.contentKey),
      capSigningSeed: Uint8Array.from(removal.stagedKeyMaterial.capSigningSeed),
      capVerificationKey: Uint8Array.from(removal.stagedKeyMaterial.capVerificationKey),
    },
    createdAt: removal.createdAt,
  }
}
