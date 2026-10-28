// @vitest-environment node
// The wire (src/adapters/rltp/wire.ts) under the real adapter of the library, over the mediator double
// (harness/mediator-double.ts): the real TSP and DIDComm crypto, the network below replaced. A port of
// trust-protocol binding/test/wire-demux.test.mjs (VTI Mediator Adapter Profile 0.29, TSP 1.0: one wire
// identity, the connection DID, sends and collects; the payload is the binding envelope the adapter built,
// RLTP-VTI-3150, handed back with its authenticated sender, RLTP-VTI-7140); time is the device clock (a
// virtual one), the double's sockets open on zero-delay turns.
import { describe, expect, it } from 'vitest'
import { cesr, sign as tspSign, pack as tspPack, packAccept, packInvite, packRouted, packWithHops, peekRevision, unpack as tspUnpack } from '@openvtc/vti-tsp-js'
import * as tspHpke from '@openvtc/vti-tsp-js/hpke'
// deep imports, test only: a frame whose sender VID in the confidential payload differs from its envelope's
// (or is the NULL VID) cannot be built through the public API, by design (as the reference test)
import { encodeFields, finalizeFrame } from '../../node_modules/@openvtc/vti-tsp-js/dist/v1/envelope.js'
import { encodePayloadFrame } from '../../node_modules/@openvtc/vti-tsp-js/dist/v1/payload.js'
import { MediatorCarrierAdapter, WireError, wrapSealed, type AckState } from '@real-life/trust-protocol/adapters/vti-mediator'
import { createVtiWire, deriveWireIdentities, peerKeys, QUIET_MS, type VtiWire, type WireRefusal } from '../../src/adapters/rltp/wire'
import { mediatorDouble, remark, type MediatorDouble } from '../../harness/mediator-double'
import { virtualClock, type VirtualClock } from '../../src/platform/fake'

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))
/** a turn of the event loop (never time) */
const turn = () => new Promise((r) => setTimeout(r, 0))
const sha256hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
type Ids = Awaited<ReturnType<typeof deriveWireIdentities>>
interface Side {
  root: Uint8Array
  nonce: Uint8Array
  ids: Ids
  consumer?: (b: Uint8Array, sender: string) => Promise<boolean>
}

const te = new TextEncoder()
const b64u = (u8: Uint8Array) => Buffer.from(u8).toString('base64url')
interface Seal {
  rkid: string
  epk: string
  nonce: string
  ciphertext: string
}
/** A sealed envelope of the schema's form (Delivery §5): what the holder hands over. */
const sealOf = (): Seal => ({ rkid: 'z6LS' + 'a'.repeat(44), epk: b64u(new Uint8Array(32)), nonce: b64u(rand(12)), ciphertext: b64u(rand(40)) })
/** The JCS bytes of a seal (flat, keys sorted): what submit() takes and what the holder receives. */
const sealBytes = (seal: Seal = sealOf()) => te.encode(JSON.stringify(Object.fromEntries(Object.entries(seal).sort(([a], [b]) => (a < b ? -1 : 1)))))
/** The payload a carried document makes of `seal` from `from` to `to` (RLTP-VTI-3150). */
const carried = async (seal: Seal, from: string, to: string) => (await wrapSealed(seal, { issuer: from, recipient: to, since: Date.now() })).bytes

async function side(did: string): Promise<Side> {
  const root = rand(64)
  const nonce = rand(32)
  return { root, nonce, ids: await deriveWireIdentities(root, did, nonce) }
}

async function pair(med: MediatorDouble, opts: { restoredB?: AckState } = {}) {
  return pairOn(med, virtualClock(Date.now(), 'UTC'), undefined, opts)
}

async function pairOn(med: MediatorDouble, clock: VirtualClock, network?: () => 'online' | 'offline', opts: { restoredB?: AckState; networkOf?: 'A' | 'B' } = {}) {
  const refusals: WireRefusal[] = []
  const A = await side(med.did)
  const B = await side(med.did)
  const mk = (self: Side, peer: Side) =>
    createVtiWire({ rootIkm: self.root, mediatorDid: med.did, nonce: self.nonce, peerDid: peer.ids.conn.did, clock, net: med.net, report: (r) => refusals.push(r), ...(network && self === (opts.networkOf === 'B' ? B : A) ? { network } : {}) })
  const wireA = await mk(A, B)
  const wireB = await mk(B, A)
  const onDeliverA = wireA.onDeliver.bind(wireA)
  wireA.onDeliver = (cb) => {
    A.consumer = cb
    onDeliverA(cb)
  }
  const alice = await MediatorCarrierAdapter.create(A.root, med.did, A.nonce, wireA)
  const bob = opts.restoredB ? await MediatorCarrierAdapter.create(B.root, med.did, B.nonce, wireB, opts.restoredB, clock.now()) : await MediatorCarrierAdapter.create(B.root, med.did, B.nonce, wireB)
  /** until nothing is in flight: the double's turns, the adapters' wire calls, frames in the wires */
  const flush = async () => {
    for (let calm = 0; calm < 2; ) {
      await med.settled()
      await alice.settle()
      await bob.settle()
      await turn()
      calm = wireA.busy() + wireB.busy() === 0 ? calm + 1 : 0
    }
  }
  alice.register([], clock.now())
  await alice.settle()
  bob.register([], clock.now())
  await bob.settle()
  await flush()
  return { A, B, alice, bob, wireA, wireB, clock, refusals, flush }
}

const close = (...xs: { close(): void }[]) => {
  for (const x of xs) x.close()
}
const quiet = async (clock: VirtualClock, flush: () => Promise<void>) => {
  await flush()
  clock.advance(QUIET_MS)
}

/** A direct frame whose ESSR sender (the sender VID in the confidential payload) is `essrSender`, while
 *  its envelope names `envelopeSender`; sealed and signed like any other (test only). */
async function packEssr(body: Uint8Array, envelopeSender: string, essrSender: string, receiver: string, keys: { senderSigningKey: Uint8Array; receiverEncryptionKey: Uint8Array }): Promise<Uint8Array> {
  const fields = encodeFields(envelopeSender, receiver)
  const { frame } = encodePayloadFrame(body, 'direct', [], essrSender)
  const sealed = await tspHpke.sealBase(frame, fields, keys.receiverEncryptionKey, cesr.TSP_INFO)
  const ct = new Uint8Array(sealed.enc.length + sealed.ciphertext.length)
  ct.set(sealed.enc, 0)
  ct.set(sealed.ciphertext, sealed.enc.length)
  const field: number[] = []
  cesr.encodeVariableData(cesr.TSP_HPKE_BASE_CIPHERTEXT, ct, field)
  const wireBytes = finalizeFrame(fields, new Uint8Array(field))
  const out = Array.from(wireBytes)
  cesr.encodeCount(cesr.TSP_ATTACH_GRP, 23, out)
  cesr.encodeCount(cesr.TSP_INDEX_SIG_GRP, 22, out)
  cesr.encodeIndexedEd25519Signature(0, tspSign.sign(wireBytes, keys.senderSigningKey), out)
  return new Uint8Array(out)
}

describe('the wire over the mediator double', () => {
  it('the adapter and the wire have one wire identity, the same connection DID (one HKDF, the same prefix); counterpart() names the peer’s (RLTP-VTI-1120, 1240)', async () => {
    const med = mediatorDouble()
    const { A, B, alice, wireA, bob, wireB } = await pair(med)
    expect(Object.keys(A.ids)).toEqual(['conn'])
    expect(alice.connectionDid).toBe(A.ids.conn.did)
    expect(wireA.connectionDid).toBe(A.ids.conn.did)
    expect('egressDid' in wireA).toBe(false)
    expect(wireA.counterpart()).toBe(B.ids.conn.did)
    expect(wireB.counterpart()).toBe(A.ids.conn.did)
    close(alice, bob, wireA, wireB)
  })

  it('RLTP-VTI-7140: onDeliver hands the consumer the payload unchanged with its authenticated sender, the counterpart’s connection DID', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did)
    const B = await side(med.did)
    const refusals: WireRefusal[] = []
    const wire = await createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, peerDid: B.ids.conn.did, clock, net: med.net, report: (r) => refusals.push(r) })
    const seen: { payload: number[]; sender: string }[] = []
    wire.onDeliver(async (payload, sender) => {
      seen.push({ payload: [...payload], sender })
      return true
    })
    await wire.authenticate({ did: A.ids.conn.did, challenge: 'c', sessionId: 's' })
    await med.settled()
    // whatever the payload, the wire passes it on unread (M-2)
    const payload = rand(77)
    med.deliver(A.ids.conn.did, (await tspPack(payload, B.ids.conn.did, A.ids.conn.did, { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })).bytes)
    for (let i = 0; i < 5; i++) {
      await med.settled()
      await turn()
    }
    expect(seen).toEqual([{ payload: [...payload], sender: B.ids.conn.did }])
    expect(refusals).toEqual([])
    wire.close()
  })

  it('XRFI, XRFA, nested, routed and empty direct frames never reach the adapter, are reported and acked; the queue keeps moving (RLTP-VTI-7140)', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const keys = { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: peerKeys(A.ids.conn.did).encPub }
    const invite = await packInvite(B.ids.conn.did, A.ids.conn.did, keys)
    const accept = await packAccept(invite.threadDigest, B.ids.conn.did, A.ids.conn.did, keys)
    const inner = await tspPack(rand(40), B.ids.conn.did, A.ids.conn.did, keys)
    const nested = await packWithHops(inner.bytes, 'nested', [], B.ids.conn.did, A.ids.conn.did, keys)
    const empty = await tspPack(new Uint8Array(0), B.ids.conn.did, A.ids.conn.did, keys)
    const routed = await packRouted(inner.bytes, [A.ids.conn.did], B.ids.conn.did, A.ids.conn.did, keys)
    const texts: string[] = []
    for (const f of [invite, accept, nested, empty, routed]) {
      texts.push(med.deliver(A.ids.conn.did, f.bytes))
      await flush()
    }
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(refusals.map((r) => r.detail)).toEqual(['control/invite', 'control/accept', 'type/nested', 'direct/empty', 'type/routed'])
    const acked = await med.ackedBy(A.ids.conn.did)
    for (const t of texts) expect(acked).toContain(await sha256hex(t))
    // a real deposit behind them arrives byte-identical, and its ack waits for the adapter's conclude
    const envelope = sealOf()
    bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    await flush()
    const c = alice.collect(clock.now())
    expect(c.items.map((i) => [...i.bytes])).toEqual([[...sealBytes(envelope)]])
    expect((await med.ackedBy(A.ids.conn.did)).length).toBe(texts.length)
    alice.conclude(c, clock.now())
    await alice.settle()
    await flush()
    expect((await med.ackedBy(A.ids.conn.did)).length).toBe(texts.length + 1)
    close(alice, bob, wireA, wireB)
  })

  it('routed (RLTP-VTI-1120, 3110, 3115): outer connection DID → C with the route [peer connection DID], inner connection DID → peer connection DID, on the connection session; the payload is the adapter’s binding envelope, the seal byte-identical at the receiver', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const envelope = sealOf()
    const id = bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    await flush()
    expect(bob.status(id)?.state).toBe('accepted')
    const c = alice.collect(clock.now())
    expect(c.items.map((i) => [...i.bytes])).toEqual([[...sealBytes(envelope)]])
    expect(med.forwarded).toHaveLength(1)
    const f = med.forwarded[0]!
    expect(f.session).toBe(B.ids.conn.did)
    expect(f.outer).toEqual({ sender: B.ids.conn.did, receiver: med.did, route: [A.ids.conn.did] })
    const inner = await tspUnpack(f.inner, { receiverDecryptionKey: A.ids.conn.xSecret, senderSigningKey: B.ids.conn.edPublic })
    expect([inner.messageType, inner.sender, inner.receiver]).toEqual(['direct', B.ids.conn.did, A.ids.conn.did])
    const doc = JSON.parse(new TextDecoder().decode(inner.payload)) as { type: string; document: { issuer: string; recipient: string; payload: unknown } }
    expect(doc.type).toBe('https://trusttasks.org/binding/tsp/0.1/envelope')
    expect([doc.document.issuer, doc.document.recipient]).toEqual([B.ids.conn.did, A.ids.conn.did])
    expect(doc.document.payload).toEqual(envelope)
    expect(new Set(med.opened)).toEqual(new Set([A.ids.conn.did, B.ids.conn.did]))
    expect(med.direct).toEqual([])
    const [frame] = wireB.sentFrames()
    expect(frame?.mode).toBe('routed')
    expect(frame!.outer).toBe(f.outerBytes)
    expect(refusals).toEqual([])
    expect(wireB.counterpart()).toBe(A.ids.conn.did)
    close(alice, bob, wireA, wireB)
  })

  it('TSP 1.0 (VTI 0.29 §3a, §7, RLTP-VTI-7110, 7140): both layers of a deposit declare YTSP-BAA, the inner one carries the sender VID; a Rev 3 frame is reported with its version and sender, acked, never delivered; the queue keeps moving', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const envelope = sealOf()
    bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    await flush()
    const c1 = alice.collect(clock.now())
    expect(c1.items).toHaveLength(1)
    // the outer layer is 1.0 (the double opened it with the 1.0 library and saw its marker), the inner too
    expect(med.frames.filter((f) => f.session === B.ids.conn.did).map((f) => f.version)).toEqual(['TSP 1.0 (YTSP-BAA)'])
    const [f] = med.forwarded
    expect(peekRevision(f!.inner)).toEqual({ major: 1, minor: 0, recognised: true })
    const inner = await tspUnpack(f!.inner, { receiverDecryptionKey: A.ids.conn.xSecret, senderSigningKey: B.ids.conn.edPublic })
    // the sender VID, bound in the confidential payload (ESSR)
    expect(inner.sender).toBe(B.ids.conn.did)
    alice.conclude(c1, clock.now())
    await alice.settle()
    await flush()
    // the same message marked Rev 3 (YTSP-AAC): refused from its marker, before any key is touched
    const v1 = await tspPack(await carried(sealOf(), B.ids.conn.did, A.ids.conn.did), B.ids.conn.did, A.ids.conn.did, { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const rev3Text = med.deliver(A.ids.conn.did, remark(v1.bytes))
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(refusals).toEqual([{ code: 'wire-frame-refused', detail: 'frame/version Rev 3 (YTSP-AAC)', version: 'Rev 3 (YTSP-AAC)', sender: B.ids.conn.did }])
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(rev3Text))
    // a 1.0 deposit behind it arrives
    const next = sealOf()
    bob.submit(sealBytes(next), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(next)]])
    close(alice, bob, wireA, wireB)
  })

  it('RLTP-VTI-7140, major version 1 only: a 1.1 direct frame is delivered; a frame of major version 2 is reported with its version, acked and never delivered', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const keys = { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic }
    const seal = sealOf()
    const body = await carried(seal, B.ids.conn.did, A.ids.conn.did)
    // a later MINOR (test only: the library's version constant, set for one pack)
    const version = cesr.TSP_VERSION as { minor: number }
    const saved = version.minor
    version.minor = 1
    let v11: Uint8Array
    try {
      v11 = (await tspPack(body, B.ids.conn.did, A.ids.conn.did, keys)).bytes
    } finally {
      version.minor = saved
    }
    expect(peekRevision(v11)).toEqual({ major: 1, minor: 1, recognised: false })
    med.deliver(A.ids.conn.did, v11)
    await flush()
    const c = alice.collect(clock.now())
    expect(c.items.map((i) => [...i.bytes])).toEqual([[...sealBytes(seal)]])
    const v2Text = med.deliver(A.ids.conn.did, remark((await tspPack(await carried(sealOf(), B.ids.conn.did, A.ids.conn.did), B.ids.conn.did, A.ids.conn.did, keys)).bytes, 'YTSP-CAA'))
    alice.conclude(c, clock.now())
    await alice.settle()
    await flush()
    // major version 2 never reaches the adapter
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(refusals).toEqual([{ code: 'wire-frame-refused', detail: 'frame/version MAJOR 2, MINOR 0 (unrecognised)', version: 'MAJOR 2, MINOR 0 (unrecognised)', sender: B.ids.conn.did }])
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(v2Text))
    close(alice, bob, wireA, wireB)
  })

  it('RLTP-VTI-7140: a frame whose sender VID in the confidential payload differs from its envelope sender, or is the NULL VID, is reported with the envelope sender, acked and never delivered; the queue keeps moving', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const keys = { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic }
    const X = await side(med.did)
    const mismatch = med.deliver(A.ids.conn.did, await packEssr(await carried(sealOf(), B.ids.conn.did, A.ids.conn.did), B.ids.conn.did, X.ids.conn.did, A.ids.conn.did, keys))
    await flush()
    const nullVid = med.deliver(A.ids.conn.did, await packEssr(await carried(sealOf(), B.ids.conn.did, A.ids.conn.did), B.ids.conn.did, '', A.ids.conn.did, keys))
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(refusals).toEqual([
      { code: 'wire-frame-refused', detail: 'frame/unopenable', sender: B.ids.conn.did },
      { code: 'wire-frame-refused', detail: 'frame/unopenable', sender: B.ids.conn.did },
    ])
    const acked = await med.ackedBy(A.ids.conn.did)
    expect(acked).toContain(await sha256hex(mismatch))
    expect(acked).toContain(await sha256hex(nullVid))
    const next = sealOf()
    bob.submit(sealBytes(next), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(next)]])
    close(alice, bob, wireA, wireB)
  })

  it('the double speaks 1.0 as a mediator from 0.45: a Rev 3 frame on a socket is dropped, routed or direct, and carried to no one', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    const keys = { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: med.publicKey() }
    const inner = await tspPack(rand(40), B.ids.conn.did, A.ids.conn.did, { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const routed = await packRouted(inner.bytes, [A.ids.conn.did], B.ids.conn.did, med.did, keys)
    const direct = await tspPack(rand(40), B.ids.conn.did, A.ids.conn.did, { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const ws = med.sockets.get(B.ids.conn.did)!
    ws.send(remark(routed.bytes))
    ws.send(remark(direct.bytes))
    await flush()
    expect(med.dropped).toEqual([
      { why: 'TSP version: Rev 3 (YTSP-AAC)', sender: B.ids.conn.did },
      { why: 'TSP version: Rev 3 (YTSP-AAC)', sender: B.ids.conn.did },
    ])
    expect(med.forwarded).toEqual([])
    expect(med.direct).toEqual([])
    expect(med.held(A.ids.conn.did)).toBe(0)
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    close(alice, bob, wireA, wireB)
  })

  it('a local mediator (plaintext, loopback) is refused unless the net seam admits it (the harness live runs); a store build sets no policy', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did)
    const B = await side(med.did)
    // the double, advertising the endpoints a local 1.0 instance advertises
    const local = async (did: string) => {
      const doc = (await med.net.resolve(did)) as { didDocument: { service: { serviceEndpoint: { uri: string }[] }[] } }
      doc.didDocument.service[0]!.serviceEndpoint = [{ uri: 'http://127.0.0.1:7037/mediator/v1' }, { uri: 'ws://127.0.0.1:7037/mediator/v1/ws' }]
      return doc
    }
    const mk = (policy?: { allowInsecure: boolean; allowPrivate: boolean }) =>
      createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, peerDid: B.ids.conn.did, clock, net: { ...med.net, resolve: local, ...(policy ? { policy } : {}) } })
    const strict = await mk()
    await expect(strict.authenticate({ did: A.ids.conn.did, challenge: 'c', sessionId: 's' })).rejects.toThrow()
    expect(med.opened).toEqual([])
    strict.close()
    const admitted = await mk({ allowInsecure: true, allowPrivate: true })
    await admitted.authenticate({ did: A.ids.conn.did, challenge: 'c', sessionId: 's' })
    await med.settled()
    expect(med.opened).toEqual([A.ids.conn.did])
    admitted.close()
  })

  it('rebinding (RLTP-VTI-7110, 7120): a failed deposit waits; C rotates its key; the renewal resolves the new key and the waiting document arrives sealed to it', async () => {
    // the mediator's tokens on the device clock: the renewal below is a renewal, not a clock skew
    const clock = virtualClock(Date.now(), 'UTC')
    const med = mediatorDouble(undefined, () => clock.now())
    const { A, B, alice, bob, wireA, wireB, flush } = await pairOn(med, clock)
    med.sockets.get(B.ids.conn.did)!.close()
    await flush()
    const envelope = sealOf()
    const id = bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    expect(bob.status(id)?.state).toBe('awaiting-transport')
    await flush()
    med.rotate()
    // the next attempt after the access token's expiry: renewal, the new key, packed anew
    clock.advance(601_000)
    bob.advance(clock.now())
    await bob.settle()
    await flush()
    expect(bob.status(id)?.state).toBe('accepted')
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(envelope)]])
    expect(med.dropped.filter((d) => d.why === 'not openable with the current key')).toEqual([])
    void A
    close(alice, bob, wireA, wireB)
  })

  it('fallback (RLTP-VTI-3120): in mode direct the inner message alone goes on the connection DID’s own session; no other session is opened; a closed socket is reopened and the next deposit goes on it', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, flush } = await pair(med, { restoredB: { concluded: [], pending: [], send: { mode: 'direct', open: [] } } })
    expect(bob.sendMode).toBe('direct')
    const envelope = sealOf()
    bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(envelope)]])
    expect(med.direct).toEqual([{ session: B.ids.conn.did, sender: B.ids.conn.did, receiver: A.ids.conn.did }])
    expect(med.forwarded).toEqual([])
    expect(wireB.sentFrames()[0]).toMatchObject({ mode: 'direct', outer: null })
    expect(new Set(med.opened)).toEqual(new Set([A.ids.conn.did, B.ids.conn.did]))
    // closed under it: reopened after the backoff (device time), the next deposit goes on it
    med.sockets.get(B.ids.conn.did)!.close()
    await flush()
    clock.advance(50)
    await flush()
    bob.submit(sealBytes(), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(1)
    expect(med.opened.filter((d) => d === B.ids.conn.did)).toHaveLength(2)
    close(alice, bob, wireA, wireB)
  })

  it('RLTP-VTI-3120: a mediator that refuses direct delivery answers the connection DID’s session with a problem report; the wire signals it and reports `direct/<code> locked`; a later deposit in mode direct fails as direct-refused, routed still goes out', async () => {
    const med = mediatorDouble()
    med.faults.refuseDirect = true
    const { A, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med, { restoredB: { concluded: [], pending: [], send: { mode: 'direct', open: [] } } })
    const first = bob.submit(sealBytes(), clock.now())
    await bob.settle()
    await flush()
    expect(bob.status(first)?.state).toBe('accepted')
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(wireB.directRefused()).toBe(true)
    expect(refusals).toEqual([{ code: 'wire-deposit-refused', detail: 'direct/e.p.direct_delivery.denied locked' }])
    await expect(wireB.deposit('t', sealBytes(), 'direct')).rejects.toSatisfy((e: unknown) => e instanceof WireError && e.kind === 'direct-refused')
    // routed is not refused by it
    await wireB.deposit('t', await carried(sealOf(), wireB.connectionDid, A.ids.conn.did), 'routed')
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(1)
    close(alice, bob, wireA, wireB)
  })

  it('RLTP-VTI-3120, §5: any other problem report (e.p.delivery.refused) is reported and consumed; the next deposit in mode direct goes out on the connection DID’s session', async () => {
    const med = mediatorDouble()
    med.faults.refuseNextDirect = 'e.p.delivery.refused'
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med, { restoredB: { concluded: [], pending: [], send: { mode: 'direct', open: [] } } })
    bob.submit(sealBytes(), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(refusals).toEqual([{ code: 'wire-deposit-refused', detail: 'direct/e.p.delivery.refused' }])
    expect(wireB.directRefused()).toBe(false)
    const next = sealOf()
    const id = bob.submit(sealBytes(next), clock.now())
    await bob.settle()
    await flush()
    expect(bob.status(id)?.state).toBe('accepted')
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(next)]])
    expect(med.direct.at(-1)).toEqual({ session: B.ids.conn.did, sender: B.ids.conn.did, receiver: A.ids.conn.did })
    close(alice, bob, wireA, wireB)
  })

  it('queueEmpty (RLTP-VTI-7150): false right after the open and after a frame, true on an open socket quiet for QUIET_MS of device time', async () => {
    const med = mediatorDouble()
    const { alice, bob, wireA, wireB, clock, flush } = await pair(med)
    expect(wireA.queueEmpty()).toBe(false)
    await quiet(clock, flush)
    expect(wireA.queueEmpty()).toBe(true)
    bob.submit(sealBytes(), clock.now())
    await bob.settle()
    await flush()
    expect(wireA.queueEmpty()).toBe(false)
    await quiet(clock, flush)
    expect(wireA.queueEmpty()).toBe(true)
    close(alice, bob, wireA, wireB)
  })

  it('a closed connection socket fails the deposit as unreachable, never accepted on a dead socket; the retry after the reconnect lands', async () => {
    const med = mediatorDouble()
    const { B, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    med.sockets.get(B.ids.conn.did)!.close()
    await flush()
    const id = bob.submit(sealBytes(), clock.now())
    await bob.settle()
    expect(bob.status(id)).toEqual({ state: 'awaiting-transport', reason: 'transport-unreachable' })
    expect(med.forwarded).toHaveLength(0)
    // the reconnect runs on the device clock: its backoff is due, the socket opens again
    clock.advance(50)
    await flush()
    expect(med.opened.filter((d) => d === B.ids.conn.did)).toHaveLength(2)
    expect(wireB.state()).toBe('connected')
    bob.advance(clock.now())
    await bob.settle()
    await flush()
    expect(bob.status(id)?.state).toBe('accepted')
    expect(alice.collect(clock.now()).items).toHaveLength(1)
    close(alice, bob, wireA, wireB)
  })

  it('an ack on a closed socket, or one whose socket dies while it is sent, fails; the intent stays and the next advance sends it', async () => {
    const med = mediatorDouble()
    const { A, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    for (const how of ['closed', 'dies'] as const) {
      bob.submit(sealBytes(), clock.now())
      await bob.settle()
      await flush()
      const c = alice.collect(clock.now())
      expect(c.items).toHaveLength(1)
      if (how === 'closed') {
        med.sockets.get(A.ids.conn.did)!.close()
        await flush()
      } else med.faults.closeOnNextText = A.ids.conn.did
      alice.conclude(c, clock.now())
      await alice.settle()
      expect(alice.ackState().pending).toHaveLength(1)
      clock.advance(50)
      await flush()
      alice.advance(clock.now())
      await alice.settle()
      await flush()
      expect(alice.ackState().pending).toHaveLength(0)
    }
    close(alice, bob, wireA, wireB)
  })

  it('a frame from a foreign sender, or a tampered one, is reported and acked, never delivered', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const X = await side(med.did)
    const foreign = await tspPack(await carried(sealOf(), X.ids.conn.did, A.ids.conn.did), X.ids.conn.did, A.ids.conn.did, { senderSigningKey: X.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const t1 = med.deliver(A.ids.conn.did, foreign.bytes)
    await flush()
    const good = await tspPack(rand(40), B.ids.conn.did, A.ids.conn.did, { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const tampered = new Uint8Array(good.bytes)
    tampered[tampered.length - 5]! ^= 0xff
    const t2 = med.deliver(A.ids.conn.did, tampered)
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    expect(refusals.map((r) => r.detail)).toEqual(['frame/unopenable', 'frame/unopenable'])
    // a report names no identifier
    for (const r of refusals) expect(r.detail).not.toMatch(/did:/)
    const acked = await med.ackedBy(A.ids.conn.did)
    expect(acked).toContain(await sha256hex(t1))
    expect(acked).toContain(await sha256hex(t2))
    close(alice, bob, wireA, wireB)
  })

  it('the switch end to end (RLTP-VTI-3130): a mediator that carries no routed frames, a quiet queue, the deadline; then mode direct carries the next document on the same session', async () => {
    const med = mediatorDouble()
    med.faults.dropRouted = true
    const { B, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    const gate = { closed: false, handOver: async (_e: unknown, _w: number, start: () => boolean) => start() }
    const entry = { digest: 'doc-1', kind: 'document' as const, envelope: sealOf(), type: 't', threadId: 't', recipient: {}, attempt: 0, since: clock.now(), notAfter: clock.now() + 10 * 72 * 3_600_000 }
    bob.reconcile({ ok: true, commitSeq: '1', at: clock.now(), entries: [entry] } as never, gate as never, clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    await quiet(clock, flush)
    bob.conclude(bob.collect(clock.now()), clock.now())
    clock.advance(72 * 3_600_000)
    bob.advance(clock.now())
    expect(bob.sendMode).toBe('direct')
    const second = sealOf()
    bob.submit(sealBytes(second), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(second)]])
    expect(med.direct.at(-1)?.session).toBe(B.ids.conn.did)
    expect(med.opened.filter((d) => d === B.ids.conn.did)).toHaveLength(1)
    close(alice, bob, wireA, wireB)
  })

  it('a frame the adapter did not take keeps queueEmpty false until the mediator offers it again at the next open and the adapter takes it', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    // fill the buffer to the cap through the adapter's consumer: maximal carried seals until one is not
    // taken, then small ones until none fits any more
    const big = { ...sealOf(), ciphertext: b64u(new Uint8Array(65536 + 16).fill(7)) }
    const feed = async (seal: Seal) => A.consumer!(await carried(seal, B.ids.conn.did, A.ids.conn.did), B.ids.conn.did)
    let fed = 0
    while (await feed({ ...big, nonce: b64u(rand(12)) })) fed++
    while (await feed(sealOf())) fed++
    expect(fed).toBeGreaterThan(0)
    const envelope = sealOf()
    bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    await flush()
    await quiet(clock, flush)
    expect(wireA.queueEmpty()).toBe(false)
    const c = alice.collect(clock.now())
    // only the fed ones
    expect(c.items.some((i) => Buffer.from(i.bytes).equals(Buffer.from(sealBytes(envelope))))).toBe(false)
    alice.conclude(c, clock.now())
    await alice.settle()
    med.sockets.get(A.ids.conn.did)!.close()
    await flush()
    clock.advance(50)
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(envelope)]])
    await quiet(clock, flush)
    expect(wireA.queueEmpty()).toBe(true)
    close(alice, bob, wireA, wireB)
  })

  it('a receive-only side reconnects by itself on the device clock; a closed wire plans nothing', async () => {
    const med = mediatorDouble()
    const { A, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    med.sockets.get(A.ids.conn.did)!.close()
    await flush()
    expect(wireA.state()).toBe('unreachable')
    clock.advance(50)
    await flush()
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    expect(wireA.state()).toBe('connected')
    const before = med.opened.length
    wireA.close()
    clock.advance(60_000)
    await flush()
    expect(med.opened.length).toBe(before)
    close(alice, bob, wireB)
  })

  it('a receive-only side whose token expired: no upgrade with the stale token after the socket drops; the adapter instance renews it (register) and the side receives again', async () => {
    const clock = virtualClock(Date.now(), 'UTC')
    const med = mediatorDouble(undefined, () => clock.now())
    const { A, alice, bob, wireA, wireB, flush } = await pairOn(med, clock)
    clock.advance(601_000)
    med.sockets.get(A.ids.conn.did)!.close()
    await flush()
    clock.advance(30_000)
    await flush()
    expect(med.counts.expiredRefused).toBe(0)
    expect(wireA.state()).toBe('unreachable')
    expect(wireA.needsAuth()).toBe(true)
    // the lib instance renews through the wire: a fresh token, the socket opens with it
    alice.register([], clock.now())
    await alice.settle()
    await flush()
    expect(wireA.state()).toBe('connected')
    expect(wireA.needsAuth()).toBe(false)
    const envelope = sealOf()
    bob.submit(sealBytes(envelope), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...sealBytes(envelope)]])
    close(alice, bob, wireA, wireB)
  })

  it('the double refuses an upgrade whose bearer expired (1006); offline, the wire tries no reconnect and resume() opens it again', async () => {
    const clock = virtualClock(Date.now(), 'UTC')
    const med = mediatorDouble(undefined, () => clock.now())
    let net: 'online' | 'offline' = 'online'
    const { A, alice, bob, wireA, wireB, flush } = await pairOn(med, clock, () => net)
    net = 'offline'
    const opened = med.opened.length
    med.sockets.get(A.ids.conn.did)!.close()
    await flush()
    clock.advance(120_000)
    await flush()
    expect(med.opened.length).toBe(opened)
    net = 'online'
    wireA.resume()
    await flush()
    expect(wireA.state()).toBe('connected')
    close(alice, bob, wireA, wireB)
  })

  it('RLTP-VTI-1227, 1240: a counterpart identity that is this side’s own connection DID is refused at construction; counterpart() names the peer, null for a wire without one', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did)
    const B = await side(med.did)
    const base = { rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, clock, net: med.net }
    await expect(createVtiWire({ ...base, peerDid: A.ids.conn.did })).rejects.toThrow(/RLTP-VTI-1227/)
    const fine: VtiWire = await createVtiWire({ ...base, peerDid: B.ids.conn.did })
    expect(fine.connectionDid).toBe(A.ids.conn.did)
    expect(fine.counterpart()).toBe(B.ids.conn.did)
    const unbound = await createVtiWire(base)
    expect(unbound.counterpart()).toBeNull()
    unbound.bind({ connectionDid: B.ids.conn.did })
    expect(unbound.counterpart()).toBe(B.ids.conn.did)
    close(fine, unbound)
  })

  it('offline() follows the platform network; without a network port it is never offline', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did)
    const B = await side(med.did)
    let net: 'online' | 'offline' | 'unknown' = 'online'
    const w = await createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, peerDid: B.ids.conn.did, clock, net: med.net, network: () => net })
    expect(w.offline()).toBe(false)
    net = 'offline'
    expect(w.offline()).toBe(true)
    const v = await createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, peerDid: B.ids.conn.did, clock, net: med.net })
    expect(v.offline()).toBe(false)
    close(w, v)
  })
})

/** The session lifecycle of the one wire identity (wire.ts sessionUnit), driven two ways: a side that
 *  only receives (renewed by the adapter instance's `register`) and a side that deposits in mode direct
 *  (renewed by the adapter's next attempt). A rig drives one side: `kick` is what the carrier does every
 *  tick of five seconds, `needsHandshake` brings the identity to where its next step authenticates. */
interface Rig {
  readonly did: string
  readonly clock: VirtualClock
  readonly med: MediatorDouble
  readonly flush: () => Promise<void>
  readonly wire: VtiWire
  setNet(n: 'online' | 'offline'): void
  needsHandshake(): Promise<void>
  kick(): Promise<void>
  close(): void
}
async function rig(kind: 'receiving' | 'direct', fetchHold?: Promise<void>): Promise<Rig> {
  const clock = virtualClock(Date.now(), 'UTC')
  const base = mediatorDouble(undefined, () => clock.now())
  let net: 'online' | 'offline' = 'online'
  let holding = false
  const realFetch = base.net.fetch
  const med = fetchHold ? Object.assign(base, { net: { ...base.net, fetch: (async (...a: Parameters<typeof fetch>) => (holding ? await fetchHold : undefined, realFetch(...a))) as typeof fetch } }) : base
  const sender = kind === 'direct'
  const p = await pairOn(med, clock, () => net, { networkOf: sender ? 'B' : 'A', ...(sender ? { restoredB: { concluded: [], pending: [], send: { mode: 'direct', open: [] } } } : {}) })
  const driven = sender ? p.bob : p.alice
  let submitted = false
  const did = sender ? p.B.ids.conn.did : p.A.ids.conn.did
  return {
    did,
    clock,
    med,
    flush: p.flush,
    wire: sender ? p.wireB : p.wireA,
    setNet: (n) => void (net = n),
    async needsHandshake() {
      holding = true
      // its token expired and its socket gone: the next renewal authenticates
      clock.advance(601_000)
      med.sockets.get(did)?.close()
      await p.flush()
    },
    async kick() {
      // the sending side: one document waits, every tick's advance attempts it again
      if (sender && !submitted) driven.submit(sealBytes(), clock.now())
      submitted = true
      if (!sender) driven.register([], clock.now())
      driven.advance(clock.now())
      await driven.settle()
      await p.flush()
    },
    close: () => close(p.alice, p.bob, p.wireA, p.wireB),
  }
}
const handshakes = (r: Rig) => r.med.counts.auths.get(r.did) ?? 0

describe.each(['receiving', 'direct'] as const)('the session lifecycle of the connection DID, %s side', (kind) => {
  it('offline, no handshake is tried', async () => {
    const r = await rig(kind)
    await r.needsHandshake()
    r.setNet('offline')
    const [a0, f0] = [handshakes(r), r.med.counts.authRefused]
    for (let i = 0; i < 60; i++) {
      r.clock.advance(5000)
      await r.kick()
    }
    expect([handshakes(r) - a0, r.med.counts.authRefused - f0]).toEqual([0, 0])
    r.close()
  })

  it('a refused handshake backs off on the device clock: no handshake per tick; it lands once the mediator answers', async () => {
    const r = await rig(kind)
    await r.needsHandshake()
    r.med.faults.authDown = true
    // the bases once the fault is on: the connection DID authenticated before (pairOn)
    const [f0, h0] = [r.med.counts.authRefused, handshakes(r)]
    for (let i = 0; i < 60; i++) {
      r.clock.advance(5000)
      await r.kick()
    }
    const tries = r.med.counts.authRefused - f0
    expect(tries).toBeGreaterThan(0)
    expect(tries).toBeLessThanOrEqual(20)
    expect(handshakes(r)).toBe(h0)
    // the mediator answers again: one handshake lands, and the identity's socket is open
    r.med.faults.authDown = false
    r.clock.advance(30_000)
    await r.kick()
    expect(handshakes(r)).toBeGreaterThan(h0)
    expect(r.med.openSockets(r.did)).toBe(1)
    r.close()
  })

  it('a socket that fails after a valid handshake is a connection failure: the token stands, the reconnects back off, one handshake', async () => {
    const r = await rig(kind)
    await r.needsHandshake()
    r.med.faults.refuseSockets = true
    const [a0, s0] = [handshakes(r), r.med.counts.socketsRefused]
    for (let i = 0; i < 60; i++) {
      r.clock.advance(5000)
      await r.kick()
    }
    expect(handshakes(r) - a0).toBeLessThanOrEqual(2)
    // from 50 ms doubling to 30 s: about 10 + 10 sockets in five minutes, never one per tick and more
    expect(r.med.counts.socketsRefused - s0).toBeLessThanOrEqual(25)
    r.med.faults.refuseSockets = false
    r.clock.advance(30_000)
    await r.kick()
    expect(r.med.openSockets(r.did)).toBe(1)
    r.close()
  })

  it('closed while its handshake runs, it opens no socket afterwards', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((res) => (release = res))
    const r = await rig(kind, hold)
    await r.needsHandshake()
    const kicked = r.kick()
    for (let i = 0; i < 50; i++) await turn()
    r.wire.close()
    release()
    await kicked
    await r.flush()
    expect(r.med.openSockets(r.did)).toBe(0)
    r.close()
  })
})

describe('the wire of a displayed card', () => {
  it('VTI 0.29 §1c: unbound, a direct frame of any sender reaches the adapter with its sender remembered; it deposits nothing and names no counterpart; bound, only the counterpart’s connection DID (RLTP-VTI-1255, 1265, 7140, 1227)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const refusals: WireRefusal[] = []
    const A = await side(med.did)
    const B = await side(med.did)
    const X = await side(med.did)
    const card = await createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, clock, net: med.net, report: (r) => refusals.push(r) })
    const adapter = await MediatorCarrierAdapter.create(A.root, med.did, A.nonce, card)
    adapter.register([], clock.now())
    await adapter.settle()
    const flush = async () => {
      for (let calm = 0; calm < 2; ) {
        await med.settled()
        await adapter.settle()
        await turn()
        calm = card.busy() === 0 ? calm + 1 : 0
      }
    }
    await flush()
    expect(card.peer()).toBeNull()
    expect(card.counterpart()).toBeNull()
    const send = (from: Side, to: string, bytes: Uint8Array) => tspPack(bytes, from.ids.conn.did, to, { senderSigningKey: from.ids.conn.edSecret, receiverEncryptionKey: peerKeys(to).encPub })
    const fromB = sealOf()
    const fromX = sealOf()
    med.deliver(A.ids.conn.did, (await send(B, A.ids.conn.did, await carried(fromB, B.ids.conn.did, A.ids.conn.did))).bytes)
    med.deliver(A.ids.conn.did, (await send(X, A.ids.conn.did, await carried(fromX, X.ids.conn.did, A.ids.conn.did))).bytes)
    // signed by the own identity: refused, never handed on
    const own = await tspPack(rand(42), A.ids.conn.did, A.ids.conn.did, { senderSigningKey: A.ids.conn.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const ownText = med.deliver(A.ids.conn.did, own.bytes)
    await flush()
    const c = adapter.collect(clock.now())
    // the two frames are opened side by side: their order at the adapter is not the mediator's
    const bySender = Object.fromEntries(c.items.map((i) => [card.senderOf(i.queueId), [...i.bytes]]))
    expect(bySender).toEqual({ [B.ids.conn.did]: [...sealBytes(fromB)], [X.ids.conn.did]: [...sealBytes(fromX)] })
    expect(refusals.map((r) => r.detail)).toEqual(['frame/foreign'])
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(ownText))
    // a Rev 3 frame of any sender: refused with its version and its sender, acked, never handed on
    const rev3Text = med.deliver(A.ids.conn.did, remark((await send(X, A.ids.conn.did, rand(44))).bytes))
    await flush()
    expect(refusals.at(-1)).toEqual({ code: 'wire-frame-refused', detail: 'frame/version Rev 3 (YTSP-AAC)', version: 'Rev 3 (YTSP-AAC)', sender: X.ids.conn.did })
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(rev3Text))
    // nothing deposited before the binding
    await expect(card.deposit('t', rand(10), 'routed')).rejects.toThrow('no counterpart')
    // RLTP-VTI-1227 at the binding too
    expect(() => card.bind({ connectionDid: A.ids.conn.did })).toThrow(/1227/)
    card.bind({ connectionDid: B.ids.conn.did })
    expect(card.counterpart()).toBe(B.ids.conn.did)
    expect(() => card.bind({ connectionDid: X.ids.conn.did })).toThrow('another counterpart')
    adapter.conclude(c, clock.now())
    await adapter.settle()
    await flush()
    // bound: a frame of another sender is refused for good (its sender named apart from the detail)
    const late = med.deliver(A.ids.conn.did, (await send(X, A.ids.conn.did, await carried(sealOf(), X.ids.conn.did, A.ids.conn.did))).bytes)
    await flush()
    expect(adapter.collect(clock.now()).items).toHaveLength(0)
    expect(refusals.at(-1)).toEqual({ code: 'wire-frame-refused', detail: 'frame/unopenable', sender: X.ids.conn.did })
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(late))
    // and the deposit goes to the counterpart's connection DID
    await card.deposit('t', await carried(sealOf(), A.ids.conn.did, B.ids.conn.did), 'routed')
    await flush()
    expect(med.forwarded.at(-1)?.outer.route).toEqual([B.ids.conn.did])
    close(adapter, card)
  })
})
