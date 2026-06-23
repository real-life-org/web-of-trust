import type { ProtocolCryptoAdapter } from '../crypto/ports'
import type { DocLogStore, LocalLogEntry } from '../../ports/DocLogStore'
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

/** Disposition the coordinator surfaces to the caller after a reject. */
export type RejectDisposition =
  | 'capability-re-present'
  | 'device-re-register'
  | 'restore-clone'
  | 'hard-stop'
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
    case 'DEVICE_ID_CONFLICT':
      return 'device-re-register'
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
  /** Available key generations for blocked-by-key classification (VE-5 preview). */
  getAvailableKeyGenerations(): Promise<readonly number[]>
  /**
   * Sends the space-register control frame for the docId (VE-8), or returns
   * undefined for Personal-docs (no space-register). Idempotent re-registers are
   * first-writer-wins on the relay. The coordinator awaits its receipt before
   * present-capability.
   */
  sendSpaceRegister?: () => Promise<ControlFrameReceipt | undefined>
  /** Clock (testable). */
  now?: () => Date
}

/** Result of {@link LogSyncCoordinator.receiveLogEntry}. */
export type ReceiveLogEntryResult =
  | { disposition: 'applied'; deviceId: string; seq: number }
  | { disposition: 'idempotent-skip'; deviceId: string; seq: number }
  | { disposition: 'engine-foreign-skip'; reason: string }
  | { disposition: 'blocked-by-key'; keyGeneration: number }
  | { disposition: 'rejected'; reason: string }

export class LogSyncCoordinator {
  private readonly config: LogSyncCoordinatorConfig
  private readonly now: () => Date

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

  constructor(config: LogSyncCoordinatorConfig) {
    this.config = config
    this.now = config.now ?? (() => new Date())
  }

  /** Reset connection-scoped state on (re)connect — a new socket = empty scope cache (VE-4/VE-9). */
  resetForReconnect(): void {
    this.published = false
    this.publishing = null
    this.controlTail = Promise.resolve()
    this.pendingSyncRequests.clear()
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
    // (3)+(4) sync-request head-abgleich + seq-consistency (VE-4). A restore-clone
    //     disposition is surfaced to the caller — the coordinator does not mint a
    //     new deviceId itself (that is an adapter/runtime concern in this phase).
    await this.catchUpInternal({ presentCapabilityFirst: false })
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
    const { docId, deviceId, authorKid } = this.config

    const entry = await this.config.logStore.appendLocalEntry({
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

    await this.sendLogEntryEnvelope(entry.entryJws)
    return entry
  }

  /** Re-send a pending entry's STORED JWS unchanged (reconnect retry, VE-2). */
  async resendPending(): Promise<void> {
    const pending = await this.config.logStore.getPending()
    for (const entry of pending) {
      if (entry.docId !== this.config.docId) continue
      await this.sendLogEntryEnvelope(entry.entryJws)
    }
  }

  private async sendLogEntryEnvelope(entryJws: string): Promise<void> {
    const recipients = await this.resolveRecipients()
    const message = createLogEntryMessage({
      id: cryptoRandomUuid(),
      from: this.config.ownDid,
      to: recipients,
      createdTime: Math.floor(this.now().getTime() / 1000),
      entry: entryJws,
    })
    await this.config.envelopes.send(message)
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
    const blocked = await this.classifyBlockedByKey(payload.keyGeneration)
    if (blocked) {
      return { disposition: 'blocked-by-key', keyGeneration: payload.keyGeneration }
    }

    const contentKey = await this.config.getContentKeyByGeneration(payload.keyGeneration)
    if (!contentKey) {
      return { disposition: 'blocked-by-key', keyGeneration: payload.keyGeneration }
    }

    let plaintext: Uint8Array
    try {
      const blob = decodeBase64Url(payload.data)
      plaintext = await decryptLogPayload({ crypto: this.config.crypto, spaceContentKey: contentKey, blob })
    } catch {
      // Cannot decrypt with the available key — treat as blocked-by-key, never crash.
      return { disposition: 'blocked-by-key', keyGeneration: payload.keyGeneration }
    }

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
    return { disposition: 'applied', deviceId: payload.deviceId, seq: payload.seq }
  }

  private async classifyBlockedByKey(keyGeneration: number): Promise<boolean> {
    const available = await this.config.getAvailableKeyGenerations()
    return classifyLogEntryKeyDisposition({ keyGeneration, availableKeyGenerations: available }) === 'blocked-by-key'
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Catch-up (VE-4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * (Re)connect catch-up (VE-4): present read-capability for the docId (a new
   * socket has an empty scope cache, so re-present), then sync-request(localHeads)
   * → sync-response → idempotent apply. Returns the broker-head-abgleich result so
   * the caller can act on a restore-clone disposition.
   */
  async catchUp(): Promise<{ restoreCloneRequired: boolean }> {
    return this.catchUpInternal({ presentCapabilityFirst: true })
  }

  private async catchUpInternal(
    opts: { presentCapabilityFirst: boolean; timeoutMs?: number },
  ): Promise<{ restoreCloneRequired: boolean }> {
    if (opts.presentCapabilityFirst) {
      await this.presentCapabilityWithRetry()
    }

    const localHeads = await this.config.logStore.getKnownHeads(this.config.docId)
    const requestId = cryptoRandomUuid()
    const request = createSyncRequestMessage({
      id: requestId,
      from: this.config.ownDid,
      to: [this.config.ownDid],
      createdTime: Math.floor(this.now().getTime() / 1000),
      body: { docId: this.config.docId, heads: localHeads },
    })

    // Register the async waiter BEFORE sending (the relay answers via onMessage →
    // handleIncoming). A mock that returns the response synchronously short-circuits.
    const responsePromise = new Promise<SyncResponseMessage | null>((resolve) => {
      const timeout = opts.timeoutMs ?? 1000
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
      return this.applySyncResponse(synchronous)
    }

    const response = await responsePromise
    if (!response) return { restoreCloneRequired: false }
    return this.applySyncResponse(response)
  }

  /**
   * Apply a sync-response (VE-4): idempotently apply every entry, then run the
   * broker head-abgleich via classifyLocalBrokerSeqConsistency against our own
   * deviceId. A broker_seq>local_seq means restore-clone (the broker saw a higher
   * seq under our deviceId than we have locally).
   */
  async applySyncResponse(response: SyncResponseMessage): Promise<{ restoreCloneRequired: boolean }> {
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
      await this.receiveLogEntry(message)
    }

    // VE-4 broker head-abgleich: deviceId absent in heads => broker_seq=-1 => no
    // restore (normal first-write/creator). broker_seq>local_seq => restore-clone.
    const brokerSeq = Object.prototype.hasOwnProperty.call(response.body.heads, this.config.deviceId)
      ? response.body.heads[this.config.deviceId]
      : -1
    const localHeads = await this.config.logStore.getKnownHeads(this.config.docId)
    const localSeq = Object.prototype.hasOwnProperty.call(localHeads, this.config.deviceId)
      ? localHeads[this.config.deviceId]
      : -1

    if (brokerSeq < 0) return { restoreCloneRequired: false }
    if (localSeq < 0) {
      // We have no local entry but the broker has one under our deviceId — that is
      // a higher broker seq than local => restore-clone (Sync 002 seq-Konsistenz).
      return { restoreCloneRequired: true }
    }
    const disposition = classifyLocalBrokerSeqConsistency({
      docId: this.config.docId,
      deviceId: this.config.deviceId,
      localSeq,
      brokerSeq,
    })
    return { restoreCloneRequired: disposition.disposition === 'restore-clone-required' }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Reject disposition (VE-4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Maps an error thrown by the control/envelope transport to a VE-4 disposition.
   * AUTHOR_MISMATCH is a HARD STOP (no retry) and re-thrown as
   * {@link AuthorMismatchError} so it cannot be swallowed into a retry loop.
   */
  dispositionForError(err: unknown): RejectDisposition {
    const code = brokerErrorCodeOf(err)
    if (!code) return 'unknown'
    const disposition = classifyRejectDisposition(code)
    if (disposition === 'hard-stop') {
      throw new AuthorMismatchError(this.config.docId, this.config.deviceId, this.config.authorKid)
    }
    return disposition
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function appliedKey(deviceId: string, seq: number): string {
  return `${deviceId}\u0000${seq}`
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
