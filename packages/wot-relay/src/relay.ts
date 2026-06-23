import { createServer, type Server as HttpServer } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { WebSocketServer, type WebSocket } from 'ws'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'
import type { RelayMessage } from './types.js'
import { OfflineQueue } from './queue.js'
import { DocLog } from './log-store.js'
import { getDashboardHtml } from './dashboard-html.js'

const {
  didKeyToPublicKeyBytes,
  createBrokerChallengeControlFrame,
  createBrokerRegisteredControlFrame,
  decideBrokerChallengeNonceConsumption,
  isDidcommMessage,
  isEncryptedInboxMessageType,
  parseAckMessage,
  parseBrokerChallengeNonce,
  parseBrokerChallengeResponseControlFrame,
  parseBrokerRegisterControlFrame,
  verifyBrokerChallengeResponseControlFrame,
  parseLogEntryMessage,
  verifyLogEntryJws,
  parseSyncRequestMessage,
  createSyncResponseMessage,
} = protocol

const DIDCOMM_PLAINTEXT_TYP = protocol.DIDCOMM_PLAINTEXT_TYP
const ACK_MESSAGE_TYPE = protocol.ACK_MESSAGE_TYPE
const LOG_ENTRY_MESSAGE_TYPE = protocol.LOG_ENTRY_MESSAGE_TYPE
const SYNC_REQUEST_MESSAGE_TYPE = protocol.SYNC_REQUEST_MESSAGE_TYPE

// did:key the broker uses as the `from` of its own sync-response transport
// envelope. Authority for inner log entries is per-entry authorKid (Sync 002
// Z.126), NOT envelope.from — this is only a schema-valid transport sender.
const RELAY_SYNC_FROM_DID = 'did:key:z6MkrelayBrokerSyncResponderPlaceholder0000000000'

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

export interface RelayServerOptions {
  port: number
  dbPath?: string // SQLite path, defaults to ':memory:' for tests
}

/** Pending challenge awaiting response from client, bound to the connection. */
interface PendingChallenge {
  did: string
  deviceId: string
  nonce: string
  createdAt: number
}

const CHALLENGE_TIMEOUT_MS = 30_000 // 30 seconds to respond
const NONCE_BYTE_LENGTH = 32

export class RelayServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private connections = new Map<string, Set<WebSocket>>() // DID → Set of WebSockets (multi-device)
  private socketToDid = new Map<WebSocket, string>() // WebSocket → DID (reverse lookup)
  private socketToDeviceId = new Map<WebSocket, string>() // WebSocket → deviceId
  private knownDevices = new Map<string, Set<string>>() // DID → Set of known deviceIds
  private pendingChallenges = new Map<WebSocket, PendingChallenge>()
  private consumedChallengeNonces = new Map<string, number>() // canonical nonce → expiresAt epoch ms
  private db: Database.Database
  private queue: OfflineQueue
  private docLog: DocLog
  private startedAt = Date.now()

  constructor(private options: RelayServerOptions) {
    // ONE SQLite connection shared by the offline inbox queue and the durable
    // log store. Sharing matters for tests: two separate ':memory:' handles are
    // distinct databases, and prod runs on a single file anyway. The RelayServer
    // owns the connection; OfflineQueue/DocLog treat it as borrowed.
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    this.queue = new OfflineQueue(this.db)
    this.docLog = new DocLog(this.db)
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      // Create HTTP server for dashboard + health endpoints
      this.httpServer = createServer((req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET')

        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
        } else if (req.url === '/dashboard') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(getDashboardHtml())
        } else if (req.url === '/dashboard/data') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(this.getStats()))
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      // Attach WebSocket server to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws) => {
        this.handleConnection(ws)
      })

      this.httpServer.listen(this.options.port, () => {
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const sockets of this.connections.values()) {
      for (const ws of sockets) ws.close()
    }
    this.connections.clear()
    this.socketToDid.clear()
    this.socketToDeviceId.clear()
    this.pendingChallenges.clear()
    this.consumedChallengeNonces.clear()

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve())
      })
      this.wss = null
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    // queue/docLog borrow the shared connection (close() is a no-op there); the
    // RelayServer owns and closes it.
    this.queue.close()
    this.docLog.close()
    this.db.close()
  }

  get port(): number {
    return this.options.port
  }

  get connectedDids(): string[] {
    return [...this.connections.keys()]
  }

  getStats(): Record<string, unknown> {
    const dids = this.connectedDids
    const devicesPerDid: Record<string, number> = {}
    let totalConnections = 0
    for (const [did, sockets] of this.connections) {
      devicesPerDid[did] = sockets.size
      totalConnections += sockets.size
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      connectedDids: dids,
      connectionCount: totalConnections,
      devicesPerDid,
      queueStats: {
        total: this.queue.count(),
        byDid: this.queue.countByDid(),
      },
      // Slice R durable-log stats (retained append-only content/sync channel).
      logStats: {
        totalEntries: this.docLog.entryCount(),
        docCount: this.docLog.docCount(),
        entriesByDoc: this.docLog.entriesByDoc(),
        devicesByDoc: this.docLog.devicesByDoc(),
        totalLogBytes: this.docLog.totalLogBytes(),
      },
      memoryMB: process.memoryUsage().rss / (1024 * 1024),
    }
  }

  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        this.sendTo(ws, {
          type: 'error',
          code: 'MALFORMED_MESSAGE',
          message: 'Invalid JSON',
        })
        return
      }
      this.handleMessage(ws, parsed)
    })

    ws.on('close', () => {
      this.pendingChallenges.delete(ws)
      const did = this.socketToDid.get(ws)
      if (did) {
        const sockets = this.connections.get(did)
        if (sockets) {
          sockets.delete(ws)
          if (sockets.size === 0) this.connections.delete(did)
        }
        this.socketToDid.delete(ws)
        this.socketToDeviceId.delete(ws)
      }
    })
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    if (msg === null || typeof msg !== 'object') {
      this.sendTo(ws, { type: 'error', code: 'MALFORMED_MESSAGE', message: 'Invalid message' })
      return
    }
    const record = msg as Record<string, unknown>
    // Safety net for the synchronous dispatch path: a throw from any handler
    // (e.g. a SQLite read error in handleSyncRequest's durable-log query) must
    // not propagate to the ws 'message' listener (which only guards JSON.parse)
    // and crash the connection/process. The async durable-log ingest is guarded
    // separately at its dispatch site via .catch(). Pre-existing handlers report
    // their own errors and do not throw on tested paths, so this only catches the
    // unexpected.
    try {
      switch (record.type) {
        case 'register':
          this.handleRegister(ws, record)
          break
        case 'challenge-response':
          void this.handleChallengeResponse(ws, record)
          break
        case 'send':
          this.handleSend(ws, (record.envelope ?? {}) as Record<string, unknown>)
          break
        case 'ack':
          this.handleAck(ws, String(record.messageId ?? ''))
          break
        case 'ping':
          this.sendTo(ws, { type: 'pong' })
          break
        default:
          this.sendTo(ws, { type: 'error', code: 'MALFORMED_MESSAGE', message: 'Unknown message type' })
      }
    } catch (err) {
      this.sendInternalError(ws, err, 'message handling failed')
    }
  }

  /**
   * Step 1: Client sends register → Relay responds with challenge nonce.
   * Sync 003 Broker-Auth-Transcript: register MUST carry `did` and a canonical
   * lowercase UUID-v4 `deviceId`. Validation is delegated to the protocol
   * register-frame helper.
   */
  private handleRegister(ws: WebSocket, raw: Record<string, unknown>): void {
    let frame
    try {
      frame = parseBrokerRegisterControlFrame(raw)
      didKeyToPublicKeyBytes(frame.did)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Invalid register frame',
      })
      return
    }

    // Generate 32 random bytes and build the challenge frame via protocol helper
    // — this produces a canonical unpadded Base64URL nonce, not hex.
    const nonceBytes = new Uint8Array(randomBytes(NONCE_BYTE_LENGTH))
    const challengeFrame = createBrokerChallengeControlFrame({ nonce: nonceBytes })

    // Bind the pending challenge to this exact connection plus did/deviceId/nonce.
    this.pendingChallenges.set(ws, {
      did: frame.did,
      deviceId: frame.deviceId,
      nonce: challengeFrame.nonce,
      createdAt: Date.now(),
    })

    this.sendTo(ws, challengeFrame)
  }

  /**
   * Step 2: Client signs the Broker-Auth-Transcript and sends it back.
   * Verification is delegated to the protocol challenge-response helper, which
   * parses the frame, applies the pending-challenge binding rule, and verifies
   * the Ed25519 signature over the JCS-canonicalized transcript bytes.
   */
  private async handleChallengeResponse(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    const candidateNonce = this.tryGetChallengeResponseNonce(raw)
    if (candidateNonce && this.isConsumedChallengeNonce(candidateNonce)) {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, {
        type: 'error',
        code: 'NONCE_REPLAY',
        message: 'Challenge nonce has already been consumed.',
      })
      return
    }

    const pending = this.pendingChallenges.get(ws)

    if (!pending) {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'No pending challenge. Send register first.',
      })
      return
    }

    if (Date.now() - pending.createdAt > CHALLENGE_TIMEOUT_MS) {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'Challenge expired. Send register again.',
      })
      return
    }

    // Caller-supplied public key bytes from the shared DID helper — no local
    // DID-to-public-key decoding in this file.
    let publicKey: Uint8Array
    try {
      publicKey = didKeyToPublicKeyBytes(pending.did)
    } catch {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: 'Pending did is not a resolvable did:key',
      })
      return
    }

    let result
    try {
      result = await verifyBrokerChallengeResponseControlFrame({
        frame: raw,
        pendingChallenge: {
          did: pending.did,
          deviceId: pending.deviceId,
          nonce: pending.nonce,
        },
        publicKey,
        crypto: protocolCrypto,
      })
    } catch (err) {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, {
        type: 'error',
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Verifier failure',
      })
      return
    }

    if (result.disposition === 'rejected') {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'Signature verification failed or challenge binding mismatched.'
            : 'Malformed challenge-response frame.',
      })
      return
    }

    const consumed = decideBrokerChallengeNonceConsumption({
      nonce: parseBrokerChallengeNonce(result.frame.nonce),
      consumedNonces: this.getConsumedChallengeNonceSet(),
      now: new Date(),
    })
    if (consumed.decision === 'reject') {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, {
        type: 'error',
        code: 'NONCE_REPLAY',
        message: 'Challenge nonce has already been consumed.',
      })
      return
    }

    // Auth successful — complete registration.
    this.pendingChallenges.delete(ws)
    this.rememberConsumedChallengeNonce(
      consumed.remember.canonicalNonce,
      consumed.remember.until,
    )
    this.completeRegistration(ws, result.frame.did, result.frame.deviceId)
  }

  private tryGetChallengeResponseNonce(raw: Record<string, unknown>): string | null {
    try {
      return parseBrokerChallengeResponseControlFrame(raw).nonce
    } catch {
      return null
    }
  }

  private isConsumedChallengeNonce(nonce: string, nowMs = Date.now()): boolean {
    this.pruneConsumedChallengeNonces(nowMs)
    return this.consumedChallengeNonces.has(nonce)
  }

  private getConsumedChallengeNonceSet(nowMs = Date.now()): ReadonlySet<string> {
    this.pruneConsumedChallengeNonces(nowMs)
    return new Set(this.consumedChallengeNonces.keys())
  }

  private rememberConsumedChallengeNonce(nonce: string, until: Date): void {
    const untilMs = until.getTime()
    if (!Number.isFinite(untilMs)) return
    this.consumedChallengeNonces.set(nonce, untilMs)
  }

  private pruneConsumedChallengeNonces(nowMs = Date.now()): void {
    for (const [nonce, expiresAt] of this.consumedChallengeNonces) {
      if (expiresAt <= nowMs) this.consumedChallengeNonces.delete(nonce)
    }
  }

  /**
   * Complete the registration after successful auth.
   * Delivers queued messages to the newly authenticated client.
   */
  private completeRegistration(ws: WebSocket, did: string, deviceId: string): void {
    // Support multiple devices per DID
    let sockets = this.connections.get(did)
    if (!sockets) {
      sockets = new Set()
      this.connections.set(did, sockets)
    }
    sockets.add(ws)
    this.socketToDid.set(ws, did)
    this.socketToDeviceId.set(ws, deviceId)

    let knownForDid = this.knownDevices.get(did)
    if (!knownForDid) {
      knownForDid = new Set()
      this.knownDevices.set(did, knownForDid)
    }
    const isNewDevice = !knownForDid.has(deviceId)
    knownForDid.add(deviceId)

    const registeredFrame = createBrokerRegisteredControlFrame({ did, deviceId, isNewDevice })
    this.sendTo(ws, { ...registeredFrame, peers: sockets.size - 1 })

    // First: get previously delivered but unACKed messages (redelivery)
    const unacked = this.queue.getUnacked(did)
    for (const envelope of unacked) {
      this.sendTo(ws, { type: 'message', envelope })
    }

    // Then: deliver newly queued messages (marks them as 'delivered')
    const queued = this.queue.dequeue(did)
    for (const envelope of queued) {
      this.sendTo(ws, { type: 'message', envelope })
    }
  }

  private handleSend(ws: WebSocket, envelope: Record<string, unknown>): void {
    const senderDid = this.socketToDid.get(ws)
    if (!senderDid) {
      this.sendTo(ws, {
        type: 'error',
        code: 'NOT_REGISTERED',
        message: 'Must register before sending',
      })
      return
    }

    // Sync 003 ack/1.0: ein DIDComm-Inbox-ACK ist an den Broker gerichtet — er
    // bestätigt durable Verarbeitung der referenzierten Inbox-Nachricht und wird
    // auf queue.ack gemappt, nicht geroutet. Matcht NUR die Type-URI-Familie;
    // der Old-World-Typ 'ack' bleibt eine opake Passthrough-Message.
    if (envelope.typ === DIDCOMM_PLAINTEXT_TYP && envelope.type === ACK_MESSAGE_TYPE) {
      this.handleInboxAckEnvelope(ws, senderDid, envelope)
      return
    }

    // Slice R / Sync 002: log-entry ingest into the durable append-only log.
    // The content/sync channel does NOT use the inbox queue — the log is the
    // source of truth (retained, never deleted on ACK). Async because it must
    // verify the JWS and hash it; dispatched like handleChallengeResponse.
    //
    // Only a STRUCTURALLY VALID log-entry envelope diverts here (parses via
    // parseLogEntryMessage → carries body.entry as a compact JWS). A merely
    // log-entry-TYPED but malformed envelope falls through to generic routing so
    // legacy queue + ack/1.0 ownership semantics stay byte-for-byte unchanged
    // (DidcommInboxRouting: a queued log-sync-typed slot is not ack/1.0-clearable).
    if (envelope.typ === DIDCOMM_PLAINTEXT_TYP && envelope.type === LOG_ENTRY_MESSAGE_TYPE) {
      const entryJws = this.tryParseLogEntryJws(envelope)
      if (entryJws !== null) {
        // Fire-and-forget, but never let a post-verify durable-write/broadcast
        // failure become an unhandled rejection (would crash the process on
        // Node 22) — report it to the sender instead.
        this.handleLogEntry(ws, envelope, entryJws).catch((err) =>
          this.sendInternalError(ws, err, 'log-entry ingest failed'),
        )
        return
      }
    }

    // Slice R / Sync 002: sync-request → sync-response served from the durable
    // log to the requesting authenticated socket only (catch-up / cold
    // reconstruction). Not routed to any recipient. Only a structurally valid
    // sync-request diverts; a malformed one falls through to generic routing.
    if (envelope.typ === DIDCOMM_PLAINTEXT_TYP && envelope.type === SYNC_REQUEST_MESSAGE_TYPE) {
      if (this.isParsableSyncRequest(envelope)) {
        this.handleSyncRequest(ws, envelope)
        return
      }
    }

    // Routing: Old-World `toDid`, DIDComm `to[0]` (Sync 003 Transport Envelope).
    const to = envelope.to
    const toDid =
      (envelope.toDid as string | undefined) ??
      (Array.isArray(to) && typeof to[0] === 'string' ? (to[0] as string) : undefined)
    if (!toDid) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MISSING_RECIPIENT',
        message: 'Envelope must have toDid or to[0] field',
      })
      return
    }

    const messageId = (envelope.id as string) ?? 'unknown'
    const now = new Date().toISOString()

    // Try to deliver to all connected devices of recipient. For self-addressed
    // multi-device sync, exclude the sending socket: the sender already applied
    // the change locally, and ACKing its own echo would delete the queued copy
    // before offline sibling devices can receive it on reconnect.
    const recipientSockets = this.connections.get(toDid)
    const targetSockets = recipientSockets
      ? [...recipientSockets].filter((recipientWs) => toDid !== senderDid || recipientWs !== ws)
      : []
    if (targetSockets.length > 0) {
      for (const recipientWs of targetSockets) {
        this.sendTo(recipientWs, { type: 'message', envelope })
      }

      // Persist until ACK — enqueue as 'queued' then immediately mark 'delivered'
      this.queue.enqueue(toDid, envelope)
      this.queue.markDelivered(messageId)

      // Notify sender: delivered
      this.sendTo(ws, {
        type: 'receipt',
        receipt: { messageId, status: 'delivered', timestamp: now },
      })
    } else {
      // Queue for offline delivery
      this.queue.enqueue(toDid, envelope)

      // Notify sender: accepted (queued)
      this.sendTo(ws, {
        type: 'receipt',
        receipt: { messageId, status: 'accepted', timestamp: now },
      })
    }
  }

  /**
   * Returns the compact-JWS entry if `envelope` is a structurally valid
   * log-entry message, else null (so the caller can fall through to generic
   * routing for malformed log-entry-typed envelopes).
   */
  private tryParseLogEntryJws(envelope: Record<string, unknown>): string | null {
    try {
      return parseLogEntryMessage(envelope).body.entry
    } catch {
      return null
    }
  }

  /** True if `envelope` is a structurally valid sync-request message. */
  private isParsableSyncRequest(envelope: Record<string, unknown>): boolean {
    try {
      parseSyncRequestMessage(envelope)
      return true
    } catch {
      return false
    }
  }

  /**
   * Slice R / Sync 002 log-entry ingest.
   *
   * A log-entry is a DIDComm-plaintext envelope (type log-entry/1.0) whose body
   * carries an opaque JWS. The broker MUST NOT trust docId/deviceId/seq from
   * envelope fields — it reads them from the AUTHENTICATED JWS payload
   * (verifyLogEntryJws verifies the Ed25519 signature against the did:key in
   * authorKid and that authorKid === header.kid; Sync 002 Z.126 — authority via
   * authorKid, not envelope.from). The broker NEVER decrypts `data`.
   *
   * Boundary checks run ATOMICALLY inside docLog.appendEntry (one transaction):
   *   - reject-author-mismatch (VE-3a) → a different authorKid already owns this
   *     (docId,deviceId) namespace; do NOT store, do NOT relay; reply AUTHOR_MISMATCH.
   *   - reject-seq-collision (VE-3, Sync 002 Z.81 deterministic-nonce reuse) →
   *     divergent content at an existing (docId,deviceId,seq); do NOT store, do NOT
   *     relay; reply SEQ_COLLISION_DETECTED + clientHint restore-clone-required.
   *   - idempotent-retransmission → no re-store, no re-broadcast.
   *   - accept-new-entry → bind owner on first write + append + live-relay to
   *     currently connected recipient devices (no inbox queue, no delete-on-ACK).
   */
  private async handleLogEntry(
    ws: WebSocket,
    envelope: Record<string, unknown>,
    entryJws: string,
  ): Promise<void> {
    let payload
    try {
      payload = await verifyLogEntryJws(entryJws, { crypto: protocolCrypto })
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: err instanceof Error ? err.message : 'Log-entry JWS verification failed',
      })
      return
    }

    const { docId, deviceId, seq, authorKid } = payload
    // Sync 003 §Broker: collision/dedup hash is over the JCS-canonicalized PAYLOAD
    // (not the JWS envelope), so an identical payload re-encoded into a different
    // valid JWS dedups as idempotent rather than a false SEQ_COLLISION_DETECTED.
    const incomingContentHash = await this.docLog.hashPayload(payload)
    const messageId = (envelope.id as string) ?? 'unknown'

    // Author-binding (VE-3a) + seq-collision (VE-3) + the durable insert run
    // ATOMICALLY inside appendEntry (one SQLite transaction, no intervening
    // await), so a foreign author cannot squat a (docId,deviceId) namespace and a
    // divergent seq cannot race a concurrent first write. The broker reads the
    // coordinates + authorKid from the verified JWS only (authority via authorKid,
    // Sync 002 Z.126) and never decrypts `data`.
    const result = this.docLog.appendEntry({
      docId,
      deviceId,
      seq,
      authorKid,
      contentHash: incomingContentHash,
      entryJws,
    })

    if (result.disposition === 'reject-author-mismatch') {
      // VE-3a: this (docId,deviceId) namespace is owned by a different authorKid.
      // Not stored, not relayed.
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message: 'Author mismatch: this (docId,deviceId) namespace is owned by a different authorKid.',
      })
      return
    }
    if (result.disposition === 'reject-seq-collision') {
      // Nonce-safety boundary: the divergent entry never reached the durable log
      // and is not relayed. Sender gets the restore-clone hint.
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message: 'Sequence collision: divergent entry at an existing (docId,deviceId,seq).',
        clientHint: result.clientHint,
      })
      return
    }
    if (result.disposition === 'idempotent-retransmission') {
      // Already have this exact (deviceId,seq,content): no re-store, no
      // re-broadcast. Acknowledge so the client's send() resolves.
      this.sendTo(ws, {
        type: 'receipt',
        receipt: { messageId, status: 'delivered', timestamp: new Date().toISOString() },
      })
      return
    }

    // accept-new-entry: the entry is durably stored. Live broadcast to currently-connected recipient devices (realtime
    // preserved). Routing uses the transport envelope `to` recipients; the
    // sender's own socket is excluded so a device does not receive its own echo.
    const recipients = Array.isArray(envelope.to)
      ? (envelope.to as unknown[]).filter((d): d is string => typeof d === 'string')
      : []
    for (const recipientDid of recipients) {
      const sockets = this.connections.get(recipientDid)
      if (!sockets) continue
      for (const recipientWs of sockets) {
        if (recipientWs === ws) continue
        this.sendTo(recipientWs, { type: 'message', envelope })
      }
    }

    this.sendTo(ws, {
      type: 'receipt',
      receipt: { messageId, status: 'delivered', timestamp: new Date().toISOString() },
    })
  }

  /**
   * Slice R / Sync 002 sync-request → sync-response.
   *
   * Serves a catch-up page from the durable log to the requesting authenticated
   * socket only (handleSend already enforces senderDid). Empty heads ⇒ full log
   * from seq 0 (cold reconstruction). Finer per-space membership authz is out of
   * scope — content is E2E ciphertext the broker cannot read. Authority for each
   * served entry is its own authorKid, not the response envelope `from`.
   */
  private handleSyncRequest(ws: WebSocket, envelope: Record<string, unknown>): void {
    let request
    try {
      request = parseSyncRequestMessage(envelope)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Malformed sync-request envelope',
      })
      return
    }

    // Sync 003: `limit` Default is 100. Without an effective cap, cold
    // reconstruction with empty heads on a large doc would build + send one
    // unbounded sync-response; the client pages on `truncated` via the existing
    // paging path.
    const { docId, heads, limit } = request.body
    const effectiveLimit = limit ?? 100
    const { entries, truncated } = this.docLog.getSinceWithTruncation(docId, heads, effectiveLimit)
    const responseHeads = this.docLog.getHeads(docId)

    const response = createSyncResponseMessage({
      id: randomUUID(),
      from: RELAY_SYNC_FROM_DID,
      createdTime: Math.floor(Date.now() / 1000),
      thid: request.id,
      body: { docId, entries, heads: responseHeads, truncated },
    })

    this.sendTo(ws, { type: 'message', envelope: response as unknown as Record<string, unknown> })
  }

  /**
   * Last-resort guard: report an unexpected handler failure to the sender without
   * crashing the relay. The durable-log ingest is dispatched fire-and-forget
   * (`handleLogEntry(...).catch(...)`) and the synchronous dispatch is wrapped in
   * handleMessage, so a transient SQLite error (SQLITE_IOERR/BUSY/disk-full, a
   * closed handle during shutdown, etc.) surfaces as an INTERNAL_ERROR frame —
   * the sender's send() resolves instead of hanging — rather than an unhandled
   * rejection / uncaught exception that would take the whole server down. Slice R
   * promotes the relay to a durable source of truth, so one bad write must not be
   * fatal.
   */
  private sendInternalError(ws: WebSocket, err: unknown, context: string): void {
    console.error(`[relay] ${context}:`, err)
    this.sendTo(ws, {
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : context,
    })
  }

  /**
   * Old-World Control-Frame-ACK (`{ type: 'ack', messageId }`).
   *
   * Der Control-Frame darf kein Bypass für die ack/1.0-Ownership sein
   * (Sync 003 §ack/1.0, Z.611-624). Solange der referenzierte Queue-Slot
   * existiert, gilt:
   *
   * - Trägt der Slot eine DIDComm-Nachricht der Inbox-Familie
   *   (ENCRYPTED_INBOX_MESSAGE_TYPES), räumt ihn ausschließlich das ack/1.0
   *   des Reception-Hosts — der Control-Frame wird abgelehnt, auch vom
   *   Empfänger selbst, denn er trägt keine Ack-Disposition
   *   (ACK-Vorbedingungen: durable Verarbeitung).
   * - Für alle anderen Slots (Old-World, Log-Sync-Typen) MUSS die per
   *   Challenge-Response authentifizierte DID der Empfänger sein
   *   (referenced.toDid) — fremde Slots sind nicht räumbar
   *   (Autoritätsgrenze, Sync 003 Z.388-396).
   *
   * Unbekannte messageIds bleiben stille No-Ops (bereits geräumter Slot,
   * Geschwister-Gerät derselben DID): alte Clients, die ihre eigenen
   * Old-World-Nachrichten acken, verhalten sich unverändert (Rollout:
   * relay-first).
   */
  private handleAck(ws: WebSocket, messageId: string): void {
    const did = this.socketToDid.get(ws)
    if (!did) return // Not registered — ignore

    const referenced = this.queue.getByMessageId(messageId)
    if (referenced) {
      const referencedType = isDidcommMessage(referenced.envelope) ? referenced.envelope.type : undefined
      if (typeof referencedType === 'string' && isEncryptedInboxMessageType(referencedType)) {
        this.discardAck(ws, 'control-frame ack cannot clear an inbox-channel message — ack/1.0 required')
        return
      }
      if (referenced.toDid !== did) {
        this.discardAck(ws, 'control-frame ack references a message addressed to another DID')
        return
      }
    }

    this.queue.ack(messageId)
  }

  /**
   * Sync 003 Z.594-624: `ack/1.0`-Transport-Envelope vom Inbox-Reception-Host.
   * Formvalidierung übernimmt parseAckMessage: `thid` MUSS gesetzt sein,
   * `thid` und `body.messageId` MÜSSEN die kanonische lowercase UUID v4 der
   * Original-Nachricht tragen und übereinstimmen. Verstöße werden verworfen
   * und geloggt (MALFORMED_MESSAGE) — die Queue bleibt unberührt, die
   * referenzierte Nachricht wird bei Reconnect redelivered.
   *
   * Laufzeitprüfungen (Sync 003 §ack/1.0 — "Diese Bindungen sind
   * Protokollzustand pro Verbindung und Inbox"):
   *
   * Was das Relay wissen KANN: solange die referenzierte Nachricht noch in
   * der Queue liegt, kennt das Relay ihren Empfänger (to_did) und — bei
   * DIDComm-Form — ihre Type-URI. Ein ack/1.0, das auf einen Log-Sync-Typ
   * (log-entry/sync-request/sync-response) oder eine Old-World-Envelope
   * referenziert, ist normativ ungültig und wird mit MALFORMED_MESSAGE
   * abgelehnt (Sync 003 §Log-Sync vs. Inbox-ACK); ebenso ein ack auf einen
   * fremden Queue-Slot (Nachricht nicht an die authentifizierte DID
   * adressiert). Maßgeblich ist die per Challenge-Response authentifizierte
   * DID, nicht `from` im Envelope (Autoritätsgrenze, Sync 003 Z.388-396).
   * Inbox-Typen = die vier implementierten ENCRYPTED_INBOX_MESSAGE_TYPES;
   * weitere Inbox-Typen (z.B. HMC trust-list-delta/1.0) kommen mit ihrer
   * Implementierung dazu.
   *
   * Was das Relay NICHT wissen kann: nach dem Räumen eines Slots ist der Typ
   * der Original-Nachricht nicht mehr rekonstruierbar, und per-Device-Inboxen
   * sind SPEC-DEFERRED (die Queue ist per-DID) — Geschwister-Geräte derselben
   * DID acken daher legitim bereits geräumte Slots. Unbekannte messageIds
   * werden deshalb idempotent akzeptiert statt strikt abgelehnt.
   */
  private handleInboxAckEnvelope(ws: WebSocket, ackingDid: string, envelope: Record<string, unknown>): void {
    let messageId: string
    try {
      messageId = parseAckMessage(envelope).body.messageId
    } catch (err) {
      this.discardAck(ws, err instanceof Error ? err.message : 'Malformed ack/1.0 envelope')
      return
    }

    const referenced = this.queue.getByMessageId(messageId)
    if (referenced) {
      if (referenced.toDid !== ackingDid) {
        this.discardAck(ws, 'ack/1.0 references a message addressed to another DID')
        return
      }
      const referencedType = isDidcommMessage(referenced.envelope) ? referenced.envelope.type : undefined
      if (typeof referencedType !== 'string' || !isEncryptedInboxMessageType(referencedType)) {
        this.discardAck(ws, 'ack/1.0 must reference an inbox-channel message')
        return
      }
    }

    this.queue.ack(messageId)
    // Receipt, damit das client-seitige send() des ack-Envelopes auflöst.
    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: (envelope.id as string) ?? 'unknown',
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Ungültiges ACK (ack/1.0-Envelope oder Old-World-Control-Frame) verwerfen:
   * loggen + MALFORMED_MESSAGE an den Sender, Queue bleibt unberührt.
   */
  private discardAck(ws: WebSocket, reason: string): void {
    console.warn(`[relay] ack discarded: ${reason}`)
    this.sendTo(ws, { type: 'error', code: 'MALFORMED_MESSAGE', message: reason })
  }

  private sendTo(ws: WebSocket, msg: RelayMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }
}
