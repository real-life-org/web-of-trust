// The wire of one shared-connect enactment (shared-connect 0.1, interop/ceremonies/shared-connect.ceremony.json;
// lib 0.16.0 `shared-connect-holder`): a TSP 1.0 session at the build's mediator under the
// enactment's messaging identity, the did:peer:2 the holder put into the link (`sharedconnect.shown`)
// or read from it (`sharedconnect.proposed`). It carries frames, nothing else: every document that
// arrives goes to the holder (`sharedConnectReceive(doc, senderDid)`), every document the holder
// wants sent (`sharedconnect.send {to, docs}`) goes out through `send`. The holder's flow machine
// holds the enactment; this wire holds no state of it beyond the peers it has seen.
//
// The same shape as the reference CLI (trust-protocol `binding/shared-connect-invite.mjs`,
// `shared-connect-respond.mjs`), which ran the ceremony against Keyring on 8 November 2026:
//  - the messaging keys come from the holder's KeyProvider (`sharedConnectSeeds(nonce)`, DEVIATION
//    D5): the messaging seed, under the same two HKDF labels `partyFromSeeds` applies, gives the
//    Ed25519 signing key and the X25519 key of the did:peer:2; the wire checks the public keys
//    against the DID the holder wrote, so a derivation that drifted never signs under it;
//  - the responder's session is at the relay the inviter's identifier names (the inviter collects
//    there; a frame sent to any other mediator never reaches it), the inviter's at the carrier it put
//    into its link;
//  - the mediator session authenticates under the X25519 method of the did:peer:2 (`#key-…` as the
//    document writes it), as Keyring's `vtiClientIdentityFromDid` does;
//  - the responder forms the TSP relationship first: an XRFI to the inviter on every socket open,
//    before its documents (as the reference CLI does; Keyring's inviter takes a propose only from a
//    sender that formed the relationship). At the inviter's relay (`routed`) the XRFI and every
//    document travel routed through that mediator, as Keyring's scanner sends them: a mediator
//    drops or refuses a direct frame between parties whose relationship it never saw form. The inviter answers an XRFI from a sender never seen with
//    XRFA while the link is live; after the link expired only
//    senders already seen reach the holder;
//  - application messages of kind `direct` carry a Trust Task document, bare or inside the
//    registry's TSP binding envelope `{ type: …/binding/tsp/0.1/envelope, document }`; the wire
//    replies in the form the counterpart used (bare by default);
//  - a frame is acknowledged at the mediator only after the holder took its document (`onDocument`
//    resolved): one it could not take comes again at the next connect;
//  - frames are handled one after another (the session does not serialise them; the holder's act
//    serialises too, but the sender's long form must be known before the next frame is read);
//  - a frame the mediator took from the socket and refused comes back as its problem report
//    (`onRefused`): sent is not carried until the mediator kept it;
//  - the socket reconnects with a backoff while the enactment is open; the token is renewed by
//    a new handshake when the mediator refuses it. `close()` ends everything.
//
// Nothing here is a Delivery-channel adapter: no custody, no deposits, no acks (the ceremony's
// documents are the flow machine's, redelivered from its outbox after a restart by the session).

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { authenticateToMediator, identityOfKid, MediatorSession } from '@openvtc/vti-didcomm-js'
import { decodeEnvelope, pack as tspPack, packAccept, packInvite, packRouted, unpack as tspUnpack } from '@openvtc/vti-tsp-js'
import { hkdf, sharedConnect as sc } from '@real-life/trust-protocol'
import type { KeyProvider } from '@real-life/trust-protocol'
import type { DeviceTimers } from './transport'
import type { WireConfig, WireRefusal } from './wire'

const PROBLEM_REPORT = 'https://didcomm.org/report-problem/2.0/problem-report'
const reportCode = (c: unknown): string => (typeof c === 'string' && /^[a-z0-9._-]{1,64}$/.test(c) ? c : 'unknown')

/** The stock session, with the mediator's own problem reports handed to `onProblem` before the stock
 *  handling: how a mediator refuses a frame it took from the socket (local direct delivery off:
 *  `e.p.direct_delivery.denied`). A frame on the socket is not a frame the mediator carries. */
class SharedConnectSession extends MediatorSession {
  onProblem: ((code: string) => void) | null = null
  override async _dispatchFrame(result: { senderDid?: string; message?: { type?: string; body?: { code?: unknown } } }, text: unknown): Promise<void> {
    const m = result.message
    if (result.senderDid === identityOfKid(this.mediator.did) && m?.type === PROBLEM_REPORT) {
      try {
        this.onProblem?.(reportCode(m.body?.code))
      } catch {
        // a sink's failure is not the session's
      }
    }
    return super._dispatchFrame(result, text)
  }
}

/** the registry's TSP binding envelope (Trust Tasks TSP binding 0.1) */
export const BINDING_ENVELOPE = 'https://trusttasks.org/binding/tsp/0.1/envelope'
export const SC_RECONNECT_MIN_MS = 500
export const SC_RECONNECT_MAX_MS = 30_000

const te = new TextEncoder()
const td = new TextDecoder()

/** the raw messaging keys of one enactment, from the holder's KeyProvider (never stored) */
export interface SharedConnectKeys {
  readonly edSecret: Uint8Array
  readonly xSecret: Uint8Array
  readonly xPublic: Uint8Array
}

/** Derive the messaging keys of the enactment whose nonce is `nonce` (the inviter's handle `_id`, the
 *  responder's own challenge; 16 bytes, base64url as the holder writes them) and check them against
 *  the did:peer:2 the holder wrote. */
export async function sharedConnectKeys(keys: KeyProvider, nonce: Uint8Array, did: string): Promise<SharedConnectKeys> {
  if (!keys.sharedConnectSeeds) throw new Error('shared-connect: the KeyProvider has no sharedConnectSeeds')
  const { messaging } = await keys.sharedConnectSeeds(nonce)
  const edSecret = await hkdf(messaging, 'shared-connect/messaging/ed25519')
  const xSecret = await hkdf(messaging, 'shared-connect/messaging/x25519')
  const xPublic = x25519.getPublicKey(xSecret)
  const peer = await sc.parsePeer(did)
  if (!peer) throw new Error('shared-connect: the own messaging identity is no peer DID')
  if (!same(ed25519.getPublicKey(edSecret), peer.ed) || !same(xPublic, peer.x)) throw new Error('shared-connect: key derivation does not match the messaging identity')
  return { edSecret, xSecret, xPublic }
}

/** The mediator's client identity of a peer DID (the X25519 method as its document writes it, and its
 *  key): what the wire authenticates under, and what a mediator double reads its acknowledgements with. */
export async function peerClient(did: string): Promise<{ readonly kid: string; readonly x: Uint8Array; readonly ed: Uint8Array } | null> {
  const peer = await sc.parsePeer(did)
  return peer ? { kid: peer.ref + peer.doc.keyAgreement[0], x: peer.x, ed: peer.ed } : null
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

export interface SharedConnectWireConfig {
  /** C, exactly as configured */
  readonly mediatorDid: string
  /** the enactment's own messaging identity (did:peer:2) and its keys */
  readonly did: string
  readonly keys: SharedConnectKeys
  /** the link's expiry (seconds since the epoch): a first contact from a sender never seen is taken
   *  only while the link is live (with the ceremony's clock tolerance) */
  readonly exp: number
  /** the counterpart the responder already knows (the link's `_from`); the inviter learns its
   *  counterpart from the first frame */
  readonly peerDid?: string
  /** every frame goes routed through the mediator (an outer message to the mediator with the
   *  counterpart as the route), not as a direct frame: the form for a relay that is not this build's
   *  carrier, which admits a direct frame only between parties it saw form their relationship (and
   *  may be configured to refuse direct delivery altogether); Keyring's scanner does the same */
  readonly routed?: boolean
  readonly clock: DeviceTimers
  /** a document for the holder, with the TSP sender the wire verified; a rejection means the holder did
   *  not take it: the frame is not acknowledged and the mediator delivers it again */
  readonly onDocument: (doc: unknown, senderDid: string) => void | Promise<void>
  readonly onState?: (s: 'connected' | 'connecting' | 'unreachable') => void
  /** the mediator refused a frame this wire sent (its problem report, by code): what was on the socket
   *  is not carried; the caller sends again or gives the enactment up */
  readonly onRefused?: (code: string) => void
  /** the wire's steps, for the diagnostics: `connected`, `xrfi-sent`, `xrfa-received`, `sent/<n>`,
   *  `received <step>` (words, never a run the diagnostics' redaction would take for a key); never an identifier */
  readonly trace?: (step: string) => void
  /** frames refused for good (diagnostics; a code and a type, never bytes or identifiers) */
  readonly report?: (r: WireRefusal) => void
  readonly net?: WireConfig['net']
}

/** what the opening gives for a wire; the carrier adds its own part (C, the device clock, the network below) */
export type SharedConnectWireOpening = Omit<SharedConnectWireConfig, 'mediatorDid' | 'clock' | 'net'> & {
  /** the responder's wire: the relay the inviter's identifier names (the inviter listens there, not
   *  at this build's carrier); absent for the inviter's wire, which listens at the carrier it put into
   *  its link */
  readonly mediatorDid?: string
}

export interface SharedConnectWire {
  readonly did: string
  /** send the holder's documents to `to` (a peer DID; the long form of a did:peer:4 must have been
   *  seen); resolves once the frames are on the socket, rejects when the socket is down */
  send(to: string, docs: readonly unknown[]): Promise<void>
  /** the socket is open */
  isOpen(): boolean
  /** ends the wire: the socket closes, no reconnect is planned */
  close(): void
  /** frames on their way to the holder (tests) */
  busy(): number
}

export async function openSharedConnectWire(cfg: SharedConnectWireConfig): Promise<SharedConnectWire> {
  const { clock, keys } = cfg
  const self = await sc.parsePeer(cfg.did)
  if (!self) throw new Error('shared-connect: the own messaging identity is no peer DID')
  // the X25519 method as the document writes its id (the mediator's client identity, Keyring's reading)
  const xKid = self.ref + self.doc.keyAgreement[0]
  const WebSocketImpl = (cfg.net?.WebSocketImpl ?? globalThis.WebSocket) as typeof WebSocket
  const netPolicy = cfg.net?.policy ? { allowInsecure: Boolean(cfg.net.policy.allowInsecure), allowPrivate: Boolean(cfg.net.policy.allowPrivate) } : undefined
  const atmSeams = { ...(cfg.net?.fetch ? { fetch: cfg.net.fetch } : {}), ...(cfg.net?.resolve ? { resolve: cfg.net.resolve } : {}), ...(netPolicy ? { netPolicy } : {}) }
  /** a frame to `peer`: direct, or routed through the mediator with the peer as the route */
  const frameTo = async (inner: Uint8Array, peer: { did: string }): Promise<Uint8Array> => {
    if (!cfg.routed) return inner
    if (!mediatorX) throw new Error('shared-connect: the mediator key is not known yet')
    const outer = await packRouted(inner, [peer.did], cfg.did, cfg.mediatorDid, { senderSigningKey: keys.edSecret, receiverEncryptionKey: mediatorX })
    return outer.bytes
  }
  const refuse = (detail: string, sender?: string) => cfg.report?.({ code: detail.startsWith('direct/') ? 'wire-deposit-refused' : 'wire-frame-refused', detail, ...(sender !== undefined ? { sender } : {}) })

  /** senders seen, by their long form where one came (a did:peer:4 short form resolves against it) */
  const knownVids = new Set<string>()
  /** senders in a relationship (an XRFI answered, or the link's counterpart) */
  const relationship = new Set<string>()
  if (cfg.peerDid) relationship.add(cfg.peerDid)
  let form: 'bare' | 'envelope' = 'bare'
  let closed = false
  let session: SharedConnectSession | null = null
  /** the mediator's X25519 key, from the handshake: the outer layer of a routed frame is sealed to it */
  let mediatorX: Uint8Array | null = null
  let reconnectTimer: (() => void) | null = null
  let backoff = 0
  let busy = 0
  const live = () => clock.now() / 1000 < cfg.exp + sc.CLOCK_TOLERANCE_S

  const peerOf = async (vid: string) => {
    const peer = await sc.parsePeer(vid, knownVids)
    if (peer && vid !== sc.peer4Short(vid)) knownVids.add(vid)
    return peer
  }

  // frames one after another
  let queue: Promise<void> = Promise.resolve()
  // The session awaits this before it acknowledges the frame at the mediator (vti-didcomm-js: ack after
  // hand-off): a document the holder could not take rejects here, stays at the mediator and comes
  // again when the socket opens next.
  const onTspFrame = (qb2: Uint8Array): Promise<void> => {
    busy++
    const taken = queue.then(() => handleFrame(qb2), () => handleFrame(qb2))
    queue = taken.catch(() => undefined)
    return taken.finally(() => { busy-- })
  }
  async function handleFrame(qb2: Uint8Array): Promise<void> {
    if (closed) return
    let senderVid = ''
    try { senderVid = decodeEnvelope(qb2).envelope.sender ?? '' } catch { /* no envelope */ }
    const peer = await peerOf(senderVid)
    if (!peer) { refuse('not-a-peer-did'); return }
    if (cfg.peerDid && !sc.sameVid(peer.did, cfg.peerDid)) { refuse('not-the-counterpart'); return }
    let got
    try { got = await tspUnpack(qb2, { receiverDecryptionKey: keys.xSecret, senderSigningKey: peer.ed }) } catch { refuse('does-not-open', peer.did); return }
    if (!sc.sameVid(got.receiver, cfg.did)) { refuse('not-for-me', peer.did); return }
    if (got.messageType === 'control') {
      const kind = String(got.control?.controlType ?? 'unknown')
      // a first contact from a sender never seen only while the link is live (the holder's checkPropose bounds the rest)
      if (!live() && !relationship.has(peer.did)) { refuse('control-after-expiry', peer.did); return }
      cfg.trace?.(kind.toLowerCase().includes('accept') ? 'xrfa received' : kind.toLowerCase().includes('invite') ? 'xrfi received' : `control ${kind.slice(0, 24)}`)
      if (kind.toLowerCase().includes('invite')) {
        relationship.add(peer.did)
        try {
          const acc = await packAccept(got.threadDigest, cfg.did, peer.did, { senderSigningKey: keys.edSecret, receiverEncryptionKey: peer.x })
          session?.sendBinary(acc.bytes)
        } catch { refuse('accept-failed', peer.did) }
      }
      return
    }
    if (got.messageType !== 'direct') { refuse('not-direct:' + String(got.messageType), peer.did); return }
    if (!live() && !relationship.has(peer.did)) { refuse('direct-after-expiry', peer.did); return }
    let body: unknown
    try { body = JSON.parse(td.decode(got.payload)) } catch { refuse('not-json', peer.did); return }
    let doc = body
    if (body && typeof body === 'object' && (body as { type?: unknown }).type === BINDING_ENVELOPE && (body as { document?: unknown }).document) {
      doc = (body as { document: unknown }).document
      form = 'envelope'
    }
    relationship.add(peer.did)
    cfg.trace?.(`received ${String((doc as { ceremony?: { step?: unknown } } | null)?.ceremony?.step ?? 'untyped').slice(0, 24)}`)
    await cfg.onDocument(doc, peer.did)
  }

  const backoffMs = (n: number) => Math.min(SC_RECONNECT_MIN_MS * 2 ** n, SC_RECONNECT_MAX_MS)
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return
    cfg.onState?.('unreachable')
    const delay = backoffMs(backoff++)
    reconnectTimer = clock.setTimer(clock.now() + delay, () => {
      reconnectTimer = null
      open().catch(() => scheduleReconnect())
    })
  }
  /** a fresh handshake and socket (the token of a closed socket is not reused: the mediator's
   *  lifetime is short against the enactment's reconnects) */
  async function open(): Promise<void> {
    if (closed) return
    cfg.onState?.('connecting')
    const auth = await authenticateToMediator({ mediatorDid: cfg.mediatorDid, clientDid: cfg.did, clientKid: xKid, clientX25519Private: keys.xSecret, clientX25519Public: keys.xPublic, ...atmSeams })
    if (closed) return
    if (!auth.mediator.wsEndpoint) throw new Error('shared-connect: the mediator has no socket endpoint')
    mediatorX = auth.mediator.x25519Pub
    const s = new SharedConnectSession({
      mediator: auth.mediator as never,
      mediatorJwt: auth.accessToken,
      client: { did: cfg.did, kid: xKid, privateKey: keys.xSecret, publicKey: keys.xPublic },
      WebSocketImpl: WebSocketImpl as never,
      ...(netPolicy ? { netPolicy } : {}),
      onTspFrame,
      // the session calls these at runtime (mediator-transport.js); its typings (0.13.0) do not name them
      ...({ onClose: () => { if (session === s) { session = null; scheduleReconnect() } }, onError: () => { /* the close follows */ } } as object),
    })
    s.onProblem = (code) => {
      refuse('direct/' + code)
      cfg.onRefused?.(code)
    }
    await s.connect()
    if (closed) { s.close(); return }
    session = s
    backoff = 0
    // the responder: the relationship-forming XRFI to the inviter, before any document on this socket
    if (cfg.peerDid) {
      try {
        const peer = await peerOf(cfg.peerDid)
        if (peer) {
          // the reply path (TSP §7.2.4): through the relay this wire is logged in at, to this identity,
          // as Keyring writes it; without it the inviter's accept has no route back
          const inv = await packInvite(cfg.did, peer.did, { senderSigningKey: keys.edSecret, receiverEncryptionKey: peer.x }, cfg.routed ? { route: [cfg.mediatorDid, cfg.did] } : undefined)
          s.sendBinary(await frameTo(inv.bytes, peer))
          cfg.trace?.('xrfi sent')
        }
      } catch { refuse('invite-failed', cfg.peerDid) }
    }
    cfg.trace?.('connected')
    cfg.onState?.('connected')
  }
  await open()

  return {
    did: cfg.did,
    async send(to, docs) {
      if (closed) throw new Error('shared-connect wire closed')
      const peer = await peerOf(to)
      if (!peer) throw new Error('shared-connect: the recipient is no peer DID this wire knows')
      const s = session
      if (!s?.isOpen) throw new Error('shared-connect wire is down')
      for (const doc of docs) {
        const body = form === 'envelope' ? { type: BINDING_ENVELOPE, document: doc } : doc
        const msg = await tspPack(te.encode(JSON.stringify(body)), cfg.did, peer.did, { senderSigningKey: keys.edSecret, receiverEncryptionKey: peer.x })
        s.sendBinary(await frameTo(msg.bytes, peer))
      }
      cfg.trace?.(`sent ${docs.length}`)
    },
    isOpen: () => session?.isOpen === true,
    close() {
      closed = true
      if (reconnectTimer) { reconnectTimer(); reconnectTimer = null }
      const s = session
      session = null
      try { s?.close() } catch { /* already closed */ }
    },
    busy: () => busy,
  }
}
