/**
 * AutomergePersonalLogSyncAdapter — Personal-Doc multi-device sync on the
 * Sync 002/003 LOG path (Slice A VE-6, Sync 006) — the Automerge counterpart of
 * {@link YjsPersonalLogSyncAdapter}.
 *
 * It reuses the SAME engine-neutral {@link LogSyncCoordinator} as the Space path,
 * so the Personal-Doc gets the identical single-writer / multi-device / loop-guard
 * / catch-up / restore-clone machinery. Only the engine hooks (Automerge change
 * capture + applyChanges) and the VE-9 docId differ.
 *
 * Personal-Doc bindings (Sync 006 / Sync 003 `#persönliche-dokumente`):
 *  - Single-Writer-per-device, Multi-Device CRDT — same Log-Core.
 *  - NO space-register (the personal doc is not a Space; `sendSpaceRegister` is
 *    omitted). The capability is a SELF-ISSUED Personal-Doc-Capability under the
 *    Identity Key (kid = `<did>#sig-0`, audience = own DID).
 *  - The content key is derived deterministically from the seed and is NEVER
 *    rotated (generation = 0 permanently). Nonce uniqueness therefore rests
 *    SOLELY on seq monotonicity per deviceId — so the broker-head-abgleich
 *    (VE-2) before the first publication AND the restore/clone path (VE-4) apply
 *    to the Personal-Doc docId with IDENTICAL strictness as for Spaces.
 *
 * VE-9: the wire docId is the canonical UUID Personal-Doc id (= personalDocIdFromKey),
 * present on present-capability + log-entry + sync-request. The Automerge handle's
 * native base58 documentId is derived from that UUID (spaceIdToDocumentId) — the
 * UUID is the single persistent/wire identity.
 *
 * LOOP-GUARD (VE-3): the Automerge change observer writes a log entry ONLY for
 * LOCAL changes; the read path applies remote changes under the `applyingRemote`
 * flag and NEVER re-broadcasts or re-writes.
 *
 * NON-GOAL: this does NOT touch `useProfileSync` / the `profile-update` envelope
 * (Old-World contact distribution) and does NOT touch the legacy `personal-sync`
 * path (PersonalNetworkAdapter).
 */
import * as Automerge from '@automerge/automerge'
import type { DocHandle } from '@automerge/automerge-repo'
import type { MessagingAdapter, WireMessage, DocLogStore } from '@web_of_trust/core/ports'
import type { IdentitySession } from '@web_of_trust/core/types'
import type {
  ProtocolCryptoAdapter,
  CapabilitySource,
  LogSyncEngineHooks,
} from '@web_of_trust/core/protocol'
import {
  LogSyncCoordinator,
  AuthorMismatchError,
  LocalAppendFailedError,
  createPersonalDocCapabilityJwsWithSigner,
  LOG_ENTRY_MESSAGE_TYPE,
  SYNC_RESPONSE_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { createRestoreCloneHandler } from '@web_of_trust/core/adapters'
import { frameChanges, unframeChanges } from './automerge-change-framing'

/** The Personal-Doc capability/content generation — permanently 0 (never rotated). */
const PERSONAL_DOC_GENERATION = 0

export interface AutomergePersonalLogSyncConfig {
  /** The Personal-Doc handle (caller owns the Repo; the native base58 docId is derived from `docId`). */
  docHandle: DocHandle<unknown>
  messaging: MessagingAdapter
  identity: IdentitySession
  /** The deterministic Personal-Doc content key (derived from the seed; never rotated). */
  personalKey: Uint8Array
  /** The Personal-Doc docId (canonical UUID v4 = personalDocIdFromKey(personalKey)). */
  docId: string
  docLogStore: DocLogStore
  /** Stable per-device UUID for the seq namespace. */
  deviceId: string
  crypto?: ProtocolCryptoAdapter
  /** Mint a fresh deviceId on restore-clone (injectable for tests). */
  mintDeviceId?: () => string
  /** Notified after a restore-clone re-binds the deviceId (durable persistence hook). */
  onDeviceIdChanged?: (newDeviceId: string, oldDeviceId: string) => void | Promise<void>
}

export class AutomergePersonalLogSyncAdapter {
  private readonly docHandle: DocHandle<unknown>
  private readonly messaging: MessagingAdapter
  private readonly identity: IdentitySession
  private readonly personalKey: Uint8Array
  private readonly docId: string
  private readonly crypto: ProtocolCryptoAdapter
  private readonly docLogStore: DocLogStore
  private readonly mintDeviceId?: () => string
  private readonly onDeviceIdChangedHook?: (newDeviceId: string, oldDeviceId: string) => void | Promise<void>
  /** Built lazily in start() AFTER the deviceId is resolved from the store (BLOCKER-1b). */
  private coordinator: LogSyncCoordinator | null = null
  /** The deviceId fallback until the store-bound id is resolved. */
  private deviceId: string
  private unsubDocChange: (() => void) | null = null
  private unsubMessage: (() => void) | null = null
  private unsubStateChange: (() => void) | null = null
  private started = false
  /** VE-3 LOOP-GUARD: set while applyRemoteUpdate() applies a remote change. */
  private applyingRemote = false

  constructor(config: AutomergePersonalLogSyncConfig) {
    this.docHandle = config.docHandle
    this.messaging = config.messaging
    this.identity = config.identity
    this.personalKey = config.personalKey
    this.docId = config.docId
    this.crypto = config.crypto ?? new WebCryptoProtocolCryptoAdapter()
    this.docLogStore = config.docLogStore
    this.deviceId = config.deviceId
    this.mintDeviceId = config.mintDeviceId
    this.onDeviceIdChangedHook = config.onDeviceIdChanged
  }

  /**
   * Build the coordinator AFTER resolving the deviceId from the durable store
   * (BLOCKER-1b): the store mints+persists the per-device id, so a store wipe
   * yields a fresh nonce namespace. Idempotent (built once).
   */
  private async ensureCoordinator(): Promise<LogSyncCoordinator> {
    if (this.coordinator) return this.coordinator
    await this.docLogStore.init()
    // TC-A2 (P-DEVICEID, nonce safety): use the caller-resolved deviceId (config.deviceId) —
    // the SAME per-device id Spaces use, resolved ONCE by the composition root via
    // resolveConnectDeviceId(), which performs the partial-meta-only ROTATION a raw
    // getOrCreateDeviceId() would MISS (→ seq-0 nonce reuse). The shared docLogStore is already
    // resolve-connected; calling getOrCreateDeviceId()/resolveConnectDeviceId() HERE would miss
    // the rotation or DOUBLE-rotate the shared store. So do NOT overwrite this.deviceId — it
    // stays the resolved id (restore-clone re-binds it in onWriteRejected). Tests seed the store
    // via setDeviceId() with the same id, so this is behavior-preserving there.

    this.coordinator = new LogSyncCoordinator({
      docId: this.docId, // VE-9: canonical UUID, never the base58 documentId.
      deviceId: this.deviceId,
      ownDid: this.identity.getDid(),
      authorKid: `${this.identity.getDid()}#sig-0`,
      crypto: this.crypto,
      logStore: this.docLogStore,
      control: {
        sendControlFrame: (frame) => this.messaging.sendControlFrame!(frame),
      },
      envelopes: {
        send: (envelope) => this.messaging.send(envelope as WireMessage),
      },
      capabilities: this.personalCapabilitySource(),
      hooks: this.automergeEngineHooks(),
      signLogEntry: (input) => this.identity.signEd25519(input),
      // Personal-Doc is single-owner multi-device: recipients = just own DID.
      getRecipients: () => [this.identity.getDid()],
      // generation 0 permanent; the content key never rotates.
      getContentKey: async () => ({ key: this.personalKey, generation: PERSONAL_DOC_GENERATION }),
      getContentKeyByGeneration: async (generation) =>
        generation === PERSONAL_DOC_GENERATION ? this.personalKey : null,
      getAvailableKeyGenerations: async () => [PERSONAL_DOC_GENERATION],
      // NO space-register for a Personal-Doc (sendSpaceRegister omitted).
      // VE-4/VE-5 restore-clone with FULL strictness (generation never resets, so
      // nonce-uniqueness rests solely on the per-deviceId seq monotonicity).
      onWriteRejected: createRestoreCloneHandler({
        identity: this.identity,
        messaging: this.messaging,
        mintDeviceId: this.mintDeviceId,
        onDeviceIdChanged: async (_docId, newDeviceId, oldDeviceId) => {
          this.deviceId = newDeviceId
          // BLOCKER-1b: persist the restore-clone's new deviceId so a reload adopts
          // the NEW namespace, never the revoked one.
          await this.docLogStore.setDeviceId(newDeviceId)
          await this.onDeviceIdChangedHook?.(newDeviceId, oldDeviceId)
        },
      }),
      // VE-6 (MUSS, identical strictness to Spaces): after a restore-clone
      // re-binds the deviceId, re-write the FULL Personal-Doc state as a fresh log
      // entry under the new deviceId (seq=0). Without this, restoreClone() would
      // fall back to resendPending() — re-sending the OLD colliding entry, which a
      // PERSISTENT collision already rejects → the edit would never converge.
      onAfterRestoreClone: () => this.writeFullStateViaLog(),
    })
    return this.coordinator
  }

  /**
   * VE-6 restore-clone re-write: publish the full Personal-Doc state as ONE log
   * entry under the (freshly re-bound) deviceId, so the second device converges
   * after a real (persistent) seq-collision restore. Generation stays 0.
   */
  private async writeFullStateViaLog(): Promise<void> {
    if (!this.coordinator) return
    const doc = this.docHandle.doc()
    if (!doc) return
    const changes = Automerge.getAllChanges(doc)
    if (changes.length === 0) return
    await this.coordinator.writeLocalUpdate(frameChanges(changes)).catch((err) => {
      if (err instanceof AuthorMismatchError) {
        console.error('[AutomergePersonalLogSync] AUTHOR_MISMATCH during restore-clone re-write:', err.message)
        return
      }
      // E1: a non-transient append failure leaves the re-bound (deviceId,seq=0)
      // namespace empty while the doc claims it was re-published — propagate.
      if (err instanceof LocalAppendFailedError) throw err
      console.debug('[AutomergePersonalLogSync] restore-clone re-write failed (retry on reconnect):', err)
    })
  }

  /** The underlying coordinator (test/inspection + manual catch-up); null until start() resolves it. */
  getCoordinator(): LogSyncCoordinator | null {
    return this.coordinator
  }

  /** The active local deviceId (store-bound; re-bound by a restore-clone). */
  getDeviceId(): string {
    return this.coordinator?.getDeviceId() ?? this.deviceId
  }

  start(): void {
    if (this.started) return
    this.started = true
    // Coordinator construction is async (it resolves the store-bound deviceId
    // first, BLOCKER-1b). Kick off init; doc edits in tests happen after a wait.
    void this.init().catch((err) => this.reportPublishError('init', err))
  }

  /** Async startup: build the coordinator (store-bound deviceId), then wire the paths. */
  private async init(): Promise<void> {
    const coordinator = await this.ensureCoordinator()
    if (!this.started) return // destroyed during async init

    // First publication + catch-up: present-capability → sync-request head-abgleich
    // (VE-2/VE-4) BEFORE the first local write reserves seq.
    void coordinator
      .catchUp()
      .catch((err) => this.reportPublishError('initial catch-up', err))

    // LOOP-GUARD: write a log entry ONLY for LOCAL changes.
    const changeHandler = (payload: { patchInfo?: { before: unknown; after: unknown } }) => {
      if (this.applyingRemote) return
      const info = payload?.patchInfo
      if (!info) return
      const changes = Automerge.getChanges(
        info.before as Automerge.Doc<unknown>,
        info.after as Automerge.Doc<unknown>,
      )
      if (changes.length === 0) return
      void coordinator.writeLocalUpdate(frameChanges(changes)).catch((err) => {
        if (err instanceof AuthorMismatchError) {
          console.error('[AutomergePersonalLogSync] AUTHOR_MISMATCH on personal-doc write — hard stop:', err.message)
          return
        }
        // E1: this local-write handler is fire-and-forget (no caller to propagate
        // to), so a non-transient append failure is surfaced loudly rather than
        // degraded to a deferred-retry log line.
        if (err instanceof LocalAppendFailedError) {
          console.error('[AutomergePersonalLogSync] non-transient local-append failure on personal-doc write (durable state NOT advanced):', err)
          return
        }
        console.debug('[AutomergePersonalLogSync] personal-doc log write failed (retry on reconnect):', err)
      })
    }
    this.docHandle.on('change', changeHandler)
    this.unsubDocChange = () => this.docHandle.off('change', changeHandler)

    // Read path: route log-path messages (log-entry/1.0, sync-response/1.0) AND the
    // routed write-path error frames to the coordinator. Personal-doc messages are
    // own-DID-addressed (multi-device), so any log-path message for THIS docId is
    // ours; the coordinator re-verifies + filters by docId internally.
    this.unsubMessage = this.messaging.onMessage(async (message) => {
      if (this.isLogPathMessage(message) || this.isErrorFrame(message)) {
        await coordinator.handleIncoming(message)
      }
    })

    // Re-sync on reconnect: a new socket = empty scope cache → re-present + catch-up.
    this.unsubStateChange = this.messaging.onStateChange((state) => {
      if (state === 'connected' && this.started) {
        coordinator.resetForReconnect()
        void coordinator
          .catchUp()
          .then(() => coordinator.resendPending())
          .catch((err) => this.reportPublishError('reconnect catch-up', err))
      }
    })
  }

  destroy(): void {
    this.unsubDocChange?.()
    this.unsubDocChange = null
    this.unsubMessage?.()
    this.unsubMessage = null
    this.unsubStateChange?.()
    this.unsubStateChange = null
    this.started = false
  }

  /**
   * Self-issued Personal-Doc capability (Sync 003 `#persönliche-dokumente`): kid =
   * `<did>#sig-0`, audience = own DID, generation 0. Signed via the operation-shaped
   * Identity Key (no raw seed) — spaceCapabilitySigningKey is NEVER the author kid
   * here; the Identity Key self-issues ONLY for the Personal-Doc.
   */
  private personalCapabilitySource(): CapabilitySource {
    return {
      getCapabilityJws: async () => {
        const did = this.identity.getDid()
        const nowMs = Date.now()
        const validityMs = 6 * 30 * 24 * 60 * 60 * 1000
        return createPersonalDocCapabilityJwsWithSigner({
          payload: {
            type: 'capability',
            spaceId: this.docId,
            audience: did,
            permissions: ['read', 'write'],
            generation: PERSONAL_DOC_GENERATION,
            issuedAt: new Date(nowMs).toISOString(),
            validUntil: new Date(nowMs + validityMs).toISOString(),
          },
          kid: `${did}#sig-0`,
          sign: (input) => this.identity.signEd25519(input),
        })
      },
    }
  }

  /**
   * Automerge engine hooks: encode = identity (the change observer frames the
   * changes); applyRemote = applyChanges under the LOOP-GUARD flag so a
   * remote-applied change never re-enters the write path.
   */
  private automergeEngineHooks(): LogSyncEngineHooks {
    return {
      engine: 'automerge',
      encodeUpdate: (update) => update,
      applyRemoteUpdate: (plaintext) => {
        const changes = unframeChanges(plaintext)
        this.applyingRemote = true
        try {
          this.docHandle.update((doc: unknown) => {
            const [next] = Automerge.applyChanges(doc as Automerge.Doc<unknown>, changes)
            return next as never
          })
        } finally {
          this.applyingRemote = false
        }
      },
      // Slice B v2: isForeignPayload removed with the (a)-model. Out-of-order apply —
      // Automerge.applyChanges buffers missing deps internally (does NOT throw), so a
      // same-engine entry above a hole converges; a cross-engine payload throws here →
      // engine-foreign-skip.
    }
  }

  private isLogPathMessage(message: WireMessage): boolean {
    const type = (message as { type?: unknown }).type
    return type === LOG_ENTRY_MESSAGE_TYPE || type === SYNC_RESPONSE_MESSAGE_TYPE
  }

  private isErrorFrame(message: WireMessage): boolean {
    return (message as { type?: unknown }).type === 'error'
  }

  private reportPublishError(phase: string, err: unknown): void {
    if (err instanceof AuthorMismatchError) {
      console.error(`[AutomergePersonalLogSync] AUTHOR_MISMATCH during ${phase}:`, err.message)
      return
    }
    // E1: a non-transient durable-append failure (e.g. a restore-clone re-write
    // triggered during catch-up) is surfaced loudly, never a silent defer.
    if (err instanceof LocalAppendFailedError) {
      console.error(
        `[AutomergePersonalLogSync] non-transient local-append failure during ${phase} (durable state NOT advanced):`,
        err,
      )
      return
    }
    console.debug(`[AutomergePersonalLogSync] ${phase} deferred (retry on reconnect):`, err)
  }
}
