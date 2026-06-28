import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { DocLogStore, GapRef, LocalLogEntry } from '../../ports/DocLogStore'
import { decodeBase64Url } from '../crypto/encoding'
import {
  createLogEntryJwsWithSigner,
  createLogEntryMessage,
  parseLogEntryMessage,
  verifyLogEntryJws,
  type LogEntryMessage,
  type LogEntryPayload,
} from './log-entry'
import {
  createSyncRequestMessage,
  parseSyncResponseMessage,
  type SyncResponseMessage,
} from './sync-messages'
import { evaluateSyncResponseDisposition } from './heads'
import { decryptLogPayload, encryptLogPayload } from './encryption'
import { classifyLocalBrokerSeqConsistency } from './seq-consistency'
import { classifyLogEntryKeyDisposition } from './log-entry-key-disposition'
import {
  createPresentCapabilityControlFrame,
} from './present-capability-control-frame'
import { ControlFrameRejectedError, type ControlFrame, type ControlFrameReceipt } from './control-frame-transport'
import { isKnownBrokerErrorCode, type BrokerErrorCode } from './broker-error'
import type { JcsEd25519SignFn } from '../crypto/jws'

/**
 * LogSyncCoordinator — engine-neutral orchestration of the Sync 002/003 log
 * path (VE-2/3/4/8/9, wot-sync@0.1).
 *
 * One coordinator instance is bound per docId. It owns:
 *  - the **first-publication state machine** (VE-2, Sync 002 §207): for a Space,
 *    space-register (VE-8) → present-capability (VE-9) → sync-request/head-abgleich
 *    → first log-entry; for a Personal-Doc, present-capability → sync-request →
 *    first log-entry.
 *  - **strictly sequential control frames per (socket, docId)** (VE-9): the relay
 *    correlates control-frame receipts by `messageId == docId`, which is NOT
 *    unique across families, so at most one docId-control-frame is in flight.
 *  - **capability sourcing / re-presentation** (VE-9) and the **reject-disposition
 *    table** (VE-4): CAPABILITY_* → re-present, DEVICE_REVOKED → restore-clone,
 *    DEVICE_NOT_REGISTERED → re-register, AUTHOR_MISMATCH → hard stop,
 *    SEQ_COLLISION_DETECTED → restore-clone.
 *  - the **write path** (VE-2): reserve seq atomically via DocLogStore.appendLocalEntry,
 *    build the encrypted+signed log-entry JWS for that exact seq, persist BEFORE
 *    send, then send as a `log-entry/1.0` plaintext envelope.
 *  - the **read path** (VE-3, LOOP-GUARD): verify → decrypt → applyRemote, record
 *    heads, NEVER write or re-broadcast. Engine-foreign payloads are skipped.
 *  - **catch-up** (VE-4): present read-capability, then sync-request(localHeads)
 *    → sync-response → idempotent apply.
 *
 * Engine specifics are injected via {@link LogSyncEngineHooks}; Yjs and the
 * future Automerge adapter reuse this class unchanged.
 */

/**
 * Slice B / VE-B1: the client-side default sync-request page size. MUST match the
 * relay default (`effectiveLimit = limit ?? 100`, relay.ts) at the contract level —
 * the coordinator sends an EXPLICIT `body.limit` (100 by default, never undefined),
 * so the wire envelope is inspectable and the two defaults are pinned at one value.
 */
const DEFAULT_CATCH_UP_PAGE_SIZE = 100

/**
 * Slice B / VE-B2 soft-skip gate: a fremder seq-gap is soft-skipped only after it has
 * been observed under `truncated:false` (broker-authoritative "nothing more") across
 * this many DISTINCT connection-epochs. Three real reconnect epochs — NOT three
 * catch-ups of the same connection (that is the purpose of the connectionEpoch dedup).
 */
const GAP_SOFT_SKIP_MIN_EPOCHS = 3

/** Slice B / VE-B2 soft-skip gate: minimum wall-clock age (ms) of the gap before a soft-skip. */
const GAP_SOFT_SKIP_MIN_AGE_MS = 60_000

/** Slice B / VE-B2 GapRepair: base backoff (ms) for re-requesting a soft-skipped hole. */
const GAP_REPAIR_BASE_BACKOFF_MS = 5_000

/** Slice B / VE-B2 GapRepair: exponential backoff cap (5 min) per the directive. */
const GAP_REPAIR_MAX_BACKOFF_MS = 5 * 60_000

/**
 * Slice B v3 GapRepair: max pages a single repair attempt paginates to REACH the target gap
 * before deferring to the next backoff. Other devices are held at their MAX (getKnownHeads) so
 * they never crowd the page; this cap only bounds the rare case where an as-yet-UNKNOWN device
 * (absent from known) sorts before the gap device and floods early pages (CodeRabbit/Codex
 * crowding finding). A no-progress page also breaks the loop, so the cap is just a backstop.
 */
const GAP_REPAIR_MAX_PAGES = 50

/** Disposition the coordinator surfaces to the caller after a reject. */
export type RejectDisposition =
  | 'capability-re-present'
  | 'device-re-register'
  | 'restore-clone'
  | 'hard-stop'
  | 'key-generation-catch-up-and-reemit'
  | 'retry'
  | 'unknown'

/** Maps a broker error code to its VE-4 client action (the disposition table). */
export function classifyRejectDisposition(code: BrokerErrorCode): RejectDisposition {
  switch (code) {
    case 'CAPABILITY_REQUIRED':
    case 'CAPABILITY_EXPIRED':
    case 'CAPABILITY_GENERATION_STALE':
    case 'CAPABILITY_INVALID':
      return 'capability-re-present'
    case 'DEVICE_NOT_REGISTERED':
      return 'device-re-register'
    case 'DEVICE_REVOKED':
      return 'restore-clone'
    case 'SEQ_COLLISION_DETECTED':
      return 'restore-clone'
    case 'AUTHOR_MISMATCH':
      return 'hard-stop'
    // A2 Teil B (TOFU): the personal doc is owner-bound to a DIFFERENT DID. Like
    // AUTHOR_MISMATCH this is a HARD STOP, no retry — but it throws its own typed
    // PersonalDocOwnerMismatchError (see throwHardStop), not the author-binding error.
    case 'PERSONAL_DOC_OWNER_MISMATCH':
      return 'hard-stop'
    case 'DEVICE_ID_CONFLICT':
      return 'device-re-register'
    // Slice SR / VE-C2: the LEGITIME LAGGER — a still-active member that authored a
    // log-entry under a content key whose generation the broker has already rotated
    // PAST. The broker rejects the OLD-gen write KEY_GENERATION_STALE (Sync 003
    // §Broker-Ingest-Generations-Gate). The client MUST catch up the missed
    // rotation, then re-emit the SAME CRDT update under a NEW seq + the new
    // keyGeneration. Re-using the same seq is forbidden (the deterministic nonce is
    // SHA-256(deviceId|seq) WITHOUT keyGeneration, so same seq + new key = AES-GCM
    // nonce reuse — the Slice-A nonce-reuse blocker).
    case 'KEY_GENERATION_STALE':
      return 'key-generation-catch-up-and-reemit'
    case 'NONCE_REPLAY':
    case 'RATE_LIMITED':
    case 'INTERNAL_ERROR':
      return 'retry'
    default:
      return 'unknown'
  }
}

/** Hard-stop signal for the AUTHOR_MISMATCH bug class (no retry). */
export class AuthorMismatchError extends Error {
  readonly docId: string
  readonly deviceId: string
  readonly authorKid: string
  constructor(docId: string, deviceId: string, authorKid: string) {
    super(
      `AUTHOR_MISMATCH for docId=${docId} deviceId=${deviceId} authorKid=${authorKid}: ` +
        'authorKid<->deviceId binding bug — hard stop, no retry',
    )
    this.name = 'AuthorMismatchError'
    this.docId = docId
    this.deviceId = deviceId
    this.authorKid = authorKid
  }
}

/**
 * A2 Teil B (TOFU personal-doc owner-binding): the relay rejected a personal-doc
 * operation (present-capability / log-entry / sync-request) with
 * PERSONAL_DOC_OWNER_MISMATCH because the doc is owner-bound to a DIFFERENT DID than
 * ours (Sync 003). HARD STOP, no retry, never auto-recovered: either a leaked
 * personalDocId is being driven by a foreign DID (an attack — silently retrying would
 * spin a loop), or our own DID lost the TOFU first-claim race for this docId. Surfaced
 * via {@link LogSyncCoordinatorConfig.onSecurityError} (the throw otherwise only reaches
 * the messaging dispatch, which console.error-logs callback errors and would swallow it)
 * and re-thrown so it cannot be degraded into a retry. Parallels {@link AuthorMismatchError}
 * (the other identity-binding hard stop) and {@link SeqCollisionError}.
 */
export class PersonalDocOwnerMismatchError extends Error {
  readonly docId: string
  readonly deviceId: string
  constructor(docId: string, deviceId: string) {
    super(
      `PERSONAL_DOC_OWNER_MISMATCH for docId=${docId} deviceId=${deviceId}: the personal ` +
        'doc is owner-bound to a different DID — hard stop, no retry',
    )
    this.name = 'PersonalDocOwnerMismatchError'
    this.docId = docId
    this.deviceId = deviceId
  }
}

/**
 * Durable Wiring / E1: a NON-TRANSIENT failure of the durable local log-append
 * ({@link DocLogStore.appendLocalEntry}) — exhausted seq-reservation retries, an
 * IndexedDB quota/abort/corruption, or a build()/crypto failure. Distinct from a
 * transient SEND failure (offline / no connection), which is retried on reconnect.
 *
 * The CRDT state MUST NOT be reported as advanced when this is thrown: the
 * seed/update is not durably logged, so swallowing it to console.debug would let
 * "the space exists locally but was never logged" drift in (partial-durability).
 * The adapters' first-publication / write / restore-clone-rewrite catches surface
 * (rethrow) this instead of degrading it to a deferred-retry log line.
 */
export class LocalAppendFailedError extends Error {
  readonly docId: string
  readonly deviceId: string
  readonly reason: unknown
  constructor(docId: string, deviceId: string, reason: unknown) {
    super(
      `local log-append failed for docId=${docId} deviceId=${deviceId}: ` +
        `${reason instanceof Error ? reason.message : String(reason)}`,
    )
    this.name = 'LocalAppendFailedError'
    this.docId = docId
    this.deviceId = deviceId
    this.reason = reason
  }
}

/**
 * VE-11 Trigger 2 (Durable Wiring): a WRITE-PATH SEQ_COLLISION_DETECTED — the relay
 * saw a DIFFERENT contentHash at an already-stored (docId, deviceId, seq), i.e.
 * seq-REUSE = deterministic-nonce-reuse-imminent. This signals a VIOLATED invariant
 * (bug / corruption / attack); a smooth auto-recover would MASK a potential AES-GCM
 * break, so it is thrown HARD and NEVER auto-recovered. The recoverable mid-session
 * case (catch-up brokerSeq>localSeq) is the SEPARATE Trigger-1 restore-clone+rebind
 * path — it never reaches this error.
 */
export class SeqCollisionError extends Error {
  readonly docId: string
  readonly deviceId: string
  readonly seq?: number
  constructor(docId: string, deviceId: string, seq?: number) {
    super(
      `SEQ_COLLISION_DETECTED (write-path) for docId=${docId} deviceId=${deviceId} ` +
        `seq=${seq ?? '?'}: seq-reuse = nonce-reuse-imminent — hard stop, never auto-recover`,
    )
    this.name = 'SeqCollisionError'
    this.docId = docId
    this.deviceId = deviceId
    this.seq = seq
  }
}

/**
 * VE-11 (Durable Wiring): our CURRENT device was DEVICE_REVOKED mid-session on a
 * write. A revoked device MUST NOT silently re-clone itself back in (that would let
 * a revoked device re-admit itself), so this is surfaced for re-auth / re-join
 * rather than auto-recovered. A straggler write under an OLD / already-rotated
 * deviceId is instead dropped silently (a benign late reject, no surface).
 */
export class DeviceRevokedError extends Error {
  readonly docId: string
  readonly deviceId: string
  constructor(docId: string, deviceId: string) {
    super(
      `DEVICE_REVOKED for docId=${docId} deviceId=${deviceId}: the current device was ` +
        'revoked — re-auth/re-join required, no silent re-clone',
    )
    this.name = 'DeviceRevokedError'
    this.docId = docId
    this.deviceId = deviceId
  }
}

/**
 * A write-path reject the relay routed back as `{ type:'error', thid, code }`
 * after a SENT log-entry (P2-NIT-1, VE-4/VE-5). The coordinator classifies the
 * code and, for the actions whose *mechanism* is an adapter/runtime concern
 * (mint a new deviceId + device-revoke the old one + re-register), delegates to
 * {@link WriteRejectHandler}. Engine-neutral so Phase 4 (Automerge) reuses it.
 */
export interface WriteReject {
  /** The structured broker error code (matched on code, never free-text). */
  code: BrokerErrorCode
  /** The VE-4 disposition the code maps to. */
  disposition: RejectDisposition
  /** The docId the rejected write targeted. */
  docId: string
  /** The deviceId under which the rejected write was authored. */
  deviceId: string
}

/**
 * Adapter/runtime hook the coordinator calls on a write-path reject whose
 * resolution it cannot perform engine-internally (P2-NIT-1):
 *  - `restore-clone` (SEQ_COLLISION_DETECTED / DEVICE_REVOKED): mint a NEW
 *    deviceId, device-revoke the old one, restart the (deviceId,docId) log at
 *    seq=0, and re-write pending under the new deviceId. NEVER re-use the
 *    colliding seq with divergent plaintext.
 *  - `device-re-register` (DEVICE_NOT_REGISTERED / DEVICE_ID_CONFLICT): register
 *    a deviceId (challenge-response) before the next log-entry.
 * The coordinator handles `capability-re-present` itself and HARD-STOPS
 * `hard-stop` (AUTHOR_MISMATCH) before this hook is ever called.
 *
 * The handler returns the deviceId the coordinator MUST use for subsequent
 * writes (a NEW one for restore-clone; the same one for a pure re-register).
 * Returning a value re-binds the coordinator's seq namespace atomically.
 */
export type WriteRejectHandler = (reject: WriteReject) => Promise<{ deviceId: string } | void>

/** A control frame the coordinator sends and awaits a receipt for. */
export interface ControlFrameTransport {
  sendControlFrame(frame: ControlFrame): Promise<ControlFrameReceipt>
}

/** A `send`-envelope transport for `log-entry` / `sync-request`. */
export interface EnvelopeTransport {
  send(envelope: LogEntryMessage | SyncResponseMessage | object): Promise<unknown>
  onMessage?(callback: (message: unknown) => void | Promise<void>): () => void
}

/** Capability material the coordinator presents + re-issues for a docId. */
export interface CapabilitySource {
  /**
   * Returns a fresh, valid capability JWS for the docId (read+write). The
   * coordinator calls this before the first present-capability and again on a
   * CAPABILITY_* reject (re-issue / refresh). Space-docs return a Space-Capability
   * (`kid = wot:space:<spaceId>#cap-<generation>`); Personal-docs return a
   * self-issued Personal-Doc-Capability (`kid = <did>#<vm>`).
   */
  getCapabilityJws(): Promise<string>
}

/** Engine-specific encode/apply (Yjs/Automerge supply these). */
export interface LogSyncEngineHooks {
  /** The CRDT engine identifier carried for engine-foreign skip (VE-3). */
  readonly engine: string
  /** Encode the local CRDT update for the log payload plaintext. Identity for raw-bytes engines. */
  encodeUpdate(update: Uint8Array): Uint8Array
  /** Apply a decrypted remote update to the CRDT with origin='remote' (LOOP-GUARD). */
  applyRemoteUpdate(plaintext: Uint8Array): void | Promise<void>
  // Slice B v2: the optional isForeignPayload sniff was REMOVED with the (a)-model.
  // It only existed to avoid BUFFERING a cross-engine payload as a false seq-gap.
  // With out-of-order apply (no seq-buffer) a same-engine entry above a hole applies
  // idempotently (Yjs state-vector; Automerge buffers missing deps internally — it
  // does NOT throw), while a genuine cross-engine entry throws in applyRemoteUpdate
  // and is caught as engine-foreign-skip. So the sniff is obsolete.
}

export interface LogSyncCoordinatorConfig {
  docId: string
  /** The local device UUID (per-(deviceId,docId) seq namespace). */
  deviceId: string
  /** The local routing DID (envelope from/to for own-device multi-device sync). */
  ownDid: string
  /** The author key id (`did:key:...#...`); MUST match {@link signLogEntry}'s key. */
  authorKid: string
  crypto: ProtocolCryptoAdapter
  logStore: DocLogStore
  control: ControlFrameTransport
  envelopes: EnvelopeTransport
  capabilities: CapabilitySource
  hooks: LogSyncEngineHooks
  /** Signs the log-entry JWS signing input with the author Ed25519 key. */
  signLogEntry: JcsEd25519SignFn
  /**
   * The routing recipients for outgoing log-entry / sync-request envelopes — the
   * space's member DIDs (Personal-docs: just the own DID). Defaults to `[ownDid]`
   * (own-device multi-device). The relay broadcasts to every member's sockets.
   */
  getRecipients?: () => Promise<string[]> | string[]
  /** Resolves the current Space Content Key + generation for the docId. */
  getContentKey(): Promise<{ key: Uint8Array; generation: number } | null>
  /** Resolves a content key by generation for decrypting remote/historic entries. */
  getContentKeyByGeneration(generation: number): Promise<Uint8Array | null>
  /**
   * Slice SR / VE-C2: wait (bounded) until the local CURRENT generation has advanced
   * strictly PAST `rejectedGeneration` — i.e. the missed key-rotation has arrived in
   * the inbox and been imported into key management — then resolve `true`. Resolve
   * `false` if the new generation is not yet importable within the wait window (the
   * rotation key has not arrived). The coordinator uses this to PARK a
   * KEY_GENERATION_STALE re-emit instead of busy-spinning: a `false` result leaves
   * the stale entry 'pending' so the normal blocked-by-key / reconnect path retries
   * once the rotation lands.
   *
   * Omitted ⇒ the coordinator falls back to a single immediate generation check via
   * {@link getContentKey} (no wait): re-emit only if the new gen is already present.
   */
  awaitKeyGenerationAdvance?: (rejectedGeneration: number) => Promise<boolean>
  /** Available key generations for blocked-by-key classification (VE-5 preview). */
  getAvailableKeyGenerations(): Promise<readonly number[]>
  /**
   * Sends the space-register control frame for the docId (VE-8), or returns
   * undefined for Personal-docs (no space-register). Idempotent re-registers are
   * first-writer-wins on the relay. The coordinator awaits its receipt before
   * present-capability.
   */
  sendSpaceRegister?: () => Promise<ControlFrameReceipt | undefined>
  /**
   * Write-path reject handler (P2-NIT-1, VE-4/VE-5). Called when the relay
   * rejects a SENT log-entry with a restore-clone / device-re-register
   * disposition; the handler performs the deviceId-minting / device-revoke /
   * re-register mechanism (an adapter/runtime concern) and returns the deviceId
   * the coordinator must use next. Omitted ⇒ the reject is surfaced via the
   * return of {@link LogSyncCoordinator.handleWriteReject} but no restore is
   * performed (the coordinator never mints a deviceId itself).
   */
  onWriteRejected?: WriteRejectHandler
  /**
   * Called after a restore-clone has re-bound the active deviceId (VE-4/VE-5),
   * with the NEW deviceId. The adapter re-writes the current CRDT state under the
   * new deviceId from seq=0 (e.g. one fresh log-entry carrying the full Yjs state)
   * — this is the "pending neu schreiben unter neuer deviceId" step. The colliding
   * seq under the OLD deviceId is abandoned (never re-used with divergent
   * plaintext). When omitted, the coordinator falls back to {@link resendPending}
   * (only safe when the store's pending entries were already re-keyed externally).
   */
  onAfterRestoreClone?: (newDeviceId: string) => Promise<void> | void
  /**
   * VE-11 Trigger 2: a programmatic surface for the HARD security detectors
   * ({@link SeqCollisionError} = write-path seq-reuse = nonce-reuse-imminent, and
   * {@link DeviceRevokedError} = our current device was revoked). handleWriteReject
   * still THROWS these, but the throw propagates through the messaging onMessage
   * dispatch which only console.error-logs callback errors — so the application
   * cannot reliably react. This hook gives the composition root a reliable callback
   * to halt / alert / re-auth. Invoked BEFORE the throw; must not itself throw.
   */
  onSecurityError?: (error: Error) => void
  /**
   * Slice B / VE-B1: the sync-request page size sent as `body.limit`. Defaults to
   * {@link DEFAULT_CATCH_UP_PAGE_SIZE} (100, matching the relay default). Config-
   * driven so the value is set once here rather than threaded through every adapter
   * call to the arg-less {@link LogSyncCoordinator.catchUp}. Festival perf-tuning
   * (e.g. 500) is a separate item.
   */
  catchUpPageSize?: number
  /**
   * Per-page sync-response wait, in ms (default 1000). Config-driven so it is set
   * once here rather than threaded through the arg-less {@link LogSyncCoordinator.catchUp}.
   * Production keeps the 1000ms default; the knob exists so test harnesses can widen it
   * to avoid a real wall-clock timer racing a CPU-starved event loop under heavy parallel
   * CI load (a benign per-page abort that, repeated, can stall a multi-epoch convergence).
   * An explicit `timeoutMs` passed to the internal catch-up still takes precedence.
   */
  catchUpPageTimeoutMs?: number
  /** Clock (testable). */
  now?: () => Date
}

/** Result of {@link LogSyncCoordinator.receiveLogEntry}. */
export type ReceiveLogEntryResult =
  | { disposition: 'applied'; deviceId: string; seq: number }
  | { disposition: 'idempotent-skip'; deviceId: string; seq: number }
  | { disposition: 'engine-foreign-skip'; reason: string }
  // Slice B / VE-B1: blocked-by-key carries the authoring (deviceId, seq) too, so
  // the pagination loop's per-page `buffered` count is exact (the terminator must
  // distinguish a pure-buffer page from a no-progress page).
  | { disposition: 'blocked-by-key'; deviceId: string; seq: number; keyGeneration: number }
  // Slice B v2: there is NO 'blocked-by-seq' disposition. Out-of-order apply means a
  // decryptable entry above a hole is applied IMMEDIATELY (idempotent, commutative) —
  // the seq-gap is only sync-head bookkeeping (getStrictContiguousHeads), never a buffer.
  | { disposition: 'rejected'; reason: string }

/**
 * Slice B / VE-B1: the typed catch-up result. Additive on the pre-B
 * `{ restoreCloneRequired }` shape (all 8+ adapter call-sites use only
 * `.catchUp().catch(...)`, none reads the result, so adding fields is safe).
 *
 *  - `complete:true`  ⇒ the relay reported `truncated:false` (no more pages). NOTE:
 *    `complete:true` is NOT "lückenlos synchron" — a strict-contiguous head may still
 *    sit behind an open hole; `pendingGaps` lists those (resolved via VE-B2 soft-skip
 *    + GapRepair, never the pagination loop). The caller MUST consult `pendingGaps`.
 *  - `complete:false` ⇒ the loop stopped EARLY; `incomplete` says why:
 *    - `'gap-pending'` (b): a `truncated:true` page applied entries OVER a hole but the
 *      strict-contiguous head did not advance — re-requesting the same head would
 *      re-fetch the same page (loop). NOT an error; VE-B2 soft-skip/GapRepair resolves it.
 *    - `'blocked-by-key'` (b): a page only buffered key-missing entries — NOT an error,
 *      retried after a key import.
 *    - `'timeout'` (c): a `truncated:true` page's follow-up response never arrived
 *      — NOT an error; retried on the next reconnect.
 *  The no-progress DoS class (d) does NOT surface here — it THROWS (the only throw
 *  class), so it can never be silently swallowed as "incomplete".
 */
export interface CatchUpResult {
  restoreCloneRequired: boolean
  complete: boolean
  incomplete?: 'gap-pending' | 'blocked-by-key' | 'timeout' | 'no-progress'
  /** Slice B / VE-B2: open seq-gaps still unfilled after this catch-up (may be non-empty even on complete:true). */
  pendingGaps?: GapRef[]
}

/** Slice B / VE-B1: thrown when a `truncated:true` page makes NO progress (no entry applied AND none buffered) — the no-progress DoS guard, the ONLY throw class of the pagination loop. */
export class SyncNoProgressError extends Error {
  readonly docId: string
  constructor(docId: string) {
    super(
      `sync pagination made no progress for docId=${docId}: the relay reports truncated:true ` +
        'but applied no new entry and buffered none — aborting to avoid an unbounded loop (no-progress DoS guard)',
    )
    this.name = 'SyncNoProgressError'
    this.docId = docId
  }
}

export class LogSyncCoordinator {
  private readonly config: LogSyncCoordinatorConfig
  private readonly now: () => Date

  /**
   * The ACTIVE local deviceId for the seq namespace. Starts at `config.deviceId`
   * and is re-bound by a restore-clone (VE-4/VE-5): a SEQ_COLLISION /
   * DEVICE_REVOKED reject mints a NEW deviceId (via {@link WriteRejectHandler}),
   * and every subsequent write reserves seq from 0 under that new id. The
   * colliding seq is NEVER re-used with divergent plaintext.
   */
  private deviceId: string

  /**
   * Per-(socket,docId) control-frame serialization (VE-9). Because this
   * coordinator is bound to ONE docId on ONE messaging adapter (= one socket),
   * a single Promise tail enforces "never two docId-equal control frames
   * in-flight": every control frame chains onto the previous one.
   */
  private controlTail: Promise<unknown> = Promise.resolve()

  /** Idempotency guard for applied (deviceId,seq) — mirrors the durable store. */
  private readonly applied = new Set<string>()

  /** Whether space-register + present-capability have completed on this connection. */
  private published = false
  /** In-flight first-publication promise (deduped). */
  private publishing: Promise<void> | null = null

  /**
   * In-flight sync-requests awaiting their async sync-response, keyed by the
   * request id (= response thid). The relay answers a sync-request asynchronously
   * as a routed message, so {@link handleIncoming} resolves the matching waiter.
   */
  private readonly pendingSyncRequests = new Map<
    string,
    (response: SyncResponseMessage) => void
  >()

  /**
   * VE-5 blocked-by-key buffer: incoming log-entry envelopes whose keyGeneration
   * is not yet available locally. Keyed by `${deviceId} ${seq}` (the
   * authoring device's, NOT ours) so a re-buffer is idempotent and a re-applied
   * entry is dropped from the buffer. Replayed (origin='remote') after a key
   * import — NEVER through the local write path (LOOP-GUARD).
   */
  private readonly blockedByKey = new Map<string, LogEntryMessage>()

  /**
   * Slice B v2 / VE-B1 pagination re-entrancy guard, per docId-scoped catch-up. A
   * gap-triggered catch-up (VE-B2) or a reconnect WHILE a catch-up is already running
   * MUST NOT start a second concurrent loop (competing sync-request / recordRemoteApplied
   * on the same store). A trigger during an in-flight catch-up is COALESCED (short-circuit
   * return) — there is NO outer re-run loop (the Opus DoS blocker: the old do-while spun
   * because a gap-pending page set catchUpAgain forever). Coexists with this.publishing,
   * this.restoreCloneInFlight and this.reemitInFlight — the established SR guard pattern.
   */
  private catchingUp = false

  /**
   * Slice B v3: the in-flight catch-up's settle-promise (set whenever `catchingUp` is set, by
   * BOTH catchUp() and runFirstPublication). Lets runFirstPublication AWAIT an already-running
   * catch-up instead of starting a second parallel pagination loop (Codex: the guard must be
   * bidirectional — ensurePublished() starting while a catchUp() is in flight). SETTLES WITH the
   * catch-up outcome and REJECTS on failure (since #214 / loop-review #2): a coalescing awaiter
   * (runFirstPublication / catchUp) propagates that rejection so the first write is never allowed
   * on an unconfirmed head-abgleich / restore-clone (BLOCKER-1b). The detached no-op `.catch` on
   * the stored handle only guards against an unhandled rejection when nobody is coalescing.
   */
  private catchUpInFlight: Promise<void> | null = null

  /**
   * Slice B v2 / VE-B2: a monotonically increasing connection-epoch counter, bumped on
   * every resetForReconnect(). Threaded into recordGapObservation so the soft-skip gate
   * counts DISTINCT reconnect epochs, not catch-ups of the same connection (Codex-BLOCKER:
   * catchUp() can run multiple times within ONE connection via gap-trigger / requestSync /
   * reconnect-followup, so the epoch must increment per real reconnect, not per catchUp).
   */
  private connectionEpoch = 0

  /**
   * Sent log-entry messageId → the (deviceId, seq) it carried, so a routed
   * write-path reject (`{ type:'error', thid }`) correlates to the exact write
   * (P2-NIT-1). Bounded; entries are dropped on correlate or when the ring caps.
   *
   * Slice SR / VE-C2 (retention): a LIVE write also retains the plaintext `encoded`
   * CRDT update IN-MEMORY (never durable — no new plaintext-at-rest) so a
   * KEY_GENERATION_STALE reject can re-emit the SAME update under a NEW seq without
   * re-decrypting. `encoded` is absent for a {@link resendPending} re-send (the
   * stored JWS, not a live update) — that case falls back to crash-recovery
   * (decrypt the persisted alt-gen JWS with the historical content key). A
   * cap-dropped entry loses its `encoded` and likewise falls to crash-recovery.
   */
  private readonly inFlightWrites = new Map<
    string,
    { deviceId: string; seq: number; encoded?: Uint8Array }
  >()

  /** Re-entrancy guard so a single reject triggers exactly one restore-clone. */
  private restoreCloneInFlight = false

  /**
   * VE-11 write-pause gate. While a restore-clone is re-binding the deviceId
   * (mint → persist → fresh-socket re-register), this is a PENDING promise that
   * every log-entry send (sendLogEntryEnvelope) awaits, so NO envelope goes out
   * under the new deviceId before it is `registered` at the broker (which would
   * race a DEVICE_NOT_REGISTERED window). null = open (steady state); resolved +
   * nulled the instant the new deviceId is registered.
   */
  private rebinding: Promise<void> | null = null

  /**
   * VE-C2 re-entrancy guard, keyed by the rejected (deviceId,seq): a single
   * KEY_GENERATION_STALE reject drives exactly one catch-up-and-re-emit, so a
   * re-routed/duplicated error frame for the same write cannot double-emit.
   */
  private readonly reemitInFlight = new Set<string>()

  /**
   * VE-C2 parked re-emits: a KEY_GENERATION_STALE reject whose missed rotation has
   * NOT yet arrived locally is PARKED here (keyed by the rejected (deviceId,seq))
   * instead of busy-spinning. {@link replayPendingReemits} drains it when a rotation
   * lands (the adapter calls it next to {@link replayBlockedByKey} on a key import).
   * The value is the live in-memory plaintext if still retained, else undefined ⇒
   * the replay recovers it from the persisted alt-gen JWS (crash-recovery decrypt).
   */
  private readonly pendingReemits = new Map<string, { deviceId: string; seq: number; encoded?: Uint8Array }>()

  constructor(config: LogSyncCoordinatorConfig) {
    this.config = config
    this.now = config.now ?? (() => new Date())
    this.deviceId = config.deviceId
  }

  /** The current active local deviceId (re-bound by a restore-clone). */
  getDeviceId(): string {
    return this.deviceId
  }

  /**
   * Whether this coordinator has a SENT log-entry awaiting a receipt under the
   * given messageId. A multi-doc adapter uses this to route a routed write-path
   * `error` frame (`thid == messageId`) to the OWNING coordinator only, so an
   * error for doc A never triggers a (false) restore-clone on doc B's coordinator.
   */
  hasInFlightWrite(messageId: string): boolean {
    return this.inFlightWrites.has(messageId)
  }

  /** Reset connection-scoped state on (re)connect — a new socket = empty scope cache (VE-4/VE-9). */
  resetForReconnect(): void {
    this.published = false
    this.publishing = null
    this.controlTail = Promise.resolve()
    this.pendingSyncRequests.clear()
    // VE-B1: a new socket = no in-flight pagination loop (the old socket's waiters
    // were just cleared). Reset the guard so the reconnect's catch-up is not coalesced
    // into a stale in-flight flag.
    this.catchingUp = false
    // VE-B2: a real reconnect is a NEW connection epoch. This is the mechanical carrier
    // of the "3 distinct epochs" soft-skip gate — without the bump, three catch-ups of
    // one connection would all share epoch 0 and never reach the 3-epoch threshold.
    this.connectionEpoch += 1
  }

  /** Slice B / VE-B2: the current connection-epoch (test/inspection). */
  getConnectionEpoch(): number {
    return this.connectionEpoch
  }

  /**
   * Single inbound dispatcher (wire the messaging adapter's onMessage to this).
   * Routes `log-entry/1.0` to the LOOP-GUARD read path and `sync-response/1.0` to
   * the matching in-flight sync-request waiter. Anything else is ignored here.
   */
  async handleIncoming(message: unknown): Promise<void> {
    const type = (message as { type?: unknown })?.type
    if (type === 'https://web-of-trust.de/protocols/log-entry/1.0') {
      await this.receiveLogEntry(message)
      return
    }
    // P2-NIT-1: a routed write-path reject for a SENT log-entry. The relay
    // answers an ingest-gate failure with `{ type:'error', thid, code }` (NOT a
    // control-frame ControlFrameRejectedError, which only the control channel
    // throws). Correlate thid → the rejected (deviceId, seq) and drive the
    // reject-disposition action (VE-4/VE-5).
    if (type === 'error') {
      await this.onWritePathErrorFrame(message)
      return
    }
    if (type === 'https://web-of-trust.de/protocols/sync-response/1.0') {
      let response: SyncResponseMessage
      try {
        response = parseSyncResponseMessage(message)
      } catch {
        return
      }
      if (response.body.docId !== this.config.docId) return
      const waiter = this.pendingSyncRequests.get(response.thid)
      if (waiter) {
        this.pendingSyncRequests.delete(response.thid)
        waiter(response)
      } else {
        // Unsolicited / late sync-response: still apply idempotently (catch-up safety).
        await this.applySyncResponse(response)
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Control-frame serialization (VE-9)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue a control frame so it runs strictly after every previously enqueued
   * control frame for this (socket, docId). Never two docId-equal control frames
   * in flight (VE-9 receipt-ambiguity guard).
   */
  private enqueueControlFrame(frame: ControlFrame): Promise<ControlFrameReceipt> {
    const run = this.controlTail.then(() => this.config.control.sendControlFrame(frame))
    // Keep the tail alive even if this frame rejects (next frame still serializes).
    this.controlTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Slice SR / VE-C1: send a `space-rotate` control frame for THIS doc through the
   * same strictly-serialized per-(socket, docId) control tail the first-publication
   * sequence uses (VE-9 receipt-ambiguity guard — receipt.messageId == docId).
   *
   * The frame MUST already be the admin-signed `{ type:'space-rotate', rotationJws }`
   * for this space (the secure-removal workflow builds it). Returns the broker
   * receipt; a reject surfaces as a {@link ControlFrameRejectedError} (the workflow
   * distinguishes a hard reject from a transient transport failure).
   */
  async sendSpaceRotate(frame: ControlFrame): Promise<ControlFrameReceipt> {
    return this.enqueueControlFrame(frame)
  }

  /**
   * Slice SR / B3: re-present the CURRENT-generation capability to re-grant the
   * relay's per-doc scope. A successful space-rotate invalidates the rotating
   * admin's OWN old-generation scope at the relay (it drops every older-generation
   * scope across all sockets), so a subsequent write under the new generation would
   * be capability-gated. This re-presents the (now new-generation) capability so the
   * very next durable write (the canonical membership-removal log entry, written
   * synchronously by the secure-removal commit) is accepted instead of timing out on
   * a stale scope. Goes through the same serialized control tail (VE-9). The
   * capability source mints for {@link getCapabilityJws}'s current generation, so the
   * caller MUST have already activated the new generation (commitStagedRotation).
   */
  async rePresentCapability(): Promise<void> {
    await this.presentCapabilityWithRetry()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // First-publication state machine (VE-2 §207) + present-capability (VE-9)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the closed first-publication sequence exactly once per connection
   * (VE-2 §207):
   *   (1) [Space] space-register, await its receipt (VE-8)
   *   (2) present-capability(read+write), await its receipt (VE-9)
   *   (3) sync-request → broker head-abgleich (VE-4)
   *   (4) classifyLocalBrokerSeqConsistency → restore-clone if broker_seq>local_seq
   * Only after this may the first log-entry be sent. Idempotent + deduped.
   */
  async ensurePublished(): Promise<void> {
    if (this.published) return
    if (this.publishing) return this.publishing
    this.publishing = this.runFirstPublication()
    try {
      await this.publishing
      this.published = true
    } finally {
      this.publishing = null
    }
  }

  private async runFirstPublication(): Promise<void> {
    // (1) Space-register (VE-8). Personal-docs skip this. Idempotent re-register
    //     is first-writer-wins on the relay. A reject is run through the
    //     disposition table so AUTHOR_MISMATCH hard-stops here too (no swallow).
    if (this.config.sendSpaceRegister) {
      try {
        await this.config.sendSpaceRegister()
      } catch (err) {
        // dispositionForError throws AuthorMismatchError on a hard stop; other
        // codes are surfaced raw (SPACE_ALREADY_REGISTERED with a conflicting set
        // is a genuine error the caller must see).
        this.dispositionForError(err)
        throw err
      }
    }
    // (2) present-capability (VE-9), with the reject-disposition retry loop.
    await this.presentCapabilityWithRetry()
    // VE-11: a restore-clone re-publish (restoreClone set published=false then called
    // ensurePublished) must do (1) space-register + (2) present-capability under the NEW
    // deviceId, but MUST NOT re-run the catch-up (3)+(4): (a) it is ALREADY acting on the
    // catch-up disposition that triggered it, so re-running is redundant — the fresh
    // deviceId has no broker history to reconcile; (b) it runs INSIDE the outer catch-up
    // (catchingUp=true, catchUpInFlight=the outer work), so the re-entrancy guard below
    // would await the outer work — which is awaiting THIS restore-clone → deadlock.
    if (this.restoreCloneInFlight) return
    // (3)+(4) sync-request head-abgleich + seq-consistency (VE-4). BLOCKER-1b
    //     defense-in-depth: a broker_seq>local_seq disposition is no longer dead
    //     code — it is acted on HERE (restore-clone BEFORE the first write), so a
    //     seq=0 is never re-entered under a broker-known deviceId.
    // VE-B1 (v3): run the first-publication catch-up under the SAME re-entrancy guard, in BOTH
    // directions (Codex): (a) while it runs, catchingUp blocks a competing catchUp(); (b) if a
    // catchUp() is ALREADY in flight when we get here, do NOT start a second parallel pagination
    // loop — AWAIT the in-flight one (it does the catch-up + acts on the restore disposition).
    // Its outcome PROPAGATES (catchUpInFlight rejects on failure): if the in-flight catch-up
    // FAILED, this await THROWS → ensurePublished() rejects and does NOT set published, so the
    // first write is never allowed on an unconfirmed head-abgleich / restore-clone (BLOCKER-1b).
    // Check-then-capture is atomic here (no await between); catchingUp ⇒ catchUpInFlight set.
    const inFlight = this.catchUpInFlight
    if (this.catchingUp && inFlight) {
      await inFlight
      return
    }
    this.catchingUp = true
    const work = (async (): Promise<void> => {
      const result = await this.catchUpInternal({ presentCapabilityFirst: false })
      await this.actOnRestoreDisposition(result)
    })()
    // Same non-swallowing handle as catchUp() (rejects on failure; detached no-op guards against
    // an unhandled rejection if no one coalesces). `await work` below propagates the error here.
    const ownInFlight = work.then(() => undefined)
    ownInFlight.catch(() => {})
    this.catchUpInFlight = ownInFlight
    try {
      await work
    } finally {
      this.catchingUp = false
      this.catchUpInFlight = null
    }
  }

  /**
   * Present the current capability and await its receipt. On a CAPABILITY reject
   * re-source the capability and re-present (VE-9 reject-semantics). Other reject
   * codes propagate (the caller maps DEVICE / AUTHOR_MISMATCH dispositions).
   */
  private async presentCapabilityWithRetry(maxAttempts = 3): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const capabilityJws = await this.config.capabilities.getCapabilityJws()
      const frame = createPresentCapabilityControlFrame({ capabilityJws })
      try {
        await this.enqueueControlFrame(frame)
        return
      } catch (err) {
        lastError = err
        const disposition = this.dispositionForError(err)
        if (disposition === 'capability-re-present') continue
        throw err
      }
    }
    throw lastError instanceof Error ? lastError : new Error('present-capability failed')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Write path (VE-2)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Write a local CRDT update through the log path (VE-2):
   *  - ensurePublished() first (no log-entry before present-capability receipt),
   *  - appendLocalEntry reserves seq atomically and persists the JWS BEFORE send,
   *  - send the `log-entry/1.0` plaintext envelope.
   * Returns the persisted entry, or null if there is no content key yet.
   *
   * LOOP-GUARD: this is the ONLY producer of outgoing log-entry envelopes. The
   * read path never calls it. One local edit → one log-entry envelope.
   */
  async writeLocalUpdate(update: Uint8Array): Promise<LocalLogEntry | null> {
    const content = await this.config.getContentKey()
    if (!content) return null

    await this.ensurePublished()

    const encoded = this.config.hooks.encodeUpdate(update)
    const { docId } = this.config
    // The active deviceId is mutable (a restore-clone re-binds it). authorKid is
    // the Identity-Key DID#vm — it does NOT change on a restore-clone (only the
    // per-device seq namespace is reset under the new deviceId).
    const deviceId = this.deviceId
    const authorKid = this.config.authorKid

    let entry: LocalLogEntry
    try {
      entry = await this.config.logStore.appendLocalEntry({
        deviceId,
        docId,
        // build(seq) runs INSIDE the store's seq lock; the nonce binds (deviceId,seq)
        // and carries NO keyGeneration, so a generation switch can never collide a
        // seq (VE-2 invariant). Re-emission of a pending entry sends this exact JWS.
        build: async (seq: number) => {
          const payloadEncryption = await encryptLogPayload({
            crypto: this.config.crypto,
            spaceContentKey: content.key,
            deviceId,
            seq,
            plaintext: encoded,
          })
          const payload: LogEntryPayload = {
            seq,
            deviceId,
            docId,
            authorKid,
            keyGeneration: content.generation,
            data: payloadEncryption.blobBase64Url,
            timestamp: this.now().toISOString(),
          }
          return createLogEntryJwsWithSigner({ payload, sign: this.config.signLogEntry })
        },
      })
    } catch (err) {
      // E1: a durable local-append failure is NON-TRANSIENT (exhausted seq retries,
      // IDB quota/abort, or a build/crypto failure). Surface it as a typed error so
      // the adapter does NOT advance/announce CRDT state for a write that was never
      // logged — instead of letting the raw error fall into a console.debug-deferred
      // swallow. A transient SEND failure happens AFTER this point and stays retryable.
      throw new LocalAppendFailedError(docId, deviceId, err)
    }

    // VE-C2 retention: keep the plaintext `encoded` update IN-MEMORY (never durable)
    // bound to this send, so a KEY_GENERATION_STALE reject re-emits the SAME update
    // under a new seq without re-decrypting.
    await this.sendLogEntryEnvelope(entry.entryJws, entry.deviceId, entry.seq, encoded)
    return entry
  }

  /**
   * Re-send a pending entry's STORED JWS unchanged (reconnect retry, VE-2).
   *
   * CONCERN-1: filter to the ACTIVE deviceId. After a restore-clone re-bound the
   * deviceId, the OLD (revoked/colliding) deviceId's entries stay 'pending' in
   * the store (markAcked never ran for them — they were rejected, not accepted).
   * Re-emitting them on every reconnect would re-trigger DEVICE_REVOKED /
   * SEQ_COLLISION_DETECTED → a restore-clone reconnect loop (the same bug class as
   * the 5000+-outbox). The active-deviceId filter stops the loop: only entries the
   * relay can still accept are re-sent.
   */
  async resendPending(): Promise<void> {
    const pending = await this.config.logStore.getPending()
    for (const entry of pending) {
      if (entry.docId !== this.config.docId) continue
      if (entry.deviceId !== this.deviceId) continue
      await this.sendLogEntryEnvelope(entry.entryJws, entry.deviceId, entry.seq)
    }
  }

  /**
   * Send a log-entry envelope and remember its messageId → (deviceId, seq) so a
   * routed write-path reject (`{ type:'error', thid }`, P2-NIT-1) correlates back
   * to the exact rejected write. The map is bounded (cleared on ack/reject and
   * size-capped) so it cannot grow unbounded.
   */
  private async sendLogEntryEnvelope(
    entryJws: string,
    deviceId: string,
    seq: number,
    encoded?: Uint8Array,
  ): Promise<void> {
    // VE-11 write-pause: while a restore-clone re-binds the deviceId (mint → persist
    // → fresh-socket re-register), hold every log-entry send until the new deviceId
    // is `registered` — otherwise a concurrent write races a DEVICE_NOT_REGISTERED
    // window. An open (null) or already-resolved gate is a no-op.
    if (this.rebinding) await this.rebinding
    const recipients = await this.resolveRecipients()
    const messageId = cryptoRandomUuid()
    this.rememberInFlight(messageId, deviceId, seq, encoded)
    const message = createLogEntryMessage({
      id: messageId,
      from: this.config.ownDid,
      to: recipients,
      createdTime: Math.floor(this.now().getTime() / 1000),
      entry: entryJws,
    })
    const sendResult = await this.config.envelopes.send(message)
    // CONCERN-1: correlate the send's delivery receipt back to this exact write
    // and mark it acked, so it leaves the pending outbox. Without this every
    // self-authored entry stays 'pending' forever and resendPending re-emits the
    // whole log on every reconnect (stale-pending churn). The transport's
    // `send()` resolves with the relay's `{ messageId, status }` receipt
    // (messageId == this envelope id); delivered/accepted both mean the relay
    // took it (delivered = relayed to a peer, accepted = durably queued).
    this.markAckedOnReceipt(sendResult, messageId, deviceId, seq)
  }

  /**
   * If `sendResult` is a delivery receipt for `messageId` with a terminal-ok
   * status, drop the in-flight correlation and mark the (docId,deviceId,seq)
   * entry acked. Tolerant of transports that return a non-receipt value (then a
   * later routed `error` frame, or the next reconnect, drives the outcome).
   */
  private markAckedOnReceipt(
    sendResult: unknown,
    messageId: string,
    deviceId: string,
    seq: number,
  ): void {
    const receipt = asDeliveryReceipt(sendResult)
    if (!receipt) return
    if (receipt.messageId !== messageId) return
    if (receipt.status !== 'delivered' && receipt.status !== 'accepted') return
    this.inFlightWrites.delete(messageId)
    // Fire-and-forget: a failed markAcked only means a redundant re-send later,
    // never a correctness break (the stored JWS is bit-identical).
    void this.config.logStore.markAcked(this.config.docId, deviceId, seq).catch(() => {})
  }

  private rememberInFlight(messageId: string, deviceId: string, seq: number, encoded?: Uint8Array): void {
    // Bound the map: a write-path reject is rare, so a small ring is enough to
    // correlate the latest sends without leaking memory on the happy path. VE-C2:
    // a cap-dropped entry loses its retained `encoded` update; its KEY_GENERATION_STALE
    // reject then falls to the crash-recovery path (decrypt the persisted alt-gen JWS).
    if (this.inFlightWrites.size > 256) {
      const oldest = this.inFlightWrites.keys().next().value
      if (oldest !== undefined) this.inFlightWrites.delete(oldest)
    }
    this.inFlightWrites.set(messageId, { deviceId, seq, encoded })
  }

  private async resolveRecipients(): Promise<string[]> {
    if (!this.config.getRecipients) return [this.config.ownDid]
    const recipients = await this.config.getRecipients()
    // Always include the own DID (own-device multi-device) and de-dup.
    const set = new Set([this.config.ownDid, ...recipients])
    return [...set]
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Read path (VE-3) — LOOP-GUARD: no write, no re-broadcast
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Process an incoming `log-entry/1.0` envelope (VE-3):
   *   verifyLogEntryJws (authority via authorKid, NEVER envelope-from)
   *   → idempotent (deviceId,seq) skip
   *   → engine-foreign skip (verify ok, NOT applied as own CRDT state)
   *   → blocked-by-key classification (VE-5 preview)
   *   → decryptLogPayload → applyRemoteUpdate(origin='remote')
   *   → recordRemoteApplied (heads forward only).
   *
   * Crucially: NO appendLocalEntry, NO sendLogEntryEnvelope. This is the path
   * that produced the 5000+-outbox loop when it re-broadcast.
   */
  async receiveLogEntry(message: unknown): Promise<ReceiveLogEntryResult> {
    let parsed: LogEntryMessage
    try {
      parsed = parseLogEntryMessage(message)
    } catch {
      return { disposition: 'rejected', reason: 'malformed-envelope' }
    }

    let payload: LogEntryPayload
    try {
      payload = await verifyLogEntryJws(parsed.body.entry, { crypto: this.config.crypto })
    } catch {
      return { disposition: 'rejected', reason: 'invalid-jws' }
    }

    // Route guard: only entries for THIS doc.
    if (payload.docId !== this.config.docId) {
      return { disposition: 'rejected', reason: 'wrong-doc' }
    }

    const key = appliedKey(payload.deviceId, payload.seq)
    if (this.applied.has(key)) {
      return { disposition: 'idempotent-skip', deviceId: payload.deviceId, seq: payload.seq }
    }
    // Durable idempotency: a re-applied entry already recorded survives reload.
    const existing = await this.config.logStore.getEntry(payload.docId, payload.deviceId, payload.seq)
    if (existing) {
      this.applied.add(key)
      return { disposition: 'idempotent-skip', deviceId: payload.deviceId, seq: payload.seq }
    }

    // Engine-foreign payloads (VE-3): a log-entry of this space whose CRDT type is
    // not ours is protocol-conformant (verify ok, routing ok) but MUST NOT be
    // applied as our own CRDT state — skip without crash/loop. The classifier is
    // generic; an adapter may wrap the plaintext with an engine tag. Here we rely
    // on the engine's applyRemoteUpdate throwing for foreign bytes and treat a
    // decode/apply failure as a skip rather than a crash.
    // VE-5: an entry under a not-yet-available keyGeneration is BUFFERED (no drop,
    // no mis-decrypt), and replayed after the key is imported. Buffering keys by
    // the AUTHORING (deviceId,seq) so a re-delivery is idempotent. The replay runs
    // through THIS read path again (origin='remote') — never the write path.
    const blocked = await this.classifyBlockedByKey(payload.keyGeneration)
    if (blocked) {
      this.bufferBlockedByKey(payload.deviceId, payload.seq, parsed)
      return { disposition: 'blocked-by-key', deviceId: payload.deviceId, seq: payload.seq, keyGeneration: payload.keyGeneration }
    }

    const contentKey = await this.config.getContentKeyByGeneration(payload.keyGeneration)
    if (!contentKey) {
      this.bufferBlockedByKey(payload.deviceId, payload.seq, parsed)
      return { disposition: 'blocked-by-key', deviceId: payload.deviceId, seq: payload.seq, keyGeneration: payload.keyGeneration }
    }

    // Decrypt the payload (side-effect-free; only applyRemoteUpdate mutates the CRDT).
    let plaintext: Uint8Array
    try {
      const blob = decodeBase64Url(payload.data)
      plaintext = await decryptLogPayload({ crypto: this.config.crypto, spaceContentKey: contentKey, blob })
    } catch {
      // Cannot decrypt with the available key — treat as blocked-by-key, never crash.
      this.bufferBlockedByKey(payload.deviceId, payload.seq, parsed)
      return { disposition: 'blocked-by-key', deviceId: payload.deviceId, seq: payload.seq, keyGeneration: payload.keyGeneration }
    }

    // Slice B v2 / VE-B2 OUT-OF-ORDER APPLY: NO contiguity check, NO seq-buffer. A
    // decryptable entry above a hole is applied IMMEDIATELY — the engine handles
    // out-of-order delivery (Yjs applyUpdate via state-vector is commutative; Automerge
    // applyChanges buffers missing deps internally and does NOT throw). A genuine
    // cross-engine payload throws below and is caught as engine-foreign-skip (records
    // nothing → never tracked as a gap; gap-state is only recorded by the catch-up loop
    // for a decryptable-same-engine device whose lower seq is missing). The seq-gap is
    // pure sync-head bookkeeping (getStrictContiguousHeads), resolved by the catch-up
    // loop's getSyncRequestHeads cursor, not by buffering here.
    try {
      await this.config.hooks.applyRemoteUpdate(plaintext)
    } catch (err) {
      // Engine-foreign / unparseable-as-our-CRDT: skip, do not loop or crash (VE-3).
      return {
        disposition: 'engine-foreign-skip',
        reason: err instanceof Error ? err.message : 'apply-failed',
      }
    }

    // Heads forward only — never a write, never a re-broadcast (LOOP-GUARD).
    await this.config.logStore.recordRemoteApplied({
      docId: payload.docId,
      deviceId: payload.deviceId,
      seq: payload.seq,
      entryJws: parsed.body.entry,
    })
    this.applied.add(key)
    // Drop from the key-buffer if it was parked there earlier (a key import made it
    // decryptable and now it applied). The store's recordRemoteApplied already
    // auto-resolves any GapRepair this seq closes (the strict-contiguous head advanced).
    this.blockedByKey.delete(blockedKey(payload.deviceId, payload.seq))
    // VE-B2 LIVE-GAP trigger: if this entry landed ABOVE a hole (the strict-contiguous
    // head for its device did not reach this seq), the missing lower seq must be
    // re-fetched. Kick a guarded catch-up — but ONLY when no catch-up is already in
    // flight (during a sync-response page apply, catchingUp is set, so this is a no-op
    // and the loop's own getSyncRequestHeads handles it; on a truly LIVE receive it
    // drives the gap-fill). The catchingUp guard coalesces concurrent triggers.
    if (!this.catchingUp) {
      const strict = await this.config.logStore.getStrictContiguousHeads(this.config.docId)
      const strictHead = Object.prototype.hasOwnProperty.call(strict, payload.deviceId)
        ? strict[payload.deviceId]
        : -1
      if (strictHead < payload.seq) this.triggerGapCatchUp()
    }
    return { disposition: 'applied', deviceId: payload.deviceId, seq: payload.seq }
  }

  private async classifyBlockedByKey(keyGeneration: number): Promise<boolean> {
    const available = await this.config.getAvailableKeyGenerations()
    return classifyLogEntryKeyDisposition({ keyGeneration, availableKeyGenerations: available }) === 'blocked-by-key'
  }

  // ──────────────────────────────────────────────────────────────────────────
  // VE-5: blocked-by-key buffer + LOOP-GUARDed replay
  // ──────────────────────────────────────────────────────────────────────────

  /** Park a not-yet-decryptable entry (idempotent on the authoring (deviceId,seq)). */
  private bufferBlockedByKey(deviceId: string, seq: number, message: LogEntryMessage): void {
    this.blockedByKey.set(blockedKey(deviceId, seq), message)
  }

  /**
   * VE-5 replay (MUST be LOOP-GUARDed): after a content key is imported (e.g. a
   * key-rotation applied), re-feed every buffered entry through the READ path
   * ({@link receiveLogEntry}, origin='remote'). A replayed FOREIGN entry produces
   * NO new log-entry under our own deviceId — it never touches the write path —
   * so a key import can never trigger a (delayed) outbox loop. Entries that
   * decrypt + apply leave the buffer; entries still blocked stay parked.
   *
   * Returns the number of entries that converged (applied or idempotently
   * skipped) on this pass — tests assert the OUTGOING send count is unchanged.
   */
  async replayBlockedByKey(): Promise<number> {
    if (this.blockedByKey.size === 0) return 0
    // Snapshot: receiveLogEntry mutates the buffer (delete on apply / re-buffer if
    // still blocked), so iterate a copy to avoid concurrent-modification surprises.
    const pending = [...this.blockedByKey.entries()]
    let converged = 0
    for (const [bufKey, message] of pending) {
      const result = await this.receiveLogEntry(message)
      if (result.disposition === 'applied' || result.disposition === 'idempotent-skip') {
        converged += 1
        this.blockedByKey.delete(bufKey)
      }
      // 'blocked-by-key' again ⇒ receiveLogEntry re-buffered it (still no key) — keep.
    }
    return converged
  }

  /** Count of currently buffered blocked-by-key entries (test/inspection). */
  blockedByKeyCount(): number {
    return this.blockedByKey.size
  }

  // ──────────────────────────────────────────────────────────────────────────
  // VE-B2: seq-gap bookkeeping (out-of-order apply; NO buffer) + GapRepair driver
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Slice B v3 / VE-B2: the OPEN seq-gaps at the FRONTIER right now — every device whose
   * effective WIRE cursor (getSyncRequestHeads = strict + soft-skipped holes) sits below its
   * MAX known seq has its next actionable hole at cursorHead+1. Used for
   * {@link CatchUpResult.pendingGaps}. Measured from the wire cursor (NOT strict) so the
   * reported gap tracks the frontier above already-soft-skipped holes (stacked gaps — Codex v3).
   */
  private async openGaps(): Promise<GapRef[]> {
    const known = await this.config.logStore.getKnownHeads(this.config.docId)
    const wire = await this.config.logStore.getSyncRequestHeads(this.config.docId)
    const gaps: GapRef[] = []
    for (const [device, maxSeq] of Object.entries(known)) {
      const cursorHead = Object.prototype.hasOwnProperty.call(wire, device) ? wire[device] : -1
      if (cursorHead < maxSeq) {
        gaps.push({ docId: this.config.docId, device, firstMissing: cursorHead + 1 })
      }
    }
    return gaps
  }

  /**
   * Slice B v2 / VE-B2 gap-trigger: a live entry that landed above a hole (the strict-
   * contiguous head did not reach the broker's max) kicks a guarded catch-up so the
   * missing lower seq is re-fetched via getSyncRequestHeads. Re-entrancy: a trigger
   * during an in-flight catch-up is COALESCED by the catchingUp guard (NO second loop,
   * NO outer re-run). Fire-and-forget; AUTHOR_MISMATCH/no-progress are surfaced to audit.
   */
  private triggerGapCatchUp(): void {
    void this.catchUp().catch((err) => {
      if (err instanceof AuthorMismatchError) {
        console.error('[LogSyncCoordinator] AUTHOR_MISMATCH during gap catch-up:', err.message)
        return
      }
      if (err instanceof SyncNoProgressError) {
        console.error('[LogSyncCoordinator] no-progress during gap catch-up:', err.message)
        return
      }
      console.debug('[LogSyncCoordinator] gap catch-up deferred (retry on reconnect):', err)
    })
  }

  /**
   * Slice B v2 / VE-B2 GapRepair driver: send a `head = firstMissing - 1` repair
   * sync-request for every GapRepair whose nextDueAt <= now, then schedule the next
   * attempt with exponential backoff capped at 5min. A repaired seq applies idempotently
   * and the store's recordRemoteApplied auto-resolves the GapRepair (deletes it). Runs at
   * catch-up start AND at app start (crash-recovery). LOOP-GUARD: this only READS (no
   * log-entry send), so it can never spawn an outbox loop.
   */
  async driveGapRepairs(): Promise<void> {
    const now = this.now().getTime()
    const due = await this.config.logStore.listDueGapRepairs(now)
    // Base the repair request on getKnownHeads (= MAX seq per device): every OTHER device is
    // held at its MAX, so the broker returns NOTHING for it (getSince is seq>head) — it cannot
    // crowd the global page. A wire-cursor base would let a device with entries ABOVE its wire
    // cursor flood the page and push the target gap past the limit (CodeRabbit/Codex crowding).
    // The target gap device is lowered to firstMissing-1 so its firstMissing is returned.
    const known = await this.config.logStore.getKnownHeads(this.config.docId)
    for (const gap of due) {
      if (gap.docId !== this.config.docId) continue
      // ONE page in the common case. With the knownHeads base the gap device's lowest returned
      // seq is firstMissing (if present) or the next seq above it — i.e. the gap device DOES
      // appear in the first page, which is our answer (arrived → applied → auto-resolved, or
      // confirmed-absent → retry next backoff). We only paginate when the gap device is CROWDED
      // OUT of the page entirely (an as-yet-UNKNOWN device, absent from known, sorting before it
      // and flooding) — then advance to drain that device. We do NOT drain a permanent gap's
      // whole tail: once the gap device appears we stop (so a never-arriving seq stays cheap).
      const repairHeads: Record<string, number> = { ...known, [gap.device]: gap.firstMissing - 1 }
      for (let page = 0; page < GAP_REPAIR_MAX_PAGES; page++) {
        const response = await this.requestSyncPage(repairHeads)
        if (!response) break // timeout — retry on the next backoff
        const { lowestSeqByDevice, highestSeqByDevice } = await this.applySyncResponsePage(response)
        // The gap device appeared → we have our answer (firstMissing arrived & auto-resolved if
        // lowest <= firstMissing, else broker-confirmed-absent). Either way: done this attempt.
        if (lowestSeqByDevice.get(gap.device) !== undefined) break
        const truncated = evaluateSyncResponseDisposition(response.body) === 'request-next-page'
        if (!truncated) break // broker served all it has; the gap device has nothing ≥ firstMissing
        // Gap device crowded out by other (unknown) devices → advance every delivering device so
        // the next page makes progress and drains them. No advance ⇒ no-progress ⇒ stop (no spin).
        let advanced = false
        for (const [device, hi] of highestSeqByDevice) {
          if (hi > (repairHeads[device] ?? -1)) {
            repairHeads[device] = hi
            advanced = true
          }
        }
        if (!advanced) break
      }
      // Backoff regardless of outcome (a filled gap is auto-resolved out of the store, so
      // markGapRepairAttempt is then a no-op).
      const backoff = Math.min(
        GAP_REPAIR_BASE_BACKOFF_MS * 2 ** gap.attempts,
        GAP_REPAIR_MAX_BACKOFF_MS,
      )
      await this.config.logStore.markGapRepairAttempt(
        gap.docId,
        gap.device,
        gap.firstMissing,
        now + backoff,
      )
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Catch-up (VE-4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * (Re)connect catch-up (VE-4): present read-capability for the docId (a new
   * socket has an empty scope cache, so re-present), then sync-request(localHeads)
   * → sync-response → idempotent apply. Returns the broker-head-abgleich result.
   *
   * BLOCKER-1b: when the broker reports a higher seq under our deviceId than we
   * hold locally (the store-wipe / clone case), this ACTS on it — a real
   * restore-clone (mint a fresh deviceId, re-write under it) BEFORE any first
   * write, so a leaked store can never re-enter seq=0 under a broker-known
   * deviceId. The disposition is still returned (callers/tests may inspect it).
   */
  async catchUp(): Promise<CatchUpResult> {
    // VE-B1 re-entrancy guard (Opus DoS fix): never two catch-up passes on the same
    // docId. A gap-trigger (VE-B2) / reconnect that fires while one is in flight is
    // COALESCED — short-circuit return, NO outer re-run loop. (The old do-while spun
    // because a gap-pending page set catchUpAgain forever and re-entered.) The single
    // pass below already consults the gap-budget INSIDE the loop, so a gap-pending page
    // STOPS instead of re-looping (VE-B1 (b)); the durable GapRepair re-fetches later.
    if (this.catchingUp) {
      return { restoreCloneRequired: false, complete: false, incomplete: 'gap-pending', pendingGaps: [] }
    }
    this.catchingUp = true
    const work = (async (): Promise<CatchUpResult> => {
      // VE-B2 GapRepair driver: re-request any due soft-skipped/pending hole BEFORE the
      // normal catch-up (so a repaired seq is in the store before progress is measured).
      await this.driveGapRepairs().catch((err) => {
        console.debug('[LogSyncCoordinator] GapRepair drive deferred:', err)
      })
      const result = await this.catchUpInternal({ presentCapabilityFirst: true })
      await this.actOnRestoreDisposition(result)
      return result
    })()
    // catchUpInFlight settles WITH the catch-up's outcome — it REJECTS if the catch-up failed,
    // so a runFirstPublication() coalescing onto it propagates the error and does NOT publish on
    // an incomplete head-abgleich / restore-clone (BLOCKER-1b). A detached no-op handler prevents
    // an "unhandled rejection" when nobody coalesces; a real awaiter still observes the rejection.
    const inFlight = work.then(() => undefined)
    inFlight.catch(() => {})
    this.catchUpInFlight = inFlight
    try {
      return await work
    } finally {
      this.catchingUp = false
      this.catchUpInFlight = null
    }
  }

  /**
   * BLOCKER-1b: drive a real restore-clone when the broker-head-abgleich detected
   * broker_seq>local_seq. Routed through the SAME machinery as a write-path
   * SEQ_COLLISION_DETECTED reject (mint a new deviceId via the WriteRejectHandler,
   * re-write the full state under it from seq=0). A no-op when no restore is
   * required or no handler is wired (degenerate; the deviceId-binding already makes
   * an empty store a fresh namespace, so this is belt-and-suspenders).
   */
  private async actOnRestoreDisposition(result: { restoreCloneRequired: boolean }): Promise<void> {
    if (!result.restoreCloneRequired) return
    if (this.restoreCloneInFlight) return
    await this.restoreClone({
      code: 'SEQ_COLLISION_DETECTED',
      rejectedDeviceId: this.deviceId,
    })
  }

  /**
   * VE-B1 pagination loop (Sync 003 §sync-response: on `truncated:true` the
   * requester MUST send a further sync-request with updated heads). One catch-up:
   *  - present-capability once (a new socket has an empty scope cache),
   *  - compute the restore-clone disposition ONCE on the FIRST page's broker heads
   *    (BLOCKER-1b localSeq-snapshot BEFORE any apply against getKnownHeads=MAX) —
   *    NEVER per page, because the broker heads are seiten-invariant MAX and a later
   *    page would falsely report localSeq<brokerSeq and fire a spurious restore-clone,
   *  - then loop: read the STRICT-CONTIGUOUS head fresh (progress snapshot), send a
   *    sync-request with getSyncRequestHeads (the WIRE cursor; getKnownHeads(=MAX) is
   *    NEVER on the wire — Codex BLOCKER), apply the page out-of-order, advance, repeat
   *    while the STRICT head advanced and the page is truncated.
   *
   * Termination (typed result; the no-progress class THROWS — the only throw class):
   *  - (complete) truncated:false → complete:true (+ pendingGaps if a hole remains).
   *  - (a) truncated:true && strict head advanced → keep paginating.
   *  - (b) truncated:true && strict head did NOT advance but entries applied (over a
   *        hole) → STOP, incomplete:'gap-pending' (NOT an error, NO re-loop — the same
   *        getSyncRequestHeads would re-fetch the same page; VE-B2 soft-skip/GapRepair
   *        resolves it). The gap-budget (recordGapObservation) is consulted HERE, inside
   *        the single pass (the Opus fix — the old code charged it too late).
   *  - (b') truncated:true && nothing applied but blocked-by-key → incomplete:'blocked-by-key'.
   *  - (c) !response (timeout) on an open truncated page → incomplete:'timeout'.
   *  - (d) truncated:true && nothing applied AND nothing blocked-by-key → THROW.
   *  Progress is measured by the STRICT-CONTIGUOUS head vs the PRE-REQUEST snapshot,
   *  never against response.body.heads (seiten-invariant broker MAX — VE-B1 (d)).
   */
  private async catchUpInternal(
    opts: { presentCapabilityFirst: boolean; timeoutMs?: number },
  ): Promise<CatchUpResult> {
    if (opts.presentCapabilityFirst) {
      await this.presentCapabilityWithRetry()
    }

    let restoreCloneRequired = false
    let firstPage = true

    for (;;) {
      // Pre-request snapshot of the STRICT-CONTIGUOUS heads — progress is measured
      // against THIS, not against a head a concurrent live log-entry advanced between
      // pages (which would mask a genuinely non-advancing page). The WIRE cursor is
      // getSyncRequestHeads (strict-contiguous + soft-skip markers); getKnownHeads
      // (=MAX) is NEVER sent — a MAX head over a hole would make the relay only return
      // seq>MAX and the hole would be permanently unrequestable (the Codex data-loss).
      const strictBefore = await this.config.logStore.getStrictContiguousHeads(this.config.docId)
      const wireHeads = await this.config.logStore.getSyncRequestHeads(this.config.docId)
      const response = await this.requestSyncPage(wireHeads, opts.timeoutMs)

      if (!response) {
        // (c) timeout: no response for this (possibly truncated) page — incomplete,
        // not an error; retried on the next reconnect.
        return { restoreCloneRequired, complete: false, incomplete: 'timeout' }
      }

      // Restore-clone disposition ONCE, on the first page only (against the broker
      // MAX heads, which are seiten-invariant; computeRestoreDisposition reads
      // getKnownHeads=MAX for the OWN deviceId, where strict==max). Folge-Seiten
      // dürfen sie NICHT neu berechnen.
      if (firstPage) {
        const disposition = await this.computeRestoreDisposition(response.body.heads)
        restoreCloneRequired = disposition.restoreCloneRequired
        firstPage = false
      }

      const { applied, idempotentSkips, buffered, lowestSeqByDevice } =
        await this.applySyncResponsePage(response)
      // VE-B1 (v3, Codex BLOCKER): pageEvidence = applied + idempotentSkips. The broker
      // delivered VERIFIED entries IFF pageEvidence > 0 — and a repeat-epoch over a
      // permanent gap re-delivers the SAME page (all idempotent-skip, applied==0), which
      // is exactly the observedEpochs evidence the soft-skip gate needs. Classifying on
      // `applied` alone would throw no-progress on those repeats → the gate never reaches
      // 3 epochs → soft-skip dead → multi-page tail lost. Count idempotent-skip as evidence.
      const pageEvidence = applied + idempotentSkips
      const truncated = evaluateSyncResponseDisposition(response.body) === 'request-next-page'

      const strictAfter = await this.config.logStore.getStrictContiguousHeads(this.config.docId)
      const strictAdvanced = headsAdvanced(strictBefore, strictAfter)

      // VE-B2 (v3): observe broker-confirmed-absent gaps from THIS page (page-lowest for
      // the device > firstMissing ⇒ the broker served contiguously from our cursor and
      // SKIPPED the hole ⇒ confirmed absent — true on truncated:true too; the v2
      // "only truncated:false" rule lost the >1-page tail above a permanent hole). This
      // records the observation toward the 3-epoch + 60s gate and may NEWLY mark a
      // soft-skip, which advances getSyncRequestHeads past the hole. MUST run before the
      // effectiveCursorAdvanced read below and before the classification. firstMissing is
      // measured from the WIRE cursor the page was requested with (wireHeads), so a SECOND
      // hole above an already-soft-skipped first hole gets its own firstMissing (Codex v3).
      await this.recordGapsFromPage(response.body.heads, lowestSeqByDevice, wireHeads)

      // effectiveCursorAdvanced: did a soft-skip newly marked just now push the WIRE
      // cursor (getSyncRequestHeads) past a hole? Then the next page fetches the tail in
      // THIS same pagination → that counts as progress (Codex BLOCKER: without this the
      // loop would stop gap-pending right after the soft-skip and defer the tail).
      const wireAfter = await this.config.logStore.getSyncRequestHeads(this.config.docId)
      const effectiveCursorAdvanced = headsAdvanced(wireHeads, wireAfter)

      if (!truncated) {
        // (complete) the relay delivered EVERY entry it holds above our wire cursor
        // (truncated:false = broker-authoritative). Out-of-order apply has already
        // applied everything decryptable; any device whose STRICT head still sits below
        // the broker MAX has an open hole → surfaced as pendingGaps (the observation +
        // soft-skip/GapRepair was recorded above). NO force-apply, NO data loss.
        const pendingGaps = await this.openGaps()
        return { restoreCloneRequired, complete: true, pendingGaps }
      }

      // truncated:true — classify by progress (strict head OR soft-skip-advanced cursor).
      if (strictAdvanced || effectiveCursorAdvanced) {
        // (a) the strict-contiguous head advanced, OR a soft-skip just advanced the wire
        // cursor over a hole → fetch the next page (so the multi-page tail above a
        // soft-skipped hole is pulled in THIS same main pagination, not deferred).
        continue
      }
      if (pageEvidence > 0) {
        // (b) the broker delivered verified entries OVER a hole (newly applied OR a
        // repeat-epoch idempotent-skip) but neither head advanced (the soft-skip gate is
        // not yet reached) → STOP typed 'gap-pending', NO throw, NO re-loop (the same wire
        // cursor would re-fetch the same page). The observation recorded above accrues an
        // epoch toward the gate; the durable GapRepair re-checks the hole meanwhile.
        const pendingGaps = await this.openGaps()
        return { restoreCloneRequired, complete: false, incomplete: 'gap-pending', pendingGaps }
      }
      if (buffered > 0) {
        // (b') the page only buffered key-missing entries (no key yet) — NOT an error,
        // retried after a key import.
        return { restoreCloneRequired, complete: false, incomplete: 'blocked-by-key' }
      }
      // (e) truncated:true but pageEvidence == 0 AND nothing blocked-by-key: the relay
      // claims more pages yet delivered NO verified entry (neither new nor idempotent) and
      // nothing bufferable. Re-requesting with the unchanged wire cursor would return the
      // same empty page forever — a no-progress DoS. HARD STOP (the only throw class).
      throw new SyncNoProgressError(this.config.docId)
    }
  }

  /**
   * Slice B v3 / VE-B2: record a gap-observation for every device the broker CONFIRMED
   * is missing our `firstMissing` — i.e. the LOWEST seq the broker delivered for the
   * device on THIS page is strictly ABOVE firstMissing. The broker serves seq>cursor
   * ordered ascending (relay getSince, ORDER BY device_id,seq), so a page-lowest above
   * firstMissing means it skipped the hole ⇒ broker-confirmed-absent. This holds on
   * `truncated:true` too — the v2 rule "only truncated:false" never reached truncated:false
   * for a >1-page tail above a permanent hole and lost the whole tail (festival BLOCKER).
   *
   * A device whose entries were crowded out of the page by the GLOBAL limit is simply
   * ABSENT from `lowestSeqByDevice` → NO observation (its hole may be on the next page —
   * a pagination artefact, not confirmed-absent). The 3-distinct-epoch + 60s soft-skip
   * gate (evaluated here) still protects a transient gap: if firstMissing fills before the
   * gate fires, the strict-contiguous head auto-resolves the observation.
   *
   * `requestCursor` is the WIRE cursor the page was requested with (getSyncRequestHeads,
   * = strict + already-soft-skipped holes), NOT the strict head: firstMissing must track the
   * EFFECTIVE frontier so a SECOND permanent hole ABOVE a soft-skipped first hole gets its OWN
   * firstMissing and is observed/soft-skipped in turn (strictHead+1 would pin firstMissing
   * behind the first hole forever → the tail above a second stacked gap stays stuck — Codex v3).
   */
  private async recordGapsFromPage(
    brokerHeads: Record<string, number>,
    lowestSeqByDevice: Map<string, number>,
    requestCursor: Record<string, number>,
  ): Promise<void> {
    const known = await this.config.logStore.getKnownHeads(this.config.docId)
    const now = this.now().getTime()
    for (const [device, brokerMax] of Object.entries(brokerHeads)) {
      const cursorHead = Object.prototype.hasOwnProperty.call(requestCursor, device) ? requestCursor[device] : -1
      // Only a DECRYPTABLE-same-engine device can have a tracked gap: an engine-foreign
      // device records nothing (engine-foreign-skip), so it never appears in known/strict
      // and is excluded here — no GapRepair churn for a device on the other engine.
      if (!Object.prototype.hasOwnProperty.call(known, device)) continue
      // A hole exists iff the broker has more above our EFFECTIVE cursor than we hold there.
      if (cursorHead >= brokerMax) continue
      const firstMissing = cursorHead + 1
      // Broker-confirmed-absent: this page delivered a seq for the device whose LOWEST
      // value is strictly above firstMissing (the broker skipped the hole). Absent
      // delivery (page-lowest undefined) = pagination artefact / global-limit crowd-out
      // → no observation this page.
      const pageLowest = lowestSeqByDevice.get(device)
      if (pageLowest === undefined || pageLowest <= firstMissing) continue
      await this.config.logStore.recordGapObservation(
        this.config.docId,
        device,
        firstMissing,
        brokerMax,
        this.connectionEpoch,
        now,
      )
      // Evaluate the soft-skip gate (3 distinct epochs + 60s age). On firing, the wire
      // cursor (getSyncRequestHeads) advances past the hole → the main loop pulls the tail.
      await this.maybeSoftSkipGap(device, firstMissing, now)
    }
  }

  /**
   * Slice B v2 / VE-B2 soft-skip gate: mark the gap soft-skipped once it has been
   * observed under truncated:false across >= 3 DISTINCT connection-epochs AND is at
   * least 60s old. After that getSyncRequestHeads advances past the hole (churn ends);
   * the durable GapRepair keeps re-requesting it so a later-arriving seq still converges.
   */
  private async maybeSoftSkipGap(device: string, firstMissing: number, now: number): Promise<void> {
    // List ALL gap records regardless of schedule (MAX_SAFE_INTEGER ⇒ nextDueAt <= it).
    const due = await this.config.logStore.listDueGapRepairs(Number.MAX_SAFE_INTEGER)
    const gap = due.find(
      (g) => g.docId === this.config.docId && g.device === device && g.firstMissing === firstMissing,
    )
    if (!gap || gap.softSkipped) return
    if (gap.observedEpochs.length < GAP_SOFT_SKIP_MIN_EPOCHS) return
    if (now - gap.firstSeenAt < GAP_SOFT_SKIP_MIN_AGE_MS) return
    await this.config.logStore.markGapSoftSkipped(this.config.docId, device, firstMissing)
  }

  /**
   * Send one sync-request(heads, limit) and await its sync-response page, or null on
   * timeout. `heads` is the WIRE cursor (getSyncRequestHeads from the caller), NEVER
   * getKnownHeads(=MAX). The limit is EXPLICIT (Sync 003 §sync-request limit; default
   * {@link DEFAULT_CATCH_UP_PAGE_SIZE} = 100, matching the relay default) so the wire
   * envelope carries it (the pre-B coordinator omitted it, so the client never paged).
   */
  private async requestSyncPage(
    localHeads: Record<string, number>,
    timeoutMs?: number,
  ): Promise<SyncResponseMessage | null> {
    const requestId = cryptoRandomUuid()
    // Validate catchUpPageSize: an invalid config (0, negative, non-integer, NaN) is treated as
    // UNSET → the default. A bogus limit on the wire would otherwise make the relay return an
    // empty/degenerate page (no progress → spurious gap-pending / no-progress throw) — CodeRabbit.
    const configuredPageSize = this.config.catchUpPageSize
    const limit =
      typeof configuredPageSize === 'number' && Number.isInteger(configuredPageSize) && configuredPageSize > 0
        ? configuredPageSize
        : DEFAULT_CATCH_UP_PAGE_SIZE
    // Wire-head sanitize: a device whose strict-contiguous head is -1 (nothing
    // contiguous yet, or a GapRepair head = firstMissing-1 = -1 for a hole at seq 0)
    // means "request from seq 0" — the wire format forbids negative heads, and an
    // ABSENT device == start-from-0 (deriveSyncStartSeq). So drop any -1 entry.
    const wireHeads: Record<string, number> = {}
    for (const [device, seq] of Object.entries(localHeads)) {
      if (seq >= 0) wireHeads[device] = seq
    }
    const request = createSyncRequestMessage({
      id: requestId,
      from: this.config.ownDid,
      to: [this.config.ownDid],
      createdTime: Math.floor(this.now().getTime() / 1000),
      body: { docId: this.config.docId, heads: wireHeads, limit },
    })

    // Register the async waiter BEFORE sending (the relay answers via onMessage →
    // handleIncoming). A mock that returns the response synchronously short-circuits.
    const responsePromise = new Promise<SyncResponseMessage | null>((resolve) => {
      const timeout = timeoutMs ?? this.config.catchUpPageTimeoutMs ?? 1000
      const timer = setTimeout(() => {
        this.pendingSyncRequests.delete(requestId)
        resolve(null)
      }, timeout)
      this.pendingSyncRequests.set(requestId, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
    })

    const sendResult = await this.config.envelopes.send(request)
    const synchronous = unwrapSyncResponse(sendResult)
    if (synchronous) {
      this.pendingSyncRequests.delete(requestId)
      return synchronous
    }
    return responsePromise
  }

  /**
   * Apply ALL entries of one sync-response page through the read path (LOOP-GUARD),
   * counting the per-entry dispositions for the pagination terminator:
   *  - `applied` = applied | idempotent-skip (out-of-order apply succeeded, or the
   *    entry was already present). NOTE: this counts entries APPLIED, including ones
   *    applied over a hole — the strict-contiguous head advance (measured separately
   *    in catchUpInternal) is what distinguishes progress from a gap-pending page.
   *  - `buffered` = blocked-by-key (no key yet; parked for a key-import replay). There
   *    is NO blocked-by-seq buffer (out-of-order apply, Slice B v2).
   * Does NOT compute the restore-clone disposition (that is done ONCE, per page-1,
   * in {@link catchUpInternal}) — so a later page cannot fire a spurious restore.
   */
  private async applySyncResponsePage(
    response: SyncResponseMessage,
  ): Promise<{
    applied: number
    idempotentSkips: number
    buffered: number
    lowestSeqByDevice: Map<string, number>
    highestSeqByDevice: Map<string, number>
  }> {
    let applied = 0
    let idempotentSkips = 0
    let buffered = 0
    // VE-B2 (v3): the LOWEST seq the broker DELIVERED per device (over any disposition
    // that carries a (deviceId, seq) — applied | idempotent-skip | blocked-by-key). This
    // is the broker-confirmed-absent signal: if page-lowest(device) > our firstMissing,
    // the broker served contiguously from our cursor and skipped the hole → confirmed
    // absent (works on truncated:true too). A device crowded out of the page by the
    // global limit is simply ABSENT here → no premature observation (Codex multi-device).
    // highestSeqByDevice is the per-device page-max — used by driveGapRepairs to advance a
    // bounded repair pagination past crowding devices toward the target gap.
    const lowestSeqByDevice = new Map<string, number>()
    const highestSeqByDevice = new Map<string, number>()
    const noteSeq = (deviceId: string, seq: number): void => {
      const lo = lowestSeqByDevice.get(deviceId)
      if (lo === undefined || seq < lo) lowestSeqByDevice.set(deviceId, seq)
      const hi = highestSeqByDevice.get(deviceId)
      if (hi === undefined || seq > hi) highestSeqByDevice.set(deviceId, seq)
    }
    for (const entryJws of response.body.entries) {
      // Re-wrap each entry as a log-entry message so the SAME verify+apply+heads
      // path (and LOOP-GUARD) handles it — no separate decode path.
      const message = createLogEntryMessage({
        id: cryptoRandomUuid(),
        from: this.config.ownDid,
        to: [this.config.ownDid],
        createdTime: Math.floor(this.now().getTime() / 1000),
        entry: entryJws,
      })
      const result = await this.receiveLogEntry(message)
      if (result.disposition === 'applied') {
        applied += 1
        noteSeq(result.deviceId, result.seq)
      } else if (result.disposition === 'idempotent-skip') {
        idempotentSkips += 1
        noteSeq(result.deviceId, result.seq)
      } else if (result.disposition === 'blocked-by-key') {
        buffered += 1
        noteSeq(result.deviceId, result.seq)
      }
    }
    return { applied, idempotentSkips, buffered, lowestSeqByDevice, highestSeqByDevice }
  }

  /**
   * Apply a sync-response that arrived UNSOLICITED / late (no matching in-flight
   * waiter — {@link handleIncoming}). Idempotently applies the page + runs the
   * broker head-abgleich (restore-clone). VE-B2: if the page is `truncated:true`,
   * this path does NOT inherit the pagination loop (it does not go through
   * catchUpInternal), so it MUST trigger a guarded follow-up catch-up to fetch the
   * rest — otherwise a truncated unsolicited response leaves silent incompleteness.
   */
  async applySyncResponse(response: SyncResponseMessage): Promise<CatchUpResult> {
    // BLOCKER-1b (disposition-before-apply): compute the broker-vs-local seq
    // disposition AGAINST response.body.heads BEFORE applying any entry, so a broker
    // entry under our own deviceId cannot back-fill localSeq and mask a restore-clone.
    const disposition = await this.computeRestoreDisposition(response.body.heads)
    await this.applySyncResponsePage(response)
    const truncated = evaluateSyncResponseDisposition(response.body) === 'request-next-page'
    // VE-B2 (v3, Codex+Opus blocker fix): do NOT observe gaps on the unsolicited/late path.
    // The page's REQUEST cursor is unknown here, so "page-lowest > frontier+1" is AMBIGUOUS at
    // a page boundary — a delayed/timed-out page (its waiter already gone) can look like a hole
    // and spuriously soft-skip a PRESENT seq → permanent 1-entry loss. The AUTHORITATIVE observe
    // runs only in catchUpInternal, where the request cursor and the page are consistent. Drive a
    // guarded catch-up to do it: on truncated (more to fetch) OR any OPEN gap at the frontier (so
    // a permanent hole surfaced by this late page still gets observed/soft-skipped there).
    const pendingGaps = await this.openGaps()
    if (truncated || pendingGaps.length > 0) {
      this.triggerGapCatchUp()
    }
    if (truncated) {
      // Late/unsolicited truncated page: the guarded catchUp() (getSyncRequestHeads on the wire)
      // converges the rest. gap-pending, not an error.
      return { restoreCloneRequired: disposition.restoreCloneRequired, complete: false, incomplete: 'gap-pending', pendingGaps }
    }
    return { restoreCloneRequired: disposition.restoreCloneRequired, complete: true, pendingGaps }
  }

  /**
   * VE-4 broker head-abgleich (Sync 002 seq-Konsistenz), computed against the
   * broker's reported heads and our CURRENT local heads — call this BEFORE
   * applying the sync-response entries (BLOCKER-1b), so a broker entry under our
   * own deviceId cannot back-fill localSeq and mask a restore-clone.
   *
   * deviceId absent in broker heads => broker_seq=-1 => no restore (normal
   * first-write/creator). broker_seq>local_seq => restore-clone. Uses the ACTIVE
   * deviceId (a restore-clone re-bound it) so a fresh post-clone namespace is
   * never falsely flagged against the old device's broker head.
   */
  private async computeRestoreDisposition(
    brokerHeads: Record<string, number>,
  ): Promise<{ restoreCloneRequired: boolean }> {
    const deviceId = this.deviceId
    const brokerSeq = Object.prototype.hasOwnProperty.call(brokerHeads, deviceId)
      ? brokerHeads[deviceId]
      : -1
    const localHeads = await this.config.logStore.getKnownHeads(this.config.docId)
    const localSeq = Object.prototype.hasOwnProperty.call(localHeads, deviceId)
      ? localHeads[deviceId]
      : -1

    if (brokerSeq < 0) return { restoreCloneRequired: false }
    if (localSeq < 0) {
      // We have no local entry but the broker has one under our deviceId — that is
      // a higher broker seq than local => restore-clone (Sync 002 seq-Konsistenz).
      return { restoreCloneRequired: true }
    }
    const disposition = classifyLocalBrokerSeqConsistency({
      docId: this.config.docId,
      deviceId,
      localSeq,
      brokerSeq,
    })
    return { restoreCloneRequired: disposition.disposition === 'restore-clone-required' }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Reject disposition (VE-4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build the typed HARD-STOP error for a no-retry reject `code`, branching by code so the
   * surfaced error type is honest:
   *  - PERSONAL_DOC_OWNER_MISMATCH (A2 Teil B) → {@link PersonalDocOwnerMismatchError}, also
   *    surfaced via `onSecurityError` here BEFORE the caller throws (the throw alone is only
   *    console-logged by the messaging dispatch, so a security detector would otherwise miss
   *    it — same pattern as {@link SeqCollisionError}).
   *  - AUTHOR_MISMATCH (and any other 'hard-stop') → {@link AuthorMismatchError}.
   * The caller `throw`s the result, so neither hard-stop path degrades into a retry. Shared
   * by the control-frame path ({@link dispositionForError}) and the write-path reject
   * ({@link handleWriteReject}).
   */
  private hardStopError(code: BrokerErrorCode, rejectedDeviceId?: string): Error {
    const deviceId = rejectedDeviceId ?? this.deviceId
    if (code === 'PERSONAL_DOC_OWNER_MISMATCH') {
      const mismatch = new PersonalDocOwnerMismatchError(this.config.docId, deviceId)
      this.config.onSecurityError?.(mismatch)
      return mismatch
    }
    // AUTHOR_MISMATCH: authorKid<->deviceId binding bug. Hard stop, never retry.
    return new AuthorMismatchError(this.config.docId, deviceId, this.config.authorKid)
  }

  /**
   * Maps an error thrown by the control/envelope transport to a VE-4 disposition.
   * AUTHOR_MISMATCH / PERSONAL_DOC_OWNER_MISMATCH are HARD STOPs (no retry) and re-thrown
   * as their typed errors (see {@link hardStopError}) so they cannot be swallowed into a
   * retry loop.
   */
  dispositionForError(err: unknown): RejectDisposition {
    const code = brokerErrorCodeOf(err)
    if (!code) return 'unknown'
    const disposition = classifyRejectDisposition(code)
    if (disposition === 'hard-stop') {
      throw this.hardStopError(code)
    }
    return disposition
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Write-path reject (P2-NIT-1, VE-4/VE-5): routed `{ type:'error', thid }`
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Parse a routed write-path `error` frame, correlate its `thid` to the rejected
   * (deviceId, seq), and drive the reject action. Unknown / uncorrelated codes are
   * ignored (the relay may route errors for frames we did not send).
   */
  private async onWritePathErrorFrame(message: unknown): Promise<void> {
    const frame = message as { type?: unknown; thid?: unknown; code?: unknown }
    if (!isKnownBrokerErrorCode(frame.code)) return
    const thid = typeof frame.thid === 'string' ? frame.thid : undefined
    // Only act on an error correlated to a log-entry WE sent. An uncorrelated thid
    // (a frame we did not send / already resolved) is ignored — never a false
    // restore-clone on a stray error.
    const correlated = thid ? this.inFlightWrites.get(thid) : undefined
    if (!correlated) return
    // VE-C2: read the retained plaintext update BEFORE dropping the correlation, so a
    // KEY_GENERATION_STALE re-emit can use the live in-memory update (no decrypt).
    const retainedEncoded = correlated.encoded
    if (thid) this.inFlightWrites.delete(thid)
    await this.handleWriteReject(frame.code, correlated.deviceId, correlated.seq, retainedEncoded)
  }

  /**
   * Drive the VE-4/VE-5 action for a write-path reject code (P2-NIT-1). The
   * disposition table:
   *  - AUTHOR_MISMATCH → HARD STOP: throw {@link AuthorMismatchError}, NO retry.
   *  - SEQ_COLLISION_DETECTED (write-path) → HARD STOP: throw {@link SeqCollisionError}
   *    (VE-11 Trigger 2 — seq-reuse = nonce-reuse-imminent, NEVER auto-recover). The
   *    recoverable mid-session case is the SEPARATE Trigger-1 catch-up restore-clone.
   *  - DEVICE_REVOKED → a straggler under an OLD deviceId is dropped; a revoke of the
   *    CURRENT device throws {@link DeviceRevokedError} (re-auth/re-join, no re-clone).
   *  - DEVICE_NOT_REGISTERED / DEVICE_ID_CONFLICT → device-re-register.
   *  - CAPABILITY_* → re-present capability + resend pending.
   *  - KEY_GENERATION_STALE → VE-C2: catch up the missed rotation, then re-emit the
   *    SAME update under a NEW seq + the new keyGeneration (never the same seq).
   *  - retry/unknown → no structural action (the reconnect path resends pending).
   *
   * Exposed for adapter wiring + tests. Returns the disposition it acted on.
   *
   * `retainedEncoded` (VE-C2): the live in-memory plaintext update for the rejected
   * write, if still retained (the happy live-lagger path). Absent ⇒ crash-recovery
   * (decrypt the persisted alt-gen JWS with the historical content key).
   */
  async handleWriteReject(
    code: BrokerErrorCode,
    rejectedDeviceId?: string,
    rejectedSeq?: number,
    retainedEncoded?: Uint8Array,
  ): Promise<RejectDisposition> {
    const disposition = classifyRejectDisposition(code)
    switch (disposition) {
      case 'hard-stop':
        // AUTHOR_MISMATCH (authorKid<->deviceId binding bug) or, A2 Teil B,
        // PERSONAL_DOC_OWNER_MISMATCH (this docId is owner-bound to a different DID).
        // Both are hard stops, never retried; hardStopError picks the typed error and
        // surfaces the owner mismatch via onSecurityError before we throw it.
        throw this.hardStopError(code, rejectedDeviceId)
      case 'restore-clone':
        // VE-11 Trigger split — a WRITE-PATH reject is NEVER the recoverable case:
        //  - SEQ_COLLISION_DETECTED = seq-REUSE at an already-stored (docId,deviceId,
        //    seq) = deterministic-nonce-reuse-imminent. HARD STOP (Trigger 2), never
        //    auto-recover: a smooth re-clone would MASK a potential AES-GCM break. The
        //    recoverable mid-session case is the SEPARATE Trigger-1 catch-up path
        //    (brokerSeq>localSeq → restoreClone), which never reaches here.
        if (code === 'SEQ_COLLISION_DETECTED') {
          const seqCollision = new SeqCollisionError(
            this.config.docId,
            rejectedDeviceId ?? this.deviceId,
            rejectedSeq,
          )
          // Surface to the app BEFORE throwing — the throw propagates through the
          // messaging onMessage dispatch, which only console.error-logs callback
          // errors, so a security detector would otherwise be unobservable.
          this.config.onSecurityError?.(seqCollision)
          throw seqCollision
        }
        //  - DEVICE_REVOKED: a revoked device must NOT silently re-clone itself back in
        //    (that would let a revoked device re-admit itself). A straggler write under
        //    an OLD / already-rotated deviceId is a benign late reject → drop (the
        //    active-deviceId filter already stops its re-sends). A revoke of our CURRENT
        //    device is surfaced for re-auth / re-join.
        if (rejectedDeviceId !== undefined && rejectedDeviceId !== this.deviceId) {
          return disposition
        }
        if (rejectedDeviceId === undefined) {
          // A DEVICE_REVOKED reject SHOULD always carry the rejected deviceId; a
          // missing one is a malformed broker frame. We conservatively treat it as a
          // current-device revoke (safe), but flag the protocol violation.
          console.warn(
            '[LogSyncCoordinator] DEVICE_REVOKED without a deviceId (malformed broker frame); treating as current-device revoke',
          )
        }
        {
          const revoked = new DeviceRevokedError(this.config.docId, this.deviceId)
          this.config.onSecurityError?.(revoked)
          throw revoked
        }
      case 'device-re-register':
        await this.deviceReRegister(code, rejectedDeviceId)
        return disposition
      case 'capability-re-present':
        // A new socket / stale scope: re-present then resend pending (idempotent).
        await this.presentCapabilityWithRetry()
        await this.resendPending()
        return disposition
      case 'key-generation-catch-up-and-reemit':
        // VE-C2: the legitimate lagger missed a rotation. Catch up + re-emit the same
        // update under a new seq + the new generation. Never the same seq.
        await this.catchUpGenerationAndReemit(rejectedDeviceId, rejectedSeq, retainedEncoded)
        return disposition
      case 'retry':
      case 'unknown':
      default:
        return disposition
    }
  }

  /**
   * Slice SR / VE-C2 — the LEGITIME LAGGER re-emit. A still-active member authored a
   * log-entry under a content key whose generation the broker has rotated PAST, and
   * the broker rejected it KEY_GENERATION_STALE. This:
   *
   *  (a) CATCH-UP: wait (bounded) until the local current generation advances strictly
   *      past `rejectedSeq`'s generation — i.e. the missed key-rotation arrived in the
   *      inbox and was imported. If it has not arrived in the wait window, PARK: leave
   *      the stale entry 'pending' and return (no busy spin) — the normal
   *      blocked-by-key / reconnect path retries once the rotation lands.
   *  (b) RECOVER the plaintext update: from the retained in-memory `encoded` (live
   *      lagger) OR, on crash-recovery (no in-memory update), by decrypting the
   *      PERSISTED alt-gen JWS with its HISTORICAL content key (getContentKeyByGeneration
   *      of the JWS payload's keyGeneration). NO new durable plaintext-at-rest.
   *  (c) RE-EMIT the SAME plaintext via {@link writeLocalUpdate}, which reserves a NEW
   *      seq and encrypts under the CURRENT generation. Same seq is FORBIDDEN (the
   *      deterministic nonce is SHA-256(deviceId|seq) without keyGeneration → same seq +
   *      new key = AES-GCM nonce reuse; the Slice-A nonce-reuse blocker). The engine
   *      deduplicates the SAME CRDT update applied twice, so the re-emit is idempotent.
   *  (d) SUPERSEDE the stale entry: markAcked the OLD (deviceId,seq) so resendPending
   *      never re-sends the old-gen JWS on the next reconnect (which would re-trigger
   *      KEY_GENERATION_STALE — a churn loop).
   *
   * Re-entrancy: a single reject drives exactly one re-emit (guarded), so two routed
   * KEY_GENERATION_STALE frames for the same write cannot double-emit.
   */
  private async catchUpGenerationAndReemit(
    rejectedDeviceId?: string,
    rejectedSeq?: number,
    retainedEncoded?: Uint8Array,
  ): Promise<void> {
    const deviceId = rejectedDeviceId ?? this.deviceId
    if (typeof rejectedSeq !== 'number') return
    const guardKey = appliedKey(deviceId, rejectedSeq)
    if (this.reemitInFlight.has(guardKey)) return
    this.reemitInFlight.add(guardKey)
    try {
      const rejectedGeneration = await this.readStaleGeneration(deviceId, rejectedSeq)
      if (rejectedGeneration === null) return // nothing persisted / unverifiable → no-op

      // (a) Catch up the missed rotation. PARK (no busy spin) if it has not landed yet:
      // the parked re-emit is drained later by replayPendingReemits() once the rotation
      // arrives (the adapter calls it on a key-rotation import, next to the
      // blocked-by-key replay).
      const advanced = await this.awaitGenerationAdvance(rejectedGeneration)
      if (!advanced) {
        this.pendingReemits.set(guardKey, { deviceId, seq: rejectedSeq, encoded: retainedEncoded })
        return
      }

      await this.performReemit(deviceId, rejectedSeq, rejectedGeneration, retainedEncoded)
    } finally {
      this.reemitInFlight.delete(guardKey)
    }
  }

  /**
   * Read the keyGeneration the persisted (deviceId,seq) entry was authored under (its
   * alt-gen anchor for catch-up + crash-recovery decrypt). Returns null if no entry is
   * persisted (already superseded / never stored) or it cannot be verified — in either
   * case there is nothing safe to re-emit.
   */
  private async readStaleGeneration(deviceId: string, seq: number): Promise<number | null> {
    const stale = await this.config.logStore.getEntry(this.config.docId, deviceId, seq)
    if (!stale) return null
    try {
      const payload = await verifyLogEntryJws(stale.entryJws, { crypto: this.config.crypto })
      return payload.keyGeneration
    } catch {
      return null
    }
  }

  /**
   * VE-C2 re-emit body (shared by the live reject path and the parked-replay path):
   *  (b) recover the plaintext — the live in-memory `retainedEncoded` if present, else
   *      decrypt the persisted alt-gen JWS with its historical content key
   *      (crash-recovery; no plaintext-at-rest),
   *  (c) re-emit via writeLocalUpdate (NEW seq + current generation), and
   *  (d) supersede the stale (deviceId,seq) via markAcked so resendPending never
   *      re-sends the old-gen JWS (no KEY_GENERATION_STALE churn loop).
   * Returns true if the re-emit was written, false if the plaintext could not be
   * recovered (the stale entry then stays pending for a later retry).
   */
  private async performReemit(
    deviceId: string,
    seq: number,
    rejectedGeneration: number,
    retainedEncoded?: Uint8Array,
  ): Promise<boolean> {
    let plaintext: Uint8Array | null = retainedEncoded ?? null
    if (!plaintext) {
      const stale = await this.config.logStore.getEntry(this.config.docId, deviceId, seq)
      if (!stale) return false
      plaintext = await this.recoverPlaintextFromStaleEntry(stale, rejectedGeneration)
    }
    if (!plaintext) return false // historical key gone — leave pending

    const reemitted = await this.writeLocalUpdate(plaintext)
    if (!reemitted) return false // no current content key (should not happen post-advance)

    await this.config.logStore.markAcked(this.config.docId, deviceId, seq)
    return true
  }

  /**
   * VE-C2 parked-re-emit drain: a key-rotation has been imported, so retry every
   * KEY_GENERATION_STALE re-emit that parked because its rotation had not yet arrived.
   * The adapter calls this on a key-rotation import, right next to
   * {@link replayBlockedByKey} (which replays the READ-path buffer). LOOP-GUARD-safe:
   * a re-emit only fires once its rejected generation is now strictly behind the
   * current generation; an entry whose generation still has not advanced stays parked.
   *
   * Returns the number of parked re-emits that fired on this pass.
   */
  async replayPendingReemits(): Promise<number> {
    if (this.pendingReemits.size === 0) return 0
    const parked = [...this.pendingReemits.entries()]
    let fired = 0
    for (const [guardKey, { deviceId, seq, encoded }] of parked) {
      if (this.reemitInFlight.has(guardKey)) continue
      this.reemitInFlight.add(guardKey)
      try {
        const rejectedGeneration = await this.readStaleGeneration(deviceId, seq)
        if (rejectedGeneration === null) {
          // Already superseded / gone — drop it from the park set.
          this.pendingReemits.delete(guardKey)
          continue
        }
        const advanced = await this.awaitGenerationAdvance(rejectedGeneration)
        if (!advanced) continue // still no rotation — keep parked
        const ok = await this.performReemit(deviceId, seq, rejectedGeneration, encoded)
        if (ok) {
          this.pendingReemits.delete(guardKey)
          fired += 1
        }
      } finally {
        this.reemitInFlight.delete(guardKey)
      }
    }
    return fired
  }

  /** Count of currently parked KEY_GENERATION_STALE re-emits (test/inspection). */
  pendingReemitCount(): number {
    return this.pendingReemits.size
  }

  /**
   * VE-C2 bounded generation catch-up: resolve true once the local current generation
   * is strictly past `rejectedGeneration`. Uses the adapter's bounded
   * {@link LogSyncCoordinatorConfig.awaitKeyGenerationAdvance} when wired; otherwise a
   * single immediate check via getContentKey (no wait) — re-emit only if the new
   * generation is already present. Either way this NEVER busy-spins.
   */
  private async awaitGenerationAdvance(rejectedGeneration: number): Promise<boolean> {
    if (this.config.awaitKeyGenerationAdvance) {
      return this.config.awaitKeyGenerationAdvance(rejectedGeneration)
    }
    const content = await this.config.getContentKey()
    return content !== null && content.generation > rejectedGeneration
  }

  /**
   * VE-C2 crash-recovery decrypt: recover the plaintext CRDT update of a stale
   * persisted entry by decrypting its alt-gen JWS payload with the HISTORICAL content
   * key for the entry's own keyGeneration. Returns null if the historical key is no
   * longer available (then the entry stays pending — no plaintext-at-rest is created).
   */
  private async recoverPlaintextFromStaleEntry(
    stale: LocalLogEntry,
    rejectedGeneration: number,
  ): Promise<Uint8Array | null> {
    const historicalKey = await this.config.getContentKeyByGeneration(rejectedGeneration)
    if (!historicalKey) return null
    let payload: LogEntryPayload
    try {
      payload = await verifyLogEntryJws(stale.entryJws, { crypto: this.config.crypto })
    } catch {
      return null
    }
    try {
      const blob = decodeBase64Url(payload.data)
      return await decryptLogPayload({ crypto: this.config.crypto, spaceContentKey: historicalKey, blob })
    } catch {
      return null
    }
  }

  /**
   * Restore/Clone (VE-4/VE-5): a SEQ_COLLISION_DETECTED (matched on CODE, never on
   * a clientHint) or a mid-session DEVICE_REVOKED for our own deviceId. The
   * MECHANISM (mint deviceId + device-revoke old + re-register) lives in the
   * adapter's {@link WriteRejectHandler}; the coordinator re-binds its seq
   * namespace to the returned new deviceId, re-publishes on the new connection
   * scope, and re-writes pending entries UNDER THE NEW deviceId from seq=0. The
   * colliding seq is NEVER re-used with divergent plaintext (the new deviceId is a
   * fresh nonce namespace).
   */
  private async restoreClone(reject: {
    code: BrokerErrorCode
    rejectedDeviceId?: string
    rejectedSeq?: number
  }): Promise<void> {
    if (this.restoreCloneInFlight) return
    this.restoreCloneInFlight = true
    // VE-11 write-pause: hold every log-entry send from the moment the restore-clone
    // begins until the NEW deviceId is BOTH re-registered AND has its capability
    // re-presented. The gate must NOT open merely on the rebind (registered): a
    // log-entry sent after register but BEFORE present-capability is acked is
    // rejected CAPABILITY_REQUIRED. So the gate opens only AFTER ensurePublished
    // (space-register + present-capability under the new deviceId) completes.
    let gateOpened = false
    let resolveGate: () => void = () => {}
    this.rebinding = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    // Idempotent: opening the gate resolves the promise AND nulls it so steady-state
    // sends short-circuit. Safe to call from both the success path and the backstop.
    const openWritePauseGate = (): void => {
      if (gateOpened) return
      gateOpened = true
      resolveGate()
      this.rebinding = null
    }
    try {
      const handler = this.config.onWriteRejected
      if (!handler) {
        // No mechanism wired: surface nothing further (the coordinator never mints
        // a deviceId itself). The caller/audit sees the disposition via the return.
        return
      }
      const oldDeviceId = this.deviceId
      const outcome = await handler({
        code: reject.code,
        disposition: classifyRejectDisposition(reject.code),
        docId: this.config.docId,
        deviceId: reject.rejectedDeviceId ?? oldDeviceId,
      })
      // Re-bind to the NEW deviceId (a restore-clone MUST return one). A handler
      // that returns void leaves the deviceId unchanged (degenerate; treated as a
      // no-op restore so we never silently re-use the colliding seq).
      const newDeviceId = outcome?.deviceId
      if (!newDeviceId || newDeviceId === oldDeviceId) return
      this.deviceId = newDeviceId
      // A new deviceId = a fresh per-(deviceId,docId) seq namespace; clear the
      // in-memory applied-set guard for our OWN device is unnecessary (it keys by
      // the authoring device), but the in-flight correlation for the old device is
      // stale — drop it.
      this.inFlightWrites.clear()
      // Re-publish under the NEW deviceId (space-register + present-capability). The
      // gate stays CLOSED through this: ensurePublished sends only CONTROL frames
      // (never log-entries, so the gate does not block it — and the restore-clone
      // skips the re-entrant catch-up step), and a log-entry must NOT race ahead of
      // present-capability.
      this.published = false
      this.publishing = null
      await this.ensurePublished()
      // NOW the new deviceId is BOTH registered AND capability-presented → OPEN the
      // gate so the re-write below + any parked concurrent write send under it.
      openWritePauseGate()
      // Re-write the current CRDT state under the NEW deviceId from seq=0. The
      // colliding seq under the OLD deviceId is abandoned (never re-used with
      // divergent plaintext — a new deviceId is a fresh nonce namespace). When the
      // adapter supplies no re-write hook, fall back to resending the stored
      // pending (only correct if those were already re-keyed to the new deviceId).
      if (this.config.onAfterRestoreClone) {
        await this.config.onAfterRestoreClone(newDeviceId)
      } else {
        await this.resendPending()
      }
    } finally {
      // Backstop: ALWAYS open the gate (no-handler / no-new-deviceId / any-error path)
      // so a failed restore can never wedge writes forever. On the error path the
      // active deviceId is the OLD one (the handler threw before this.deviceId was set,
      // or rebindDeviceId rolled it back), so parked writes resume under the still-
      // registered old deviceId; their ensurePublished re-triggers the catch-up restore
      // on the next attempt (or the broker rejects them, surfacing the failure).
      openWritePauseGate()
      this.restoreCloneInFlight = false
    }
  }

  /**
   * DEVICE_NOT_REGISTERED / DEVICE_ID_CONFLICT (VE-4): register the deviceId
   * (challenge-response) BEFORE the next log-entry. The registration MECHANISM is
   * the adapter's {@link WriteRejectHandler}; a DEVICE_ID_CONFLICT may return a
   * fresh deviceId (re-bound here), a plain DEVICE_NOT_REGISTERED keeps the id.
   */
  private async deviceReRegister(code: BrokerErrorCode, rejectedDeviceId?: string): Promise<void> {
    const handler = this.config.onWriteRejected
    if (!handler) return
    const outcome = await handler({
      code,
      disposition: 'device-re-register',
      docId: this.config.docId,
      deviceId: rejectedDeviceId ?? this.deviceId,
    })
    if (outcome?.deviceId && outcome.deviceId !== this.deviceId) {
      this.deviceId = outcome.deviceId
      this.inFlightWrites.clear()
    }
    await this.resendPending()
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function appliedKey(deviceId: string, seq: number): string {
  return `${deviceId}\u0000${seq}`
}

/** Buffer key for a blocked-by-key entry, by the AUTHORING (deviceId, seq). */
function blockedKey(deviceId: string, seq: number): string {
  return appliedKey(deviceId, seq)
}

/**
 * Slice B v2 / VE-B1: true iff any device's head in `after` is strictly higher than in
 * `before` (a NEW device appearing also counts as advancement). Used to measure
 * strict-contiguous progress across a sync-page against the pre-request snapshot.
 */
function headsAdvanced(
  before: Record<string, number>,
  after: Record<string, number>,
): boolean {
  for (const [device, seq] of Object.entries(after)) {
    const prev = Object.prototype.hasOwnProperty.call(before, device) ? before[device] : -1
    if (seq > prev) return true
  }
  return false
}

function brokerErrorCodeOf(err: unknown): BrokerErrorCode | null {
  if (err instanceof ControlFrameRejectedError) return err.code
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (isKnownBrokerErrorCode(code)) return code
  }
  return null
}

function unwrapSyncResponse(value: unknown): SyncResponseMessage | null {
  if (value === null || value === undefined) return null
  // The in-process mock may return the sync-response message directly, or wrap it
  // in `{ type:'message', envelope }` (relay parity).
  const candidate = isMessageWrapper(value) ? value.envelope : value
  try {
    return parseSyncResponseMessage(candidate)
  } catch {
    return null
  }
}

function isMessageWrapper(value: unknown): value is { type: 'message'; envelope: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'message' &&
    'envelope' in (value as object)
  )
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID()
}

/** A minimal delivery-receipt view: the relay/transport `send()` result shape. */
interface DeliveryReceiptLike {
  messageId: string
  status: string
}

/** Structural parse of a `send()` result into a delivery receipt, or null. */
function asDeliveryReceipt(value: unknown): DeliveryReceiptLike | null {
  if (typeof value !== 'object' || value === null) return null
  const messageId = (value as { messageId?: unknown }).messageId
  const status = (value as { status?: unknown }).status
  if (typeof messageId !== 'string' || typeof status !== 'string') return null
  return { messageId, status }
}
