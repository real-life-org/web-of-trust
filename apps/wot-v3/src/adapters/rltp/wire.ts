// The wire under the VTI mediator adapter (VTI Mediator Adapter Profile 0.25 §3a, §7): the
// MediatorWire of @real-life/trust-protocol/adapters/vti-mediator over vti-didcomm-js 0.12.0 and
// vti-tsp-js 0.3.0, TSP Rev 3 (HPKE-Base, outer signature). A port of trust-protocol
// binding/vti-wire.mjs for the browser: globalThis.WebSocket (the bearer token travels as a
// subprotocol), WebCrypto, the device clock for every delay (#430), the platform's network state for
// `offline()`. One wire belongs to one adapter instance: one relationship, one side, one opening.
//
//  - The wire identities' raw seeds come from the library's own HKDF with the same info prefixes, so
//    the DIDs are byte-identical to the adapter's trio (the library keeps its keys non-extractable).
//  - ATM authentication under the connection DID, one pickup socket.
//  - deposit(token, bytes, egressDid, mode), packed anew for every attempt (RLTP-VTI-7110), the
//    addressing from the library's depositAddressing:
//      routed          inner Rev 3 `direct` egress identity → the counterpart's connection DID,
//                      inside an outer routed message connection DID → C with the route
//                      [counterpart's connection DID], sealed to the key C's DID document names first
//                      under keyAgreement, as resolved at the last authentication or renewal
//                      (RLTP-VTI-7120); sent on the connection DID's session
//      egress-session  the inner message alone, on a send-only session of the egress identity,
//                      authenticated at the first deposit in this mode (RLTP-VTI-3120)
//  - onDeliver hands the adapter only the payload of a Rev 3 `direct` message with a non-empty
//    payload from the counterpart's egress identity to the own connection DID (RLTP-VTI-7140), byte
//    for byte; everything else is reported (code and message type, no identifiers) and acked.
//  - Delete-to-ack is the adapter's: a frame is acked when the adapter concludes it, translated from
//    the payload digest to the mediator's queue id (sha256 of the qb64 text).
//  - The counterpart's identities are never this side's own (RLTP-VTI-1227): refused at construction.

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { authenticateToMediator, didKey, MediatorSession, multibase } from '@openvtc/vti-didcomm-js'
import { decodeEnvelope, pack as tspPack, packRouted, unpack as tspUnpack } from '@openvtc/vti-tsp-js'
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

/** A frame the wire did not hand to the adapter, for the diagnostics: a code and the message type,
 *  never an identifier, a key or bytes. */
export interface WireRefusal {
  readonly code: 'wire-frame-refused'
  readonly detail: string
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
  /** the counterpart's connection DID: its hint's `id` without `#tsp` (RLTP-VTI-1240) */
  readonly peerDid: string
  /** the counterpart's egress identity: its hint's `rltpEgress` */
  readonly peerEgressDid: string
  readonly clock: DeviceTimers
  readonly network?: () => NetworkState
  /** frames refused for good (diagnostics) */
  readonly report?: (r: WireRefusal) => void
  /** test seam: the network below (ATM HTTP, DID resolution, socket); omitted, the real ones */
  readonly net?: { readonly fetch?: typeof fetch; readonly resolve?: (did: string) => Promise<unknown>; readonly WebSocketImpl?: unknown }
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

/** The egress identity's send-only session (RLTP-VTI-3120): the socket opens without live delivery,
 *  every inbound frame is dropped unhandled; nothing is collected, nothing acknowledged. */
class SendOnlySession extends MediatorSession {
  override async connect(): Promise<void> {
    await this._openSocket()
  }
  override async _onFrame(): Promise<void> {}
}

export async function createVtiWire(cfg: WireConfig): Promise<VtiWire> {
  const conn = await wireIdentity(cfg.rootIkm, cfg.mediatorDid, cfg.nonce, CONNECTION_INFO_PREFIX)
  const egress = await wireIdentity(cfg.rootIkm, cfg.mediatorDid, cfg.nonce, EGRESS_INFO_PREFIX)
  // the counterpart's identities are never this side's own (RLTP-VTI-1227)
  const own = new Set([conn.did, egress.did])
  if (own.has(cfg.peerDid) || own.has(cfg.peerEgressDid)) throw new Error("a counterpart identity names one of this side's own wire identities (RLTP-VTI-1227)")
  const peerConn = peerKeys(cfg.peerDid)
  const peerSender = peerKeys(cfg.peerEgressDid)
  const { clock } = cfg
  const WebSocketImpl = (cfg.net?.WebSocketImpl ?? globalThis.WebSocket) as typeof WebSocket
  const atmSeams = { ...(cfg.net?.fetch ? { fetch: cfg.net.fetch } : {}), ...(cfg.net?.resolve ? { resolve: cfg.net.resolve } : {}) }
  const refuse = (detail: string) => cfg.report?.({ code: 'wire-frame-refused', detail })

  let session: RltpMediatorSession | null = null
  let consumer: ((bytes: Uint8Array) => Promise<boolean>) | null = null
  /** payload digest (the adapter's queue id) → the mediator's queue id */
  const ackMap = new Map<string, string>()
  let dispatching = 0
  let lastFrameAt = 0
  /** a frame the adapter did not take since the socket last opened: it waits at the mediator, which
   *  offers it again at the next open; until then the queue is not empty (fail-safe) */
  let leftBehind = false
  let closed = false
  let state: WireState = 'connecting'
  const watchers = new Set<() => void>()
  const setState = (s: WireState) => {
    if (state === s) return
    state = s
    for (const w of [...watchers]) w()
  }

  let reconnecting: Promise<void> | null = null
  let reconnectTimer: (() => void) | null = null
  let backoff = 0
  /** when the access token of the connection DID's session expires (device time) */
  let tokenExpiresAt = Number.POSITIVE_INFINITY
  const stale = () => clock.now() >= tokenExpiresAt
  const opened = () => {
    lastFrameAt = clock.now()
    leftBehind = false
    backoff = 0
    setState('connected')
  }
  const reconnect = (): Promise<void> => {
    if (session?.isOpen) return Promise.resolve()
    if (!session || closed) return Promise.reject(new WireError('unreachable', 'no session'))
    // never an upgrade with an expired token (the mediator refuses it, 1006): the adapter renews it,
    // and its authentication through this wire reopens the socket; offline, nothing is tried
    if (stale() || network() === 'offline') {
      setState('unreachable')
      return Promise.reject(new WireError('unreachable', stale() ? 'token expired' : 'offline'))
    }
    setState('connecting')
    reconnecting ??= session
      .connect()
      .then(opened, (e: unknown) => {
        setState('unreachable')
        throw e
      })
      .finally(() => {
        reconnecting = null
      })
    return reconnecting
  }
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return
    setState(session?.isOpen ? 'connected' : 'unreachable')
    // the backoff runs only while a reconnect can succeed: an expired token waits for the renewal,
    // offline waits for resume()
    if (session?.isOpen || stale() || network() === 'offline') return
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** backoff, RECONNECT_MAX_MS)
    backoff++
    reconnectTimer = clock.setTimer(clock.now() + delay, () => {
      reconnectTimer = null
      reconnect().catch(() => scheduleReconnect())
    })
  }
  /** the connection DID's session, open; a closed one is reopened in the background and this call
   *  fails as unreachable (a send on a closed socket would vanish without an error) */
  const openSession = (): RltpMediatorSession => {
    if (session?.isOpen) return session
    if (session) reconnect().catch(() => scheduleReconnect())
    throw new WireError('unreachable', "the connection DID's socket is closed")
  }

  async function dispatchFrame(s: RltpMediatorSession, qb2: Uint8Array, text: string) {
    if (!consumer) return
    const mediatorQid = hexOf(await sha(te.encode(text)))
    const got = await tspUnpack(qb2, { receiverDecryptionKey: conn.xSecret, senderSigningKey: peerSender.signPub })
    if (got.revision !== 'rev3') throw new Error('not rev3')
    if (got.sender !== cfg.peerEgressDid || got.receiver !== conn.did) throw new Error('other relationship')
    const drop = async (what: string) => {
      refuse(what)
      await s.ackTsp([mediatorQid])
    }
    if (got.messageType === 'control') return drop(`control/${got.control?.controlType ?? 'unknown'}`)
    if (got.messageType !== 'direct') return drop(`type/${String(got.messageType)}`)
    if (got.payload.length === 0) return drop('direct/empty')
    const payload = new Uint8Array(got.payload)
    ackMap.set(hexOf(await sha(payload)), mediatorQid)
    // the adapter's own failure is no refusal of the frame: unacked, offered again
    let took: boolean
    try {
      took = await consumer(payload)
    } catch (e) {
      throw Object.assign(new Error('consumer failed'), { consumer: true, cause: e })
    }
    if (!took) leftBehind = true
  }

  async function ensureSession(accessToken: string, mediator: MediatorInfo) {
    if (session) return session
    const s = new RltpMediatorSession({
      mediator: mediator as never,
      mediatorJwt: accessToken,
      client: { did: conn.did, kid: conn.kid, privateKey: conn.xSecret, publicKey: conn.xPublic },
      WebSocketImpl: WebSocketImpl as never,
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
          // a frame that cannot be opened, from another sender or for another relationship: refused for
          // good, reported and acked so it leaves the queue (RLTP-VTI-7140)
          let kind = 'unreadable'
          try {
            decodeEnvelope(qb2)
            kind = (e as Error).message === 'other relationship' ? 'foreign' : 'unopenable'
          } catch {
            // undecodable
          }
          refuse(`frame/${kind}`)
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
      onClose: () => scheduleReconnect(),
    } as SessionArgs)
    session = s
    setState('connecting')
    try {
      await s.connect()
      // closed while the socket opened: it closes again at once
      if (closed) {
        s.close()
        return s
      }
      opened()
    } catch {
      // a socket that fails after a valid authentication is a connection failure, not an
      // authentication failure: the token stands, the reconnect backs off on the device clock
      setState('unreachable')
      scheduleReconnect()
    }
    return s
  }

  /** C's key as resolved at the last authentication or renewal (RLTP-VTI-7120) */
  let mediatorInfo: MediatorInfo | null = null
  let egressSession: SendOnlySession | null = null
  let egressAuthing: Promise<SendOnlySession> | null = null
  let egressExpiresAt = 0
  const ensureEgressSession = (): Promise<SendOnlySession> => {
    if (egressSession?.isOpen && clock.now() < egressExpiresAt) return Promise.resolve(egressSession)
    egressAuthing ??= (async () => {
      try {
        egressSession?.close()
      } catch {
        // replaced below
      }
      egressSession = null
      const auth = await authenticateToMediator({ mediatorDid: cfg.mediatorDid, clientDid: egress.did, clientX25519Private: egress.xSecret, clientX25519Public: egress.xPublic, ...atmSeams })
      egressExpiresAt = (auth.accessExpiresAt ?? 0) * 1000 || clock.now() + 600_000
      const s = new SendOnlySession({
        mediator: auth.mediator as never,
        mediatorJwt: auth.accessToken,
        client: { did: egress.did, kid: egress.kid, privateKey: egress.xSecret, publicKey: egress.xPublic },
        WebSocketImpl: WebSocketImpl as never,
        onError: () => undefined,
      } as SessionArgs)
      await s.connect()
      if (closed) {
        s.close()
        throw new WireError('unreachable', 'closed')
      }
      egressSession = s
      return s
    })().finally(() => {
      egressAuthing = null
    })
    return egressAuthing
  }

  const sent: { mode: SendMode; payload: number; inner: number; outer: number | null }[] = []
  const network = () => cfg.network?.() ?? 'unknown'

  /** a failed authentication holds the next one back, with the reconnect's backoff (device time) */
  let authBlockedUntil = Number.NEGATIVE_INFINITY
  let authBackoff = 0
  const authenticate = async (): Promise<TokenSet> => {
    if (closed) throw new WireError('unreachable', 'closed')
    // offline nothing is tried; after a failure the next try waits for its turn: `unreachable`, no call
    if (network() === 'offline') throw new WireError('unreachable', 'offline')
    if (clock.now() < authBlockedUntil) throw new WireError('unreachable', 'authentication backs off')
    let auth
    try {
      auth = await authenticateToMediator({ mediatorDid: cfg.mediatorDid, clientDid: conn.did, clientX25519Private: conn.xSecret, clientX25519Public: conn.xPublic, ...atmSeams })
    } catch (e) {
      authBlockedUntil = clock.now() + Math.min(RECONNECT_MIN_MS * 2 ** authBackoff, RECONNECT_MAX_MS)
      authBackoff++
      if (!session?.isOpen) setState('unreachable')
      throw new WireError('unreachable', e instanceof Error ? e.message : 'auth')
    }
    authBackoff = 0
    authBlockedUntil = Number.NEGATIVE_INFINITY
    // closed while the handshake ran: no session, no socket of an ended wire (LIFECYCLE.md #428)
    if (closed) throw new WireError('unreachable', 'closed')
    mediatorInfo = auth.mediator
    tokenExpiresAt = (auth.accessExpiresAt ?? 0) * 1000 || clock.now() + 600_000
    if (session) {
      // a renewal: the session's own traffic and its next reconnect use what was just resolved
      session.mediator = auth.mediator as never
      session.mediatorJwt = auth.accessToken
      // the token is renewed whatever the socket does: a failing socket backs off, never refuses the token
      if (!session.isOpen) await reconnect().catch(() => scheduleReconnect())
    }
    await ensureSession(auth.accessToken, auth.mediator)
    return {
      accessToken: auth.accessToken,
      accessExpiresAt: tokenExpiresAt,
      refreshToken: auth.refreshToken ?? '',
      refreshExpiresAt: (auth.refreshExpiresAt ?? 0) * 1000 || clock.now() + 86_400_000,
    }
  }

  return {
    connectionDid: conn.did,
    egressDid: egress.did,
    // the ATM handshake is one call in vti-didcomm-js; the adapter's two steps get a staged marker
    authChallenge: async () => ({ challenge: 'vti-staged', sessionId: 'vti-staged' }),
    authenticate,
    // a renewal is the handshake again
    refresh: () => authenticate(),
    // the mediator routes on the envelope receiver; a did:key client needs no keylist (Open Issue 5)
    keylistUpdate: async () => undefined,
    async deposit(_token, bytes, egressDid, mode) {
      if (closed) throw new WireError('unreachable', 'closed')
      if (egressDid !== egress.did) throw new Error('deposit under a foreign egress identity')
      const addr = depositAddressing(mode, { connection: conn.did, egress: egress.did }, cfg.peerDid, cfg.mediatorDid)
      const inner = await tspPack(bytes, addr.inner.sender, addr.inner.receiver, { senderSigningKey: egress.edSecret, receiverEncryptionKey: peerConn.encPub })
      if (addr.outer) {
        if (!mediatorInfo) throw new WireError('unreachable', 'not authenticated')
        openSession()
        const outer = await packRouted(inner.bytes, [...(addr.outer.route ?? [])], addr.outer.sender, addr.outer.receiver, { senderSigningKey: conn.edSecret, receiverEncryptionKey: mediatorInfo.x25519Pub })
        // checked again right before the send: the socket may have closed while packing
        openSession().sendBinary(outer.bytes)
        sent.push({ mode, payload: bytes.length, inner: inner.bytes.length, outer: outer.bytes.length })
        return
      }
      const s = await ensureEgressSession()
      if (!s.isOpen) throw new WireError('unreachable', "the egress identity's socket is closed")
      s.sendBinary(inner.bytes)
      sent.push({ mode, payload: bytes.length, inner: inner.bytes.length, outer: null })
    },
    async ackReceived(_token, queueIds) {
      const ids = queueIds.map((q) => ackMap.get(q)).filter((x): x is string => x !== undefined)
      if (ids.length === 0) return
      const s = openSession()
      await s.ackTsp(ids)
      // the socket may have died while the ack was sent: fail, the intent stays
      if (!s.isOpen) openSession()
      for (const q of queueIds) ackMap.delete(q)
    },
    onDeliver(cb) {
      consumer = cb
    },
    offline: () => network() === 'offline',
    queueEmpty: () => Boolean(session?.isOpen) && dispatching === 0 && !leftBehind && clock.now() - lastFrameAt >= QUIET_MS,
    state: () => (closed ? 'unreachable' : state),
    onState(cb) {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
    sentFrames: () => sent.map((f) => ({ ...f })),
    busy: () => dispatching + (reconnecting ? 1 : 0) + (egressAuthing ? 1 : 0),
    needsAuth: () => !closed && session !== null && !session.isOpen && stale(),
    resume() {
      if (closed || !session || session.isOpen) return
      backoff = 0
      reconnect().catch(() => scheduleReconnect())
    },
    close() {
      closed = true
      reconnectTimer?.()
      reconnectTimer = null
      try {
        session?.close()
      } catch {
        // teardown
      }
      try {
        egressSession?.close()
      } catch {
        // teardown
      }
      watchers.clear()
    },
  }
}
