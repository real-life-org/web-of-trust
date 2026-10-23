// A store-and-forward double of the VTI mediator (the live double of the wire): ATM HTTP, DID
// resolution and the socket are replaced (the wire's `net` seam), the TSP and DIDComm crypto is the
// real vti-tsp-js / vti-didcomm-js code. A port of the double in trust-protocol
// binding/test/wire-demux.test.mjs for the browser and the app's tests: two phones of the harness
// share one double in one page.
//
// What it does, as the dev instance was measured to (binding/README.md "Gemessene Betriebsfakten"):
//  - a binary TSP frame is relayed only when its envelope sender is the socket's authenticated DID;
//    any other frame vanishes without an error;
//  - a frame addressed to the mediator itself is a routed message: opened with the current X25519
//    key (a frame sealed to a key it no longer holds is dropped silently), its next hop taken, and the
//    inner message passed on unchanged; any other frame is routed on its envelope receiver;
//  - every frame for a client is held until the client acks it (messages-received over sha256 of the
//    qb64 text) and offered again whenever that client's socket opens.
// Fault switches (`faults`) let tests and the harness make it refuse, drop or expire.

import { x25519 } from '@noble/curves/ed25519.js'
import { didKey, jwk, multibase, unpack as didcommUnpack } from '@openvtc/vti-didcomm-js'
import { decodeEnvelope, nextHop, unpack as tspUnpack } from '@openvtc/vti-tsp-js'
import { peerKeys } from '../src/adapters/rltp/wire'

export const DOUBLE_DID = 'did:example:mediator-double'

const b64u = (u8: Uint8Array): string => {
  let bin = ''
  for (const b of u8) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const hex = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256hex = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

/** The switches of the double; each holds until it is set back (a test or the harness decides). */
export interface DoubleFaults {
  /** ATM: authentication answers 503 (the mediator unreachable for a handshake) */
  authDown: boolean
  /** access tokens expire this many seconds after issue (default 600) */
  tokenSeconds: number
  /** routed frames are accepted and carried to no one (a mediator that does not carry routed) */
  dropRouted: boolean
  /** new sockets fail to open (the network gone below the socket) */
  refuseSockets: boolean
  /** the next DIDComm text frame (an ack) of this DID closes its socket on the way */
  closeOnNextText: string | null
}

export interface MediatorDouble {
  readonly did: string
  readonly faults: DoubleFaults
  readonly net: { fetch: typeof fetch; resolve: (did: string) => Promise<unknown>; WebSocketImpl: unknown }
  /** inject a frame into a client's socket as the mediator would deliver it (and hold it) */
  deliver(did: string, qb2: Uint8Array): string
  /** the message ids a client has acked */
  ackedBy(did: string): Promise<string[]>
  /** the mediator's key changes; frames sealed to the old one are dropped from now on */
  rotate(): void
  /** every open socket closes (the network drops); the clients reconnect on their own */
  dropAll(): void
  /** frames held for a client, not acked */
  held(did: string): number
  /** resolves when the double has no turn of its own pending (opens, closes, routing, re-offers) */
  settled(): Promise<void>
  openSockets(did: string): number
  publicKey(): Uint8Array
  readonly sockets: Map<string, FakeWs>
  readonly dropped: { why: string; sender: string }[]
  readonly forwarded: { session: string; outer: { sender: string; receiver: string; route: string[] }; inner: Uint8Array; outerBytes: number }[]
  readonly direct: { session: string; sender: string; receiver: string }[]
  readonly opened: string[]
  readonly sent: { did: string; data: string }[]
}

export interface FakeWs {
  readonly did: string
  readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onerror: (() => void) | null
  send(data: string | Uint8Array): void
  close(): void
}

export function mediatorDouble(mediatorDid = DOUBLE_DID): MediatorDouble {
  let xSecret = rand(32)
  let xPublic = x25519.getPublicKey(xSecret)
  const oldSecrets: Uint8Array[] = []
  const kid = `${mediatorDid}#key-1`
  const sockets = new Map<string, FakeWs>()
  const sent: MediatorDouble['sent'] = []
  const dropped: MediatorDouble['dropped'] = []
  const forwarded: MediatorDouble['forwarded'] = []
  const direct: MediatorDouble['direct'] = []
  const opened: string[] = []
  const all: FakeWs[] = []
  const faults: DoubleFaults = { authDown: false, tokenSeconds: 600, dropRouted: false, refuseSockets: false, closeOnNextText: null }
  let lastChallengeDid: string | null = null
  // every turn of its own the double schedules is a job: settled() waits for none to be pending
  let busy = 0
  let idle: (() => void)[] = []
  const job = (p: Promise<unknown>) => {
    busy++
    void p
      .catch(() => undefined)
      .finally(() => {
        busy--
        if (busy > 0) return
        const w = idle
        idle = []
        for (const r of w) r()
      })
  }
  /** a turn of the event loop later (never time) */
  const later = (fn: () => unknown) => job(new Promise<void>((r) => setTimeout(r, 0)).then(fn))

  const resolve = async () => ({
    didDocument: {
      id: mediatorDid,
      verificationMethod: [{ id: kid, type: 'Multikey', controller: mediatorDid, publicKeyMultibase: multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, xPublic) }],
      keyAgreement: [kid],
      service: [{ id: `${mediatorDid}#service`, type: ['DIDCommMessaging'], serviceEndpoint: [{ uri: 'https://mediator.example.com/v1' }, { uri: 'wss://mediator.example.com/v1/ws' }] }],
    },
  })

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (faults.authDown) return new Response('unavailable', { status: 503 })
    const now = Math.floor(Date.now() / 1000)
    if (String(url).endsWith('/challenge')) {
      lastChallengeDid = (JSON.parse(String(init?.body)) as { did: string }).did
      return new Response(JSON.stringify({ data: { challenge: 'c', session_id: 's' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: { access_token: `tok:${lastChallengeDid}`, access_expires_at: now + faults.tokenSeconds, refresh_token: 'r', refresh_expires_at: now + 86400 } }), { status: 200 })
  }) as typeof fetch

  const held = new Map<string, Map<string, string>>()
  const toClient = (did: string, qb2: Uint8Array): string => {
    const text = b64u(qb2)
    let mine = held.get(did)
    if (!mine) held.set(did, (mine = new Map()))
    const box = mine
    job(sha256hex(text).then((id) => box.set(id, text)))
    const ws = sockets.get(did)
    if (ws?.readyState === 1) ws.onmessage?.({ data: text })
    return text
  }

  async function route(session: string, qb2: Uint8Array) {
    let got
    try {
      got = await tspUnpack(qb2, { receiverDecryptionKey: xSecret, senderSigningKey: peerKeys(session).signPub })
    } catch {
      dropped.push({ why: 'not openable with the current key', sender: session })
      return
    }
    if (got.messageType !== 'routed') return void dropped.push({ why: `not routed: ${got.messageType}`, sender: session })
    if (faults.dropRouted) return void dropped.push({ why: 'routed frames not carried', sender: session })
    const step = nextHop(got.hops, got.payload)
    if (step.kind !== 'forward') return void dropped.push({ why: 'no next hop', sender: session })
    forwarded.push({ session, outer: { sender: got.sender, receiver: got.receiver, route: [...got.hops] }, inner: step.inner, outerBytes: qb2.length })
    toClient(step.next, step.inner)
  }

  class Ws implements FakeWs {
    readonly did: string
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: string }) => void) | null = null
    onclose: ((ev: { code: number }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(_url: string, protocols: string[]) {
      this.did = (protocols[0] ?? '').slice('bearer.tok:'.length)
      all.push(this)
      if (faults.refuseSockets) {
        later(() => {
          this.readyState = 3
          this.onerror?.()
          this.onclose?.({ code: 1006 })
        })
        return
      }
      this.readyState = 1
      sockets.set(this.did, this)
      opened.push(this.did)
      later(() => {
        this.onopen?.()
        later(() => reoffer(this.did))
      })
    }
    send(data: string | Uint8Array) {
      // as a socket does: a send after close is dropped without an error
      if (this.readyState !== 1) return void dropped.push({ why: 'socket closed', sender: this.did })
      if (typeof data === 'string') {
        if (faults.closeOnNextText === this.did) {
          faults.closeOnNextText = null
          this.close()
          dropped.push({ why: 'socket closed', sender: this.did })
          return
        }
        sent.push({ did: this.did, data })
        return
      }
      const qb2 = new Uint8Array(data)
      const env = decodeEnvelope(qb2).envelope
      if (env.sender !== this.did) return void dropped.push({ why: "sender is not the socket's DID", sender: env.sender })
      if (env.receiver === mediatorDid) return void job(route(this.did, qb2))
      direct.push({ session: this.did, sender: env.sender, receiver: env.receiver })
      toClient(env.receiver, qb2)
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      if (sockets.get(this.did) === this) sockets.delete(this.did)
      later(() => this.onclose?.({ code: 1006 }))
    }
  }

  async function reoffer(did: string) {
    const ws = sockets.get(did)
    const mine = held.get(did)
    if (!mine || ws?.readyState !== 1) return
    const acked = new Set(await ackedBy(did))
    for (const [id, text] of mine) {
      if (acked.has(id)) {
        mine.delete(id)
        continue
      }
      ws.onmessage?.({ data: text })
    }
  }

  async function ackedBy(did: string): Promise<string[]> {
    const doc = didKey.resolve(did).didDocument as { keyAgreement?: ({ id: string } | string)[] }
    const first = doc.keyAgreement?.[0]
    const clientKid = typeof first === 'string' ? first : first?.id
    const clientX = peerKeys(did).encPub
    const ids: string[] = []
    for (const f of sent.filter((s) => s.did === did)) {
      for (const sk of [xSecret, ...oldSecrets]) {
        try {
          const { message } = (await didcommUnpack(f.data, { kid, privateJwk: jwk.privateJwk('X25519', sk, x25519.getPublicKey(sk)) }, { kid: clientKid, publicJwk: jwk.publicJwk('X25519', clientX) })) as unknown as {
            message: { type: string; body: { message_id_list: string[] } }
          }
          if (message.type.endsWith('/messages-received')) ids.push(...message.body.message_id_list)
          break
        } catch {
          // sealed to another key
        }
      }
    }
    return ids
  }

  return {
    did: mediatorDid,
    faults,
    net: { fetch: fetchImpl, resolve, WebSocketImpl: Ws },
    deliver: toClient,
    ackedBy,
    rotate() {
      oldSecrets.push(xSecret)
      xSecret = rand(32)
      xPublic = x25519.getPublicKey(xSecret)
    },
    dropAll() {
      for (const w of [...sockets.values()]) w.close()
    },
    held: (did) => held.get(did)?.size ?? 0,
    async settled() {
      while (busy > 0) await new Promise<void>((r) => idle.push(r))
    },
    openSockets: (did) => all.filter((w) => w.did === did && w.readyState === 1).length,
    publicKey: () => xPublic,
    sockets,
    dropped,
    forwarded,
    direct,
    opened,
    sent,
  }
}
