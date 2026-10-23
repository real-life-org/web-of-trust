// @vitest-environment node
// The wire (src/adapters/rltp/wire.ts) under the real adapter of the library, over the mediator double
// (harness/mediator-double.ts): the real TSP and DIDComm crypto, the network below replaced. A port of
// trust-protocol binding/test/wire-demux.test.mjs; time is the device clock (a virtual one), the
// double's sockets open on zero-delay turns.
import { describe, expect, it } from 'vitest'
import { pack as tspPack, packAccept, packInvite, packRouted, packWithHops, unpack as tspUnpack } from '@openvtc/vti-tsp-js'
import { MediatorCarrierAdapter, type AckState } from '@real-life/trust-protocol/adapters/vti-mediator'
import { createVtiWire, deriveWireIdentities, peerKeys, QUIET_MS, type VtiWire, type WireRefusal } from '../../src/adapters/rltp/wire'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
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
  consumer?: (b: Uint8Array) => Promise<boolean>
}

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
    createVtiWire({ rootIkm: self.root, mediatorDid: med.did, nonce: self.nonce, peerDid: peer.ids.conn.did, peerEgressDid: peer.ids.egress.did, clock, net: med.net, report: (r) => refusals.push(r), ...(network && self === (opts.networkOf === 'B' ? B : A) ? { network } : {}) })
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

describe('the wire over the mediator double', () => {
  it('the adapter trio and the wire identities are the same DIDs (one HKDF, the same prefixes)', async () => {
    const med = mediatorDouble()
    const { A, alice, wireA, bob, wireB } = await pair(med)
    expect([alice.connectionDid, alice.egressDid]).toEqual([A.ids.conn.did, A.ids.egress.did])
    expect([wireA.connectionDid, wireA.egressDid]).toEqual([A.ids.conn.did, A.ids.egress.did])
    close(alice, bob, wireA, wireB)
  })

  it('XRFI, XRFA, nested, routed and empty direct frames never reach the adapter, are reported and acked; the queue keeps moving (RLTP-VTI-7140)', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const keys = { senderSigningKey: B.ids.egress.edSecret, receiverEncryptionKey: peerKeys(A.ids.conn.did).encPub }
    const invite = await packInvite(B.ids.egress.did, A.ids.conn.did, keys)
    const accept = await packAccept(invite.threadDigest, B.ids.egress.did, A.ids.conn.did, keys)
    const inner = await tspPack(rand(40), B.ids.egress.did, A.ids.conn.did, keys)
    const nested = await packWithHops(inner.bytes, 'nested', [], B.ids.egress.did, A.ids.conn.did, keys)
    const empty = await tspPack(new Uint8Array(0), B.ids.egress.did, A.ids.conn.did, keys)
    const routed = await packRouted(inner.bytes, [B.ids.conn.did], B.ids.egress.did, A.ids.conn.did, keys)
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
    const envelope = rand(64)
    bob.submit(envelope, clock.now())
    await bob.settle()
    await flush()
    const c = alice.collect(clock.now())
    expect(c.items.map((i) => [...i.bytes])).toEqual([[...envelope]])
    expect((await med.ackedBy(A.ids.conn.did)).length).toBe(texts.length)
    alice.conclude(c, clock.now())
    await alice.settle()
    await flush()
    expect((await med.ackedBy(A.ids.conn.did)).length).toBe(texts.length + 1)
    close(alice, bob, wireA, wireB)
  })

  it('routed (RLTP-VTI-3110, 3115): outer connection DID → C with the route [peer connection DID] on the connection session, inner egress → peer connection DID; byte-identical at the receiver', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, refusals, flush } = await pair(med)
    const envelope = rand(64)
    const id = bob.submit(envelope, clock.now())
    await bob.settle()
    await flush()
    expect(bob.status(id)?.state).toBe('accepted')
    const c = alice.collect(clock.now())
    expect(c.items.map((i) => [...i.bytes])).toEqual([[...envelope]])
    expect(med.forwarded).toHaveLength(1)
    const f = med.forwarded[0]!
    expect(f.session).toBe(B.ids.conn.did)
    expect(f.outer).toEqual({ sender: B.ids.conn.did, receiver: med.did, route: [A.ids.conn.did] })
    const inner = await tspUnpack(f.inner, { receiverDecryptionKey: A.ids.conn.xSecret, senderSigningKey: B.ids.egress.edPublic })
    expect([inner.messageType, inner.sender, inner.receiver]).toEqual(['direct', B.ids.egress.did, A.ids.conn.did])
    expect(med.sockets.has(B.ids.egress.did)).toBe(false)
    expect(med.direct).toEqual([])
    const [frame] = wireB.sentFrames()
    expect(frame?.mode).toBe('routed')
    expect(frame!.outer).toBe(f.outerBytes)
    expect(refusals).toEqual([])
    close(alice, bob, wireA, wireB)
  })

  it('rebinding (RLTP-VTI-7110, 7120): a failed deposit waits; C rotates its key; the renewal resolves the new key and the waiting document arrives sealed to it', async () => {
    // the mediator's tokens on the device clock: the renewal below is a renewal, not a clock skew
    const clock = virtualClock(Date.now(), 'UTC')
    const med = mediatorDouble(undefined, () => clock.now())
    const { A, B, alice, bob, wireA, wireB, flush } = await pairOn(med, clock)
    med.sockets.get(B.ids.conn.did)!.close()
    await flush()
    const envelope = rand(48)
    const id = bob.submit(envelope, clock.now())
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
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...envelope]])
    expect(med.dropped.filter((d) => d.why === 'not openable with the current key')).toEqual([])
    void A
    close(alice, bob, wireA, wireB)
  })

  it('fallback (RLTP-VTI-3120): in egress-session the inner message alone goes on the egress identity’s send-only session, opened at the first such deposit; nothing is acked from it', async () => {
    const med = mediatorDouble()
    const { A, B, alice, bob, wireA, wireB, clock, flush } = await pair(med, { restoredB: { concluded: [], pending: [], send: { mode: 'egress-session', open: [] } } })
    expect(bob.sendMode).toBe('egress-session')
    expect(med.sockets.has(B.ids.egress.did)).toBe(false)
    const envelope = rand(40)
    bob.submit(envelope, clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...envelope]])
    expect(med.direct).toEqual([{ session: B.ids.egress.did, sender: B.ids.egress.did, receiver: A.ids.conn.did }])
    expect(med.forwarded).toEqual([])
    expect(wireB.sentFrames()[0]).toMatchObject({ mode: 'egress-session', outer: null })
    expect(med.sent.filter((f) => f.did === B.ids.egress.did)).toEqual([])
    // closed under it: reopened after the backoff (device time), the next deposit goes on it
    med.sockets.get(B.ids.egress.did)!.close()
    await flush()
    clock.advance(50)
    await flush()
    bob.submit(rand(24), clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(1)
    expect(med.opened.filter((d) => d === B.ids.egress.did)).toHaveLength(2)
    close(alice, bob, wireA, wireB)
  })

  it('queueEmpty (RLTP-VTI-7150): false right after the open and after a frame, true on an open socket quiet for QUIET_MS of device time', async () => {
    const med = mediatorDouble()
    const { alice, bob, wireA, wireB, clock, flush } = await pair(med)
    expect(wireA.queueEmpty()).toBe(false)
    await quiet(clock, flush)
    expect(wireA.queueEmpty()).toBe(true)
    bob.submit(rand(32), clock.now())
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
    const id = bob.submit(rand(32), clock.now())
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
      bob.submit(rand(32), clock.now())
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
    const foreign = await tspPack(rand(40), X.ids.egress.did, A.ids.conn.did, { senderSigningKey: X.ids.egress.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
    const t1 = med.deliver(A.ids.conn.did, foreign.bytes)
    await flush()
    const good = await tspPack(rand(40), B.ids.egress.did, A.ids.conn.did, { senderSigningKey: B.ids.egress.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
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

  it('the switch end to end (RLTP-VTI-3130): a mediator that carries no routed frames, a quiet queue, the deadline; then the egress session carries the next document', async () => {
    const med = mediatorDouble()
    med.faults.dropRouted = true
    const { B, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    const gate = { closed: false, handOver: async (_e: unknown, _w: number, start: () => boolean) => start() }
    const entry = { digest: 'doc-1', kind: 'document' as const, envelope: { b: 'x' }, type: 't', threadId: 't', recipient: {}, attempt: 0, since: clock.now(), notAfter: clock.now() + 10 * 72 * 3_600_000 }
    bob.reconcile({ ok: true, commitSeq: '1', at: clock.now(), entries: [entry] } as never, gate as never, clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items).toHaveLength(0)
    await quiet(clock, flush)
    bob.conclude(bob.collect(clock.now()), clock.now())
    clock.advance(72 * 3_600_000)
    bob.advance(clock.now())
    expect(bob.sendMode).toBe('egress-session')
    const second = rand(32)
    bob.submit(second, clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...second]])
    expect(med.direct.at(-1)?.session).toBe(B.ids.egress.did)
    close(alice, bob, wireA, wireB)
  })

  it('a frame the adapter did not take keeps queueEmpty false until the mediator offers it again at the next open and the adapter takes it', async () => {
    const med = mediatorDouble()
    const { A, alice, bob, wireA, wireB, clock, flush } = await pair(med)
    expect(await A.consumer!(new Uint8Array(16 * 1024 * 1024))).toBe(true)
    const envelope = rand(32)
    bob.submit(envelope, clock.now())
    await bob.settle()
    await flush()
    await quiet(clock, flush)
    expect(wireA.queueEmpty()).toBe(false)
    const c = alice.collect(clock.now())
    expect(c.items).toHaveLength(1)
    alice.conclude(c, clock.now())
    await alice.settle()
    med.sockets.get(A.ids.conn.did)!.close()
    await flush()
    clock.advance(50)
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...envelope]])
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
    const envelope = rand(32)
    bob.submit(envelope, clock.now())
    await bob.settle()
    await flush()
    expect(alice.collect(clock.now()).items.map((i) => [...i.bytes])).toEqual([[...envelope]])
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

  it('RLTP-VTI-1227: a counterpart identity that is one of this side’s own is refused at construction', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did)
    const B = await side(med.did)
    const base = { rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, clock, net: med.net }
    for (const [peerDid, peerEgressDid] of [
      [A.ids.conn.did, B.ids.egress.did],
      [B.ids.conn.did, A.ids.egress.did],
      [B.ids.conn.did, A.ids.conn.did],
      [A.ids.conn.did, A.ids.egress.did],
    ] as const) {
      await expect(createVtiWire({ ...base, peerDid, peerEgressDid })).rejects.toThrow(/RLTP-VTI-1227/)
    }
    const fine: VtiWire = await createVtiWire({ ...base, peerDid: B.ids.conn.did, peerEgressDid: B.ids.egress.did })
    expect(fine.connectionDid).toBe(A.ids.conn.did)
    fine.close()
  })

  it('offline() follows the platform network; without a network port it is never offline', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did)
    const B = await side(med.did)
    let net: 'online' | 'offline' | 'unknown' = 'online'
    const w = await createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, peerDid: B.ids.conn.did, peerEgressDid: B.ids.egress.did, clock, net: med.net, network: () => net })
    expect(w.offline()).toBe(false)
    net = 'offline'
    expect(w.offline()).toBe(true)
    const v = await createVtiWire({ rootIkm: A.root, mediatorDid: med.did, nonce: A.nonce, peerDid: B.ids.conn.did, peerEgressDid: B.ids.egress.did, clock, net: med.net })
    expect(v.offline()).toBe(false)
    close(w, v)
  })
})

/** The session lifecycle is one unit for both identities (wire.ts sessionUnit): each rule holds for the
 *  connection DID (pickup, renewed by the adapter instance) and for the egress identity (send-only,
 *  opened by a deposit in egress-session). A rig drives one identity: `kick` is what the carrier does
 *  every tick of five seconds, `needsHandshake` brings the identity to where its next step authenticates. */
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
async function rig(kind: 'connection' | 'egress', fetchHold?: Promise<void>): Promise<Rig> {
  const clock = virtualClock(Date.now(), 'UTC')
  const base = mediatorDouble(undefined, () => clock.now())
  let net: 'online' | 'offline' = 'online'
  let holding = false
  const realFetch = base.net.fetch
  const med = fetchHold ? Object.assign(base, { net: { ...base.net, fetch: (async (...a: Parameters<typeof fetch>) => (holding ? await fetchHold : undefined, realFetch(...a))) as typeof fetch } }) : base
  const egress = kind === 'egress'
  const p = await pairOn(med, clock, () => net, { networkOf: egress ? 'B' : 'A', ...(egress ? { restoredB: { concluded: [], pending: [], send: { mode: 'egress-session', open: [] } } } : {}) })
  const driven = egress ? p.bob : p.alice
  let submitted = false
  const did = egress ? p.B.ids.egress.did : p.A.ids.conn.did
  return {
    did,
    clock,
    med,
    flush: p.flush,
    wire: egress ? p.wireB : p.wireA,
    setNet: (n) => void (net = n),
    async needsHandshake() {
      holding = true
      if (egress) return
      // the connection DID: its token expired and its socket gone, the next renewal authenticates
      clock.advance(601_000)
      med.sockets.get(did)?.close()
      await p.flush()
    },
    async kick() {
      // the egress identity: one document waits, every tick's advance attempts it again
      if (egress && !submitted) driven.submit(rand(16), clock.now())
      submitted = true
      if (!egress) driven.register([], clock.now())
      driven.advance(clock.now())
      await driven.settle()
      await p.flush()
    },
    close: () => close(p.alice, p.bob, p.wireA, p.wireB),
  }
}
const handshakes = (r: Rig) => r.med.counts.auths.get(r.did) ?? 0

describe.each(['connection', 'egress'] as const)('the session lifecycle of the %s identity', (kind) => {
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
