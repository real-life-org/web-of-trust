// The wire under the VTI mediator adapter (VTI Mediator Adapter Profile 0.28 §3a, §7): the
// MediatorWire of @real-life/trust-protocol/adapters/vti-mediator over vti-didcomm-js 0.13.0 and
// vti-tsp-js 0.4.0, TSP 1.0 (HPKE-Base, outer signature, the sender VID in the confidential payload).
// A port of trust-protocol
// binding/vti-wire.mjs for the browser: globalThis.WebSocket (the bearer token travels as a
// subprotocol), WebCrypto, the device clock for every delay (#430), the platform's network state for
// `offline()`. One wire belongs to one adapter instance: one relationship, one side, one opening.
//
//  - The wire identities' raw seeds come from the library's own HKDF with the same info prefixes, so
//    the DIDs are byte-identical to the adapter's trio (the library keeps its keys non-extractable).
//  - ATM authentication under the connection DID, one pickup socket.
//  - deposit(token, bytes, egressDid, mode), packed anew for every attempt (RLTP-VTI-7110), the
//    addressing from the library's depositAddressing:
//      routed          inner TSP 1.0 `direct` egress identity → the counterpart's connection DID,
//                      inside an outer routed message connection DID → C with the route
//                      [counterpart's connection DID], sealed to the key C's DID document names first
//                      under keyAgreement, as resolved at the last authentication or renewal
//                      (RLTP-VTI-7120); sent on the connection DID's session
//      egress-session  the inner message alone, on a send-only session of the egress identity,
//                      authenticated at the first deposit in this mode (RLTP-VTI-3120). That session
//                      reads one kind of frame, the mediator's problem report: `e.p.direct_delivery.denied`
//                      (local direct delivery off) refuses every later deposit in this mode for the
//                      life of the wire (WireError('direct-refused')), and `directRefused()` says so from
//                      the moment the report arrived: the adapter records it in the relationship's send
//                      state, which carries it across openings (lib 0.9.1); any other code is reported
//                      and consumed (§5)
//  - Both layers are TSP 1.0 messages carrying the sender's VID in the confidential payload (inner: the
//    egress identity, outer: the connection DID); the library packs nothing else (RLTP-VTI-7110).
//  - onDeliver hands the adapter only the payload of a TSP 1.0 `direct` message with a non-empty
//    payload from the counterpart's egress identity to the own connection DID (RLTP-VTI-7140), byte
//    for byte; everything else is reported (code and message type, no identifiers) and acked. A frame
//    of another TSP version (Rev 3 included), which the library refuses from its version marker before
//    any key is touched, is reported with that version and the sender its envelope names (the
//    diagnostics shorten it), acked and never delivered (RLTP-VTI-7140, 1255, 3140).
//  - Delete-to-ack is the adapter's: a frame is acked when the adapter concludes it, translated from
//    the payload digest to the mediator's queue id (sha256 of the qb64 text).
//  - The counterpart's identities are never this side's own (RLTP-VTI-1227): refused at construction.
//  - The wire of a displayed card's instance (TRANSPORT.md "The displayed card's instance", VTI 0.26
//    §1c) starts without a counterpart: it hands the adapter the payload of a TSP 1.0 `direct` message
//    from any sender to its connection DID and remembers that inner sender per frame (`senderOf`);
//    `bind` names the counterpart once the card's bundle was judged, and from then on 7140 holds as for
//    every other wire. It deposits nothing before it is bound.
//  - The only version check is the library's: MAJOR 1. No minor, no revision field is judged here.

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { authenticateToMediator, didKey, identityOfKid, MediatorSession, multibase } from '@openvtc/vti-didcomm-js'
import { cesr, decodeEnvelope, describeVersion, isRevisionError, pack as tspPack, packRouted, unpack as tspUnpack } from '@openvtc/vti-tsp-js'
import { CONNECTION_INFO_PREFIX, EGRESS_INFO_PREFIX, hkdf } from '@real-life/trust-protocol'
import { depositAddressing, WireError, type MediatorWire, type SendMode, type TokenSet } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { DeviceTimers } from './transport'

const te = new TextEncoder()
const hexOf = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
const b64u = (u8: Uint8Array) => {
  let bin = ''
  for (const b of u8) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** multihash(sha2-256) in base64url, as the library's carrier identity derivation (Identity §7a.4) */
const mh = async (bytes: Uint8Array) => {
  const d = await sha(bytes)
  const withPrefix = new Uint8Array(2 + d.length)
  withPrefix.set([0x12, 0x20])
  withPrefix.set(d, 2)
  return 'u' + b64u(withPrefix)
}

interface WireIdentity {
  readonly did: string
  readonly kid: string
  readonly edSecret: Uint8Array
  readonly edPublic: Uint8Array
  readonly xSecret: Uint8Array
  readonly xPublic: Uint8Array
}

const agreementKid = (did: string): string => {
  const doc = didKey.resolve(did).didDocument as { keyAgreement?: ({ id: string } | string)[] }
  const first = doc.keyAgreement?.[0]
  return typeof first === 'string' ? first : (first?.id ?? '')
}

async function wireIdentity(rootIkm: Uint8Array, carrier: string, nonce: Uint8Array, prefix: string): Promise<WireIdentity> {
  const info = prefix + (await mh(te.encode(carrier))) + (await mh(nonce))
  const edSecret = await hkdf(rootIkm, info)
  const edPublic = ed25519.getPublicKey(edSecret)
  const xSecret = ed25519.utils.toMontgomerySecret(edSecret)
  const xPublic = x25519.getPublicKey(xSecret)
  const did = `did:key:${multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPublic)}`
  return { did, kid: agreementKid(did), edSecret, edPublic, xSecret, xPublic }
}

/** The wire pair (connection, egress) of one relationship at one carrier, with the raw secrets: for
 *  tests and the mediator double, which act as the counterpart. */
export async function deriveWireIdentities(rootIkm: Uint8Array, carrier: string, nonce: Uint8Array) {
  return { conn: await wireIdentity(rootIkm, carrier, nonce, CONNECTION_INFO_PREFIX), egress: await wireIdentity(rootIkm, carrier, nonce, EGRESS_INFO_PREFIX) }
}

/** The public TSP keys of a did:key, resolved offline. */
export function peerKeys(did: string): { signPub: Uint8Array; encPub: Uint8Array } {
  const doc = didKey.resolve(did).didDocument as { verificationMethod?: { id: string; publicKeyMultibase: string }[] }
  const agreementId = agreementKid(did)
  const methods = doc.verificationMethod ?? []
  const agreement = methods.find((vm) => vm.id === agreementId)
  const signing = methods.find((vm) => vm.id !== agreementId)
  if (!agreement || !signing) throw new Error('not an Ed25519 did:key')
  return { signPub: multibase.decodeMultikey(signing.publicKeyMultibase).key, encPub: multibase.decodeMultikey(agreement.publicKeyMultibase).key }
}

/** A frame the wire did not hand to the adapter, or (`wire-deposit-refused`) the mediator's problem
 *  report on the send-only session, for the diagnostics: a code and the message type or the report's
 *  code, never an identifier, a key, free text or bytes. */
export interface WireRefusal {
  readonly code: 'wire-frame-refused' | 'wire-deposit-refused'
  readonly detail: string
  /** the envelope's sender where the frame names one: for the displayed card's instance and for a frame
   *  of another TSP version, whose refusals log it shortened through the error filter (never in `detail`) */
  readonly sender?: string
  /** the TSP version a frame declares that the wire does not speak (e.g. `Rev 3 (YTSP-AAC)`), as the
   *  library names it (RLTP-VTI-7140: logged with its version) */
  readonly version?: string
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The version and the sender of a frame the library refused for its version: the version from the
 *  refusal, the sender read from the cleartext envelope without the version gate (Rev 3 and 1.0 share
 *  the envelope layout). For the diagnostics only, never to open or route anything. */
function foreignVersion(qb2: Uint8Array, e: { major?: number | undefined; minor?: number | undefined }): { version: string; sender?: string } {
  const version = e.major !== undefined && e.minor !== undefined ? describeVersion(e.major, e.minor) : 'unknown'
  try {
    const cur = { pos: 0 }
    if (cesr.decodeCount(cesr.TSP_ETS_WRAPPER, qb2, cur) === undefined || cesr.readVersion(qb2, cur) === undefined) return { version }
    const sender = cesr.decodeVariableData(cesr.TSP_VID, qb2, cur)
    return sender === undefined || sender.length === 0 ? { version } : { version, sender: utf8.decode(sender) }
  } catch {
    return { version }
  }
}

/** The counterpart's two identities at this carrier, as its hint names them. */
export interface WirePeer {
  readonly connectionDid: string
  readonly egressDid: string
}

/** What the platform says of the network (NetworkPort.current). */
export type NetworkState = 'online' | 'offline' | 'unknown'

/** The socket of the connection DID: open, opening (first open or reconnect), or down. */
export type WireState = 'connected' | 'connecting' | 'unreachable'

export interface WireConfig {
  /** the 64-byte root IKM (the same the adapter factory takes) */
  readonly rootIkm: Uint8Array
  /** C, exactly as configured */
  readonly mediatorDid: string
  /** the relationship's carrier nonce N, 32 bytes */
  readonly nonce: Uint8Array
  /** the counterpart's connection DID: its hint's `id` without `#tsp` (RLTP-VTI-1240); absent, with
   *  `peerEgressDid`, for the wire of a displayed card's instance, bound later (`bind`) */
  readonly peerDid?: string
  /** the counterpart's egress identity: its hint's `rltpEgress` */
  readonly peerEgressDid?: string
  readonly clock: DeviceTimers
  readonly network?: () => NetworkState
  /** frames refused for good (diagnostics) */
  readonly report?: (r: WireRefusal) => void
  /** test seam: the network below (ATM HTTP, DID resolution, socket); omitted, the real ones.
   *  `policy` admits a plaintext or local mediator (a local 1.0 instance on `ws://127.0.0.1`) for the
   *  harness's live runs; no store build sets it, so the library's default holds there (wss, public) */
  readonly net?: {
    readonly fetch?: typeof fetch
    readonly resolve?: (did: string) => Promise<unknown>
    readonly WebSocketImpl?: unknown
    readonly policy?: { readonly allowInsecure?: boolean; readonly allowPrivate?: boolean }
  }
}

export interface VtiWire extends MediatorWire {
  readonly connectionDid: string
  readonly egressDid: string
  offline(): boolean
  queueEmpty(): boolean
  state(): WireState
  onState(cb: () => void): () => void
  /** the sizes and modes of the frames deposited so far (measurements) */
  sentFrames(): readonly { mode: SendMode; payload: number; inner: number; outer: number | null }[]
  /** ends the wire: its sockets close, no reconnect is planned */
  close(): void
  /** received frames on their way to the adapter and (re)connects running (tests, harness) */
  busy(): number
  /** the socket is down and the access token it would open with has expired: only a renewal by the
   *  adapter instance (`register`, which authenticates through this wire) brings it back */
  needsAuth(): boolean
  /** open the socket again now if it is down (the network came back); nothing while the token expired */
  resume(): void
  /** the counterpart, or null while the wire of a displayed card is not bound */
  peer(): WirePeer | null
  /** binds the wire of a displayed card to its counterpart (RLTP-VTI-1227 holds: never an own
   *  identity); from then on only frames of the counterpart's egress identity reach the adapter
   *  (RLTP-VTI-7140) and deposits go to its connection DID. A wire bound already refuses another peer. */
  bind(peer: WirePeer): void
  /** RLTP-VTI-3120: true from the moment the mediator's refusal of direct delivery
   *  (`e.p.direct_delivery.denied`) arrived on the egress session, until the wire ends */
  directRefused(): boolean
  /** the inner sender of a frame handed to the adapter, by the adapter's queue id (the payload
   *  digest), until the frame is acknowledged; null for one the wire does not know */
  senderOf(queueId: string): string | null
}

/** how long (device time) the socket must have been quiet before the queue counts as drained */
export const QUIET_MS = 1000
/** the reconnect backoff: from 50 ms, doubling, at most 30 s (device time) */
export const RECONNECT_MIN_MS = 50
export const RECONNECT_MAX_MS = 30_000

/** the session's options; `onError` is read by the session but missing from its declared type */
type SessionArgs = ConstructorParameters<typeof MediatorSession>[0]
type MediatorInfo = Awaited<ReturnType<typeof authenticateToMediator>>['mediator']

/** Delete-to-ack under the adapter's control: the stock session acks a TSP frame as soon as the
 *  consumer returns (with a session-level dedup); here the frame is only handed on and acked when the
 *  adapter concludes it. The adapter's registers own absorption, so the session's dedup goes too. */
class RltpMediatorSession extends MediatorSession {
  override async _dispatchTspFrame(qb2: Uint8Array, text: string): Promise<void> {
    const on = this.onTspFrame as ((qb2: Uint8Array, text: string) => Promise<void>) | undefined
    if (!on) return
    try {
      await on(qb2, text)
    } catch {
      // the dispatch reports its own refusals; a throw here leaves the frame unacked
    }
  }
  ackTsp(ids: string[]): Promise<void> {
    return this._ackReceived(ids)
  }
}

const PROBLEM_REPORT = 'https://didcomm.org/report-problem/2.0/problem-report'
/** the problem report of a mediator with local direct delivery off (mediator 0.45's default) */
export const DIRECT_DELIVERY_DENIED = 'e.p.direct_delivery.denied'
/** a report code as the diagnostics take it: the mediator's text is not trusted */
const reportCode = (c: unknown): string => (typeof c === 'string' && /^[a-z0-9._-]{1,64}$/.test(c) ? c : 'unknown')

/** The egress identity's send-only session (RLTP-VTI-3120): the socket opens without live delivery;
 *  it collects nothing and acknowledges nothing. The one frame it reads is the mediator's own problem
 *  report, how a mediator refuses a deposit on this session; its code goes to `onRefusal`. */
class SendOnlySession extends MediatorSession {
  onRefusal: ((code: string) => void) | null = null
  override async connect(): Promise<void> {
    await this._openSocket()
  }
  override async _dispatchTspFrame(): Promise<void> {}
  override async _dispatchFrame(result: { senderDid?: string; message?: { type?: string; body?: { code?: unknown } } }): Promise<void> {
    const m = result.message
    if (result.senderDid === identityOfKid(this.mediator.did) && m?.type === PROBLEM_REPORT) this.onRefusal?.(reportCode(m.body?.code))
  }
  override _ackReceived(): Promise<void> {
    return Promise.resolve()
  }
}

/** One identity's session at the mediator: the token it holds, the socket it opens. */
interface SessionUnit<S extends MediatorSession> {
  /** the ATM handshake, then the socket: offline nothing, after a failure the backoff, closed after
   *  every step; a socket that fails after a valid handshake backs off, the token stands */
  authenticate(): Promise<TokenSet>
  /** the open session, now: a closed one is reopened in the background and this call fails as
   *  unreachable (a send on a closed socket would vanish without an error) */
  open(): S
  /** the open session, waited for: an expired or missing token is renewed, a closed socket reopened */
  ensure(): Promise<S>
  readonly session: () => S | null
  readonly mediator: () => MediatorInfo | null
  /** the socket is down and the token it would open with has expired */
  needsAuth(): boolean
  resume(): void
  busy(): number
  close(): void
}

export async function createVtiWire(cfg: WireConfig): Promise<VtiWire> {
  const conn = await wireIdentity(cfg.rootIkm, cfg.mediatorDid, cfg.nonce, CONNECTION_INFO_PREFIX)
  const egress = await wireIdentity(cfg.rootIkm, cfg.mediatorDid, cfg.nonce, EGRESS_INFO_PREFIX)
  const own = new Set([conn.did, egress.did])
  /** the counterpart: its identities and keys; null while the wire of a displayed card is not bound */
  let peer: { readonly ids: WirePeer; readonly encPub: Uint8Array; readonly signPub: Uint8Array } | null = null
  const toPeer = (p: WirePeer) => {
    // the counterpart's identities are never this side's own (RLTP-VTI-1227)
    if (own.has(p.connectionDid) || own.has(p.egressDid)) throw new Error("a counterpart identity names one of this side's own wire identities (RLTP-VTI-1227)")
    return { ids: { connectionDid: p.connectionDid, egressDid: p.egressDid }, encPub: peerKeys(p.connectionDid).encPub, signPub: peerKeys(p.egressDid).signPub }
  }
  if ((cfg.peerDid === undefined) !== (cfg.peerEgressDid === undefined)) throw new Error('a counterpart names both identities or none')
  if (cfg.peerDid !== undefined && cfg.peerEgressDid !== undefined) peer = toPeer({ connectionDid: cfg.peerDid, egressDid: cfg.peerEgressDid })
  const { clock } = cfg
  const WebSocketImpl = (cfg.net?.WebSocketImpl ?? globalThis.WebSocket) as typeof WebSocket
  const netPolicy = cfg.net?.policy ? { allowInsecure: Boolean(cfg.net.policy.allowInsecure), allowPrivate: Boolean(cfg.net.policy.allowPrivate) } : undefined
  const atmSeams = { ...(cfg.net?.fetch ? { fetch: cfg.net.fetch } : {}), ...(cfg.net?.resolve ? { resolve: cfg.net.resolve } : {}), ...(netPolicy ? { netPolicy } : {}) }
  const refuse = (detail: string, sender?: string) => cfg.report?.({ code: 'wire-frame-refused', detail, ...(sender !== undefined ? { sender } : {}) })
  const network = () => cfg.network?.() ?? 'unknown'
  let closed = false
  const backoffMs = (n: number) => Math.min(RECONNECT_MIN_MS * 2 ** n, RECONNECT_MAX_MS)

  /** The session lifecycle, one for both identities (the connection DID with pickup and live delivery,
   *  the egress identity send-only): token lifetime, renewal only online, the backoff of handshakes and
   *  sockets on the device clock, `closed` after every await. The two differ only in the session they
   *  build (`make`) and in what an open or a drop means to the wire (`opened`, `state`). */
  function sessionUnit<S extends MediatorSession>(id: WireIdentity, make: (mediator: MediatorInfo, jwt: string, unit: { scheduleReconnect(): void }) => S, on: { opened?(): void; state?(s: WireState): void } = {}): SessionUnit<S> {
    let session: S | null = null
    let mediator: MediatorInfo | null = null
    let tokens: TokenSet | null = null
    let authing: Promise<TokenSet> | null = null
    let reconnecting: Promise<void> | null = null
    let reconnectTimer: (() => void) | null = null
    let backoff = 0
    let authBackoff = 0
    let authBlockedUntil = Number.NEGATIVE_INFINITY
    const stale = () => tokens !== null && clock.now() >= tokens.accessExpiresAt
    const state = (s: WireState) => on.state?.(s)
    const opened = () => {
      backoff = 0
      state('connected')
      on.opened?.()
    }
    const reconnect = (): Promise<void> => {
      if (session?.isOpen) return Promise.resolve()
      if (!session || closed) return Promise.reject(new WireError('unreachable', 'no session'))
      // never an upgrade with an expired token (the mediator refuses it, 1006); offline, nothing
      if (stale() || network() === 'offline') {
        state('unreachable')
        return Promise.reject(new WireError('unreachable', stale() ? 'token expired' : 'offline'))
      }
      state('connecting')
      const s = session
      reconnecting ??= s
        .connect()
        .then(
          () => {
            if (closed) s.close()
            else opened()
          },
          (e: unknown) => {
            state('unreachable')
            throw e
          },
        )
        .finally(() => {
          reconnecting = null
        })
      return reconnecting
    }
    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return
      state(session?.isOpen ? 'connected' : 'unreachable')
      // the backoff runs only while a reconnect can succeed: an expired token waits for the renewal,
      // offline waits for resume()
      if (session?.isOpen || stale() || network() === 'offline') return
      const delay = backoffMs(backoff)
      backoff++
      reconnectTimer = clock.setTimer(clock.now() + delay, () => {
        reconnectTimer = null
        reconnect().catch(() => scheduleReconnect())
      })
    }
    const handshake = async (): Promise<TokenSet> => {
      if (closed) throw new WireError('unreachable', 'closed')
      // offline nothing is tried; after a failure the next try waits for its turn: `unreachable`, no call
      if (network() === 'offline') throw new WireError('unreachable', 'offline')
      if (clock.now() < authBlockedUntil) throw new WireError('unreachable', 'authentication backs off')
      let auth
      try {
        auth = await authenticateToMediator({ mediatorDid: cfg.mediatorDid, clientDid: id.did, clientX25519Private: id.xSecret, clientX25519Public: id.xPublic, ...atmSeams })
      } catch (e) {
        authBlockedUntil = clock.now() + backoffMs(authBackoff)
        authBackoff++
        if (!session?.isOpen) state('unreachable')
        throw new WireError('unreachable', e instanceof Error ? e.message : 'auth')
      }
      authBackoff = 0
      authBlockedUntil = Number.NEGATIVE_INFINITY
      // closed while the handshake ran: no session, no socket of an ended wire (LIFECYCLE.md #428)
      if (closed) throw new WireError('unreachable', 'closed')
      mediator = auth.mediator
      tokens = {
        accessToken: auth.accessToken,
        accessExpiresAt: (auth.accessExpiresAt ?? 0) * 1000 || clock.now() + 600_000,
        refreshToken: auth.refreshToken ?? '',
        refreshExpiresAt: (auth.refreshExpiresAt ?? 0) * 1000 || clock.now() + 86_400_000,
      }
      if (session) {
        // a renewal: the session's own traffic and its next reconnect use what was just resolved;
        // a failing socket backs off, it never refuses the token
        session.mediator = auth.mediator as never
        session.mediatorJwt = auth.accessToken
        if (!session.isOpen) await reconnect().catch(() => scheduleReconnect())
        return tokens
      }
      const s = make(auth.mediator, auth.accessToken, { scheduleReconnect })
      session = s
      state('connecting')
      try {
        await s.connect()
        // closed while the socket opened: it closes again at once
        if (closed) s.close()
        else opened()
      } catch {
        // a socket that fails after a valid handshake is a connection failure, not an
        // authentication failure: the token stands, the reconnect backs off
        state('unreachable')
        scheduleReconnect()
      }
      return tokens
    }
    const authenticate = (): Promise<TokenSet> => {
      authing ??= handshake().finally(() => {
        authing = null
      })
      return authing
    }
    return {
      authenticate,
      open() {
        if (session?.isOpen) return session
        // a reconnect now, unless the backoff holds one back already
        if (session && !reconnectTimer) reconnect().catch(() => scheduleReconnect())
        throw new WireError('unreachable', 'the socket is closed')
      },
      async ensure() {
        if (!tokens || stale() || !session) await authenticate()
        else if (!session.isOpen) {
          if (reconnectTimer) throw new WireError('unreachable', 'the reconnect backs off')
          await reconnect().catch((e: unknown) => {
            scheduleReconnect()
            throw e
          })
        }
        if (closed || !session?.isOpen) throw new WireError('unreachable', 'the socket is closed')
        return session
      },
      session: () => session,
      mediator: () => mediator,
      needsAuth: () => !closed && session !== null && !session.isOpen && stale(),
      resume() {
        if (closed || !session || session.isOpen) return
        backoff = 0
        reconnect().catch(() => scheduleReconnect())
      },
      busy: () => (reconnecting ? 1 : 0) + (authing ? 1 : 0),
      close() {
        reconnectTimer?.()
        reconnectTimer = null
        try {
          session?.close()
        } catch {
          // teardown
        }
      },
    }
  }

  let consumer: ((bytes: Uint8Array) => Promise<boolean>) | null = null
  /** payload digest (the adapter's queue id) → the mediator's queue id */
  const ackMap = new Map<string, string>()
  /** payload digest → the inner sender, for the frames handed to the adapter (`senderOf`) */
  const senders = new Map<string, string>()
  let dispatching = 0
  let lastFrameAt = 0
  /** a frame the adapter did not take since the socket last opened: it waits at the mediator, which
   *  offers it again at the next open; until then the queue is not empty (fail-safe) */
  let leftBehind = false
  let state: WireState = 'connecting'
  const watchers = new Set<() => void>()
  const setState = (st: WireState) => {
    if (state === st) return
    state = st
    for (const w of [...watchers]) w()
  }

  async function dispatchFrame(s: RltpMediatorSession, qb2: Uint8Array, text: string) {
    if (!consumer) return
    const mediatorQid = hexOf(await sha(te.encode(text)))
    // the sender the frame must come from: the counterpart's egress identity; before a displayed card's
    // wire is bound, the sender the envelope names (its did:key carries its key), never an own identity
    const p = peer
    const sender = p ? p.ids.egressDid : decodeEnvelope(qb2).envelope.sender
    if (own.has(sender)) throw new Error('other relationship')
    // the library opens TSP 1.0 only (another version throws before any key is touched) and refuses a
    // confidential payload without the sender VID
    const got = await tspUnpack(qb2, { receiverDecryptionKey: conn.xSecret, senderSigningKey: p ? p.signPub : peerKeys(sender).signPub })
    if (got.sender !== sender || got.receiver !== conn.did) throw new Error('other relationship')
    const drop = async (what: string) => {
      refuse(what, p ? undefined : sender)
      await s.ackTsp([mediatorQid])
    }
    if (got.messageType === 'control') return drop(`control/${got.control?.controlType ?? 'unknown'}`)
    if (got.messageType !== 'direct') return drop(`type/${String(got.messageType)}`)
    if (got.payload.length === 0) return drop('direct/empty')
    const payload = new Uint8Array(got.payload)
    const digest = hexOf(await sha(payload))
    ackMap.set(digest, mediatorQid)
    senders.set(digest, sender)
    // the adapter's own failure is no refusal of the frame: unacked, offered again
    let took: boolean
    try {
      took = await consumer(payload)
    } catch (e) {
      throw Object.assign(new Error('consumer failed'), { consumer: true, cause: e })
    }
    if (!took) leftBehind = true
  }

  /** the connection DID: pickup and live delivery; its drops and opens are the wire's state */
  const connection = sessionUnit<RltpMediatorSession>(
    conn,
    (mediator, jwt, unit) => {
      const s: RltpMediatorSession = new RltpMediatorSession({
        mediator: mediator as never,
        mediatorJwt: jwt,
        client: { did: conn.did, kid: conn.kid, privateKey: conn.xSecret, publicKey: conn.xPublic },
        WebSocketImpl: WebSocketImpl as never,
        ...(netPolicy ? { netPolicy } : {}),
        onTspFrame: (async (qb2: Uint8Array, text: string) => {
          lastFrameAt = clock.now()
          dispatching++
          try {
            await dispatchFrame(s, qb2, text)
          } catch (e) {
            if ((e as { consumer?: boolean }).consumer) {
              leftBehind = true
              return
            }
            // a frame that cannot be opened, of another TSP version, from another sender or for another
            // relationship: refused for good, reported and acked so it leaves the queue (RLTP-VTI-7140)
            if (isRevisionError(e)) {
              const f = foreignVersion(qb2, e)
              cfg.report?.({ code: 'wire-frame-refused', detail: `frame/version ${f.version}`, version: f.version, ...(f.sender !== undefined ? { sender: f.sender } : {}) })
            } else {
              let kind = 'unreadable'
              let from: string | undefined
              try {
                from = decodeEnvelope(qb2).envelope.sender
                kind = (e as Error).message === 'other relationship' ? 'foreign' : 'unopenable'
              } catch {
                // undecodable
              }
              refuse(`frame/${kind}`, from)
            }
            try {
              await s.ackTsp([hexOf(await sha(te.encode(text)))])
            } catch {
              // the next delivery covers it again
            }
          } finally {
            dispatching--
            lastFrameAt = clock.now()
          }
        }) as never,
        // the default sink logs a frame fingerprint to the console; the wire reports its own refusals
        onError: () => undefined,
        onClose: () => unit.scheduleReconnect(),
      } as SessionArgs)
      return s
    },
    {
      opened() {
        lastFrameAt = clock.now()
        leftBehind = false
      },
      state: setState,
    },
  )
  /** the egress identity: send-only, opened at the first deposit in egress-session (RLTP-VTI-3120) */
  /** the mediator refused direct delivery on the egress session: from then on every deposit in
   *  egress-session fails as a retriable carrier refusal, for the life of this wire (the switch to
   *  egress-session is one-way, RLTP-VTI-3130) */
  let egressRefused = false
  const egressUnit = sessionUnit<SendOnlySession>(
    egress,
    (mediator, jwt, unit) => {
      const s = new SendOnlySession({
        mediator: mediator as never,
        mediatorJwt: jwt,
        client: { did: egress.did, kid: egress.kid, privateKey: egress.xSecret, publicKey: egress.xPublic },
        WebSocketImpl: WebSocketImpl as never,
        ...(netPolicy ? { netPolicy } : {}),
        onError: () => undefined,
        onClose: () => unit.scheduleReconnect(),
      } as SessionArgs)
      s.onRefusal = (code) => {
        if (code === DIRECT_DELIVERY_DENIED) egressRefused = true
        cfg.report?.({ code: 'wire-deposit-refused', detail: `egress/${code}${code === DIRECT_DELIVERY_DENIED ? ' locked' : ''}` })
      }
      return s
    },
  )

  const sent: { mode: SendMode; payload: number; inner: number; outer: number | null }[] = []

  return {
    connectionDid: conn.did,
    egressDid: egress.did,
    // the ATM handshake is one call in vti-didcomm-js; the adapter's two steps get a staged marker
    authChallenge: async () => ({ challenge: 'vti-staged', sessionId: 'vti-staged' }),
    authenticate: () => connection.authenticate(),
    // a renewal is the handshake again
    refresh: () => connection.authenticate(),
    // the mediator routes on the envelope receiver; a did:key client needs no keylist (Open Issue 5)
    keylistUpdate: async () => undefined,
    async deposit(_token, bytes, egressDid, mode) {
      if (closed) throw new WireError('unreachable', 'closed')
      if (egressDid !== egress.did) throw new Error('deposit under a foreign egress identity')
      // a displayed card's wire deposits nothing before it is bound: it has no counterpart to address
      const p = peer
      if (!p) throw new WireError('unreachable', 'no counterpart bound')
      // the mediator refused direct delivery on the egress session: the adapter records it (never unreachable)
      if (mode === 'egress-session' && egressRefused) throw new WireError('direct-refused', `the mediator refuses direct delivery (${DIRECT_DELIVERY_DENIED})`)
      const addr = depositAddressing(mode, { connection: conn.did, egress: egress.did }, p.ids.connectionDid, cfg.mediatorDid)
      // the session first: a deposit that cannot go out now costs no packing (the HPKE and the
      // signatures of both layers are the expensive part of an attempt)
      const egressSession = addr.outer ? null : await egressUnit.ensure()
      if (addr.outer) connection.open()
      const inner = await tspPack(bytes, addr.inner.sender, addr.inner.receiver, { senderSigningKey: egress.edSecret, receiverEncryptionKey: p.encPub })
      if (addr.outer) {
        // C's key as resolved at the last authentication or renewal (RLTP-VTI-7120)
        const mediator = connection.mediator()
        if (!mediator) throw new WireError('unreachable', 'not authenticated')
        const outer = await packRouted(inner.bytes, [...(addr.outer.route ?? [])], addr.outer.sender, addr.outer.receiver, { senderSigningKey: conn.edSecret, receiverEncryptionKey: mediator.x25519Pub })
        // checked again right before the send: the socket may have closed while packing
        connection.open().sendBinary(outer.bytes)
        sent.push({ mode, payload: bytes.length, inner: inner.bytes.length, outer: outer.bytes.length })
        return
      }
      // checked again right before the send: the socket may have closed while packing
      if (closed || !egressSession?.isOpen) throw new WireError('unreachable', "the egress identity's socket is closed")
      egressSession.sendBinary(inner.bytes)
      sent.push({ mode, payload: bytes.length, inner: inner.bytes.length, outer: null })
    },
    async ackReceived(_token, queueIds) {
      const ids = queueIds.map((q) => ackMap.get(q)).filter((x): x is string => x !== undefined)
      if (ids.length === 0) return
      const s = connection.open()
      await s.ackTsp(ids)
      // the socket may have died while the ack was sent: fail, the intent stays
      if (!s.isOpen) connection.open()
      for (const q of queueIds) {
        ackMap.delete(q)
        senders.delete(q)
      }
    },
    onDeliver(cb) {
      consumer = cb
    },
    offline: () => network() === 'offline',
    queueEmpty: () => Boolean(connection.session()?.isOpen) && dispatching === 0 && !leftBehind && clock.now() - lastFrameAt >= QUIET_MS,
    state: () => (closed ? 'unreachable' : state),
    onState(cb) {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
    // RLTP-VTI-3120: from the moment the mediator's refusal of direct delivery arrived on the egress session
    directRefused: () => egressRefused,
    sentFrames: () => sent.map((f) => ({ ...f })),
    busy: () => dispatching + connection.busy() + egressUnit.busy(),
    needsAuth: () => connection.needsAuth(),
    peer: () => (peer ? { ...peer.ids } : null),
    bind(p) {
      if (peer) {
        if (peer.ids.connectionDid === p.connectionDid && peer.ids.egressDid === p.egressDid) return
        throw new Error('the wire is bound to another counterpart')
      }
      peer = toPeer(p)
    },
    senderOf: (q) => senders.get(q) ?? null,
    resume() {
      connection.resume()
      egressUnit.resume()
    },
    close() {
      closed = true
      connection.close()
      egressUnit.close()
      watchers.clear()
    },
  }
}
