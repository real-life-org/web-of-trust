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
import { createServer, type AddressInfo } from 'node:net'
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

/** Poll `fn` until it returns true or `timeoutMs` elapses (real-socket convergence). */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  { timeoutMs = 8_000, stepMs = 40 }: { timeoutMs?: number; stepMs?: number } = {},
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
 */
export async function waitForStableCount(
  read: () => number,
  { stableMs = 300, timeoutMs = 15_000, stepMs = 50 }: { stableMs?: number; timeoutMs?: number; stepMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = read()
  let lastChangeAt = Date.now()
  for (;;) {
    await wait(stepMs)
    const cur = read()
    if (cur !== last) {
      last = cur
      lastChangeAt = Date.now()
    } else if (Date.now() - lastChangeAt >= stableMs) {
      return cur
    }
    if (Date.now() >= deadline) return cur
  }
}

/** Allocate a concrete free TCP port (RelayServer.port returns options.port — never pass 0). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

export interface StartedRelay {
  server: RelayServer
  url: string
  port: number
  /** Total retained entries for a docId (positive-proof: == N before disconnect). */
  entryCount(docId: string): number
  /**
   * Retained entries for one (docId, deviceId) — the durable trace a SPECIFIC device
   * left. A precise security assertion for the removal-negative test: a removed
   * member's deviceId MUST leave ZERO durable entries after the rotation, regardless
   * of any legitimate in-session recovery write a STILL-active admin makes (whose
   * write-path reject now routes + recovers, Slice SR-2 / Symptom B).
   */
  entryCountForDevice(docId: string, deviceId: string): number
  isSpaceRegistered(docId: string): boolean
  getSpace(docId: string): { verificationKey: string; generation: number } | null
  getSpaceAdmins(docId: string): string[]
  stop(): Promise<void>
}

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

export async function startRelay(): Promise<StartedRelay> {
  const port = await freePort()
  const server = new RelayServer({ port, dbPath: ':memory:' })
  await server.start()
  const docLog = relayDocLog(server)
  return {
    server,
    url: `ws://localhost:${port}`,
    port,
    entryCount: (docId: string) => docLog.entryCount(docId),
    entryCountForDevice: (docId: string, deviceId: string) => docLog.entryCountForDevice(docId, deviceId),
    isSpaceRegistered: (id: string) => docLog.isSpaceRegistered(id),
    getSpace: (id: string) => docLog.getSpace(id),
    getSpaceAdmins: (id: string) => docLog.getSpaceAdmins(id),
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
