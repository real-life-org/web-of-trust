import { createServer, type Server as HttpServer } from 'http'
import { randomBytes, randomUUID, createHmac } from 'crypto'
import { dirname, resolve as resolvePath } from 'node:path'
import Database from 'better-sqlite3'
import { WebSocketServer, type WebSocket } from 'ws'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'
import type { RelayMessage } from './types.js'
import { OfflineQueue, DEFAULT_INACTIVE_MS } from './queue.js'
import { DocLog } from './log-store.js'
import { getDashboardHtml } from './dashboard-html.js'
import {
  RelayMetrics,
  METRICS_WINDOWS,
  METRICS_BUCKET_SECONDS,
  toIngestRejectCode,
  type MetricsWindowKey,
} from './metrics.js'

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
  computeBrokerInboxDeliveryTargets,
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
  /**
   * Injectable clock (epoch ms), defaults to `Date.now`. A test seam for the
   * capability-expiry gate (Sync 003 §Capability-Prüfung, `validUntil`): a test
   * advances this past a short-lived capability's `validUntil` to prove a
   * still-cached-but-expired scope no longer authorizes. Production leaves it
   * unset and reads wall-clock time.
   */
  now?: () => number
  /**
   * Expose SENSITIVE extended `/dashboard/data` stats: `logStats.spacesByDoc` (persistent
   * admin DIDs + generation per space) and `logStats.entriesByDocAndDevice` (per-(doc,device)
   * counts). OFF by default. `/dashboard/data` is UNAUTHENTICATED and served with
   * `Access-Control-Allow-Origin: *`, and the relay image is deployed publicly
   * (relay.web-of-trust.de), so these fields are redacted in prod and emitted only when a
   * staging / local-test relay opts in (env `RELAY_DEBUG_STATS`). The D1 Spur-C remote-
   * observation harness REQUIRES this flag; a full auth/redaction layer is D3.
   */
  exposeDebugStats?: boolean
  /**
   * Inbox retention sweep interval in ms (Sync 003 §Store-and-Forward Z.210-211). The
   * relay periodically runs `queue.collectGarbage` to enforce the TTL / fully-delivered
   * backstop / inactive-entry GC — without this the per-device inbox grows unbounded
   * (cold-start + never-acked messages are never reclaimed). Default 1h; set to 0 to
   * disable (tests that assert GC drive `collectGarbage` directly).
   */
  gcIntervalMs?: number
  /**
   * Metrics bucket-flush interval in ms. Default = METRICS_BUCKET_SECONDS (10s) —
   * production leaves this unset (the ring assumes 10s buckets). TEST SEAM: 0
   * disables the timer (tests drive `metrics.flush` directly with a controlled
   * clock, mirroring gcIntervalMs).
   */
  metricsIntervalMs?: number
  /**
   * /proc/net/dev interface for the net rx/tx byte series (env RELAY_NET_INTERFACE
   * via start.ts). Default: first non-`lo` interface.
   */
  metricsNetInterface?: string
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
  /**
   * The capability's `validUntil` as epoch ms (parsed from the verified payload;
   * Sync 003 §Capability-Prüfung — "validUntil begrenzt Zugriffsrechte"). At every
   * gate check the relay drops the scope and rejects once `now >= validUntil`, so a
   * presented capability does NOT authorize until WS close after it expires. A
   * non-parseable/absent validUntil yields NaN, which makes the `now >= validUntil`
   * comparison false; the verifier already enforces a well-formed validUntil before
   * a scope is ever cached, so that case is unreachable in practice.
   */
  validUntil: number
}

const CHALLENGE_TIMEOUT_MS = 30_000 // 30 seconds to respond
const NONCE_BYTE_LENGTH = 32

// ---------------------------------------------------------------------------
// /dashboard/data `display` block — server-side shortening (Broker-Dashboard).
//
// The generic broker dashboard shows identities/documents/inbox with SHORTENED
// ids. The shortening happens HERE, server-side: `/dashboard/data` is served
// UNAUTHENTICATED with `Access-Control-Allow-Origin: *` (see start()/CORS), so a
// full id must NEVER leave the server without RELAY_DEBUG_STATS — display-cosmetic
// truncation on the client would be trivially bypassable. The `display` block is
// ALWAYS public (it carries only shortened forms), and is deliberately built as
// ARRAYS (no map keys) so it can coexist with the existing flag-gated maps without
// touching their redaction semantics (the e2e-log-sync harness + DashboardStats
// tests pin the OMISSION of those maps by default).
//
// Shortening rules (Anton, 07.07.): DIDs + deviceIds shown but shortened; docIds
// are CLIENT-CHOSEN strings (a speaking name would leak via a prefix) so they are
// KEYED-HASHED (HMAC with a per-process random salt), not prefix-cut.
// ---------------------------------------------------------------------------

/** Top-N documents surfaced in the always-public `display.topDocs` array. */
export const DISPLAY_TOP_DOCS_LIMIT = 12

/**
 * Shorten a `did:key` for public display. A did:key is
 * `did:key:z6Mk…<multibase-pubkey>` — the multibase part is a random pubkey
 * encoding, so a PREFIX+SUFFIX cut leaks nothing sensitive and stays stable across
 * polls. Format: first 8 chars of the multibase part + `…` + last 4
 * (e.g. `z6MktgyS…tUfX`). A non-`did:key` (or too-short) input is returned as-is
 * (still escaped downstream) rather than mangled. Deterministic + pure.
 *
 * Threat model — why prefix-cutting is fine HERE but not for docIds: a DID's
 * multibase part is HIGH-ENTROPY random key material, so there is no candidate
 * dictionary to hash/compare against — a prefix reveals nothing an observer
 * could not already enumerate. docIds are CLIENT-CHOSEN (often speaking,
 * low-entropy) strings, hence the keyed-hash treatment in {@link shortenDocId}.
 * The same reasoning applies to UUID deviceIds ({@link shortenDeviceId}).
 */
export function shortenDid(did: string): string {
  const PREFIX = 'did:key:'
  if (!did.startsWith(PREFIX)) {
    // Not a did:key — fall back to a generic middle-ellipsis so we never emit a
    // long opaque string, but do not assume multibase structure.
    return did.length > 16 ? `${did.slice(0, 10)}…${did.slice(-4)}` : did
  }
  const mb = did.slice(PREFIX.length)
  if (mb.length <= 12) return mb
  return `${mb.slice(0, 8)}…${mb.slice(-4)}`
}

/**
 * Shorten a deviceId (canonical lowercase UUID v4, fully random) for public
 * display: first 8 chars + `…` (e.g. `87473e1b…`). A short/empty input is returned
 * unchanged. Deterministic + pure.
 */
export function shortenDeviceId(deviceId: string): string {
  if (deviceId.length <= 8) return deviceId
  return `${deviceId.slice(0, 8)}…`
}

/**
 * Shorten a docId for public display. Unlike DIDs/deviceIds a docId is a
 * CLIENT-CHOSEN string (personalDocId is even a bearer secret, A2 Teil B) — a
 * speaking name like `familie-mueller-2026` would leak via a prefix cut, and an
 * UNSALTED hash would be a GUESSING ORACLE on the unauthenticated public surface
 * (offline-hash candidates like `familie-mueller-*`, compare against
 * /dashboard/data). So the shortcut is a KEYED hash:
 * `HMAC-SHA256(salt, docId)` → first 10 hex chars + `…`, with a PER-PROCESS
 * random salt (`randomBytes(32)`, minted once in the RelayServer constructor).
 *
 * Properties (Antons Freigabe der einfachen Variante, Loop-Review #256):
 * - stable WITHIN one relay process (enough — dashboard + polls are process-local),
 * - CHANGES ACROSS RESTARTS (documented, deliberate: the shortcut is a display
 *   pseudonym, not a durable identifier),
 * - not computable without the process secret → no candidate-dictionary oracle.
 * Collision risk at display-N stays negligible. Deterministic + pure given
 * (docId, salt). NOTE: an empty docId hashes like any other string.
 */
export function shortenDocId(docId: string, salt: Uint8Array): string {
  const hex = createHmac('sha256', salt).update(docId, 'utf8').digest('hex')
  return `${hex.slice(0, 10)}…`
}

/** One shortened identity row in `display.dids`. */
export interface DisplayDid {
  idShort: string
  deviceCount: number
  online: boolean
}

/** One shortened document row in `display.topDocs`. */
export interface DisplayDoc {
  idShort: string
  entries: number
  devices: number
}

/** One shortened inbox-recipient row in `display.inboxPendingByDid`. */
export interface DisplayInboxPending {
  idShort: string
  pending: number
}

/** The always-public, server-shortened `display` block of `/dashboard/data`. */
export interface DisplayBlock {
  dids: DisplayDid[]
  topDocs: DisplayDoc[]
  inboxPendingByDid: DisplayInboxPending[]
}

/**
 * Build the always-public `display` block. This runs server-side regardless of
 * `exposeDebugStats`; only the shortened forms are ever serialized, so full ids
 * never leave the server without the flag.
 *
 * - `dids`: from `devicesPerDid` (in-memory connection map — no DB cost; all
 *   connected DIDs are online by definition, but we keep `online` explicit
 *   against `connectedDids` for a stable contract).
 * - `topDocs` / `inboxPendingByDid`: from the SQL-LIMITED top-N queries
 *   (DocLog.topDocsByEntries / OfflineQueue.topPendingByDid) — the 2s public
 *   poll must never materialize unbounded full-table aggregates (review #256);
 *   the unlimited maps remain exclusively on the flag-gated debug path.
 * - `docIdSalt`: the per-process secret for the keyed docId shortcut
 *   ({@link shortenDocId}).
 *
 * The inputs carry the full ids — this function is the ONLY consumer of them,
 * and it emits only shortened arrays. Sort + slice are kept as a defensive
 * belt (the SQL already orders + limits).
 */
export function buildDisplayBlock(input: {
  connectedDids: string[]
  devicesPerDid: Record<string, number>
  topDocs: Array<{ docId: string; entries: number; devices: number }>
  inboxPendingByDid: Array<{ did: string; pending: number }>
  docIdSalt: Uint8Array
}): DisplayBlock {
  const online = new Set(input.connectedDids)

  const dids: DisplayDid[] = Object.entries(input.devicesPerDid)
    .map(([did, deviceCount]) => ({
      idShort: shortenDid(did),
      deviceCount,
      online: online.has(did),
    }))
    // Most devices first, stable by shortened id for a deterministic order.
    .sort((a, b) => b.deviceCount - a.deviceCount || a.idShort.localeCompare(b.idShort))

  const topDocs: DisplayDoc[] = [...input.topDocs]
    .sort((a, b) => b.entries - a.entries || a.docId.localeCompare(b.docId))
    .slice(0, DISPLAY_TOP_DOCS_LIMIT)
    .map((d) => ({
      idShort: shortenDocId(d.docId, input.docIdSalt),
      entries: d.entries,
      devices: d.devices,
    }))

  const inboxPendingByDid: DisplayInboxPending[] = [...input.inboxPendingByDid]
    .sort((a, b) => b.pending - a.pending || a.did.localeCompare(b.did))
    .slice(0, DISPLAY_TOP_DOCS_LIMIT)
    .map((p) => ({ idShort: shortenDid(p.did), pending: p.pending }))

  return { dids, topDocs, inboxPendingByDid }
}

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
  /**
   * Per-process random secret keying the docId display shortcut (shortenDocId,
   * review-#256 blocker): without it the public shortcut would be a guessing
   * oracle for low-entropy speaking docIds. Minted once per process — shortcuts
   * are stable across polls but DELIBERATELY change on restart.
   */
  private readonly docIdDisplaySalt = randomBytes(32)
  /** Injectable clock (epoch ms) for the capability-expiry gate; see options.now. */
  private now: () => number
  /** Gate for sensitive extended /dashboard/data stats; see options.exposeDebugStats. */
  private exposeDebugStats: boolean
  /** Periodic inbox-retention sweep timer (Sync 003 Z.210-211); null when disabled/stopped. */
  private gcTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Metrics accumulator + 24h ring (see metrics.ts). Owned by the RelayServer for
   * its whole lifetime — the monotone counters live HERE (durable accumulator),
   * never on short-lived per-connection objects, so they cannot jump backwards on
   * internal object replacement.
   */
  private metrics: RelayMetrics
  /** Periodic metrics bucket-flush timer (10s); null when disabled/stopped. */
  private metricsTimer: ReturnType<typeof setInterval> | null = null

  constructor(private options: RelayServerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.exposeDebugStats = options.exposeDebugStats ?? false
    // ONE SQLite connection shared by the offline inbox queue and the durable
    // log store. Sharing matters for tests: two separate ':memory:' handles are
    // distinct databases, and prod runs on a single file anyway. The RelayServer
    // owns the connection; OfflineQueue/DocLog treat it as borrowed.
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    this.queue = new OfflineQueue(this.db)
    this.docLog = new DocLog(this.db)
    // Disk stats target the directory holding the SQLite file (':memory:' → none).
    const dbPath = options.dbPath ?? ':memory:'
    this.metrics = new RelayMetrics({
      diskDir: dbPath === ':memory:' ? null : dirname(resolvePath(dbPath)),
      netInterface: options.metricsNetInterface ?? null,
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      // Create HTTP server for dashboard + health endpoints
      this.httpServer = createServer((req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET')

        // Match on the PATH only (ignore any query string / trailing slash), so
        // `/dashboard`, `/dashboard/`, and `/dashboard?x=1` all resolve.
        const path = (req.url ?? '').split('?')[0]

        if (path === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
        } else if (path === '/dashboard' || path === '/dashboard/') {
          // Single-file dashboard: inline CSS + JS. This is a self-contained
          // operator page (no external origins, no user-authored HTML injected —
          // all interpolated strings are esc()'d client-side), so we intentionally
          // ship it without a strict CSP; adding one would forbid the inline
          // <style>/<script>. Kept pragmatic per the broker-dashboard spec.
          // `no-store` also here: the page ships its JS INLINE, so a cached copy
          // would pin a stale dashboard version (old render logic) after a deploy.
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(getDashboardHtml())
        } else if (path === '/dashboard/data' || path === '/dashboard/data/') {
          // `no-store`: the dashboard polls every 2s with `cache: no-store`, and
          // this endpoint is live per-request state — never let a proxy/browser
          // serve a stale snapshot.
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify(this.getStats()))
        } else if (path === '/dashboard/metrics' || path === '/dashboard/metrics/') {
          // History ring (metrics.ts): aggregates only — NO DIDs/deviceIds/docIds,
          // so it is public like the base /dashboard/data aggregates. Unknown or
          // missing ?window falls back to 1h.
          const rawWindow = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('window') ?? ''
          // Object.hasOwn, NOT `in`: `in` walks the prototype chain, so junk like
          // `?window=__proto__` would pass the guard and yield undefined seconds.
          const window = (Object.hasOwn(METRICS_WINDOWS, rawWindow) ? rawWindow : '1h') as MetricsWindowKey
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify(this.metrics.query(window, Date.now())))
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      // Attach WebSocket server to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws) => {
        // Raw (pre-auth) socket churn — authenticated sessions are counted
        // separately in completeRegistration (wsConnects).
        this.metrics.countRawWsConnect()
        this.handleConnection(ws)
      })

      this.httpServer.listen(this.options.port, () => {
        resolve()
      })
    })

    this.startInboxRetentionSweep()
    this.startMetricsFlush()
  }

  /**
   * Periodic inbox retention (Sync 003 §Store-and-Forward Z.210-211): enforce the TTL,
   * the fully-delivered backstop, and the inactive-entry GC so the per-device inbox does
   * not grow unbounded (cold-start + never-fully-acked messages are reclaimed only here).
   * The timer is `unref`'d so it never keeps the process alive, and a sweep failure is
   * logged but never crashes the relay. Disabled when `gcIntervalMs` is 0.
   */
  private startInboxRetentionSweep(): void {
    const intervalMs = this.options.gcIntervalMs ?? 60 * 60 * 1000 // 1h default
    if (intervalMs <= 0) return
    this.gcTimer = setInterval(() => {
      try {
        this.queue.collectGarbage(this.now())
      } catch (err) {
        console.error('[relay] inbox retention sweep failed:', err instanceof Error ? err.message : err)
      }
    }, intervalMs)
    this.gcTimer.unref?.()
  }

  /**
   * Periodic metrics bucket flush (metrics.ts): every 10s fold the monotone
   * counters into one ring bucket + sample process/host gauges. Wired exactly
   * like the gcTimer (field / start-after-listen / unref / stop in stop()) — a
   * periodic task without a wired call-site is a silent leak, so a test proves
   * this timer produces buckets and that stop() halts it. A flush failure is
   * logged, never fatal. Disabled when `metricsIntervalMs` is 0 (test seam).
   */
  private startMetricsFlush(): void {
    const intervalMs = this.options.metricsIntervalMs ?? METRICS_BUCKET_SECONDS * 1000
    if (intervalMs <= 0) return
    this.metricsTimer = setInterval(() => {
      try {
        this.metrics.flush(Date.now(), {
          connections: this.socketToDeviceId.size,
          queuePendingTotal: this.queue.count(),
        })
      } catch (err) {
        console.error('[relay] metrics flush failed:', err instanceof Error ? err.message : err)
      }
    }, intervalMs)
    this.metricsTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
    this.metrics.dispose()
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

  /**
   * The port the relay is listening on. After {@link start} the HTTP server is bound, so
   * this returns the ACTUAL port — callers may pass `port: 0` for an OS-assigned ephemeral
   * port and read it back here (no free-port-then-reuse TOCTOU race). Before start (or for a
   * non-AddressInfo listener) it falls back to the requested option.
   */
  get port(): number {
    const address = this.httpServer?.address()
    if (address && typeof address === 'object') return address.port
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
      // Inbox store-and-forward stats. NOTE (semantics change with the per-device
      // model): `total` now counts per-device delivery SLOTS (inbox_entry rows), not
      // distinct messages — a message fanned out to N devices counts as N. `messages`
      // is the distinct retained-message count (inbox_message rows). `byDid` is keyed by
      // RECIPIENT DID (who has undelivered inbox messages) — recipient-activity metadata,
      // so it is redacted on the public unauthenticated /dashboard/data and emitted only
      // behind exposeDebugStats (consistent with the per-doc logStats maps).
      queueStats: {
        total: this.queue.count(),
        messages: this.queue.messageCount(),
        ...(this.exposeDebugStats ? { byDid: this.queue.countByDid() } : {}),
      },
      // Slice R durable-log stats (retained append-only content/sync channel). The base
      // fields below are non-sensitive aggregates and stay public.
      logStats: this.buildLogStats(),
      memoryMB: process.memoryUsage().rss / (1024 * 1024),
      // Broker-Dashboard: ALWAYS-public block of server-side SHORTENED ids (arrays,
      // no map keys). Only the shortened forms are serialized — full ids never
      // leave the server without RELAY_DEBUG_STATS. Fed by SQL-LIMITED top-N
      // queries (never the unbounded full maps — those stay flag-gated above with
      // their exact redaction semantics: harness + DashboardStats omission tests).
      display: buildDisplayBlock({
        connectedDids: dids,
        devicesPerDid,
        topDocs: this.docLog.topDocsByEntries(DISPLAY_TOP_DOCS_LIMIT),
        inboxPendingByDid: this.queue.topPendingByDid(DISPLAY_TOP_DOCS_LIMIT),
        docIdSalt: this.docIdDisplaySalt,
      }),
    }
  }

  /**
   * Assemble `logStats`. The public default carries ONLY leak-free AGGREGATES (totalEntries /
   * docCount / totalLogBytes / personalDocCount) — NO docId keys. Every per-doc MAP
   * (entriesByDoc, devicesByDoc, entriesByDocAndDevice, spacesByDoc) carries full docId keys
   * and is emitted ONLY when `exposeDebugStats` is set. `/dashboard/data` is unauthenticated +
   * `ACAO:*` and deployed publicly; a personalDocId is a BEARER SECRET (A2 Teil B, T-DASHBOARD),
   * so leaking it via entriesByDoc/devicesByDoc would let a foreigner pre-squat/poison the log
   * and defeat the TOFU/bearer protection. The maps stay opted-in on staging / local test relays
   * (the D1 Spur-C remote-e2e harness runs with RELAY_DEBUG_STATS=1 and still gets them).
   */
  private buildLogStats(): Record<string, unknown> {
    const logStats: Record<string, unknown> = {
      totalEntries: this.docLog.entryCount(),
      docCount: this.docLog.docCount(),
      totalLogBytes: this.docLog.totalLogBytes(),
      personalDocCount: this.docLog.personalDocOwnerCount(),
    }
    if (this.exposeDebugStats) {
      logStats.entriesByDoc = this.docLog.entriesByDoc()
      logStats.devicesByDoc = this.docLog.devicesByDoc()
      logStats.entriesByDocAndDevice = this.docLog.entriesByDocAndDevice()
      logStats.spacesByDoc = this.docLog.spacesByDoc()
    }
    return logStats
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
        // Metrics: one AUTHENTICATED session ended (mirrors wsConnects, which
        // counts authenticated sessions only — raw pre-auth churn is rawWsConnects).
        this.metrics.countWsDisconnect()
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
          this.handleChallengeResponse(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'challenge-response handling failed'),
          )
          break
        case 'send':
          this.handleSend(ws, (record.envelope ?? {}) as Record<string, unknown>)
          break
        case 'ack':
          this.handleAck(ws, String(record.messageId ?? ''))
          break
        // Async control-frame handlers: dispatched with a `.catch()` (NOT bare
        // `void`) so a later promise rejection from an unexpected SQLite/crypto/parse
        // error surfaces as an INTERNAL_ERROR frame to the sender instead of an
        // unhandled rejection (process crash on Node 22). The synchronous try/catch
        // below only guards the dispatch itself, not the async tail — mirrors the
        // handleLogEntry hardening (Slice R).
        case BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE:
          this.handleDeviceRevoke(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'device-revoke handling failed'),
          )
          break
        case SPACE_REGISTER_MESSAGE_TYPE:
          this.handleSpaceRegister(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'space-register handling failed'),
          )
          break
        case SPACE_ROTATE_MESSAGE_TYPE:
          this.handleSpaceRotate(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'space-rotate handling failed'),
          )
          break
        case ADMIN_ADD_MESSAGE_TYPE:
          this.handleAdminAdd(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'admin-add handling failed'),
          )
          break
        case ADMIN_REMOVE_MESSAGE_TYPE:
          this.handleAdminRemove(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'admin-remove handling failed'),
          )
          break
        case PRESENT_CAPABILITY_CONTROL_FRAME_TYPE:
          this.handlePresentCapability(ws, record).catch((err) =>
            this.sendInternalError(ws, err, 'present-capability handling failed'),
          )
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
    // One WS = one session (Sync 003 §Authentisierung — "Alle weiteren Nachrichten
    // auf dieser Verbindung gelten als von dieser DID + deviceId kommend"). A WS that
    // is already authenticated MUST NOT be re-bound to a new DID/deviceId: rebinding
    // would leak the old DID's still-cached capability scopes and keep routing the
    // old DID's live messages to this socket. Reject re-registration outright; the
    // client opens a fresh socket to authenticate as a different identity.
    if (this.socketToDid.has(ws)) {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'This connection is already registered; open a new connection to authenticate again.',
      })
      return
    }

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
    // Defense-in-depth for the one-WS-one-session rule (handleRegister already
    // rejects a `register` on an authenticated socket): if this socket is somehow
    // already bound (e.g. an in-flight challenge-response racing a prior auth), do
    // NOT rebind it — that would leak the old DID's cached scopes + live routing.
    if (this.socketToDid.has(ws)) {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'This connection is already registered; open a new connection to authenticate again.',
      })
      return
    }

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
    // Metrics: "connect" = AUTHENTICATED session established (v2 spec) — counted
    // here after the socket bookkeeping, not at the raw wss connection.
    this.metrics.countWsConnect()

    const registeredFrame = createBrokerRegisteredControlFrame({
      did,
      deviceId,
      isNewDevice: disposition.isNewDevice,
    })
    this.sendTo(ws, { ...registeredFrame, peers: sockets.size - 1 })

    // Store-and-forward pick-up for THIS (did, deviceId) (Sync 003 TC5): mint a
    // 'pending' entry for every retained message to this DID without one yet
    // (Cold-Start / Late-Joiner) and deliver all this device's pending messages in
    // inbox_message.id order. Persist (in a transaction) runs before the sends.
    // Terminal (fully-ACKed) messages were already deleted, so a device registering
    // after a complete ACK gets nothing.
    const pending = this.queue.deliverOnConnect(did, deviceId)
    for (const envelope of pending) {
      this.sendTo(ws, { type: 'message', envelope })
    }
    // Metrics: queued-on-connect redeliveries count as inbox deliveries too.
    if (pending.length > 0) this.metrics.countInboxDelivered(pending.length)
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
    // Durable revoke (idempotent; first metadata authoritative). Then drop the revoked
    // device's per-device inbox entries and terminal-re-check the affected messages
    // (deleteForDevice, below) — the per-device inbox (Sync 003 §Store-and-Forward) IS
    // device-scoped now. The durable tombstone + the live status==active checks on
    // ingest/sync-request enforce the revocation going forward.
    //
    // Authorization boundary (Sync 003 §Device-Deaktivierung): a revocation may
    // only revoke a device of the SIGNING DID. The inner JWS is signed by `did`,
    // but `did` is attacker-chosen — without the owner check in revokeDevice an
    // attacker could sign {did: attackerDid, deviceId: victimDeviceId} and flip a
    // victim's ACTIVE device. A 'did-mismatch' (deviceId owned by another DID) is
    // NOT the signer's device → AUTH_INVALID, no state change.
    const revocation = this.docLog.revokeDevice(did, deviceId, revokedAt)
    if (revocation.disposition === 'did-mismatch') {
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: 'device-revoke may only revoke a device owned by the signing DID.',
      })
      return
    }

    // Inbox cleanup (Sync 003 §Store-and-Forward R5): drop the revoked device's
    // per-device entries and terminal-delete any message that is now fully
    // delivered because the revoked device no longer counts (e.g. sibling acked,
    // this device pending → message complete after R4). Idempotent on re-revoke.
    this.queue.deleteForDevice(deviceId, { nowMs: this.now() })

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
    // A2 Teil B anti-escalation: bind the upgrade on the CRYPTOGRAPHICALLY-PROVEN signer (the
    // verified inner-JWS kid-DID), not on mere adminDids membership — a Personal→Space upgrade of
    // an owned docId is only legitimate when the OWNER signed it (closes the decoy-co-admin vector).
    const signerKid = typeof result.header.kid === 'string' ? result.header.kid : ''
    const disposition = this.docLog.registerSpace({
      spaceId,
      verificationKey: spaceCapabilityVerificationKey,
      adminDids,
      signerDid: didOrKidToDid(signerKid),
    })

    // A2 Teil B: the docId is a personal doc owned by a DID OTHER than the space-register signer —
    // a foreigner cannot promote a personal doc to a space to escape the personal owner gate.
    if (disposition.disposition === 'personal-owner-conflict') {
      this.sendTo(ws, {
        type: 'error',
        code: 'PERSONAL_DOC_OWNER_MISMATCH',
        message: 'This docId is a personal document owned by a different identity and cannot be registered as a space.',
      })
      return
    }

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
        // SR-4 / CodeRabbit (F1): control-frame errors carry thid == docId (spaceId)
        // so the sender's coordinator correlates the reject to the in-flight
        // control-frame waiter (keyed by docId), matching the receipt's
        // messageId == docId. Without it a hard space-rotate reject matches no waiter,
        // times out, and is misclassified pending instead of failing hard.
        thid: spaceId,
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
        thid: spaceId, // SR-4 / F1: correlate the hard reject to the control-frame waiter
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
   * `newGeneration === current + 1` for a new rotation. An exact retry of the
   * installed generation succeeds only with byte-identical material; divergent or
   * superseded material is GENERATION_TAKEN. It then applies the rotation
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
        thid: signer.spaceId, // SR-4 / F1: correlate to the control-frame waiter (docId)
        code: result.errorCode,
        message:
          result.errorCode === 'AUTH_INVALID'
            ? 'space-rotate signature invalid or not signed by a registered admin.'
            : 'Malformed space-rotate control-frame.',
      })
      return
    }

    const { spaceId, newSpaceCapabilityVerificationKey, newGeneration } = result.payload

    // Material-bound retry semantics (Sync 003): an exact repeat of installed
    // material proves the caller's earlier rotation won. It is a no-op, including
    // no redundant cache invalidation. Different material cannot claim that slot.
    const space = this.docLog.getSpace(spaceId)
    if (space !== null && newGeneration === space.generation) {
      if (newSpaceCapabilityVerificationKey === space.verificationKey) {
        this.sendTo(ws, {
          type: 'receipt',
          receipt: { messageId: spaceId, status: 'delivered', timestamp: new Date().toISOString() },
        })
        return
      }
      this.sendTo(ws, {
        type: 'error', thid: spaceId, code: 'GENERATION_TAKEN',
        message: 'space-rotate generation is already installed with different key material.',
      })
      return
    }
    if (space !== null && newGeneration < space.generation) {
      this.sendTo(ws, {
        type: 'error', thid: spaceId, code: 'GENERATION_TAKEN',
        message: 'space-rotate generation has already been superseded.',
      })
      return
    }
    if (space !== null && newGeneration > space.generation + 1) {
      // Sync 003: der Absender ist dem Broker-Zustand vorausgeeilt bzw. hat
      // Rotationen verpasst — dedizierter Code, Client macht Catch-Up + Restage.
      this.sendTo(ws, {
        type: 'error', thid: spaceId, code: 'GENERATION_GAP',
        message: 'space-rotate newGeneration is beyond the current generation plus one.',
        currentGeneration: space.generation,
      })
      return
    }
    if (space === null || newGeneration !== space.generation + 1) {
      this.sendTo(ws, {
        type: 'error',
        thid: spaceId, // SR-4 / F1: correlate to the control-frame waiter (docId)
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

    // A byte-identical self-remove retry is safe after the first accepted frame:
    // verify its signature against the removed DID, then acknowledge the no-op.
    const claimedSignerDid = typeof parsed.header.kid === 'string' ? didOrKidToDid(parsed.header.kid) : ''
    const admins = this.docLog.getSpaceAdmins(parsed.payload.spaceId)
    const selfRetry = claimedSignerDid === parsed.payload.removedAdminDid && !admins.includes(claimedSignerDid)
    let signer: { spaceId: string; adminDid: string; adminPublicKey: Uint8Array } | null
    if (selfRetry) {
      try {
        signer = { spaceId: parsed.payload.spaceId, adminDid: claimedSignerDid, adminPublicKey: didKeyToPublicKeyBytes(claimedSignerDid) }
      } catch {
        this.sendTo(ws, { type: 'error', thid: parsed.payload.spaceId, code: 'AUTH_INVALID', message: 'Admin signer DID is not a resolvable did:key.' })
        return
      }
    } else {
      signer = this.resolveAdminSigner(ws, parsed.adminChangeJws, 'adminChangeJws')
      if (signer === null) return
    }

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

    if (!selfRetry) this.docLog.removeAdmin(result.payload.spaceId, result.payload.removedAdminDid)

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
        now: new Date(this.now()),
      })
    } catch (err) {
      this.sendCapabilityVerifyError(ws, err)
      return
    }

    this.cacheScope(ws, docId, {
      permissions: new Set(payload.permissions),
      generation: space.generation,
      path: 'space',
      validUntil: Date.parse(payload.validUntil),
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
        now: new Date(this.now()),
      })
    } catch (err) {
      this.sendCapabilityVerifyError(ws, err)
      return
    }

    // T-CLAIM (A2 Teil B, TOFU): the FIRST successful present-capability for this personal
    // docId binds it to the authenticated DID. Done HERE (not at the first log-entry) so the
    // doc is owned already at init/catch-up, closing the unowned window. Same-DID reconnects
    // and the owner's other devices (shared seed) re-claim idempotently; a DIFFERENT DID is a
    // conflict (the foreign-leaked-docId attack) → rejected, no scope cached, no receipt.
    //
    // PERSONAL-PATH ONLY: handlePresentCapability routes here ONLY when !isSpaceRegistered(docId)
    // (the space path is presentSpaceCapability), so this never claims a space docId. Even a
    // stray claim from a concurrent space-register race is INERT: the T-CHECK write/read gates
    // short-circuit on isSpaceRegistered, so a personal owner row on a space docId is never read.
    const ownerClaim = this.docLog.claimPersonalDocOwner(docId, socketDid)
    if (ownerClaim.disposition === 'conflict') {
      this.sendTo(ws, {
        type: 'error',
        code: 'PERSONAL_DOC_OWNER_MISMATCH',
        message: 'This personal document is owned by a different identity.',
      })
      return
    }

    this.cacheScope(ws, docId, {
      permissions: new Set(payload.permissions),
      generation: 0, // Personal docs are not rotated in wot-sync@0.1.
      path: 'personal',
      validUntil: Date.parse(payload.validUntil),
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

  /**
   * Evaluate the cached capability scope for (socket, docId, permission) at the
   * current clock (Sync 003 §Capability-Prüfung):
   *  - 'granted'  → a cached scope exists, is NOT expired, and carries `permission`.
   *  - 'expired'  → a cached scope exists but `now >= validUntil`. The expired scope
   *    is DELETED here so a still-cached-but-expired capability never authorizes; the
   *    caller rejects with CAPABILITY_EXPIRED, forcing a re-`present-capability`.
   *  - 'missing'  → no cached scope, or one without `permission` (→ CAPABILITY_REQUIRED).
   *
   * Expiry is checked BEFORE the permission bit so an expired scope reports EXPIRED
   * rather than a confusing REQUIRED, even when the permission would otherwise match.
   * Applied uniformly to log-entry (write) and sync-request (read), SPACE + PERSONAL.
   */
  private checkScope(
    ws: WebSocket,
    docId: string,
    permission: 'read' | 'write',
  ): 'granted' | 'expired' | 'missing' {
    const scope = this.getScope(ws, docId)
    if (!scope) return 'missing'
    if (this.now() >= scope.validUntil) {
      // A still-cached-but-expired scope MUST NOT authorize. Drop it now.
      this.socketToScopes.get(ws)?.delete(docId)
      return 'expired'
    }
    return scope.permissions.has(permission) ? 'granted' : 'missing'
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
    // log-entry-TYPED but malformed envelope falls through and is rejected
    // MALFORMED_MESSAGE by the relay-whitelist below (it is not a queue-eligible
    // Inbox type) — it is never relayed or queued as opaque content.
    if (envelope.typ === DIDCOMM_PLAINTEXT_TYP && envelope.type === LOG_ENTRY_MESSAGE_TYPE) {
      const entryJws = this.tryParseLogEntryJws(envelope)
      if (entryJws !== null) {
        // Fire-and-forget, but never let a post-verify durable-write/broadcast
        // failure become an unhandled rejection (would crash the process on
        // Node 22) — report it to the sender instead.
        this.handleLogEntry(ws, envelope, entryJws).catch((err) => {
          // Metrics: an unexpected async ingest failure (SQLite/crypto/parse) is a
          // reject outside the closed code catalog → 'OTHER'.
          this.metrics.countIngestReject('OTHER')
          this.sendInternalError(ws, err, 'log-entry ingest failed')
        })
        return
      }
    }

    // Slice R / Sync 002: sync-request → sync-response served from the durable
    // log to the requesting authenticated socket only (catch-up / cold
    // reconstruction). Not routed to any recipient. Only a structurally valid
    // sync-request diverts; a malformed one falls through to the relay-whitelist
    // below and is rejected MALFORMED_MESSAGE (not a queue-eligible Inbox type).
    if (envelope.typ === DIDCOMM_PLAINTEXT_TYP && envelope.type === SYNC_REQUEST_MESSAGE_TYPE) {
      if (this.isParsableSyncRequest(envelope)) {
        this.handleSyncRequest(ws, envelope)
        return
      }
    }

    // (VE-R2) Relay-Whitelist (Sync 003 §Relay-Whitelist (MUSS)): the broker
    // relays/queues EXCLUSIVELY messages of DEFINED types — the WoT Transport
    // Envelopes in the Nachrichtentypen-Tabelle plus the defined control-frames.
    // The control-frames + the self-handling transport types each leave handleSend
    // through their own paths BEFORE this point:
    //   - control-frames (device-revoke/space-register/space-rotate/admin-add/
    //     admin-remove/present-capability) via the TOP-LEVEL handleMessage switch,
    //   - ack/1.0 (1480), log-entry/1.0 (1495 → generations-gated handleLogEntry),
    //     sync-request/1.0 (1512 → capability-gated handleSyncRequest),
    //   - the broker's OWN sync-response/1.0 via sendTo in handleSyncRequest.
    // So the ONLY transport types that may legitimately reach the generic routing
    // tail are the four ECIES Inbox types (inbox/1.0, space-invite/1.0,
    // member-update/1.0, key-rotation/1.0 — isEncryptedInboxMessageType). They MUST
    // stay relay/queueable or a fresh client could never receive its first
    // capability (Cold-Start; the Inbox channel is intentionally NOT capability-
    // gated, Sync 003 §Capability-Prüfung).
    //
    // EVERYTHING ELSE is rejected MALFORMED_MESSAGE and is NEITHER relayed NOR
    // queued: an unknown `type`, a CLIENT-originated sync-response/1.0 (only the
    // broker emits sync-response), a log-entry/1.0|sync-request/1.0 that was too
    // malformed to divert above, and the deprecated old-world pipe-`content`
    // MessageEnvelope (`v:1`/`fromDid`/`toDid` — no DIDComm `typ`). Rationale
    // (security-critical, Sync 003): this closes the un-gated relay channel a
    // removed member could otherwise use to push old-content-key ciphertext in an
    // arbitrary-typed envelope LIVE to remaining members — the log-entry ingest
    // gate (incl. the generations-gate) does not reach that path.
    if (!(envelope.typ === DIDCOMM_PLAINTEXT_TYP && isEncryptedInboxMessageType(envelope.type as string))) {
      // Metrics: the whitelist reject also catches a log-entry-typed-but-malformed
      // envelope that failed to divert into handleLogEntry above (ingest reject site
      // per plan review).
      this.metrics.countIngestReject('MALFORMED_MESSAGE')
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: 'Message type is not relay/queue-eligible (Sync 003 relay-whitelist)',
      })
      return
    }

    // Mid-session revocation gate (Sync 003 §Device-Deaktivierung): a whitelisted Inbox
    // envelope may only be fanned out / live-relayed by a sender whose device is STILL
    // registered AND active. The log-entry and sync-request paths already gate on
    // docLog.isActive (see handleLogEntry / handleSyncRequest); without the same gate
    // here a device revoked DURING the open session keeps an open inbox-send path for the
    // four ECIES Inbox types — a revocation bypass. Reject before any enqueue or live send.
    const senderDeviceId = this.socketToDeviceId.get(ws)
    if (senderDeviceId === undefined || !this.docLog.isActive(senderDid, senderDeviceId)) {
      this.sendTo(ws, {
        type: 'error',
        code: 'DEVICE_REVOKED',
        message: 'This device is not active (revoked or not registered).',
      })
      return
    }

    // Routing: DIDComm `to[0]` (Sync 003 Transport Envelope). Only whitelisted
    // Inbox envelopes reach here and they MUST set `to` (Sync 003 §Nachrichten-
    // typen — "Inbox- und direkt adressierte Nachrichten MÜSSEN `to` setzen"); the
    // old-world `toDid` channel is no longer reachable past the relay-whitelist.
    const to = envelope.to
    const toDid = Array.isArray(to) && typeof to[0] === 'string' ? (to[0] as string) : undefined
    if (!toDid) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MISSING_RECIPIENT',
        message: 'Envelope must have a to[0] recipient field',
      })
      return
    }

    // A whitelisted inbox envelope without an `id` cannot be acked (ack/1.0 needs the
    // canonical UUID) — give it a UNIQUE fallback so two such envelopes never collide on
    // the inbox_message UNIQUE(message_id) key (a constant would drop the second message).
    const messageId = (envelope.id as string) ?? `unknown-${randomUUID()}`
    const nowMs = this.now()
    const now = new Date(nowMs).toISOString()

    // Multi-device store-and-forward fan-out (Sync 003 §Store-and-Forward, R1 + Z.204).
    // Delivery targets come from the DURABLE EFFECTIVE-ACTIVE device list (not socket
    // presence): every effective-active recipient device gets a 'pending' entry, so a
    // currently-offline-but-active sibling picks the message up on its next connect (TC5).
    // We use effective-active (not plain active) so the fan-out target set is IDENTICAL to
    // the fully-delivered completeness set — a target is always counted in completeness, so
    // a pending entry can never be terminal-deleted out from under a still-eligible device.
    // The pure helper computes the non-sender targets + the self-addressed sender exclusion;
    // we pass it ONLY active devices, so its cleanupPendingEntriesFor is empty (revoked-
    // cleanup is the device-revoke path).
    //
    // INVARIANT (load-bearing): this active-device read and the enqueueFanout persist below
    // run with NO `await` between them. better-sqlite3 + JS run-to-completion keeps read +
    // persist atomic against a concurrent register/deliverOnConnect. Do NOT introduce an
    // await here. (senderDeviceId is the active-gated value from above.)
    const activeDeviceIds = this.docLog.effectiveActiveDeviceIdsForDid(toDid, nowMs, DEFAULT_INACTIVE_MS)
    const disposition = computeBrokerInboxDeliveryTargets({
      messageId,
      sender: { did: senderDid, deviceId: senderDeviceId },
      recipientDid: toDid,
      recipientDevices: activeDeviceIds.map((deviceId) => ({ did: toDid, deviceId, status: 'active' as const })),
    })
    const deliveryTargetDeviceIds = disposition.deliveryTargets.map(
      (target: { deviceId: string }) => target.deviceId,
    )

    // Persist (message once + per-device entries) BEFORE any send — the durable
    // state must be committed before the WebSocket side effect. A divergent
    // messageId reuse (same id, different recipient/payload) is rejected here and
    // NOT live-delivered, so live delivery can never diverge from the durable row.
    const fanout = this.queue.enqueueFanout({
      messageId,
      toDid,
      envelope,
      deliveryTargetDeviceIds,
      excludedSenderDeviceId: disposition.excludedSenderTarget?.deviceId,
      nowMs,
    })
    if (fanout.disposition === 'collision') {
      this.sendTo(ws, {
        type: 'error',
        code: 'MALFORMED_MESSAGE',
        message: 'messageId already in use for a different recipient or payload (no reuse with divergent content)',
      })
      return
    }
    // Metrics: one message accepted into the durable inbox ('inserted' only — an
    // idempotent retransmission is not a new enqueue).
    if (fanout.disposition === 'inserted') this.metrics.countInboxEnqueued()

    // Live-deliver to the CONNECTED sockets of the delivery-target devices only.
    // An active-but-offline target gets no live send — its 'pending' entry is
    // collected on reconnect (TC5). A self-addressed sender is excluded above, so
    // its own socket never receives the echo.
    let liveSends = 0
    const recipientSockets = this.connections.get(toDid)
    if (recipientSockets) {
      for (const recipientWs of recipientSockets) {
        const recipientDeviceId = this.socketToDeviceId.get(recipientWs)
        if (recipientDeviceId !== undefined && deliveryTargetDeviceIds.includes(recipientDeviceId)) {
          this.sendTo(recipientWs, { type: 'message', envelope })
          liveSends += 1
        }
      }
    }

    // Metrics: live inbox deliveries to connected target devices.
    if (liveSends > 0) this.metrics.countInboxDelivered(liveSends)

    // Receipt: 'delivered' iff at least one live send happened, else 'accepted'
    // (retained for offline / cold-start pick-up). A self-addressed sender with no
    // online sibling gets 'accepted' — the message stays retained for the sibling.
    this.sendTo(ws, {
      type: 'receipt',
      receipt: { messageId, status: liveSends > 0 ? 'delivered' : 'accepted', timestamp: now },
    })
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
   * Ingest verification ORDER (Sync 003 MUSS — device-active BEFORE the gate so a
   * revoked socket reports DEVICE_REVOKED even without a cached scope, SHOULD-FIX 2):
   *   1. verify JWS (verifyLogEntryJws — alg/signature/kid==authorKid/schema);
   *      failure → AUTH_INVALID.
   *   2. device-active check → the AUTHENTICATED socket's (did, deviceId) MUST
   *      currently be status==active in the durable device list. A device revoked
   *      DURING the open session is rejected with DEVICE_REVOKED (live status, not
   *      just DID equality). Runs BEFORE the capability gate (mirrors sync-request).
   *   3. capability gate (VE-5 / BLOCKER 2) → a cached WRITE scope for docId that is
   *      NOT expired (now < validUntil). Expired → CAPABILITY_EXPIRED (scope dropped);
   *      absent/insufficient → CAPABILITY_REQUIRED. NOT stored, NOT relayed.
   *   4. author-binding (Sync 003 §Log-Eintrag-Autor-Bindung) → the DID extracted
   *      from payload.authorKid (part before '#') MUST equal the DID that owns
   *      payload.deviceId in the durable device list. Unregistered deviceId →
   *      DEVICE_NOT_REGISTERED; mismatch → AUTHOR_MISMATCH. Replaces the Slice-R
   *      VE-3a first-writer-wins heuristic. Entry NOT stored, NOT relayed.
   *   5. seq-collision (VE-3, deterministic-nonce reuse) → divergent content at an
   *      existing (docId,deviceId,seq); → SEQ_COLLISION_DETECTED + restore-clone
   *      hint; NOT stored, NOT relayed. (Idempotent re-send → no re-store.)
   *   6. store + live-relay to currently connected recipient devices (no inbox
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
      this.metrics.countIngestReject('AUTH_INVALID')
      this.sendTo(ws, {
        type: 'error',
        code: 'AUTH_INVALID',
        message: err instanceof Error ? err.message : 'Log-entry JWS verification failed',
      })
      return
    }

    const { docId, deviceId, seq, authorKid } = payload
    const messageId = (envelope.id as string) ?? 'unknown'

    // (2) Live device-active check FIRST (before the capability gate, SHOULD-FIX 2):
    // the AUTHENTICATED socket's (did, deviceId) MUST currently be active. A device
    // revoked DURING the open session is rejected DEVICE_REVOKED on EVERY log-entry,
    // even when no scope is cached — the live revoked check is the higher-priority
    // signal (mirrors sync-request, which already checks device-active first).
    // author-binding DID-equality alone would still pass for a revoked device.
    const socketDid = this.socketToDid.get(ws)
    const socketDeviceId = this.socketToDeviceId.get(ws)
    if (
      socketDid === undefined ||
      socketDeviceId === undefined ||
      !this.docLog.isActive(socketDid, socketDeviceId)
    ) {
      this.metrics.countIngestReject('DEVICE_REVOKED')
      this.sendTo(ws, {
        type: 'error',
        // Slice SR-2 / Symptom B (additive, backward-compatible): attach `thid ==
        // messageId` so the sender's LogSyncCoordinator can CORRELATE this routed reject
        // back to the exact in-flight write (onWritePathErrorFrame / routeWritePathError
        // require a string `thid`; types.ts error variant has `thid?` optional). Without
        // it a mid-session DEVICE_REVOKED disposition (restore-clone) never fires
        // in-session over real WS. messageId is in scope (defined above for this handler).
        thid: messageId,
        code: 'DEVICE_REVOKED',
        message: 'This device is not active (revoked or not registered).',
      })
      return
    }

    // T-CHECK write (A2 Teil B): a PERSONAL doc (not space-registered) bound to an owner is
    // writable ONLY by that owner DID. Checked BEFORE the capability-scope cache (Slice CG) so
    // a foreign DID can never authorize a write even with a racing cached scope. Not stored,
    // not relayed → PERSONAL_DOC_OWNER_MISMATCH. DID-level (same-DID multi-device allowed).
    // Space docs and not-yet-claimed docs are unaffected. docId is from the VERIFIED payload.
    if (!this.docLog.isSpaceRegistered(docId)) {
      const personalOwner = this.docLog.getPersonalDocOwner(docId)
      if (personalOwner !== null && personalOwner !== socketDid) {
        this.metrics.countIngestReject('PERSONAL_DOC_OWNER_MISMATCH')
        this.sendTo(ws, {
          type: 'error',
          thid: messageId,
          code: 'PERSONAL_DOC_OWNER_MISMATCH',
          message: 'Only the personal document owner can write to this doc.',
        })
        return
      }
    }

    // (Capability gate, VE-5 — Sync 003 §Gate, Log-Sync channel only): a cached
    // WRITE scope for `docId` is REQUIRED on THIS socket before any durable side
    // effect. Established session-scoped via present-capability. The docId is read
    // from the VERIFIED payload (authority via authorKid, never envelope fields), so
    // the gate trusts a cryptographically-anchored docId. An EXPIRED cached scope
    // (now >= validUntil, Sync 003 §Capability-Prüfung) is dropped and rejected
    // CAPABILITY_EXPIRED — a presented capability MUST NOT authorize past validUntil;
    // an absent/insufficient scope → CAPABILITY_REQUIRED. Nothing is stored/relayed
    // in either case. Author-binding / seq checks follow.
    const writeScope = this.checkScope(ws, docId, 'write')
    if (writeScope !== 'granted') {
      this.metrics.countIngestReject(writeScope === 'expired' ? 'CAPABILITY_EXPIRED' : 'CAPABILITY_REQUIRED')
      this.sendTo(ws, {
        type: 'error',
        // Slice SR-2 / Symptom A+B (additive, backward-compatible): attach `thid ==
        // messageId` so the coordinator can CORRELATE this routed reject to the exact
        // in-flight write (require a string `thid`; types.ts `thid?` optional). LAGGER-
        // CRITICAL: on the real relay a rotation deletes the lagger's stale scope
        // atomically (invalidateStaleScopesForDoc), so its stale write hits THIS gate
        // first; with thid the capability-re-present disposition becomes routable
        // in-session. (For the TEIL 1 lagger-fix the post-rotation resendPending re-sends
        // under the gen-N cap, so the relay's generations-gate is what rejects then — but
        // routing this frame closes Symptom B for the general case.)
        thid: messageId,
        code: writeScope === 'expired' ? 'CAPABILITY_EXPIRED' : 'CAPABILITY_REQUIRED',
        message:
          writeScope === 'expired'
            ? 'Cached write capability for this docId has expired. Present a renewed capability first.'
            : 'No cached write capability for this docId. Present a capability first.',
      })
      return
    }

    // (3) Author-binding against the DURABLE device list (Sync 003 §Autor-Bindung):
    // the DID owning payload.deviceId MUST equal the DID in payload.authorKid.
    const ownerDid = this.docLog.didForDevice(deviceId)
    if (ownerDid === null) {
      // payload.deviceId is not registered at all.
      this.metrics.countIngestReject('DEVICE_NOT_REGISTERED')
      this.sendTo(ws, {
        type: 'error',
        // Slice SR-2 / Symptom B (additive, backward-compatible): attach `thid ==
        // messageId` so the coordinator can CORRELATE this routed reject to the exact
        // in-flight write (device-re-register disposition; types.ts `thid?` optional).
        thid: messageId,
        code: 'DEVICE_NOT_REGISTERED',
        message: 'The log-entry deviceId is not registered in the broker device list.',
      })
      return
    }
    if (ownerDid !== didOrKidToDid(authorKid)) {
      // The authorKid DID does not own this deviceId. Not stored, not relayed.
      this.metrics.countIngestReject('AUTHOR_MISMATCH')
      this.sendTo(ws, {
        type: 'error',
        // Slice SR-2 / Symptom B (additive, backward-compatible): attach `thid ==
        // messageId` so the coordinator can CORRELATE this routed reject to the exact
        // in-flight write (AUTHOR_MISMATCH is a hard-stop disposition; types.ts `thid?`
        // optional). Routing it lets the sender surface the hard stop in-session instead
        // of waiting on a send-timeout.
        thid: messageId,
        code: 'AUTHOR_MISMATCH',
        message: 'Author mismatch: the authorKid DID does not own this deviceId.',
      })
      return
    }

    // (VE-R1) Broker-Ingest-Generations-Gate (Sync 003 §log-entry/1.0 —
    // "Broker-Ingest-Generations-Gate (MUSS, sicherheitskritisch)"): for a
    // REGISTERED space-docId (a space-register entry with a generation exists), a
    // log-entry whose `keyGeneration` is STRICTLY LESS than the durable
    // `space.generation` is rejected KEY_GENERATION_STALE and is NEITHER stored NOR
    // relayed — it is a write attempt under a rotated-out content key (e.g. a
    // just-removed member after rotation). Runs AFTER JWS verification + author-
    // binding and BEFORE the durable insert/relay (appendEntry).
    //
    // The comparison reads the DURABLE generation via getSpace (from
    // space-register/space-rotate), NOT the capability-scope cache — so it is
    // race-safe against a concurrent rotateSpace (an atomic UPDATE), and it stays
    // correct even on a socket whose stale scope was already cache-invalidated.
    // payload.keyGeneration comes from the VERIFIED JWS (verifyLogEntryJws), so the
    // gated value is cryptographically anchored.
    //
    // keyGeneration GREATER THAN OR EQUAL the current generation MUST be accepted —
    // including a future generation the broker has not itself seen yet (multi-broker
    // liveness): such an entry is persisted, NOT buffered. getSpace returns null for
    // an unregistered docId (Personal-Doc), so the gate is a no-op there. For
    // generation 0 the test `0 < 0` is false → accepted.
    // FAST-PATH pre-gate (B2): a cheap early reject for the common case (no concurrent
    // rotation). This is NOT authoritative — appendEntry re-checks the generation
    // inside its SQLite transaction (the race-closing gate), since a rotateSpace can
    // still land between this read and the durable insert below.
    const space = this.docLog.getSpace(docId)
    if (space !== null && payload.keyGeneration < space.generation) {
      this.metrics.countIngestReject('KEY_GENERATION_STALE')
      // Slice SR / VE-C2 (APPROVAL-GATED relay change): attach `thid == messageId` so
      // the sender's LogSyncCoordinator can CORRELATE this routed error back to the
      // exact in-flight write (onWritePathErrorFrame / routeWritePathError require a
      // string `thid`). Without it the legitimate lagger's KEY_GENERATION_STALE is
      // dropped client-side and the catch-up-and-re-emit never fires — a greenwash
      // trap, since the InProcessLogBroker model already sets thid (unit tests pass).
      this.sendTo(ws, {
        type: 'error',
        thid: messageId,
        code: 'KEY_GENERATION_STALE',
        message:
          'Log-entry keyGeneration is older than the current space generation; re-emit under a new seq and the new keyGeneration.',
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
    // Metrics: time the hot durable ingest write (synchronous better-sqlite3
    // transaction) — sqliteWriteP95Ms is the write-pressure indicator. Duration
    // via performance.now() (monotonic), never wall clock.
    const writeStart = performance.now()
    const result = this.docLog.appendEntry({
      docId,
      deviceId,
      seq,
      contentHash: incomingContentHash,
      entryJws,
      // B2: the verified payload generation, gated in-transaction against the durable
      // space generation (the authoritative race-closing check).
      keyGeneration: payload.keyGeneration,
    })
    this.metrics.recordSqliteWriteMs(performance.now() - writeStart)

    if (result.disposition === 'reject-key-generation-stale') {
      this.metrics.countIngestReject('KEY_GENERATION_STALE')
      // Slice SR / B2 — the AUTHORITATIVE in-transaction gate fired: a concurrent
      // rotateSpace advanced the generation past this NEW entry between the fast-path
      // pre-gate and the durable insert. Same wire response as the pre-gate
      // (KEY_GENERATION_STALE + thid == messageId) so the lagger's coordinator
      // catches up + re-emits. The entry was NEITHER stored NOR relayed.
      this.sendTo(ws, {
        type: 'error',
        thid: messageId,
        code: 'KEY_GENERATION_STALE',
        message:
          'Log-entry keyGeneration is older than the current space generation; re-emit under a new seq and the new keyGeneration.',
      })
      return
    }
    if (result.disposition === 'reject-seq-collision') {
      // Nonce-safety boundary: the divergent entry never reached the durable log
      // and is not relayed. Sender gets the restore-clone hint. (Metrics: the wire
      // code comes from the store result — fold via the closed catalog.)
      this.metrics.countIngestReject(toIngestRejectCode(result.errorCode))
      this.sendTo(ws, {
        type: 'error',
        // Slice SR-2 / Symptom B (additive, backward-compatible): attach `thid ==
        // messageId` so the coordinator can CORRELATE this routed reject to the exact
        // in-flight write (SEQ_COLLISION_DETECTED → restore-clone disposition; types.ts
        // `thid?` optional). Lets an in-session restore-clone fire over real WS instead of
        // only on the next reconnect.
        thid: messageId,
        code: result.errorCode,
        message: 'Sequence collision: divergent entry at an existing (docId,deviceId,seq).',
        clientHint: result.clientHint,
      })
      return
    }
    if (result.disposition === 'idempotent-retransmission') {
      // Already have this exact (deviceId,seq,content): no re-store, no
      // re-broadcast. Acknowledge so the client's send() resolves. (Metrics: an
      // idempotent retransmission is an OK ingest outcome.)
      this.metrics.countIngestOk()
      this.sendTo(ws, {
        type: 'receipt',
        receipt: { messageId, status: 'delivered', timestamp: new Date().toISOString() },
      })
      return
    }

    // accept-new-entry: the entry is durably stored. Live broadcast to currently-connected recipient devices (realtime
    // preserved). Routing uses the transport envelope `to` recipients; the
    // sender's own socket is excluded so a device does not receive its own echo.
    this.metrics.countIngestOk()
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

    // T-CHECK read (A2 Teil B): a PERSONAL doc bound to an owner is readable ONLY by that
    // owner DID — checked BEFORE the capability-scope cache. A foreign DID gets NO sync-response
    // (else a metadata leak of the owner's log). DID-level (same-DID multi-device allowed);
    // space docs / not-yet-claimed docs unaffected.
    if (!this.docLog.isSpaceRegistered(docId)) {
      const personalOwner = this.docLog.getPersonalDocOwner(docId)
      if (personalOwner !== null && personalOwner !== socketDid) {
        this.sendTo(ws, {
          type: 'error',
          code: 'PERSONAL_DOC_OWNER_MISMATCH',
          message: 'Only the personal document owner can read this doc.',
        })
        return
      }
    }

    // (Capability gate, VE-5 — Sync 003 §Gate, Log-Sync channel only): a cached
    // READ scope for `docId` is REQUIRED on THIS socket before serving any
    // catch-up. Established session-scoped via present-capability. An EXPIRED cached
    // scope (now >= validUntil, Sync 003 §Capability-Prüfung) is dropped and rejected
    // CAPABILITY_EXPIRED — a presented capability MUST NOT serve reads past
    // validUntil; an absent/insufficient scope → CAPABILITY_REQUIRED. Nothing served
    // in either case.
    const readScope = this.checkScope(ws, docId, 'read')
    if (readScope !== 'granted') {
      this.sendTo(ws, {
        type: 'error',
        code: readScope === 'expired' ? 'CAPABILITY_EXPIRED' : 'CAPABILITY_REQUIRED',
        message:
          readScope === 'expired'
            ? 'Cached read capability for this docId has expired. Present a renewed capability first.'
            : 'No cached read capability for this docId. Present a capability first.',
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

    // No-op for the inbox queue (Sync 003 TC4): the inbox carries ONLY ack/1.0-bound
    // types, every one of which is rejected above (inbox-channel discard). The legacy
    // global delete is removed — a per-device inbox entry is cleared exclusively by the
    // owning device's ack/1.0 (handleInboxAckEnvelope), never by a control-frame ack.
    // An unknown messageId (already-cleared slot / sibling device) stays a silent no-op.
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
   * Was das Relay NICHT wissen kann: nach dem terminalen Löschen einer Nachricht
   * ist ihr Typ nicht mehr rekonstruierbar. Die Inbox ist jetzt PER-DEVICE
   * (Sync 003 §Store-and-Forward): ein ack/1.0 räumt via rowcount-gesteuertem
   * ackDevice nur den Eintrag DIESES Devices; ein Geschwister-Gerät, das eine
   * bereits terminal gelöschte oder fremde messageId ackt, ist ein striktes
   * No-op (changes===0). Unbekannte messageIds werden deshalb idempotent
   * akzeptiert (mit Receipt) statt strikt abgelehnt.
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

    // Per-device ACK (Sync 003 TC4): clear ONLY this device's entry and terminal-
    // delete the message iff it is now fully delivered (durable, rowcount-gated — a
    // sender-excluded / already-acked / foreign-device ack is a strict no-op). The
    // acking device is the authenticated socket's deviceId.
    const deviceId = this.socketToDeviceId.get(ws)
    if (deviceId !== undefined) {
      const ack = this.queue.ackDevice(messageId, deviceId, { nowMs: this.now() })
      // Metrics: count only a DURABLY APPLIED ack (changes > 0) — a no-op re-ack /
      // foreign-device ack is not inbox progress (v2 spec).
      if (ack.applied) this.metrics.countAck()
    }
    // Receipt (idempotent — sent even on a no-op ack) so the client-side send() of the
    // ack envelope resolves; existing send()/ack flows depend on it.
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
      // Metrics: ONE central hook for receipt/error frames actually written to an
      // OPEN socket (v2 spec — instead of a dozen per-call-site increments).
      // receipt 'failed' has no sender in the relay (types-only) and stays uncounted.
      if (msg.type === 'receipt') this.metrics.countReceipt(msg.receipt.status)
      else if (msg.type === 'error') this.metrics.countErrorFrame()
      ws.send(JSON.stringify(msg))
    }
  }
}
