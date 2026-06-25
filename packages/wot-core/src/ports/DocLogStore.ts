/**
 * DocLogStore — durable, append-only per-(deviceId, docId) log with a durable
 * seq counter. The crash-safe foundation under the CRDT sync layer (VE-2..VE-11
 * make Yjs/Automerge write and read log entries through this store).
 *
 * Engine-neutral: this port knows nothing about Yjs, Automerge, or the wire. It
 * stores opaque, already-encrypted-and-signed LogEntry JWS strings keyed by
 * (deviceId, seq), derives the next seq from the durably persisted maximum, and
 * serializes seq reservation across tabs via an injected {@link SeqLock}.
 *
 * ── Security invariants (Sync 002) ──────────────────────────────────────────
 *
 * 1. Crash-safe persistence BEFORE send (Sync 002 Z.207-211): the COMPLETE
 *    encrypted+signed log-entry JWS is durably persisted under its (deviceId,
 *    seq) BEFORE the first send attempt — not just a seq counter. After a crash,
 *    a reserved seq WITHOUT a persisted entry is NEVER re-assigned to fresh
 *    plaintext. Rationale: seq=k twice with divergent plaintext means reuse of
 *    (Key, nonce(deviceId, k)) — and the log-payload nonce is deterministic
 *    (SHA-256(deviceId | seq)[0:12]) — which breaks AES-GCM.
 *
 * 2. Cross-tab seq atomicity (Sync 002 Z.108): multiple tabs of the same origin
 *    share deviceId + Content-Key. {@link DocLogStore.appendLocalEntry} MUST be
 *    serialized across tabs. A plain IndexedDB readwrite transaction per tab is
 *    NOT enough: separate connections interleave between read and write,
 *    yielding a duplicate seq=k and therefore a nonce reuse. The atomicity
 *    boundary is the {@link SeqLock} (Web Locks across tabs), NOT the IDB txn —
 *    an IDB transaction does not survive an `await` across the async crypto
 *    `build()` phase (it auto-closes on the next microtask).
 *
 * ── How the API enforces invariant 1 structurally ───────────────────────────
 *
 * There is exactly ONE write primitive, {@link DocLogStore.appendLocalEntry},
 * taking a `build(seq)` callback that returns the entry JWS. There is NO public
 * `reserveSeq()`. A caller therefore CANNOT burn a seq without also persisting
 * the entry built for it: the store reserves seq = maxSeq + 1, calls build(seq)
 * (the async crypto), and persists the returned JWS — all inside the lock,
 * persisting before returning (and thus before any send). seq starts at 0.
 *
 * ── Crash-scenario analysis (see also IndexedDBDocLogStore) ──────────────────
 *
 * - Crash between readMaxSeq and persist: no entry persisted, seq NOT consumed
 *   (nothing was sent). The next start reads the SAME maxSeq, so the same seq
 *   with NEW plaintext is safe — no wire reuse occurred.
 * - Crash after persist, before send: entry sits as 'pending'. The retry sends
 *   the bit-identical JWS (the broker dedups via contentHash). NEVER rebuilt.
 *   Hence: 'pending' status + {@link DocLogStore.getPending} +
 *   {@link DocLogStore.markAcked}. The retry returns the STORED JWS unchanged.
 *
 * ── deviceId bound to the log-store lifecycle (BLOCKER-1b) ───────────────────
 *
 * The per-device seq namespace is the FIRST half of the deterministic nonce
 * nonce(deviceId, seq); the Content-Key is the other input. For a Personal-Doc
 * the Content-Key is PERMANENT (generation 0, never rotated), so nonce-uniqueness
 * rests SOLELY on (deviceId, seq) never repeating with divergent plaintext.
 *
 * A naive design persists the deviceId OUTSIDE this store (e.g. localStorage),
 * independently evictable from the log (iOS/Safari 7-day IDB eviction, quota,
 * partial clear-site-data). After such a wipe the log is empty (readMaxSeq=-1 ⇒
 * seq=0 again) while the deviceId survives — re-entering the seq=0 namespace under
 * a STABLE deviceId ⇒ nonce(deviceId, 0) reused with new bytes ⇒ AES-GCM break.
 *
 * Mitigation (MUSS): the deviceId lives in the SAME durable store as the log, so
 * a wipe that empties the log ALSO drops the deviceId, and {@link
 * DocLogStore.getOrCreateDeviceId} mints a FRESH one — a fresh nonce namespace.
 * seq=0 under the new deviceId has a DIFFERENT nonce, so no reuse can occur.
 * {@link DocLogStore.setDeviceId} persists a restore-clone's new deviceId.
 *
 * ── Out of scope for VE-1 (Phase 1) ─────────────────────────────────────────
 *
 * The reject-handling orchestration path (relay error SEQ_COLLISION_DETECTED →
 * mint new deviceId + device-revoke + restart at seq=0) needs send/messaging
 * and lands in Phase 2 / VE-4. This store only has to MAKE THAT MODEL POSSIBLE:
 * everything is keyed by deviceId, so "new deviceId, seq=0" is automatically a
 * fresh namespace with no collision against the old device's log.
 */

/** A persisted local or applied-remote log entry. */
export interface LocalLogEntry {
  /** The document this entry belongs to. */
  docId: string
  /** The authoring device. The per-device seq namespace is keyed by this. */
  deviceId: string
  /** Monotonic per-(deviceId, docId) sequence number, starting at 0. */
  seq: number
  /**
   * The complete encrypted+signed LogEntryPayload JWS (compact form). Stored
   * verbatim; never rebuilt. Optional only for applied-remote bookkeeping that
   * does not retain the wire bytes — local entries always carry it.
   */
  entryJws: string
  /**
   * 'pending' until the entry has been acknowledged by the broker; 'acked'
   * afterwards. Pending entries are replayed on reconnect with the SAME JWS.
   */
  status: 'pending' | 'acked'
  /** Local creation time (ms since epoch), used for stable pending ordering. */
  createdAt: number
}

/** Parameters for {@link DocLogStore.appendLocalEntry}. */
export interface AppendLocalEntryParams {
  deviceId: string
  docId: string
  /**
   * Builds the encrypted+signed entry JWS for the reserved seq. Invoked exactly
   * once, inside the seq lock, AFTER the seq has been reserved and BEFORE the
   * entry is persisted. This is where the adapter (later phase) derives the
   * deterministic nonce, encrypts the CRDT update, and signs the LogEntry — the
   * store never touches crypto itself. If build rejects, NO entry is persisted
   * and the seq stays free for the next attempt (see invariant 1 / crash case).
   */
  build: (seq: number) => Promise<string>
}

/** Remote-entry bookkeeping recorded after a successful apply. */
export interface RecordRemoteAppliedEntry {
  docId: string
  deviceId: string
  seq: number
  /** Optional: the remote wire JWS, if the caller wants it retained. */
  entryJws?: string
}

/**
 * The new key material staged for the COMMIT phase of a two-phase member
 * removal (Slice SR / VE-S0). Held durably alongside the {@link PendingRemoval}
 * intent — NOT a CRDT op, NOT a Sync-002 log entry — until every authoritative
 * home broker has confirmed the space-rotate; only then does the commit phase
 * (VE-C1, Phase 3) distribute it as a key-rotation / member-update.
 *
 * All fields are raw key bytes. They round-trip through durable storage as
 * base64url (the IndexedDB adapter encodes/decodes them), so a crash + restart
 * recovers byte-identical material to finish (or retry) the rotation.
 */
export interface StagedRemovalKeyMaterial {
  /** The NEW Space Content Key (generation = {@link PendingRemoval.newGeneration}). */
  contentKey: Uint8Array
  /** Seed for the NEW capability signing keypair (Ed25519 private seed). */
  capSigningSeed: Uint8Array
  /** The NEW capability verification (public) key. */
  capVerificationKey: Uint8Array
}

/**
 * A durable, crash-safe record that a member removal is IN PROGRESS but NOT yet
 * enforced (Slice SR, wot-spec #110 / 005-gruppen.md).
 *
 * Removal-enforcement semantics: a removal counts as enforced only once ALL
 * authoritative home brokers have confirmed the space-rotate. The home-broker
 * set is FIXED at removal start ({@link homeBrokerSet}); {@link confirmedBrokerUrls}
 * grows monotonically as confirmations arrive (always a subset of
 * {@link homeBrokerSet}). Until the set is complete, the removal stays in a
 * retryable staging state — NO local commit, NO key-rotation / member-update
 * distribution, and this record is NEVER appended/published as a Sync-002 log
 * entry nor committed into the CRDT state. It carries ONLY the intent plus the
 * {@link stagedKeyMaterial} the commit phase will need — no CRDT op.
 */
export interface PendingRemoval {
  /** The space the removal targets. */
  spaceId: string
  /** The DID of the member being removed. */
  removedDid: string
  /**
   * The authoritative home brokers, FIXED at removal start. The removal is only
   * enforced once every URL here also appears in {@link confirmedBrokerUrls}.
   */
  homeBrokerSet: string[]
  /**
   * Brokers that have confirmed the space-rotate. Grows monotonically and is
   * always a subset of {@link homeBrokerSet}. Empty at removal start.
   */
  confirmedBrokerUrls: string[]
  /** The new key generation this removal rotates to. */
  newGeneration: number
  /** The new key material the commit phase (VE-C1) needs once all brokers confirm. */
  stagedKeyMaterial: StagedRemovalKeyMaterial
  /** Staging-record creation time (ms since epoch). */
  createdAt: number
}

/**
 * Slice B / VE-B2: a reference to a single open seq-gap, returned by the
 * pagination/catch-up loop in {@link CatchUpResult.pendingGaps}. `firstMissing` is
 * the lowest absent seq for the device (= strict-contiguous-head + 1).
 */
export interface GapRef {
  docId: string
  device: string
  firstMissing: number
}

/**
 * Slice B / VE-B2: the durable gap-state record for one (docId, device, firstMissing).
 * It tracks how many DISTINCT connection-epochs have observed the gap with a
 * `truncated:false` (broker-authoritative "nothing more") response, which drives the
 * soft-skip decision, plus the durable GapRepair backoff schedule (so a permanently
 * soft-skipped gap keeps being re-requested with `head = firstMissing - 1` and a
 * later-arriving entry is still fetched — NO irreversible head-skip, no data loss).
 */
export interface GapRepair {
  docId: string
  device: string
  /** The lowest absent seq — the GapRepair re-requests with `head = firstMissing - 1`. */
  firstMissing: number
  /** The highest seq observed ABOVE the gap (the broker's reported max for the device). */
  observedMax: number
  /** Total observations (every truncated:false sighting, regardless of epoch). */
  observations: number
  /**
   * The DISTINCT connection-epochs that observed this gap under truncated:false. The
   * soft-skip fires only once this reaches >= 3 (three real reconnect epochs, NOT three
   * catch-ups of the same connection — that is the mechanical purpose of the epoch dedup).
   */
  observedEpochs: number[]
  /** The most recent epoch recorded, so a repeat within the same epoch does not re-count. */
  lastObservedEpoch: number
  /** Wall-clock ms of the first observation — the `now - firstSeenAt >= 60s` gate. */
  firstSeenAt: number
  /** True once the soft-skip advanced the sync-request cursor past this hole. */
  softSkipped: boolean
  /** Next GapRepair attempt due-time (ms). 0 = due now / never attempted. */
  nextDueAt: number
  /** Number of GapRepair attempts made (drives the exponential backoff, capped 5min). */
  attempts: number
}

export interface DocLogStore {
  /** Open/initialize the backing store. Idempotent. */
  init(): Promise<void>

  /**
   * Atomically (under the SeqLock) reserve seq = maxSeq + 1 for (deviceId,
   * docId), call build(seq) (the async crypto), and durably persist the
   * returned JWS as a 'pending' entry BEFORE returning — and thus before any
   * send. Returns the persisted entry. seq starts at 0.
   *
   * Durable seq-uniqueness (BLOCKER-1a): the persist MUST be an insert that
   * FAILS if (docId, deviceId, seq) already exists (IDB `add`, not `put`), and
   * on that conflict the WHOLE read→build→insert cycle retries with the next
   * seq. The SeqLock alone cannot guarantee uniqueness across JS contexts when
   * Web Locks is unavailable (it silently degrades to in-process); the key
   * constraint is the durable backstop, so a discarded build is NEVER sent
   * (persist-before-send) and two contexts can never persist the same seq.
   */
  appendLocalEntry(params: AppendLocalEntryParams): Promise<LocalLogEntry>

  /**
   * The durable per-device id bound to THIS store's lifecycle (BLOCKER-1b).
   * Mints a canonical lowercase UUID-v4 on first call, persists it in the SAME
   * durable store as the log, and returns the SAME value thereafter. A store
   * wipe (which empties the log) therefore yields a FRESH deviceId — a fresh
   * nonce namespace — so seq=0 can never be re-entered under a stale deviceId.
   */
  getOrCreateDeviceId(): Promise<string>

  /**
   * Persist a new deviceId (restore-clone, VE-4/VE-5): after a SEQ_COLLISION /
   * DEVICE_REVOKED the coordinator mints a new deviceId; persisting it here makes
   * the new namespace survive a reload (so the revoked id is never re-adopted).
   */
  setDeviceId(deviceId: string): Promise<void>

  /**
   * Record an entry from another device after it has been successfully applied,
   * so heads stay correct and re-applies are idempotent. Recorded entries are
   * 'acked' (they are not part of our outbox) and are folded into heads.
   */
  recordRemoteApplied(entry: RecordRemoteAppliedEntry): Promise<void>

  /**
   * The MAX known seq per device for a doc — own writes plus applied-remote
   * entries — as Record<deviceId, seq>. Empty for unknown docs.
   *
   * Slice B / VE-B2 (Codex-BLOCKER): this is the MAX head and is for
   * {@link computeRestoreDisposition}/debug ONLY — it is NEVER the wire
   * sync-request cursor. With out-of-order apply (the (b)-model) the store can hold
   * a non-contiguous tail (e.g. seq 0 and 5 with a hole at 1..4) and this returns 5;
   * a sync-request with head=5 would make the relay only return seq>5, so 1..4 would
   * be permanently unrequestable. The wire path MUST use {@link getSyncRequestHeads}
   * (= strict-contiguous + soft-skip markers) and progress is measured by
   * {@link getStrictContiguousHeads}. For the OWN deviceId strict==max (own writes
   * are contiguous, restore-clone re-emit is markAcked-not-delete) so this stays
   * correct for the restore-disposition.
   */
  getKnownHeads(docId: string): Promise<Record<string, number>>

  /**
   * Slice B / VE-B2: the STRICT-CONTIGUOUS head per device — the highest seq below
   * which there is no gap (stops at the first missing seq). Used for progress
   * measurement (VE-B1 termination) and gap detection. For 0,5 (hole at 1..4) this
   * returns 0 (NOT 5, unlike {@link getKnownHeads}). Springt NIE über eine Lücke.
   */
  getStrictContiguousHeads(docId: string): Promise<Record<string, number>>

  /**
   * Slice B / VE-B2: the effective WIRE sync-request cursor per device — strict-
   * contiguous, ADVANCED past durable soft-skip markers. Before any soft-skip it
   * equals {@link getStrictContiguousHeads} (so a live gap stays behind the hole and
   * re-requests it). After {@link markGapSoftSkipped} the cursor jumps over the
   * soft-skipped hole to the next contiguous run (the re-fetch churn ends), while a
   * durable GapRepair keeps re-requesting the hole itself with `head = firstMissing-1`.
   */
  getSyncRequestHeads(docId: string): Promise<Record<string, number>>

  /**
   * Slice B / VE-B2: record one observation of an open gap under a `truncated:false`
   * (broker-authoritative) catch-up. ALWAYS increments `observations`; adds
   * `connectionEpoch` to `observedEpochs` ONLY if it differs from `lastObservedEpoch`
   * (the Codex-BLOCKER dedup so three catch-ups of the SAME connection do not count as
   * three epochs); sets `firstSeenAt` on the first observation. Creates the GapRepair
   * record if absent. `now` is the injected clock (testability of the 60s gate).
   */
  recordGapObservation(
    docId: string,
    device: string,
    firstMissing: number,
    observedMax: number,
    connectionEpoch: number,
    now: number,
  ): Promise<void>

  /**
   * Slice B / VE-B2: mark a gap soft-skipped (the 3-distinct-epoch + 60s gate fired).
   * {@link getSyncRequestHeads} then advances the cursor past the hole, but the
   * GapRepair record SURVIVES so the hole keeps being re-requested (no final skip).
   */
  markGapSoftSkipped(docId: string, device: string, firstMissing: number): Promise<void>

  /**
   * Slice B / VE-B2: every GapRepair whose `nextDueAt <= now`. The catch-up driver
   * sends a `head = firstMissing - 1` repair request for each; crash-recovery drives
   * this at app start so a soft-skipped gap resumes its backoff after a reload.
   */
  listDueGapRepairs(now: number): Promise<GapRepair[]>

  /**
   * Slice B / VE-B2: record a GapRepair attempt — bumps `attempts` and sets the next
   * `nextDueAt` (the caller computes the exponential backoff, capped at 5min).
   */
  markGapRepairAttempt(
    docId: string,
    device: string,
    firstMissing: number,
    nextDueAt: number,
  ): Promise<void>

  /**
   * Slice B / VE-B2: drop a GapRepair (the gap was filled / aborted). Normally the
   * store AUTO-RESOLVES a gap when the missing seq arrives (recordRemoteApplied
   * advances the strict-contiguous head past it); this is the explicit form.
   */
  deleteGapRepair(docId: string, device: string, firstMissing: number): Promise<void>

  /** Fetch a single entry by its composite key, or null if absent. */
  getEntry(docId: string, deviceId: string, seq: number): Promise<LocalLogEntry | null>

  /**
   * All locally authored entries still awaiting ack, ascending by (deviceId,
   * seq) then createdAt — the reconnect retry order. Each carries its STORED
   * JWS, which the retry MUST send unchanged.
   */
  getPending(): Promise<LocalLogEntry[]>

  /** Mark a previously pending entry as acknowledged. No-op if already acked/absent. */
  markAcked(docId: string, deviceId: string, seq: number): Promise<void>

  // ── Pending member-removal staging (Slice SR / VE-S0) ──────────────────────
  //
  // A durable, crash-safe staging area for two-phase member removals, keyed by
  // (spaceId, removedDid). It lives in the SAME durable store as the log so the
  // commit phase (Phase 3) can finish or retry a rotation after a crash. These
  // methods store ONLY intent + key material — never a CRDT op, never a Sync-002
  // log entry. They are independent of the (deviceId, docId) log above.

  /**
   * Durably stage (or re-stage) a pending removal. Idempotent on
   * (spaceId, removedDid): an existing record for the same removal is
   * OVERWRITTEN — this is the retry / re-stage path, so a fresh start with new
   * key material replaces a stale staging record wholesale.
   */
  putPendingRemoval(removal: PendingRemoval): Promise<void>

  /** Fetch the pending removal for (spaceId, removedDid), or null if none. */
  getPendingRemoval(spaceId: string, removedDid: string): Promise<PendingRemoval | null>

  /**
   * Record that one home broker confirmed the space-rotate. Adds `brokerUrl` to
   * confirmedBrokerUrls idempotently (no duplicate if already present) and
   * monotonically (never removes). No-op if the URL is already confirmed or no
   * staging record exists.
   */
  markBrokerConfirmed(spaceId: string, removedDid: string, brokerUrl: string): Promise<void>

  /**
   * Selectively drop the staging record for (spaceId, removedDid) (a targeted
   * delete, NOT a clear) — e.g. after the removal is fully enforced or aborted.
   * Other removals, the log, and the deviceId binding are untouched.
   */
  deletePendingRemoval(spaceId: string, removedDid: string): Promise<void>

  /**
   * All open pending removals — the crash-recovery view at startup, from which
   * the commit/retry orchestration (Phase 3, VE-C3) resumes. Empty store → [].
   */
  listPendingRemovals(): Promise<PendingRemoval[]>

  /** Remove all entries — log, pending removals, deviceId binding, AND gap-state. Test/reset helper. */
  clear(): Promise<void>
}
