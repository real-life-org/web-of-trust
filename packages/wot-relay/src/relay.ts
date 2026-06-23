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
  didOrKidToDid,
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
  parseBrokerDeviceRevokeControlFrame,
  verifyBrokerDeviceRevokeControlFrame,
  parseSpaceRegisterMessage,
  verifySpaceRegisterMessage,
  parseSpaceRotateMessage,
  verifySpaceRotateMessage,
  parseAdminAddMessage,
  verifyAdminAddMessage,
  parseAdminRemoveMessage,
  verifyAdminRemoveMessage,
  parseLogEntryMessage,
  verifyLogEntryJws,
  parseSyncRequestMessage,
  createSyncResponseMessage,
  verifySpaceCapabilityJws,
  verifyPersonalDocCapabilityJws,
  decodeJws,
  decodeBase64Url,
} = protocol

const BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE = protocol.BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE
const SPACE_REGISTER_MESSAGE_TYPE = protocol.SPACE_REGISTER_MESSAGE_TYPE
const SPACE_ROTATE_MESSAGE_TYPE = protocol.SPACE_ROTATE_MESSAGE_TYPE
const ADMIN_ADD_MESSAGE_TYPE = protocol.ADMIN_ADD_MESSAGE_TYPE
const ADMIN_REMOVE_MESSAGE_TYPE = protocol.ADMIN_REMOVE_MESSAGE_TYPE

// Sync 003 §Capability-Prüfung: a `present-capability` control-frame is a CLOSED
// top-level frame carrying exactly `{ type, capabilityJws }`. Like device-revoke /
// space-register it is dispatched at the top level (NOT wrapped in a `send`
// envelope) and a malformed shape is rejected with MALFORMED_MESSAGE here.
const PRESENT_CAPABILITY_CONTROL_FRAME_TYPE = 'present-capability'

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

/**
 * A capability scope established by a verified `present-capability` for one
 * `(WebSocket, docId)` (Sync 003 §Capability-Prüfung). The cache MUST carry the
 * `permissions` AND the `generation` (generation-aware from day one, so a
 * `space-rotate`/STALE check has the data it needs). `path` records whether the
 * scope was established via the Space path (registered docId) or the Personal-Doc
 * path (no registry entry) — the VE-8 first-register invalidation drops only
 * `personal` scopes for a docId.
 */
interface CachedScope {
  permissions: Set<'read' | 'write'>
  generation: number
  path: 'space' | 'personal'
}

const CHALLENGE_TIMEOUT_MS = 30_000 // 30 seconds to respond
const NONCE_BYTE_LENGTH = 32

export class RelayServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private connections = new Map<string, Set<WebSocket>>() // DID → Set of WebSockets (multi-device)
  private socketToDid = new Map<WebSocket, string>() // WebSocket → DID (reverse lookup)
  private socketToDeviceId = new Map<WebSocket, string>() // WebSocket → deviceId
  // Per-WebSocket capability scope cache (Sync 003 §Capability-Prüfung,
  // session-scoped). Sessions are WS-bound, so this is correctly in-memory and
  // cleared on close. Map<WebSocket, Map<docId, CachedScope>>.
  private socketToScopes = new Map<WebSocket, Map<string, CachedScope>>()
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
    this.socketToScopes.clear()
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
      // Capability scopes are session-scoped (per-WebSocket); drop this socket's
      // entire scope cache on close (Sync 003 §Capability-Prüfung).
      this.socketToScopes.delete(ws)
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
        case BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE:
          void this.handleDeviceRevoke(ws, record)
          break
        case SPACE_REGISTER_MESSAGE_TYPE:
          void this.handleSpaceRegister(ws, record)
          break
        case SPACE_ROTATE_MESSAGE_TYPE:
          void this.handleSpaceRotate(ws, record)
          break
        case ADMIN_ADD_MESSAGE_TYPE:
          void this.handleAdminAdd(ws, record)
          break
        case ADMIN_REMOVE_MESSAGE_TYPE:
          void this.handleAdminRemove(ws, record)
          break
        case PRESENT_CAPABILITY_CONTROL_FRAME_TYPE:
          void this.handlePresentCapability(ws, record)
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
   *
   * Consults the DURABLE device list (Sync 003 §Erstregistrierung): the deviceId
   * is registered globally-uniquely, so a deviceId already owned by ANOTHER DID
   * (active OR revoked tombstone) is rejected with DEVICE_ID_CONFLICT, and a
   * revoked tombstone for THIS DID is rejected with DEVICE_REVOKED. On rejection
   * the connection is NOT registered (no socket bookkeeping, no `registered`
   * frame, no inbox delivery). On success it delivers queued messages to the
   * newly authenticated client.
   */
  private completeRegistration(ws: WebSocket, did: string, deviceId: string): void {
    // Durable Erstregistrierung conflict checks (atomic in the device table).
    const disposition = this.docLog.registerDevice(did, deviceId)
    if (disposition.disposition === 'device-id-conflict') {
      this.sendTo(ws, {
        type: 'error',
        code: 'DEVICE_ID_CONFLICT',
        message: 'deviceId is already registered for another DID (device IDs must be globally unique).',
      })
      return
    }
    if (disposition.disposition === 'device-revoked') {
      this.sendTo(ws, {
        type: 'error',
        code: 'DEVICE_REVOKED',
        message: 'This device has been revoked.',
      })
      return
    }

    // Support multiple devices per DID
    let sockets = this.connections.get(did)
    if (!sockets) {
      sockets = new Set()
      this.connections.set(did, sockets)
    }
    sockets.add(ws)
    this.socketToDid.set(ws, did)
    this.socketToDeviceId.set(ws, deviceId)

    const registeredFrame = createBrokerRegisteredControlFrame({
      did,
      deviceId,
      isNewDevice: disposition.isNewDevice,
    })
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

  /**
   * Sync 003 §Device-Deaktivierung: `device-revoke` Broker Control-Frame.
   *
   * Outer wire shape `{ type: 'device-revoke', revocationJws }` (closed top-level
   * keys). The inner JWS payload `{ type, did, deviceId, revokedAt }` MUST be
   * signed by the Identity Key of `did`. Verification is delegated to the core
   * primitive (parse → decode inner JWS → verify Ed25519 against the key derived
   * from the payload `did`): malformed → MALFORMED_MESSAGE, bad/foreign signature
   * → AUTH_INVALID. On success the broker marks (did, deviceId) revoked in the
   * DURABLE device list (idempotent re-revoke ok; first metadata authoritative)
   * and deletes pending inbox messages for that device. A revocation does NOT
   * require the socket to be authenticated as that DID — any valid signature by
   * the DID's Identity Key may revoke any of its devices (Shared-Seed model).
   */
  private async handleDeviceRevoke(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    // Parse the closed outer frame + inner JWS payload first (MALFORMED_MESSAGE on
    // any structural defect) so we can derive the signer key from the payload DID.
    let parsed
    try {
      parsed = parseBrokerDeviceRevokeControlFrame(raw)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Malformed device-revoke control-frame',
      })
      return
    }

    // Public key bytes via the shared DID helper — no inline crypto in this file.
    let publicKey: Uint8Array
    try {
      publicKey = didKeyToPublicKeyBytes(parsed.payload.did)
    } catch {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'device-revoke did is not a resolvable did:key',
      })
      return
    }

    let result
    try {
      result = await verifyBrokerDeviceRevokeControlFrame({
        frame: raw,
        publicKey,
        crypto: protocolCrypto,
      })
    } catch (err) {
      this.sendInternalError(ws, err, 'device-revoke verification failed')
      return
    }

    if (result.disposition === 'rejected') {
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'device-revoke signature invalid or not signed by the claimed DID.'
            : 'Malformed device-revoke control-frame.',
      })
      return
    }

    const { did, deviceId, revokedAt } = result.payload
    // Durable revoke (idempotent; first metadata authoritative). Then drop pending
    // inbox messages for the revoked device. The inbox queue is per-DID
    // (per-device inbox is spec-deferred), so there is nothing device-scoped to
    // delete here yet; the durable tombstone + the live status==active checks on
    // ingest/sync-request are what enforce the revocation going forward.
    this.docLog.revokeDevice(did, deviceId, revokedAt)

    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: deviceId,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Sync 003 §Space-Registrierung: `space-register` Broker Control-Frame.
   *
   * Outer wire shape `{ type: 'space-register', registrationJws }` (closed
   * top-level keys). The inner JWS payload
   * `{ type, spaceId, spaceCapabilityVerificationKey, adminDids }` is verified
   * TOFU/self-asserting (Sync 003 MUSS): the inner JWS `kid`-DID MUST be one of
   * the payload's `adminDids`, and the signature MUST verify against that kid-DID's
   * Ed25519 key (derived from the `did:key`). Verification is delegated to the core
   * primitive: malformed → MALFORMED_MESSAGE, non-listed kid / bad signature →
   * AUTH_INVALID. relay.ts stays crypto-free (source guard) — it only calls the
   * protocol helpers and the durable registry.
   *
   * On a verified frame the broker binds (spaceId → verificationKey, adminDids)
   * first-writer-wins in the durable space registry:
   *  - 'registered' / 'idempotent' (identical re-register, idempotent recovery) →
   *    delivered receipt.
   *  - 'conflict' (divergent verificationKey or admin set for an already-registered
   *    spaceId) → SPACE_ALREADY_REGISTERED. Changes go via the signed frames
   *    space-rotate / admin-add / admin-remove (Phase 5), not a re-register.
   *
   * This phase does NOT yet gate log-entry/sync-request on the registry — that is
   * the capability gate (Phase 4). It only records the binding.
   */
  private async handleSpaceRegister(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    // Outer/inner structural gate first (MALFORMED_MESSAGE on any defect), mirroring
    // device-revoke. Management frames are CLOSED control-frames — a malformed shape
    // is rejected here, never falls through to inbox routing.
    try {
      parseSpaceRegisterMessage(raw)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Malformed space-register control-frame',
      })
      return
    }

    // TOFU verification (self-asserting kid-DID ∈ adminDids + Ed25519 signature).
    // The core helper derives the signer key from the kid-DID; no inline crypto here.
    let result
    try {
      result = await verifySpaceRegisterMessage({ frame: raw, crypto: protocolCrypto })
    } catch (err) {
      this.sendInternalError(ws, err, 'space-register verification failed')
      return
    }

    if (result.disposition === 'rejected') {
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'space-register inner JWS is not signed by one of the self-asserted adminDids.'
            : 'Malformed space-register control-frame.',
      })
      return
    }

    // First-writer-wins binding against the DURABLE registry (atomic). The frame is
    // verified; only a divergent prior binding is a conflict.
    const { spaceId, spaceCapabilityVerificationKey, adminDids } = result.payload
    const disposition = this.docLog.registerSpace({
      spaceId,
      verificationKey: spaceCapabilityVerificationKey,
      adminDids,
    })

    if (disposition.disposition === 'conflict') {
      this.sendTo(ws, {
        type: 'error',
        code: 'SPACE_ALREADY_REGISTERED',
        message:
          'spaceId is already registered with a different verification key or admin set (first-writer-wins).',
      })
      return
    }

    // VE-8 (Sync 003 §Scope-Invalidierung bei Erst-Register, MUSS): on the INITIAL
    // registration (disposition 'registered', NOT an idempotent recovery), this
    // docId transitions Personal-Doc → Space. Any Personal-Doc scope a socket
    // cached BEFORE the register would otherwise let it bypass the now-mandatory
    // Space path on its still-open connection. Drop every cached PERSONAL scope for
    // this docId across ALL open sockets. Space scopes (there are none yet for a
    // just-registered space) are untouched.
    if (disposition.disposition === 'registered') {
      this.invalidatePersonalScopesForDoc(spaceId)
    }

    // 'registered' or 'idempotent' (identical recovery re-register) → delivered.
    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: spaceId,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Resolve the registered-admin signer of an inner-JWS management frame
   * (`space-rotate` / `admin-add` / `admin-remove`), shared by all three handlers
   * (Sync 003 §Capability-Widerruf über Rotation + §Admin-Management).
   *
   * The management payloads do NOT carry the signer DID — the JWS `kid` does
   * (analogous to device-revoke). The relay stays crypto-free (source guard): it
   * only calls protocol.* helpers (decodeJws / didOrKidToDid / didKeyToPublicKeyBytes)
   * to derive the signer WITHOUT trusting the signature, then hands the derived
   * (adminDid, adminPublicKey) to the verify primitive which performs the actual
   * Ed25519 check (kid-DID === adminDid AND sig verifies vs adminPublicKey).
   *
   * Resolution order (per HANDLER STRATEGY):
   *  1. decode the inner JWS (no signature trust) to read payload.spaceId + header.kid;
   *     undecodable → MALFORMED_MESSAGE.
   *  2. require isSpaceRegistered(spaceId) → else DOC_NOT_FOUND (no registry entry).
   *  3. signerDid = didOrKidToDid(header.kid); require signerDid ∈ getSpaceAdmins
   *     (current registered set) → else AUTH_INVALID.
   *  4. adminPublicKey = didKeyToPublicKeyBytes(signerDid) (resolvable did:key →
   *     else AUTH_INVALID).
   *
   * On any failure it emits the wire error itself and returns null; on success it
   * returns the decoded spaceId + the resolved signer for the verify primitive.
   */
  private resolveAdminSigner(
    ws: WebSocket,
    innerJws: string,
    jwsField: 'rotationJws' | 'adminChangeJws',
  ): { spaceId: string; adminDid: string; adminPublicKey: Uint8Array } | null {
    // (2) Decode the inner JWS WITHOUT trusting it — read spaceId + kid only.
    let decoded
    try {
      decoded = decodeJws<{ kid?: unknown }, { spaceId?: unknown }>(innerJws)
    } catch {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: `Malformed ${jwsField}: inner JWS is not decodable.`,
      })
      return null
    }
    const spaceId = typeof decoded.payload.spaceId === 'string' ? decoded.payload.spaceId : null
    const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : null
    if (spaceId === null || kid === null) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: `Malformed ${jwsField}: inner JWS payload spaceId or header kid missing.`,
      })
      return null
    }

    // (3) The space MUST be registered (no registry entry → nothing to mutate).
    if (!this.docLog.isSpaceRegistered(spaceId)) {
      this.sendTo(ws, {
        type: 'error',
        code: 'DOC_NOT_FOUND',
        message: 'Space is not registered; register it before rotating or changing admins.',
      })
      return null
    }

    // (4) The signer (kid-DID) MUST be in the CURRENT registered admin set.
    const signerDid = didOrKidToDid(kid)
    if (!this.docLog.getSpaceAdmins(spaceId).includes(signerDid)) {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'Frame is not signed by a registered admin of this space.',
      })
      return null
    }

    // (5) Derive the signer's Ed25519 public key for the verify primitive.
    let adminPublicKey: Uint8Array
    try {
      adminPublicKey = didKeyToPublicKeyBytes(signerDid)
    } catch {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'Admin signer DID is not a resolvable did:key.',
      })
      return null
    }

    return { spaceId, adminDid: signerDid, adminPublicKey }
  }

  /**
   * Sync 003 §Capability-Widerruf über Rotation (VE-6): `space-rotate` Broker
   * Control-Frame — the security-critical member-removal mechanism.
   *
   * Outer wire shape `{ type: 'space-rotate', rotationJws }` (closed top-level
   * keys); a malformed shape → MALFORMED_MESSAGE, never falls through. The inner JWS
   * payload `{ type, spaceId, newSpaceCapabilityVerificationKey, newGeneration }` is
   * signed with the space-derived Admin Key; the signer (kid-DID) MUST be a
   * registered admin of the space (else AUTH_INVALID).
   *
   * After cryptographic verification the relay enforces the spec invariant
   * `newGeneration === current + 1` EXACTLY (else AUTH_INVALID — a malformed
   * generation step is treated as an unauthorized rotation), applies the rotation
   * to the durable registry (new verification key + generation), and then —
   * IMMEDIATELY and sicherheitskritisch — invalidates every cached capability scope
   * for this spaceId with `generation < newGeneration` across ALL open WebSockets of
   * ALL DIDs. A just-removed member MUST NOT keep writing on a still-open socket; the
   * next log-entry/sync-request on that socket without a re-presented current-gen
   * capability fails the gate (CAPABILITY_REQUIRED), and re-presenting the old-gen
   * capability fails with CAPABILITY_GENERATION_STALE.
   *
   * relay.ts stays crypto-free (source guard): only protocol.* helpers + the durable
   * registry are called here.
   */
  private async handleSpaceRotate(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    // (1) Closed-frame structural gate first (MALFORMED_MESSAGE on any defect),
    // mirroring device-revoke / space-register.
    let parsed
    try {
      parsed = parseSpaceRotateMessage(raw)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Malformed space-rotate control-frame',
      })
      return
    }

    // (2)-(5) Resolve the registered-admin signer from the inner JWS (emits its own
    // wire error + returns null on MALFORMED_MESSAGE / DOC_NOT_FOUND / AUTH_INVALID).
    const signer = this.resolveAdminSigner(ws, parsed.rotationJws, 'rotationJws')
    if (signer === null) return

    // Cryptographic verification against the resolved registered admin. The verify
    // primitive re-binds kid-DID === adminDid AND checks the Ed25519 signature.
    let result
    try {
      result = await verifySpaceRotateMessage({
        frame: raw,
        adminDid: signer.adminDid,
        adminPublicKey: signer.adminPublicKey,
        crypto: protocolCrypto,
      })
    } catch (err) {
      this.sendInternalError(ws, err, 'space-rotate verification failed')
      return
    }

    if (result.disposition === 'rejected') {
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'space-rotate signature invalid or not signed by a registered admin.'
            : 'Malformed space-rotate control-frame.',
      })
      return
    }

    const { spaceId, newSpaceCapabilityVerificationKey, newGeneration } = result.payload

    // Spec invariant (Sync 003): newGeneration MUST be EXACTLY current + 1. A space
    // record always exists here (isSpaceRegistered passed under the single shared
    // connection). A wrong step is an unauthorized rotation → AUTH_INVALID.
    const space = this.docLog.getSpace(spaceId)
    if (space === null || newGeneration !== space.generation + 1) {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'space-rotate newGeneration must be exactly the current generation plus one.',
      })
      return
    }

    // Apply the rotation to the durable registry (new key + generation).
    this.docLog.rotateSpace(spaceId, newSpaceCapabilityVerificationKey, newGeneration)

    // Cache-Invalidierung bei Rotation (MUSS, sicherheitskritisch): drop every
    // cached scope for this spaceId of an OLDER generation across ALL open sockets.
    this.invalidateStaleScopesForDoc(spaceId, newGeneration)

    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: spaceId,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Sync 003 §Admin-Management (VE-7): `admin-add` Broker Control-Frame.
   *
   * Outer wire shape `{ type: 'admin-add', adminChangeJws }` (closed top-level
   * keys); malformed → MALFORMED_MESSAGE. Inner JWS payload
   * `{ type, spaceId, newAdminDid }`, signed by an EXISTING registered admin of the
   * space (else AUTH_INVALID). On success the relay adds `newAdminDid` to the durable
   * admin set (idempotent) — the new admin may then sign subsequent management frames.
   */
  private async handleAdminAdd(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    let parsed
    try {
      parsed = parseAdminAddMessage(raw)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Malformed admin-add control-frame',
      })
      return
    }

    const signer = this.resolveAdminSigner(ws, parsed.adminChangeJws, 'adminChangeJws')
    if (signer === null) return

    let result
    try {
      result = await verifyAdminAddMessage({
        frame: raw,
        adminDid: signer.adminDid,
        adminPublicKey: signer.adminPublicKey,
        crypto: protocolCrypto,
      })
    } catch (err) {
      this.sendInternalError(ws, err, 'admin-add verification failed')
      return
    }

    if (result.disposition === 'rejected') {
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'admin-add signature invalid or not signed by a registered admin.'
            : 'Malformed admin-add control-frame.',
      })
      return
    }

    this.docLog.addAdmin(result.payload.spaceId, result.payload.newAdminDid)

    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: result.payload.spaceId,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Sync 003 §Admin-Management (VE-7): `admin-remove` Broker Control-Frame.
   *
   * Outer wire shape `{ type: 'admin-remove', adminChangeJws }` (closed top-level
   * keys); malformed → MALFORMED_MESSAGE. Inner JWS payload
   * `{ type, spaceId, removedAdminDid }`, signed by an EXISTING registered admin of
   * the space (else AUTH_INVALID). On success the relay removes `removedAdminDid`
   * from the durable admin set (idempotent) — the removed admin's subsequent
   * management frames then fail the registered-admin check (AUTH_INVALID).
   *
   * No last-admin guard at the broker (see DocLog.removeAdmin) — Sync 003
   * §Admin-Management constrains only the signer, not the resulting set size.
   */
  private async handleAdminRemove(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    let parsed
    try {
      parsed = parseAdminRemoveMessage(raw)
    } catch (err) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: err instanceof Error ? err.message : 'Malformed admin-remove control-frame',
      })
      return
    }

    const signer = this.resolveAdminSigner(ws, parsed.adminChangeJws, 'adminChangeJws')
    if (signer === null) return

    let result
    try {
      result = await verifyAdminRemoveMessage({
        frame: raw,
        adminDid: signer.adminDid,
        adminPublicKey: signer.adminPublicKey,
        crypto: protocolCrypto,
      })
    } catch (err) {
      this.sendInternalError(ws, err, 'admin-remove verification failed')
      return
    }

    if (result.disposition === 'rejected') {
      this.sendTo(ws, {
        type: 'error',
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'admin-remove signature invalid or not signed by a registered admin.'
            : 'Malformed admin-remove control-frame.',
      })
      return
    }

    this.docLog.removeAdmin(result.payload.spaceId, result.payload.removedAdminDid)

    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: result.payload.spaceId,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Sync 003 §Capability-Prüfung (Präsentation, session-scoped MUSS):
   * `present-capability` Broker Control-Frame.
   *
   * Wire shape `{ type: 'present-capability', capabilityJws }` (CLOSED top-level
   * keys — a malformed shape → MALFORMED_MESSAGE, never falls through). Requires an
   * AUTHENTICATED socket (challenge-response done) — otherwise NOT_REGISTERED;
   * `audience` is bound to that authenticated DID.
   *
   * The broker reads spaceId(=docId)/audience/permissions/generation from the
   * DECODED capability payload (`decodeJws`, no signature trust yet) only to choose
   * the verification PATH and parameters; the cryptographic decision is made by the
   * core primitive:
   *  - docId IS a registered space → SPACE path: verify against the registered
   *    `spaceCapabilityVerificationKey` at the CURRENT generation. A capability of
   *    an OLDER generation → CAPABILITY_GENERATION_STALE (generation-aware from day
   *    one; Phase 5 `space-rotate` bumps the live generation). Verify failure →
   *    CAPABILITY_INVALID (CAPABILITY_EXPIRED if it is specifically a validUntil
   *    expiry).
   *  - docId is NOT registered → PERSONAL path: self-issued capability verified
   *    against the authenticated DID's Identity Key (generation 0, kid-DID =
   *    audience = authenticated DID). Verify failure → CAPABILITY_INVALID.
   *
   * On success the broker caches `{ permissions, generation, path }` for
   * `(this socket, docId)` and replies with a delivered receipt. Subsequent
   * log-entry / sync-request on the Log-Sync channel are gated against this cache
   * (no re-presentation per message). The Inbox channel is NEVER gated.
   *
   * relay.ts stays crypto-free (source guard): it only calls protocol.* helpers
   * (decodeJws / decodeBase64Url / didKeyToPublicKeyBytes / verify*CapabilityJws)
   * and the durable registry — no inline decoders or crypto.subtle here.
   */
  private async handlePresentCapability(ws: WebSocket, raw: Record<string, unknown>): Promise<void> {
    // Closed-frame structural gate first (MALFORMED_MESSAGE on any defect),
    // mirroring device-revoke / space-register. Exactly {type, capabilityJws}.
    const capabilityJws = this.parsePresentCapabilityFrame(raw)
    if (capabilityJws === null) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: 'present-capability MUST carry exactly { type, capabilityJws } with a string capabilityJws.',
      })
      return
    }

    // Must be authenticated: the audience is bound to the challenge-response DID,
    // and the Personal path resolves the signer key from it. (handleSend uses the
    // same NOT_REGISTERED literal for the unauthenticated case.)
    const socketDid = this.socketToDid.get(ws)
    if (socketDid === undefined) {
      this.sendTo(ws, {
        type: 'error',
        code: 'NOT_REGISTERED',
        message: 'Must register (challenge-response) before presenting a capability.',
      })
      return
    }

    // Decode the payload (NO signature trust here) only to read docId(=spaceId) and
    // pick the path. The cryptographic decision is the verify* primitive's job.
    const docId = this.tryDecodeCapabilityDocId(capabilityJws)
    if (docId === null) {
      this.sendTo(ws, {
        type: 'error',
        code: 'CAPABILITY_INVALID',
        message: 'present-capability JWS payload is not a decodable capability (missing spaceId).',
      })
      return
    }

    if (this.docLog.isSpaceRegistered(docId)) {
      await this.presentSpaceCapability(ws, socketDid, docId, capabilityJws)
    } else {
      await this.presentPersonalCapability(ws, socketDid, docId, capabilityJws)
    }
  }

  /**
   * SPACE path (Sync 003 §Capability-Prüfung): the docId has a `space-register`
   * binding. Verify the capability against the registered verification key at the
   * CURRENT generation. An older-generation capability is STALE; a verify failure
   * is INVALID (or EXPIRED on a validUntil failure).
   */
  private async presentSpaceCapability(
    ws: WebSocket,
    socketDid: string,
    docId: string,
    capabilityJws: string,
  ): Promise<void> {
    const space = this.docLog.getSpace(docId)
    if (space === null) {
      // isSpaceRegistered said yes but the record vanished (impossible under the
      // single shared connection); treat defensively as not verifiable.
      this.sendTo(ws, { type: 'error', code: 'CAPABILITY_INVALID', message: 'Space record unavailable.' })
      return
    }

    // Generation gate (VE-8 generation-awareness / Phase-5 rotation): a capability
    // of an older generation than the live space generation is STALE — the client
    // must obtain a renewed capability and re-present. Checked from the decoded
    // payload BEFORE the signature verify so a stale-but-otherwise-valid capability
    // reports STALE, not a generic mismatch.
    const presentedGeneration = this.tryDecodeCapabilityGeneration(capabilityJws)
    if (presentedGeneration !== null && presentedGeneration < space.generation) {
      this.sendTo(ws, {
        type: 'error',
        code: 'CAPABILITY_GENERATION_STALE',
        message: 'Capability generation is older than the current space generation; obtain a renewed capability.',
      })
      return
    }

    let payload
    try {
      payload = await verifySpaceCapabilityJws(capabilityJws, {
        crypto: protocolCrypto,
        publicKey: decodeBase64Url(space.verificationKey),
        expectedSpaceId: docId,
        expectedAudience: socketDid,
        expectedGeneration: space.generation,
        now: new Date(),
      })
    } catch (err) {
      this.sendCapabilityVerifyError(ws, err)
      return
    }

    this.cacheScope(ws, docId, {
      permissions: new Set(payload.permissions),
      generation: space.generation,
      path: 'space',
    })
    this.sendCapabilityReceipt(ws, docId)
  }

  /**
   * PERSONAL path (Sync 003 §Persönliche Dokumente): no `space-register` binding
   * for docId. Self-issued capability: verify against the authenticated DID's
   * Identity Key, with kid-DID = audience = authenticated DID and generation 0.
   */
  private async presentPersonalCapability(
    ws: WebSocket,
    socketDid: string,
    docId: string,
    capabilityJws: string,
  ): Promise<void> {
    let publicKey: Uint8Array
    try {
      publicKey = didKeyToPublicKeyBytes(socketDid)
    } catch {
      // The authenticated DID is always a resolvable did:key (it passed register),
      // so this is defensive only.
      this.sendTo(ws, { type: 'error', code: 'CAPABILITY_INVALID', message: 'Authenticated DID is not a resolvable did:key.' })
      return
    }

    let payload
    try {
      payload = await verifyPersonalDocCapabilityJws(capabilityJws, {
        crypto: protocolCrypto,
        publicKey,
        expectedSpaceId: docId,
        expectedAudience: socketDid,
        now: new Date(),
      })
    } catch (err) {
      this.sendCapabilityVerifyError(ws, err)
      return
    }

    this.cacheScope(ws, docId, {
      permissions: new Set(payload.permissions),
      generation: 0, // Personal docs are not rotated in wot-sync@0.1.
      path: 'personal',
    })
    this.sendCapabilityReceipt(ws, docId)
  }

  /**
   * Parse a `present-capability` CLOSED control-frame. Returns the capabilityJws
   * string, or null if the shape is malformed (exactly {type, capabilityJws};
   * capabilityJws MUST be a string). No core primitive exists for this frame yet,
   * so the structural check is inline (NOT crypto — allowed under the source guard).
   */
  private parsePresentCapabilityFrame(raw: Record<string, unknown>): string | null {
    const keys = Object.keys(raw)
    if (keys.length !== 2) return null
    if (raw.type !== PRESENT_CAPABILITY_CONTROL_FRAME_TYPE) return null
    if (typeof raw.capabilityJws !== 'string' || raw.capabilityJws.length === 0) return null
    return raw.capabilityJws
  }

  /** Decode the capability payload's spaceId (=docId) without trusting the signature, or null. */
  private tryDecodeCapabilityDocId(capabilityJws: string): string | null {
    try {
      const { payload } = decodeJws<Record<string, unknown>, { spaceId?: unknown }>(capabilityJws)
      return typeof payload.spaceId === 'string' ? payload.spaceId : null
    } catch {
      return null
    }
  }

  /** Decode the capability payload's generation without trusting the signature, or null. */
  private tryDecodeCapabilityGeneration(capabilityJws: string): number | null {
    try {
      const { payload } = decodeJws<Record<string, unknown>, { generation?: unknown }>(capabilityJws)
      return typeof payload.generation === 'number' ? payload.generation : null
    } catch {
      return null
    }
  }

  /**
   * Map a capability verify failure to the wire code. The core verifiers throw
   * `'Capability expired'` specifically on a `now >= validUntil` failure; that maps
   * to CAPABILITY_EXPIRED. Every other verify failure (bad signature, kid mismatch,
   * audience/spaceId/generation mismatch, malformed payload) is CAPABILITY_INVALID.
   */
  private sendCapabilityVerifyError(ws: WebSocket, err: unknown): void {
    const message = err instanceof Error ? err.message : 'Capability verification failed'
    const code = message === 'Capability expired' ? 'CAPABILITY_EXPIRED' : 'CAPABILITY_INVALID'
    this.sendTo(ws, { type: 'error', code, message })
  }

  /** Record a verified capability scope for (socket, docId). */
  private cacheScope(ws: WebSocket, docId: string, scope: CachedScope): void {
    let scopes = this.socketToScopes.get(ws)
    if (!scopes) {
      scopes = new Map()
      this.socketToScopes.set(ws, scopes)
    }
    scopes.set(docId, scope)
  }

  /** The cached scope for (socket, docId), or null. */
  private getScope(ws: WebSocket, docId: string): CachedScope | null {
    return this.socketToScopes.get(ws)?.get(docId) ?? null
  }

  /** True if (socket, docId) holds a cached scope including `permission`. */
  private hasScopePermission(ws: WebSocket, docId: string, permission: 'read' | 'write'): boolean {
    return this.getScope(ws, docId)?.permissions.has(permission) ?? false
  }

  /**
   * VE-8 / Phase-5 helper: drop every cached PERSONAL-path scope for `docId` across
   * ALL open sockets. Space-path scopes are left intact. Called on the initial
   * `space-register` for a docId (Sync 003 §Scope-Invalidierung bei Erst-Register).
   */
  private invalidatePersonalScopesForDoc(docId: string): void {
    for (const scopes of this.socketToScopes.values()) {
      const scope = scopes.get(docId)
      if (scope && scope.path === 'personal') scopes.delete(docId)
    }
  }

  /**
   * VE-6 helper (Sync 003 §Cache-Invalidierung bei Rotation, MUSS,
   * sicherheitskritisch): after a successful `space-rotate` to `newGeneration`, drop
   * every cached scope for `docId` whose `generation < newGeneration` across ALL
   * open WebSockets of ALL DIDs — by DELETING the stale scope (not stale-marking),
   * matching the VE-8 invalidation style. A just-removed member therefore cannot
   * keep writing on its still-open socket: its cached old-generation scope is gone,
   * so the next log-entry/sync-request fails the gate (CAPABILITY_REQUIRED), and
   * re-presenting the old-generation capability is rejected CAPABILITY_GENERATION_STALE
   * by the present-capability generation gate. The rotating admin's own freshly
   * minted current-generation capability is presented AFTER the rotation, so it is
   * unaffected.
   */
  private invalidateStaleScopesForDoc(docId: string, newGeneration: number): void {
    for (const scopes of this.socketToScopes.values()) {
      const scope = scopes.get(docId)
      if (scope && scope.generation < newGeneration) scopes.delete(docId)
    }
  }

  private sendCapabilityReceipt(ws: WebSocket, docId: string): void {
    this.sendTo(ws, {
      type: 'receipt',
      receipt: {
        messageId: docId,
        status: 'delivered',
        timestamp: new Date().toISOString(),
      },
    })
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
   * Ingest verification ORDER (Sync 003 MUSS):
   *   1. verify JWS (verifyLogEntryJws — alg/signature/kid==authorKid/schema);
   *      failure → AUTH_INVALID.
   *   2. device-active check → the AUTHENTICATED socket's (did, deviceId) MUST
   *      currently be status==active in the durable device list. A device revoked
   *      DURING the open session is rejected with DEVICE_REVOKED (live status, not
   *      just DID equality).
   *   3. author-binding (Sync 003 §Log-Eintrag-Autor-Bindung) → the DID extracted
   *      from payload.authorKid (part before '#') MUST equal the DID that owns
   *      payload.deviceId in the durable device list. Unregistered deviceId →
   *      DEVICE_NOT_REGISTERED; mismatch → AUTHOR_MISMATCH. Replaces the Slice-R
   *      VE-3a first-writer-wins heuristic. Entry NOT stored, NOT relayed.
   *   4. seq-collision (VE-3, deterministic-nonce reuse) → divergent content at an
   *      existing (docId,deviceId,seq); → SEQ_COLLISION_DETECTED + restore-clone
   *      hint; NOT stored, NOT relayed. (Idempotent re-send → no re-store.)
   *   5. store + live-relay to currently connected recipient devices (no inbox
   *      queue, no delete-on-ACK).
   */
  private async handleLogEntry(
    ws: WebSocket,
    envelope: Record<string, unknown>,
    entryJws: string,
  ): Promise<void> {
    // (1) Verify the JWS first — authority via authorKid (Sync 002 Z.126), never
    // envelope.from. The broker NEVER decrypts `data`.
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
    const messageId = (envelope.id as string) ?? 'unknown'

    // (Capability gate, VE-5 — Sync 003 §Gate, Log-Sync channel only): a cached
    // WRITE scope for `docId` is REQUIRED on THIS socket before any durable side
    // effect. Established session-scoped via present-capability; missing →
    // CAPABILITY_REQUIRED (NOT stored, NOT relayed). The docId is read from the
    // VERIFIED payload (authority via authorKid, never envelope fields), so the
    // gate trusts a cryptographically-anchored docId. The Phase-2 device-active /
    // author-binding / seq checks follow.
    if (!this.hasScopePermission(ws, docId, 'write')) {
      this.sendTo(ws, {
        type: 'error',
        code: 'CAPABILITY_REQUIRED',
        message: 'No cached write capability for this docId. Present a capability first.',
      })
      return
    }

    // (2) Live device-active check: the AUTHENTICATED socket's (did, deviceId)
    // MUST currently be active. A mid-session revocation must be rejected here —
    // author-binding DID-equality alone would still pass for a revoked device.
    const socketDid = this.socketToDid.get(ws)
    const socketDeviceId = this.socketToDeviceId.get(ws)
    if (
      socketDid === undefined ||
      socketDeviceId === undefined ||
      !this.docLog.isActive(socketDid, socketDeviceId)
    ) {
      this.sendTo(ws, {
        type: 'error',
        code: 'DEVICE_REVOKED',
        message: 'This device is not active (revoked or not registered).',
      })
      return
    }

    // (3) Author-binding against the DURABLE device list (Sync 003 §Autor-Bindung):
    // the DID owning payload.deviceId MUST equal the DID in payload.authorKid.
    const ownerDid = this.docLog.didForDevice(deviceId)
    if (ownerDid === null) {
      // payload.deviceId is not registered at all.
      this.sendTo(ws, {
        type: 'error',
        code: 'DEVICE_NOT_REGISTERED',
        message: 'The log-entry deviceId is not registered in the broker device list.',
      })
      return
    }
    if (ownerDid !== didOrKidToDid(authorKid)) {
      // The authorKid DID does not own this deviceId. Not stored, not relayed.
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTHOR_MISMATCH',
        message: 'Author mismatch: the authorKid DID does not own this deviceId.',
      })
      return
    }

    // Sync 003 §Broker: collision/dedup hash is over the JCS-canonicalized PAYLOAD
    // (not the JWS envelope), so an identical payload re-encoded into a different
    // valid JWS dedups as idempotent rather than a false SEQ_COLLISION_DETECTED.
    const incomingContentHash = await this.docLog.hashPayload(payload)

    // (4) seq-collision (VE-3) + the durable insert run ATOMICALLY inside
    // appendEntry (one SQLite transaction, no intervening await), so a divergent
    // seq cannot race a concurrent first write. The broker reads the coordinates
    // from the verified JWS only.
    const result = this.docLog.appendEntry({
      docId,
      deviceId,
      seq,
      contentHash: incomingContentHash,
      entryJws,
    })

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
   *
   * Live device-active check (Sync 003): the authenticated socket's
   * (did, deviceId) MUST currently be status==active. A device revoked DURING the
   * open session is rejected with DEVICE_REVOKED before any log read.
   */
  private handleSyncRequest(ws: WebSocket, envelope: Record<string, unknown>): void {
    const socketDid = this.socketToDid.get(ws)
    const socketDeviceId = this.socketToDeviceId.get(ws)
    if (
      socketDid === undefined ||
      socketDeviceId === undefined ||
      !this.docLog.isActive(socketDid, socketDeviceId)
    ) {
      this.sendTo(ws, {
        type: 'error',
        code: 'DEVICE_REVOKED',
        message: 'This device is not active (revoked or not registered).',
      })
      return
    }

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

    // (Capability gate, VE-5 — Sync 003 §Gate, Log-Sync channel only): a cached
    // READ scope for `docId` is REQUIRED on THIS socket before serving any
    // catch-up. Established session-scoped via present-capability; missing →
    // CAPABILITY_REQUIRED (nothing served).
    if (!this.hasScopePermission(ws, docId, 'read')) {
      this.sendTo(ws, {
        type: 'error',
        code: 'CAPABILITY_REQUIRED',
        message: 'No cached read capability for this docId. Present a capability first.',
      })
      return
    }

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
