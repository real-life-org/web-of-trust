import type {
  AppendLocalEntryParams,
  DocLogStore,
  GapRepair,
  LocalLogEntry,
  PendingRemoval,
  RecordRemoteAppliedEntry,
} from '../../ports/DocLogStore'
import { OrphanedLogRepairError } from '../../ports/DocLogStore'
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
  /**
   * Slice B / VE-B2 durable gap-state, keyed by
   * `${docId}\u0000${device}\u0000${firstMissing}` → {@link GapRepair}. Cleared by
   * clear() alongside the log + deviceId. Auto-resolved in recordRemoteApplied once
   * the missing seq is stored (the strict-contiguous head advances past it).
   */
  private readonly gapState = new Map<string, GapRepair>()
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

  async resolveConnectDeviceId(): Promise<string> {
    // Mirrors IndexedDBDocLogStore.resolveConnectDeviceId (Durable Wiring / N2).
    if (this.deviceId !== null) {
      // deviceId present → normal-resume vs partial-meta-only.
      const hasOwnEntries = [...this.entries.values()].some((e) => e.deviceId === this.deviceId)
      if (hasOwnEntries) return this.deviceId // normal resume
      // partial-meta-only → rotate to a fresh nonce namespace.
      this.deviceId = globalThis.crypto.randomUUID()
      return this.deviceId
    }
    // deviceId ABSENT → cold-start OR orphaned-log (E1/Repair).
    const pendingDevices = [
      ...new Set(
        [...this.entries.values()].filter((e) => e.status === 'pending').map((e) => e.deviceId),
      ),
    ]
    if (pendingDevices.length > 1) throw new OrphanedLogRepairError(pendingDevices)
    if (pendingDevices.length === 1) {
      // Re-bind the lost deviceId so resendPending can still flush the pending entries.
      this.deviceId = pendingDevices[0]
      return this.deviceId
    }
    // cold-start → mint a fresh namespace.
    this.deviceId = globalThis.crypto.randomUUID()
    return this.deviceId
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
    // VE-B2 auto-resolve: a stored seq may have closed (or healed past) a tracked
    // gap. Drop every GapRepair for this (docId, device) whose firstMissing is now
    // at or below the new strict-contiguous head — the hole self-clears, NO data loss.
    this.autoResolveGaps(docId, deviceId)
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

  async getStrictContiguousHeads(docId: string): Promise<Record<string, number>> {
    // VE-B2: highest seq with NO gap below it, per device. Walk each device's sorted
    // seqs and stop at the first hole. Distinct from getKnownHeads (= max).
    const heads: Record<string, number> = {}
    for (const [device, seqs] of this.seqsByDevice(docId)) {
      heads[device] = strictContiguousHead(seqs)
    }
    return heads
  }

  async getSyncRequestHeads(docId: string): Promise<Record<string, number>> {
    // VE-B2 wire cursor: strict-contiguous, advanced past durable soft-skip markers.
    const seqsByDevice = this.seqsByDevice(docId)
    const heads: Record<string, number> = {}
    for (const [device, seqs] of seqsByDevice) {
      heads[device] = strictContiguousHead(seqs)
    }
    // For each device with a soft-skipped gap at strictHead+1, advance the cursor to
    // the highest contiguous run ABOVE the soft-skipped hole (so the churn ends).
    // Process gaps in ASCENDING firstMissing order so STACKED soft-skips fold in ONE pass
    // (lower hole advances the cursor, then the next hole becomes strict+1 and advances
    // too). Without the sort the advance is iteration-order-dependent and InMemory (Map
    // insertion order) could diverge from IndexedDB (getAll key order) — Opus minor.
    const softGaps = [...this.gapState.values()]
      .filter((gap) => gap.docId === docId && gap.softSkipped)
      .sort((a, b) => a.firstMissing - b.firstMissing)
    for (const gap of softGaps) {
      const seqs = seqsByDevice.get(gap.device)
      if (!seqs) continue
      const strict = heads[gap.device] ?? strictContiguousHead(seqs)
      // Only advance if this soft-skipped hole is exactly the next missing seq.
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
    const key = this.gapKey(docId, device, firstMissing)
    let gap = this.gapState.get(key)
    if (!gap) {
      gap = {
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
      this.gapState.set(key, gap)
    }
    gap.observations += 1
    if (observedMax > gap.observedMax) gap.observedMax = observedMax
    // Dedup by epoch: three catch-ups of the SAME connection count as one epoch.
    if (gap.lastObservedEpoch !== connectionEpoch) {
      if (!gap.observedEpochs.includes(connectionEpoch)) gap.observedEpochs.push(connectionEpoch)
      gap.lastObservedEpoch = connectionEpoch
    }
  }

  async markGapSoftSkipped(docId: string, device: string, firstMissing: number): Promise<void> {
    const gap = this.gapState.get(this.gapKey(docId, device, firstMissing))
    if (gap) gap.softSkipped = true
  }

  async listDueGapRepairs(now: number): Promise<GapRepair[]> {
    return [...this.gapState.values()]
      .filter((g) => g.nextDueAt <= now)
      .map(cloneGapRepair)
  }

  async markGapRepairAttempt(
    docId: string,
    device: string,
    firstMissing: number,
    nextDueAt: number,
  ): Promise<void> {
    const gap = this.gapState.get(this.gapKey(docId, device, firstMissing))
    if (!gap) return
    gap.attempts += 1
    gap.nextDueAt = nextDueAt
  }

  async deleteGapRepair(docId: string, device: string, firstMissing: number): Promise<void> {
    this.gapState.delete(this.gapKey(docId, device, firstMissing))
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
    // VE-B2: a wipe drops gap-state too (same lifecycle).
    this.gapState.clear()
    // BLOCKER-1b: a wipe that empties the log MUST also drop the deviceId so the
    // next getOrCreateDeviceId() mints a FRESH nonce namespace (no seq=0 reuse).
    this.deviceId = null
  }

  /** VE-B2: sorted seq list per device for one doc. */
  private seqsByDevice(docId: string): Map<string, number[]> {
    const byDevice = new Map<string, number[]>()
    for (const entry of this.entries.values()) {
      if (entry.docId !== docId) continue
      const list = byDevice.get(entry.deviceId)
      if (list) list.push(entry.seq)
      else byDevice.set(entry.deviceId, [entry.seq])
    }
    for (const list of byDevice.values()) list.sort((a, b) => a - b)
    return byDevice
  }

  /** VE-B2: drop GapRepairs whose hole has been filled past the new strict head. */
  private autoResolveGaps(docId: string, device: string): void {
    const seqs = this.seqsByDevice(docId).get(device)
    if (!seqs) return
    const strict = strictContiguousHead(seqs)
    for (const [key, gap] of this.gapState) {
      if (gap.docId !== docId || gap.device !== device) continue
      // The hole self-clears once the strict-contiguous head has reached/passed it.
      if (gap.firstMissing <= strict) this.gapState.delete(key)
    }
  }

  private gapKey(docId: string, device: string, firstMissing: number): string {
    return `${docId}\u0000${device}\u0000${firstMissing}`
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

/**
 * VE-B2: the highest seq with no gap below it, given a SORTED ascending seq list.
 * Returns -1 if seq 0 is absent (no contiguous prefix at all). Stops at the first hole.
 */
export function strictContiguousHead(sortedSeqs: number[]): number {
  let head = -1
  for (const seq of sortedSeqs) {
    if (seq === head + 1) head = seq
    else if (seq > head + 1) break // a gap — stop
    // seq <= head can only be a duplicate (dedup-safe); ignore.
  }
  return head
}

/**
 * VE-B2: given a SORTED ascending seq list and a soft-skipped hole STARTING at
 * `firstMissing`, return the highest seq of the contiguous run that begins at the
 * FIRST stored seq above the hole, jumping over the (possibly multi-seq) hole. E.g.
 * seqs [0,1,5], firstMissing=2 → 5 (the hole 2..4 is skipped, the run {5} ends at 5).
 * seqs [0,1,5,6,8], firstMissing=2 → 6 (run {5,6}, then a new hole at 7). Returns
 * firstMissing-1 (i.e. no advance, still behind the hole) if nothing is stored above it.
 */
export function contiguousHeadAbove(sortedSeqs: number[], firstMissing: number): number {
  // The first stored seq strictly above the hole start.
  let head: number | null = null
  for (const seq of sortedSeqs) {
    if (seq < firstMissing) continue
    if (head === null) {
      // First seq at/above firstMissing — but the hole means firstMissing itself is
      // absent, so the run above starts at the first PRESENT seq >= firstMissing.
      head = seq
    } else if (seq === head + 1) {
      head = seq
    } else if (seq > head + 1) {
      break // a further hole above — stop extending the run
    }
  }
  // Nothing stored above the hole → stay behind it (cursor = firstMissing - 1).
  return head ?? firstMissing - 1
}

/** Deep-clone a {@link GapRepair} so callers cannot mutate the stored record. */
function cloneGapRepair(gap: GapRepair): GapRepair {
  return { ...gap, observedEpochs: [...gap.observedEpochs] }
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
    phase: removal.phase ?? (removal.committed ? 'committed' : removal.confirmedBrokerUrls.length > 0 ? 'broker-confirmed' : 'staged'),
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
    activityEntry: removal.activityEntry === undefined ? undefined : JSON.parse(JSON.stringify(removal.activityEntry)),
    kind: removal.kind,
    committed: removal.committed,
    adminRemoveConfirmedBrokerUrls: removal.adminRemoveConfirmedBrokerUrls === undefined ? undefined : [...removal.adminRemoveConfirmedBrokerUrls],
  }
}
