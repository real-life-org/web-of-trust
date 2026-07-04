/**
 * Slice A / VE-11 — REAL-relay end-to-end harness.
 *
 * Boots an in-process {@link RelayServer} (better-sqlite3 + ws, dbPath ':memory:')
 * and wires REAL {@link WebSocketMessagingAdapter} clients (register → challenge →
 * challenge-response → present-capability via sendControlFrame) to the REAL
 * replication adapters (Yjs and, separately, Automerge) with `enableLogSync:true`.
 *
 * This is the engine-NEUTRAL part of the harness: identities, the relay lifecycle,
 * a free-port allocator, the content-blocking + counting messaging spy (Legacy-
 * Isolation), and the shared per-client store wiring. The engine-specific client
 * factories live in `yjs-client.ts` / `automerge-client.ts`.
 *
 * LEGACY ISOLATION (enforced for EVERY client built here):
 *  - NO vault / vaultUrl is ever passed (the log path must converge standalone).
 *  - Incoming `content` AND full-state `content` envelopes are dropped by the spy
 *    and counted; tests assert `contentMessagesApplied === 0`.
 *  - The spy counts applied `sync-response` entries so a cold-start can assert
 *    `syncResponseEntriesApplied > 0` (the positive catch-up proof), and the
 *    outgoing types so a test can assert `sentTypes` never contains `content`.
 */
import { RelayServer } from '@web_of_trust/relay'
import { WebSocketMessagingAdapter } from '@web_of_trust/core/adapters/messaging/websocket'
import type { WireMessage } from '@web_of_trust/core/ports'
import {
  LOG_ENTRY_MESSAGE_TYPE,
  SYNC_REQUEST_MESSAGE_TYPE,
  SYNC_RESPONSE_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import type { PublicIdentitySession } from '@web_of_trust/core/application'
import { IdentityWorkflow } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'

export const sharedCrypto = new WebCryptoProtocolCryptoAdapter()

export const wait = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── D1 / Spur-C — remote-relay mode + three-way test-mode matrix (TC1/TC5) ──────
//
/**
 * Remote-relay mode. When `REMOTE_RELAY_URL` is set (e.g. a Staging relay
 * `wss://relay-staging.web-of-trust.de`), {@link startRelay} OBSERVES that shared
 * relay from outside over HTTP instead of booting an in-process `:memory:` server.
 * Unset (the CI default) → unchanged in-process behavior (fast + green).
 */
export const REMOTE_RELAY_URL = process.env.REMOTE_RELAY_URL?.trim() || undefined
// Explicit truthy parse: `REMOTE_ALLOW_DESTRUCTIVE=false`/`0` must NOT enable destructive
// remote suites (a bare `!!process.env...` is true for any non-empty string).
const ALLOW_DESTRUCTIVE_REMOTE = /^(1|true|yes)$/i.test(process.env.REMOTE_ALLOW_DESTRUCTIVE ?? '')

/**
 * Three-way test-mode matrix (TC5). Every e2e suite/test is EXPLICITLY one class:
 *  - **remote-capable** — runs in-process (default) AND remote. No guard needed.
 *  - **remote-destructive** — creates permanent/global-reserved relay state
 *    (device-revoke, key-rotation, member-removal, restore-clone, deliberate
 *    stale-write). Remote ONLY with `REMOTE_ALLOW_DESTRUCTIVE` set; otherwise the
 *    suite is SKIPPED remote (guard against pointing this at a non-disposable relay).
 *  - **local-only** — needs relay-internal mechanics (injected clock, deterministic
 *    interna). Can NEVER run remote → SKIPPED remote (never green-washed).
 * Usage (vitest): `describe.skipIf(testMode.skipLocalOnlyRemote)(…)`.
 */
export const testMode = {
  /** True when running against a remote relay (REMOTE_RELAY_URL set). */
  isRemote: REMOTE_RELAY_URL !== undefined,
  /** remote-destructive suites: skip when remote and destructive runs are not explicitly allowed. */
  skipDestructiveRemote: REMOTE_RELAY_URL !== undefined && !ALLOW_DESTRUCTIVE_REMOTE,
  /** local-only suites: skip whenever remote (relay-internal mechanics can't be remote). */
  skipLocalOnlyRemote: REMOTE_RELAY_URL !== undefined,
} as const

/**
 * Mode-derived polling defaults — the SINGLE switch the directive asks for (not N
 * scattered timeout edits). In-process convergence is ~ms; a remote relay observed
 * over HTTPS needs a larger budget AND a gentler poll interval (≥200 ms — don't
 * hammer the shared endpoint).
 */
const WAIT_DEFAULTS = testMode.isRemote
  ? { waitTimeoutMs: 30_000, waitStepMs: 250, stableMs: 800, stableTimeoutMs: 40_000, stableStepMs: 250 }
  : { waitTimeoutMs: 8_000, waitStepMs: 40, stableMs: 300, stableTimeoutMs: 15_000, stableStepMs: 50 }

/** Poll `fn` until it returns true or `timeoutMs` elapses (real-socket convergence). */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  { timeoutMs = WAIT_DEFAULTS.waitTimeoutMs, stepMs = WAIT_DEFAULTS.waitStepMs }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await wait(stepMs)
  }
}

/**
 * Drain barrier: poll a numeric reading until it has been STABLE (unchanged) for `stableMs`,
 * then return the settled value. Replaces a fixed `wait(N)` after an async outbox write burst —
 * a fixed wait races the drain (the count can still be climbing or not yet reached), making
 * `entryCount` snapshot assertions flaky under CPU load (Slice B v3, Opus merge-blocker).
 *
 * `read` may be async (Promise-capable) so it composes with the async accessor contract
 * (TC1): `waitForStableCount(() => relay.entryCount(d))` stays formgleich — the lambda now
 * just yields a Promise.
 */
export async function waitForStableCount(
  read: () => number | Promise<number>,
  {
    stableMs = WAIT_DEFAULTS.stableMs,
    timeoutMs = WAIT_DEFAULTS.stableTimeoutMs,
    stepMs = WAIT_DEFAULTS.stableStepMs,
  }: { stableMs?: number; timeoutMs?: number; stepMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  let lastChangeAt = Date.now()
  for (;;) {
    await wait(stepMs)
    const cur = await read()
    if (cur !== last) {
      last = cur
      lastChangeAt = Date.now()
    } else if (Date.now() - lastChangeAt >= stableMs) {
      return cur
    }
    if (Date.now() >= deadline) return cur
  }
}

/**
 * Relay observation accessors present in BOTH modes. ALL async (TC1 async-accessor
 * contract): local-mode impls are trivial wrappers over the in-process docLog; remote
 * impls read GET /dashboard/data. No sync-over-async, no stale-snapshot refresh muster.
 */
export interface RelayObservation {
  /** WS URL clients dial (`ws://localhost:…` in-process, `wss://…` for a remote relay). */
  url: string
  /** Total retained entries for a docId (positive-proof: == N before disconnect). */
  entryCount(docId: string): Promise<number>
  /**
   * Retained entries for one (docId, deviceId) — the durable trace a SPECIFIC device
   * left. A precise security assertion for the removal-negative test: a removed
   * member's deviceId MUST leave ZERO durable entries after the rotation, regardless
   * of any legitimate in-session recovery write a STILL-active admin makes (whose
   * write-path reject now routes + recovers, Slice SR-2 / Symptom B).
   */
  entryCountForDevice(docId: string, deviceId: string): Promise<number>
  isSpaceRegistered(docId: string): Promise<boolean>
  /**
   * The durable space record. `verificationKey` is local-only — it is intentionally
   * NOT exposed via /dashboard/data (minimal D1 stats), so in remote mode it is
   * `undefined` (no remote-capable test reads it; all read `.generation`).
   */
  getSpace(docId: string): Promise<{ generation: number; verificationKey?: string } | null>
  getSpaceAdmins(docId: string): Promise<string[]>
  /** Local: stop the in-process server. Remote: NO-OP (a shared relay is NEVER stopped). */
  stop(): Promise<void>
}

/**
 * Discriminated union (TC1, Codex-BLOCKER-2): in `remote` mode there is NO in-process
 * `server`/`port`. Any test that DIRECTLY reads `relay.server`/`relay.port` must narrow to
 * `mode === 'local'` first — the COMPILER enforces that (a bare `relay.server` is a type
 * error). Helpers that ENCAPSULATE server construction (e.g. `startRelayWithClock`) bypass
 * that type surface, so they additionally hard-guard on `REMOTE_RELAY_URL` at runtime;
 * together the two stop a local-only (clock-inject) test from ever silently running — and
 * green-washing — against a remote relay.
 */
export type StartedRelay =
  | (RelayObservation & { mode: 'local'; server: RelayServer; port: number })
  | (RelayObservation & { mode: 'remote' })

/** Reach into the server's durable registry (the SAME accessor the relay's own tests use). */
function relayDocLog(server: RelayServer): {
  entryCount: (docId?: string) => number
  entryCountForDevice: (docId: string, deviceId: string) => number
  isSpaceRegistered: (id: string) => boolean
  getSpace: (id: string) => { verificationKey: string; generation: number } | null
  getSpaceAdmins: (id: string) => string[]
} {
  return (server as unknown as { docLog: ReturnType<typeof relayDocLog> }).docLog
}

/**
 * `ws(s)://host[:port]` → `http(s)://host[:port]`. Normalizes via URL so a trailing slash
 * or path on REMOTE_RELAY_URL (`wss://relay-staging…/`) still resolves to `…/dashboard/data`
 * instead of `…//dashboard/data` (operator footgun). The relay serves /dashboard/data at the
 * SAME host/port as the WS endpoint.
 */
export function httpBaseFromWsUrl(wsUrl: string): string {
  const u = new URL(wsUrl)
  const httpProtocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  return `${httpProtocol}//${u.host}`
}

interface RemoteLogStats {
  entriesByDoc?: Record<string, number>
  entriesByDocAndDevice?: Record<string, Record<string, number>>
  spacesByDoc?: Record<string, { registered: boolean; generation: number; admins: string[] }>
}

/** Per-request timeout for the remote /dashboard/data poll — a hung TCP/TLS/HTTP call must
 * fail fast into the waitFor/waitForStableCount budget instead of blocking indefinitely. */
const REMOTE_FETCH_TIMEOUT_MS = 10_000

/** Observe the shared relay from OUTSIDE: GET {httpBase}/dashboard/data → logStats. */
async function fetchRemoteLogStats(httpBase: string): Promise<RemoteLogStats> {
  const res = await fetch(`${httpBase}/dashboard/data`, { signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`remote relay GET /dashboard/data → HTTP ${res.status}`)
  const json = (await res.json()) as { logStats?: RemoteLogStats }
  const logStats = json.logStats
  // Fail LOUD when the sensitive observation fields are absent. A missing field must NEVER be
  // read as "real zero/empty": that would green-wash the NEGATIVE security assertions this
  // remote path exists to prove (e.g. "a removed device left 0 durable entries"). Empty maps
  // ({}) are fine on a fresh relay; an ABSENT entriesByDocAndDevice/spacesByDoc means the relay
  // has debug stats OFF (default-redacted prod) or predates the D1 stats — set RELAY_DEBUG_STATS
  // on the (staging/local) target relay.
  if (
    !logStats ||
    typeof logStats.entriesByDoc !== 'object' ||
    typeof logStats.entriesByDocAndDevice !== 'object' ||
    typeof logStats.spacesByDoc !== 'object'
  ) {
    throw new Error(
      'remote relay /dashboard/data is missing logStats.entriesByDocAndDevice / spacesByDoc — ' +
        'enable RELAY_DEBUG_STATS on the target relay (these sensitive fields are redacted by ' +
        'default). Refusing to observe: a missing field would silently green-wash negative assertions.',
    )
  }
  return logStats
}

/**
 * Remote mode (TC1/TC2): observe a SHARED relay over HTTP. NEVER reaches into an
 * in-process docLog (there is none). `stop()` is a no-op so a test teardown can never
 * kill the shared/staging relay. Each accessor re-fetches /dashboard/data, so a poll
 * loop (waitFor/waitForStableCount) sees fresh state every iteration.
 */
export function startRemoteRelay(wsUrl: string): StartedRelay {
  const httpBase = httpBaseFromWsUrl(wsUrl)
  return {
    mode: 'remote',
    url: wsUrl,
    entryCount: async (docId) => (await fetchRemoteLogStats(httpBase)).entriesByDoc?.[docId] ?? 0,
    entryCountForDevice: async (docId, deviceId) =>
      (await fetchRemoteLogStats(httpBase)).entriesByDocAndDevice?.[docId]?.[deviceId] ?? 0,
    isSpaceRegistered: async (docId) => (await fetchRemoteLogStats(httpBase)).spacesByDoc?.[docId]?.registered === true,
    getSpace: async (docId) => {
      const space = (await fetchRemoteLogStats(httpBase)).spacesByDoc?.[docId]
      return space ? { generation: space.generation } : null
    },
    getSpaceAdmins: async (docId) => (await fetchRemoteLogStats(httpBase)).spacesByDoc?.[docId]?.admins ?? [],
    stop: async () => {
      /* shared/staging relay — a test must NEVER stop it. */
    },
  }
}

export async function startRelay(): Promise<StartedRelay> {
  if (REMOTE_RELAY_URL) return startRemoteRelay(REMOTE_RELAY_URL)
  // port:0 → OS-assigned ephemeral port, read back AFTER bind via server.port (no
  // free-port-then-reuse TOCTOU race).
  const server = new RelayServer({ port: 0, dbPath: ':memory:' })
  await server.start()
  const port = server.port
  const docLog = relayDocLog(server)
  return {
    mode: 'local',
    server,
    url: `ws://localhost:${port}`,
    port,
    entryCount: async (docId: string) => docLog.entryCount(docId),
    entryCountForDevice: async (docId: string, deviceId: string) => docLog.entryCountForDevice(docId, deviceId),
    isSpaceRegistered: async (id: string) => docLog.isSpaceRegistered(id),
    getSpace: async (id: string) => docLog.getSpace(id),
    getSpaceAdmins: async (id: string) => docLog.getSpaceAdmins(id),
    stop: () => server.stop(),
  }
}

export async function makeIdentity(): Promise<PublicIdentitySession> {
  const { identity } = await new IdentityWorkflow({ crypto: sharedCrypto }).createIdentity({
    passphrase: 'e2e-log-sync',
    storeSeed: false,
  })
  return identity
}

/**
 * Per-client Legacy-Isolation + observability counters. A test reads these AFTER
 * the relevant traffic to prove the log core (not the dead content path) carried
 * convergence.
 */
export interface MessagingProbe {
  /** Incoming `content`/full-state envelopes that were DROPPED (must stay 0-applied). */
  contentMessagesBlocked: number
  /** `content` envelopes that reached the adapter (MUST be 0 — the blocker is upstream). */
  contentMessagesApplied: number
  /** `sync-response` envelopes whose entries[] were handed to the adapter (catch-up proof). */
  syncResponseEnvelopes: number
  /** Total entries carried by all observed `sync-response` envelopes (assert > 0 on cold-start). */
  syncResponseEntriesApplied: number
  /** Outgoing message types observed (assert: never contains 'content' after VE-2). */
  sentTypes: string[]
  /** Outgoing log-entry envelope count (LOOP-GUARD: == local edits; 0 on a pure reader). */
  sentLogEntries: number
  sentSyncRequests: number
  /**
   * Incoming relay `error` frames tallied by code (Festival-Scale-Stress zero-error).
   * These are the WRITE-PATH rejects the adapter fans into the message path
   * (KEY_GENERATION_STALE, SEQ_COLLISION_DETECTED, routed CAPABILITY/DEVICE rejects).
   * Control-frame rejects surface as thrown errors from adapter calls, not here.
   */
  errorFramesByCode: Record<string, number>
}

function freshProbe(): MessagingProbe {
  return {
    contentMessagesBlocked: 0,
    contentMessagesApplied: 0,
    syncResponseEnvelopes: 0,
    syncResponseEntriesApplied: 0,
    sentTypes: [],
    sentLogEntries: 0,
    sentSyncRequests: 0,
    errorFramesByCode: {},
  }
}

/**
 * Wrap a REAL {@link WebSocketMessagingAdapter} with the content-blocking +
 * counting spy. The spy:
 *  - drops every incoming `content` (and full-state `content`) envelope BEFORE the
 *    adapter sees it (Legacy-Isolation), counting it as blocked;
 *  - counts a `content` that slips through as APPLIED (must remain 0);
 *  - counts `sync-response` envelopes + their entries (catch-up proof);
 *  - tallies outgoing types (so `content`-off + LOOP-GUARD are assertable).
 *
 * The wrap returns the SAME object (so the adapter passes its own `instanceof`
 * checks for `sendControlFrame`), with `onMessage` / `send` intercepted.
 */
export function instrumentMessaging(
  messaging: WebSocketMessagingAdapter,
): { messaging: WebSocketMessagingAdapter; probe: MessagingProbe } {
  const probe = freshProbe()

  // --- incoming: drop `content`, count `sync-response` entries -----------------
  const baseOnMessage = messaging.onMessage.bind(messaging)
  ;(messaging as unknown as { onMessage: typeof messaging.onMessage }).onMessage = (
    callback: (envelope: WireMessage) => void | Promise<void>,
  ) => {
    return baseOnMessage(async (envelope: WireMessage) => {
      const type = (envelope as { type?: string }).type
      if (type === 'content') {
        // Legacy content channel is DEAD on the log path: never deliver it to the
        // adapter. If the adapter still relied on it, contentMessagesApplied would
        // stay 0 yet convergence would fail — exactly the regression this guards.
        probe.contentMessagesBlocked += 1
        return
      }
      if (type === SYNC_RESPONSE_MESSAGE_TYPE) {
        probe.syncResponseEnvelopes += 1
        const entries = (envelope as { body?: { entries?: unknown } }).body?.entries
        if (Array.isArray(entries)) probe.syncResponseEntriesApplied += entries.length
      }
      if (type === 'error') {
        // Write-path reject fanned into the message path (Festival-Scale-Stress zero-error tally).
        const code = (envelope as { code?: unknown }).code
        const message = (envelope as { message?: unknown }).message
        let key = typeof code === 'string' ? code : 'UNKNOWN'
        // The relay correctly rejects the DEAD legacy content/full-state channel (not queue-eligible
        // under the Sync-003 whitelist) — Legacy Isolation means convergence rides the log path, so
        // this is benign and structurally expected. Key it distinctly from a genuine malformed
        // log-entry (which must still fail the zero-error gate).
        if (key === 'MALFORMED_MESSAGE' && typeof message === 'string' && message.includes('not relay/queue-eligible')) {
          key = 'MALFORMED_MESSAGE(content-channel-not-queue-eligible)'
        }
        probe.errorFramesByCode[key] = (probe.errorFramesByCode[key] ?? 0) + 1
        if (process.env.STRESS_DEBUG_ERRORS === '1') {
          // eslint-disable-next-line no-console
          console.error(`[stress-error-frame] ${JSON.stringify(envelope)}`)
        }
      }
      // Defensive: a content that somehow reached here would be "applied".
      if (type === 'content') probe.contentMessagesApplied += 1
      await callback(envelope)
    })
  }

  // --- outgoing: tally types (content-off, LOOP-GUARD) -------------------------
  const baseSend = messaging.send.bind(messaging)
  ;(messaging as unknown as { send: typeof messaging.send }).send = async (envelope: WireMessage) => {
    const type = (envelope as { type?: string }).type
    if (typeof type === 'string') probe.sentTypes.push(type)
    if (type === LOG_ENTRY_MESSAGE_TYPE) probe.sentLogEntries += 1
    if (type === SYNC_REQUEST_MESSAGE_TYPE) probe.sentSyncRequests += 1
    return baseSend(envelope)
  }

  return { messaging, probe }
}

/**
 * Build + connect a REAL WS messaging adapter for an identity, wired to the
 * identity's Ed25519 key for the Sync 003 Broker-Auth-Transcript (so the relay
 * verifies the challenge-response against the identity's did:key) and wrapped with
 * the Legacy-Isolation spy.
 */
export async function connectMessaging(
  relayUrl: string,
  identity: PublicIdentitySession,
  deviceId: string,
): Promise<{ messaging: WebSocketMessagingAdapter; probe: MessagingProbe }> {
  const raw = new WebSocketMessagingAdapter(relayUrl, {
    deviceId,
    signBrokerAuthTranscript: (bytes) => identity.signEd25519(bytes),
    // The real round-trip (challenge, control-frame receipts, sync-response) is
    // fast in-process; keep a bounded timeout so a genuine stall fails loudly.
    sendTimeoutMs: 5_000,
  })
  const { messaging, probe } = instrumentMessaging(raw)
  await messaging.connect(identity.getDid())
  return { messaging, probe }
}

/** Deterministic-but-valid UUID-v4 device id (stable per logical device in a test). */
export function deviceUuid(): string {
  return globalThis.crypto.randomUUID()
}

export {
  LOG_ENTRY_MESSAGE_TYPE,
  SYNC_REQUEST_MESSAGE_TYPE,
  SYNC_RESPONSE_MESSAGE_TYPE,
}
