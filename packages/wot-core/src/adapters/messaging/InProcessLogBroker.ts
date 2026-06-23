import type { WireMessage } from '../../ports/MessagingAdapter'
import {
  parseLogEntryMessage,
  type LogEntryMessage,
} from '../../protocol/sync/log-entry'
import {
  parseSyncRequestMessage,
  createSyncResponseMessage,
  type SyncResponseMessage,
} from '../../protocol/sync/sync-messages'
import { verifyLogEntryJws } from '../../protocol/sync/log-entry'
import {
  ControlFrameRejectedError,
  type ControlFrame,
  type ControlFrameReceipt,
} from '../../protocol/sync/control-frame-transport'
import { parsePresentCapabilityControlFrame, PRESENT_CAPABILITY_CONTROL_FRAME_TYPE } from '../../protocol/sync/present-capability-control-frame'
import { parseSpaceRegisterMessage, SPACE_REGISTER_MESSAGE_TYPE, SPACE_ROTATE_MESSAGE_TYPE, parseSpaceRotateMessage } from '../../protocol/sync/broker-admin-messages'
import { controlFrameDocId } from '../../protocol/sync/control-frame-doc-id'
import { WebCryptoProtocolCryptoAdapter } from '../protocol-crypto'
import type { BrokerErrorCode } from '../../protocol/sync/broker-error'

/**
 * InProcessLogBroker — an in-process model of the Sync 003 gated relay's log
 * path, for adapter-level Phase-2 tests (the spike test modes as an adapter,
 * since `packages/sync-spike` is untracked).
 *
 * It is intentionally a faithful-but-minimal mirror of the wire contract:
 *  - `space-register` (VE-8): first-writer-wins; idempotent identical re-register
 *    is accepted; a conflicting re-register is SPACE_ALREADY_REGISTERED.
 *  - `present-capability` (VE-9): records a read+write scope per (socket, docId).
 *    The {@link InProcessLogBrokerControls} let a test pre-arm a rejection
 *    (CAPABILITY_REQUIRED / _EXPIRED / _GENERATION_STALE / DEVICE_REVOKED /
 *    DEVICE_NOT_REGISTERED / AUTHOR_MISMATCH / SEQ_COLLISION_DETECTED) for the
 *    next control frame or the next log-entry — the reject-disposition table is
 *    exercised against real broker error codes.
 *  - `log-entry` ingest gate: verify JWS → device-active → write-capability for
 *    docId → author-binding → seq-collision → accept + broadcast.
 *  - `sync-request`: read-capability → return a sync-response with the doc's log
 *    since the requester's heads, plus the broker heads.
 *
 * Sockets are registered by the InMemoryMessagingAdapter; the broker broadcasts
 * accepted log entries to every socket of the recipient DID(s) EXCEPT the sender
 * socket (relay parity: the author already has the entry locally — this also
 * keeps the LOOP-GUARD test's send-count assertion honest).
 */

export interface BrokerSocket {
  readonly socketId: string
  readonly did: string
  deliver(message: WireMessage): Promise<void> | void
}

interface StoredLogEntry {
  seq: number
  deviceId: string
  authorKid: string
  entryJws: string
  contentHash: string
}

interface DocLog {
  /** registrationJws holder = first writer. */
  registered: boolean
  registrationAdminDids: string[]
  /** entries keyed by `${deviceId}:${seq}`. */
  entries: Map<string, StoredLogEntry>
  /** broker heads: max seq per deviceId. */
  heads: Map<string, number>
}

/** A pre-armed gate rejection for the next matching frame. */
export interface ArmedRejection {
  code: BrokerErrorCode
  message?: string
  /** Apply to the next 'control' frame, the next 'log-entry', or the next 'sync-request'. */
  target: 'control' | 'log-entry' | 'sync-request'
  /** Only reject frames for this docId (optional). */
  docId?: string
  /**
   * Only reject control frames of this exact type (e.g. 'present-capability').
   * Lets a test target present-capability without also matching the
   * space-register frame that shares the same docId.
   */
  frameType?: string
}

export interface InProcessLogBrokerControls {
  /** Arm a one-shot rejection for the next matching frame. */
  armRejection(rejection: ArmedRejection): void
  /** Mark a deviceId as revoked (DEVICE_REVOKED on its next log-entry). */
  revokeDevice(deviceId: string): void
  /** Pre-register a docId as already registered by another admin (SPACE_ALREADY_REGISTERED test). */
  forceRegistered(docId: string, adminDids: string[]): void
  /** Seed a broker head for a deviceId+docId (restore-clone scenarios). */
  seedHead(docId: string, deviceId: string, seq: number): void
}

export class InProcessLogBroker implements InProcessLogBrokerControls {
  private readonly crypto = new WebCryptoProtocolCryptoAdapter()
  private readonly sockets = new Map<string, BrokerSocket>()
  /** docId → DocLog. */
  private readonly docs = new Map<string, DocLog>()
  /** scope cache keyed by `${socketId}:${docId}` → true once present-capability accepted. */
  private readonly scopes = new Set<string>()
  private readonly revokedDevices = new Set<string>()
  private readonly armed: ArmedRejection[] = []

  /** Inspection hook: every control frame the broker received, in order. */
  readonly receivedControlFrames: Array<{ socketId: string; frame: ControlFrame }> = []

  registerSocket(socket: BrokerSocket): void {
    this.sockets.set(socket.socketId, socket)
  }

  unregisterSocket(socketId: string): void {
    this.sockets.delete(socketId)
    for (const key of [...this.scopes]) {
      if (key.startsWith(`${socketId}:`)) this.scopes.delete(key)
    }
  }

  // ── Controls (test arming) ────────────────────────────────────────────────

  armRejection(rejection: ArmedRejection): void {
    this.armed.push(rejection)
  }

  revokeDevice(deviceId: string): void {
    this.revokedDevices.add(deviceId)
  }

  forceRegistered(docId: string, adminDids: string[]): void {
    const log = this.ensureDoc(docId)
    log.registered = true
    log.registrationAdminDids = [...adminDids]
  }

  seedHead(docId: string, deviceId: string, seq: number): void {
    const log = this.ensureDoc(docId)
    log.heads.set(deviceId, seq)
  }

  // ── Control-frame channel (present-capability / space-register / …) ─────────

  async handleControlFrame(socketId: string, frame: ControlFrame): Promise<ControlFrameReceipt> {
    this.receivedControlFrames.push({ socketId, frame })

    const armed = this.takeArmed('control', controlFrameDocId(frame), frame.type)
    if (armed) throw new ControlFrameRejectedError({ code: armed.code, message: armed.message ?? armed.code })

    switch (frame.type) {
      case SPACE_REGISTER_MESSAGE_TYPE:
        return this.handleSpaceRegister(frame)
      case SPACE_ROTATE_MESSAGE_TYPE:
        return this.handleSpaceRotate(socketId, frame)
      case PRESENT_CAPABILITY_CONTROL_FRAME_TYPE:
        return this.handlePresentCapability(socketId, frame)
      default:
        // Unknown control frame: accept with a receipt keyed by any spaceId field.
        return this.receipt(controlFrameDocId(frame) ?? 'unknown')
    }
  }

  private async handleSpaceRegister(frame: ControlFrame): Promise<ControlFrameReceipt> {
    const parsed = parseSpaceRegisterMessage(frame)
    const docId = parsed.payload.spaceId
    const log = this.ensureDoc(docId)
    if (log.registered) {
      // first-writer-wins: identical admin set re-register is idempotent.
      const same =
        log.registrationAdminDids.length === parsed.payload.adminDids.length &&
        log.registrationAdminDids.every((d, i) => d === parsed.payload.adminDids[i])
      if (!same) {
        throw new ControlFrameRejectedError({
          code: 'SPACE_ALREADY_REGISTERED',
          message: 'space already registered by a different admin set',
        })
      }
      return this.receipt(docId)
    }
    log.registered = true
    log.registrationAdminDids = [...parsed.payload.adminDids]
    return this.receipt(docId)
  }

  private async handleSpaceRotate(_socketId: string, frame: ControlFrame): Promise<ControlFrameReceipt> {
    const parsed = parseSpaceRotateMessage(frame)
    const docId = parsed.payload.spaceId
    // After a rotate the relay clears the scope cache hard across all sockets.
    for (const key of [...this.scopes]) {
      if (key.endsWith(`:${docId}`)) this.scopes.delete(key)
    }
    return this.receipt(docId)
  }

  private async handlePresentCapability(socketId: string, frame: ControlFrame): Promise<ControlFrameReceipt> {
    const parsed = parsePresentCapabilityControlFrame(frame)
    // Extract docId from the capability payload (spaceId).
    const docId = typeof parsed.payload.spaceId === 'string' ? parsed.payload.spaceId : undefined
    if (!docId) {
      throw new ControlFrameRejectedError({ code: 'CAPABILITY_INVALID', message: 'capability has no spaceId' })
    }
    this.scopes.add(`${socketId}:${docId}`)
    return this.receipt(docId)
  }

  // ── log-entry ingest gate + sync-request (via `send`) ───────────────────────

  /**
   * Returns true if the message was a log-path message (log-entry / sync-request)
   * the broker handled (so the adapter does NOT also peer-route it). Returns false
   * for any other envelope (the adapter routes it normally).
   */
  async handleSend(socket: BrokerSocket, envelope: WireMessage): Promise<boolean> {
    if (isLogEntryEnvelope(envelope)) {
      await this.ingestLogEntry(socket, envelope as LogEntryMessage)
      return true
    }
    if (isSyncRequestEnvelope(envelope)) {
      await this.answerSyncRequest(socket, envelope)
      return true
    }
    return false
  }

  private async ingestLogEntry(socket: BrokerSocket, envelope: LogEntryMessage): Promise<void> {
    const message = parseLogEntryMessage(envelope)
    const payload = await verifyLogEntryJws(message.body.entry, { crypto: this.crypto }).catch(() => null)
    if (!payload) return // AUTH_INVALID — silently drop (client will time out / not used in tests)

    const docId = payload.docId

    const armed = this.takeArmed('log-entry', docId)
    if (armed) {
      this.emitError(socket, message.id, armed.code, armed.message ?? armed.code)
      return
    }

    // device-active
    if (this.revokedDevices.has(payload.deviceId)) {
      this.emitError(socket, message.id, 'DEVICE_REVOKED', 'device revoked')
      return
    }

    // write-capability for docId on this socket
    if (!this.scopes.has(`${socket.socketId}:${docId}`)) {
      this.emitError(socket, message.id, 'CAPABILITY_REQUIRED', 'no capability presented for doc')
      return
    }

    const log = this.ensureDoc(docId)
    const slot = `${payload.deviceId}:${payload.seq}`
    const contentHash = await this.hash(message.body.entry)
    const existing = log.entries.get(slot)
    if (existing) {
      if (existing.contentHash === contentHash) {
        // idempotent retransmission — accept, no re-broadcast needed but re-broadcast is harmless.
        this.broadcast(socket, message, payload.deviceId)
        return
      }
      this.emitError(socket, message.id, 'SEQ_COLLISION_DETECTED', 'seq collision (restore-clone-required)')
      return
    }

    log.entries.set(slot, {
      seq: payload.seq,
      deviceId: payload.deviceId,
      authorKid: payload.authorKid,
      entryJws: message.body.entry,
      contentHash,
    })
    const head = log.heads.get(payload.deviceId) ?? -1
    if (payload.seq > head) log.heads.set(payload.deviceId, payload.seq)

    this.broadcast(socket, message, payload.deviceId)
  }

  private async answerSyncRequest(socket: BrokerSocket, envelope: WireMessage): Promise<void> {
    const request = parseSyncRequestMessage(envelope)
    const docId = request.body.docId

    const armed = this.takeArmed('sync-request', docId)
    if (armed) {
      this.emitError(socket, request.id, armed.code, armed.message ?? armed.code)
      return
    }
    if (!this.scopes.has(`${socket.socketId}:${docId}`)) {
      this.emitError(socket, request.id, 'CAPABILITY_REQUIRED', 'no read capability presented for doc')
      return
    }

    const log = this.ensureDoc(docId)
    const entries: string[] = []
    for (const stored of [...log.entries.values()].sort(byDeviceThenSeq)) {
      const since = request.body.heads[stored.deviceId]
      if (since === undefined || stored.seq > since) entries.push(stored.entryJws)
    }
    const heads: Record<string, number> = {}
    for (const [deviceId, seq] of log.heads) heads[deviceId] = seq

    const response: SyncResponseMessage = createSyncResponseMessage({
      id: globalThis.crypto.randomUUID(),
      from: socket.did,
      to: [socket.did],
      createdTime: Math.floor(Date.now() / 1000),
      thid: request.id,
      body: { docId, entries, heads, truncated: false },
    })
    // Relay parity: sync-response comes back as a routed message to the requester.
    await socket.deliver(response as unknown as WireMessage)
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private broadcast(sender: BrokerSocket, message: LogEntryMessage, _authorDeviceId: string): void {
    const recipients = new Set(message.to)
    for (const socket of this.sockets.values()) {
      if (socket.socketId === sender.socketId) continue // never echo to the author socket
      if (!recipients.has(socket.did)) continue
      void socket.deliver(message as unknown as WireMessage)
    }
  }

  private emitError(socket: BrokerSocket, messageId: string, code: BrokerErrorCode, message: string): void {
    // log-entry / sync-request errors travel as a routed `error` frame to the
    // sender. The adapter surfaces it to the coordinator's onMessage handler.
    void socket.deliver({ type: 'error', thid: messageId, code, message } as unknown as WireMessage)
  }

  private ensureDoc(docId: string): DocLog {
    let log = this.docs.get(docId)
    if (!log) {
      log = { registered: false, registrationAdminDids: [], entries: new Map(), heads: new Map() }
      this.docs.set(docId, log)
    }
    return log
  }

  private takeArmed(
    target: ArmedRejection['target'],
    docId: string | undefined,
    frameType?: string,
  ): ArmedRejection | null {
    const idx = this.armed.findIndex(
      (a) =>
        a.target === target &&
        (a.docId === undefined || a.docId === docId) &&
        (a.frameType === undefined || a.frameType === frameType),
    )
    if (idx < 0) return null
    return this.armed.splice(idx, 1)[0]
  }

  private async hash(value: string): Promise<string> {
    const digest = await this.crypto.sha256(new TextEncoder().encode(value))
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  }

  private receipt(messageId: string): ControlFrameReceipt {
    return { messageId, status: 'delivered', timestamp: new Date().toISOString() }
  }
}

function isLogEntryEnvelope(envelope: WireMessage): boolean {
  return (envelope as { type?: unknown }).type === 'https://web-of-trust.de/protocols/log-entry/1.0'
}

function isSyncRequestEnvelope(envelope: WireMessage): boolean {
  return (envelope as { type?: unknown }).type === 'https://web-of-trust.de/protocols/sync-request/1.0'
}

function byDeviceThenSeq(a: StoredLogEntry, b: StoredLogEntry): number {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  return a.seq - b.seq
}
