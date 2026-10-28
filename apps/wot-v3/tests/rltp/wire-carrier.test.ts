// @vitest-environment node
// The custody lease of the VTI mediator (src/adapters/rltp/carrier-mediator.ts, TRANSPORT.md "The VTI
// mediator") on its own: synthesized contact views with real delivery hints, a fake opening (a gate that
// says yes, an ack store in a map), the real wire over the mediator double. What carries, what does not,
// the chaining, the ack state across instances, the routing of a contact's documents, the generation.
import { describe, expect, it, vi } from 'vitest'
import { deliveryHint, wrapSealed, type AckState } from '@real-life/trust-protocol/adapters/vti-mediator'
import { pack as tspPack } from '@openvtc/vti-tsp-js'
import { mediatorTransport, shortDid } from '../../src/adapters/rltp/carrier-mediator'
import type { CarrierOpening, CustodyLease, TransportHandlers } from '../../src/adapters/rltp/transport'
import { WireError } from '@real-life/trust-protocol/adapters/vti-mediator'
import { deriveWireIdentities, type VtiWire } from '../../src/adapters/rltp/wire'
import { mediatorDouble, remark, type MediatorDouble } from '../../harness/mediator-double'
import { fakeNetwork, virtualClock, type VirtualClock } from '../../src/platform/fake'
import type { DiagnosticCode } from '../../src/port/diagnostics'

type ContactView = Parameters<CustodyLease['carry']>[0][number]
type TransportView = Parameters<CustodyLease['reconcile']>[0]
type TransportEntry = TransportView['entries'][number]
type DeliveryReport = Parameters<TransportHandlers['report']>[0]

const b64u = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const turn = () => new Promise((r) => setTimeout(r, 0))

interface Side {
  root: Uint8Array
  nonce: Uint8Array
  hint: string
}
async function side(did: string, fill: number): Promise<Side> {
  const root = new Uint8Array(64).fill(fill)
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  return { root, nonce, hint: await deliveryHint(root, did, nonce) }
}

/** a contact of `self` whose relationship `relId` was opened with `peer`'s hints */
const contact = (id: string, rels: { id: string; self: Side; peerHints?: string[]; chainedFrom?: string[] }[]): ContactView =>
  ({
    id,
    aliases: [],
    relationships: rels.map((r) => ({ id: r.id, tuples: 1, chainedFrom: r.chainedFrom ?? [], carrierNonce: { nonce: b64u(r.self.nonce), generation: '1' }, ...(r.peerHints ? { counterpartDeliveryHints: r.peerHints } : {}) })),
  }) as unknown as ContactView

/** the seal vector's public test key: the seals below are of the schema's form, nobody opens them */
const RKID = 'z6LStLK2kxribiLHz6U4vpGfzMtmgc4q5WjR4mvhS6KG1W16'
/** a sealed envelope of the Delivery Contract's form, a function of `tag` (the adapter refuses any other) */
const sealFor = (tag: string) => {
  const bytes = (n: number, k: number) => Uint8Array.from({ length: n }, (_, i) => (tag.charCodeAt(i % tag.length) * 31 + i * 7 + k) & 0xff)
  return { rkid: RKID, epk: b64u(bytes(32, 1)), nonce: b64u(bytes(12, 2)), ciphertext: b64u(bytes(24, 3)) }
}
const entry = (digest: string, contactId: string, at: number): TransportEntry =>
  ({ digest, kind: 'document', envelope: sealFor(digest), type: 't', threadId: 't', recipient: { contactId, rkid: 'r', keyAgreement: 'k' }, attempt: 1, since: at, notAfter: at + 86_400_000 }) as unknown as TransportEntry
const view = (entries: TransportEntry[], at: number): TransportView => ({ ok: true, commitSeq: '1', at, entries, answerable: [] }) as unknown as TransportView

function opening(root: Uint8Array, clock: VirtualClock, acks = new Map<string, unknown>(), answeredByHolder = new Set<string>()) {
  const diagnosed: DiagnosticCode[] = []
  const details: (string | undefined)[] = []
  const handedOver: string[] = []
  const o: CarrierOpening = {
    answered: async (ds) => ds.filter((d) => answeredByHolder.has(d)),
    record: async () => undefined,
    rootIkm: root,
    gate: {
      handOver: async (e, _w, start) => {
        handedOver.push(e.digest)
        return start()
      },
    },
    acks: { get: async (k) => acks.get(k), put: async (k, v) => void (v === null ? acks.delete(k) : acks.set(k, v)) },
    when: () => clock.now(),
    offer: () => undefined,
    // no card is displayed in these tests
    receiveAtCard: async () => ({ answer: 'taken', recorded: null }),
    diagnose: (code, detail) => {
      diagnosed.push(code)
      details.push(detail)
    },
  }
  return { o, acks, diagnosed, details, handedOver }
}

function handlers() {
  const reports: DeliveryReport[] = []
  const h: TransportHandlers = { envelope: async () => 'taken', report: (r) => reports.push(r) }
  return { h, reports }
}

async function rest(med: MediatorDouble, ...leases: CustodyLease[]) {
  for (let calm = 0; calm < 3; ) {
    await med.settled()
    await turn()
    calm = leases.every((l) => l.busy() === 0) ? calm + 1 : 0
  }
}

describe('the custody lease of the VTI mediator', () => {
  it('direct (RLTP-VTI-3120, §5): a mediator that refuses direct delivery (e.p.direct_delivery.denied) answers the session with a problem report; it is diagnosed, and every later document of the relationship waits as a retriable carrier refusal, nothing more goes out', async () => {
    const med = mediatorDouble()
    med.faults.refuseDirect = true
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'direct', open: [] } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, diagnosed, details } = opening(A.root, clock, store)
    const r = handlers()
    lease.start(r.h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    expect(lease.carriage.get().contacts['c-b']).toBe('direct')
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    // the refused deposit had already left: accepted, and the mediator's answer is the problem report
    expect(r.reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
    // the report is unpacked by the session: the wire counts it as work, so rest() waits for it
    expect(diagnosed).toEqual(['wire-deposit-refused'])
    expect(details).toEqual(['direct/e.p.direct_delivery.denied locked'])
    lease.reconcile(view([entry('d-1', 'c-b', t), entry('d-2', 'c-b', t)], clock.now()))
    await rest(med, lease)
    expect(r.reports).toContainEqual({ digest: 'd-2', status: 'awaiting-transport', reason: 'carrier-refused-retriable' })
    expect(med.dropped.filter((d) => d.why === 'e.p.direct_delivery.denied')).toHaveLength(1)
    expect(med.direct).toEqual([])
    await lease.stop()
  })

  it('direct (RLTP-VTI-3120): the refusal of direct delivery is recorded in the send state at receipt; after one deposit and a restart (a new wire, the restored ack state) nothing is deposited, the document waits as a retriable carrier refusal, and the contact shows the refusal', async () => {
    const med = mediatorDouble()
    med.faults.refuseDirect = true
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'direct', open: [] } }]])
    const carrier = mediatorTransport({ did: med.did, clock, net: med.net })
    const rel = [contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])]
    const first = carrier.lease()
    const r1 = handlers()
    first.start(r1.h, opening(A.root, clock, store).o)
    first.activate()
    first.carry(rel)
    await rest(med, first)
    const t = clock.now()
    first.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, first)
    expect(r1.reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
    // recorded when the report arrives, before any later deposit: in the ack state and in the carriage
    expect((store.get('r-b') as AckState).send?.directRefusedAt).toBeTypeOf('number')
    expect(first.carriage.get().contacts['c-b']).toBe('direct-refused')
    await first.stop()
    expect(med.dropped.filter((d) => d.why === 'e.p.direct_delivery.denied')).toHaveLength(1)
    // the next opening: a new wire, the restored ack state
    med.faults.refuseDirect = false
    const second = carrier.lease()
    const r2 = handlers()
    second.start(r2.h, opening(A.root, clock, store).o)
    second.activate()
    second.carry(rel)
    await rest(med, second)
    expect(second.carriage.get().contacts['c-b']).toBe('direct-refused')
    second.reconcile(view([entry('d-2', 'c-b', clock.now())], clock.now()))
    await rest(med, second)
    expect(r2.reports).toEqual([{ digest: 'd-2', status: 'awaiting-transport', reason: 'carrier-refused-retriable' }])
    // no deposit: nothing more refused, nothing relayed
    expect(med.dropped.filter((d) => d.why === 'e.p.direct_delivery.denied')).toHaveLength(1)
    expect(med.direct).toEqual([])
    await second.stop()
  })

  it('direct (RLTP-VTI-3120, VTI §6): a stop right after the report, before the instance advanced, still stores the refusal (the close reads the ack state, which reads the wire); the next opening deposits nothing', async () => {
    const med = mediatorDouble()
    med.faults.refuseDirect = true
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'direct', open: [] } }]])
    const carrier = mediatorTransport({ did: med.did, clock, net: med.net })
    const rel = [contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])]
    const first = carrier.lease()
    const one = opening(A.root, clock, store)
    // the stop comes from inside the report's diagnosis: before the advance the carrier plans for it
    let stopped: Promise<void> | null = null
    const diagnose = one.o.diagnose
    one.o = { ...one.o, diagnose: (code, detail) => {
      diagnose(code, detail)
      if (code === 'wire-deposit-refused' && !stopped) stopped = first.stop()
    } }
    first.start(handlers().h, one.o)
    first.activate()
    first.carry(rel)
    await rest(med, first)
    const t = clock.now()
    first.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, first)
    expect(stopped).not.toBeNull()
    await stopped
    expect((store.get('r-b') as AckState).send?.directRefusedAt).toBeTypeOf('number')
    med.faults.refuseDirect = false
    const second = carrier.lease()
    const r2 = handlers()
    second.start(r2.h, opening(A.root, clock, store).o)
    second.activate()
    second.carry(rel)
    await rest(med, second)
    second.reconcile(view([entry('d-2', 'c-b', clock.now())], clock.now()))
    await rest(med, second)
    expect(r2.reports).toEqual([{ digest: 'd-2', status: 'awaiting-transport', reason: 'carrier-refused-retriable' }])
    expect(med.direct).toEqual([])
    await second.stop()
  })

  it('a problem report on the session is work until the session has read it: busy() counts it, so rest() returns only after the report was diagnosed', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const a = await deriveWireIdentities(A.root, med.did, A.nonce)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'direct', open: [] } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, diagnosed } = opening(A.root, clock, store)
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    expect(med.direct).toHaveLength(1)
    // the report is on the connection DID's socket; the session unpacks it off the event loop
    await med.report(a.conn.did, 'e.p.delivery.refused')
    expect(diagnosed).toEqual([])
    expect(lease.busy()).toBeGreaterThan(0)
    await rest(med, lease)
    expect(diagnosed).toEqual(['wire-deposit-refused'])
    expect(lease.busy()).toBe(0)
    await lease.stop()
  })

  it('direct (RLTP-VTI-3120, §5): any other problem report on the session (e.p.delivery.refused) is diagnosed and consumed; the next document goes out and arrives', async () => {
    const med = mediatorDouble()
    med.faults.refuseNextDirect = 'e.p.delivery.refused'
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'direct', open: [] } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, diagnosed, details } = opening(A.root, clock, store)
    const r = handlers()
    lease.start(r.h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    expect(diagnosed).toEqual(['wire-deposit-refused'])
    expect(details).toEqual(['direct/e.p.delivery.refused'])
    lease.reconcile(view([entry('d-1', 'c-b', t), entry('d-2', 'c-b', t)], clock.now()))
    await rest(med, lease)
    expect(r.reports).toContainEqual({ digest: 'd-2', status: 'accepted' })
    expect(med.direct).toHaveLength(1)
    await lease.stop()
  })

  it('direct (RLTP-VTI-3120): a problem report e.p.direct_delivery.denied from another sender than the mediator, or a message of another type from the mediator, locks nothing and is not diagnosed; the next document goes out', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const X = await side(med.did, 3)
    const a = await deriveWireIdentities(A.root, med.did, A.nonce)
    const x = await deriveWireIdentities(X.root, med.did, X.nonce)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'direct', open: [] } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, diagnosed } = opening(A.root, clock, store)
    const r = handlers()
    lease.start(r.h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    expect(med.direct).toHaveLength(1)
    // a third party's report, authcrypt under its own key; a status message of the mediator with the code
    await med.report(a.conn.did, 'e.p.direct_delivery.denied', { from: { did: x.conn.did, kid: x.conn.kid, xSecret: x.conn.xSecret } })
    await med.report(a.conn.did, 'e.p.direct_delivery.denied', { type: 'https://didcomm.org/messagepickup/3.0/status' })
    // the mediator's own report of another code is consumed (the control: a report that does reach the wire)
    await med.report(a.conn.did, 'e.p.delivery.refused')
    await rest(med, lease)
    expect(diagnosed).toEqual(['wire-deposit-refused'])
    lease.reconcile(view([entry('d-1', 'c-b', t), entry('d-2', 'c-b', t)], clock.now()))
    await rest(med, lease)
    expect(r.reports).toContainEqual({ digest: 'd-2', status: 'accepted' })
    expect(med.direct).toHaveLength(2)
    expect(diagnosed).toEqual(['wire-deposit-refused'])
    await lease.stop()
  })

  it('a frame of another TSP version at a carried relationship (Rev 3, VTI 0.29 Open Issue 14): diagnosed with its version and its sender shortened, acknowledged, never handed to the holder; a 1.0 frame behind it is (RLTP-VTI-7140)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const a = await deriveWireIdentities(A.root, med.did, A.nonce)
    const b = await deriveWireIdentities(B.root, med.did, B.nonce)
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, diagnosed, details } = opening(A.root, clock)
    const received: unknown[] = []
    const h: TransportHandlers = { envelope: async (env) => (received.push(env), 'taken'), report: () => undefined }
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed' })
    // a carried document from the counterpart's connection DID, as its adapter wraps it (RLTP-VTI-3150)
    const frame = async (seal: ReturnType<typeof sealFor>) => tspPack((await wrapSealed(seal, { issuer: b.conn.did, recipient: a.conn.did, since: clock.now() })).bytes, b.conn.did, a.conn.did, { senderSigningKey: b.conn.edSecret, receiverEncryptionKey: a.conn.xPublic })
    const rev3Text = med.deliver(a.conn.did, remark((await frame(sealFor('old'))).bytes))
    await rest(med, lease)
    expect(received).toEqual([])
    expect(diagnosed).toEqual(['wire-frame-refused'])
    expect(details).toEqual([`frame/version Rev 3 (YTSP-AAC) sender ${shortDid(b.conn.did)}`])
    expect(details[0]).not.toContain(b.conn.did)
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rev3Text)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    expect(await med.ackedBy(a.conn.did)).toContain(id)
    med.deliver(a.conn.did, (await frame(sealFor('new'))).bytes)
    await rest(med, lease)
    expect(received).toEqual([sealFor('new')])
    await lease.stop()
  })

  it('carries a relationship with a readable hint of the counterpart; one without hints or with a hint for another carrier is not carried and its documents are reported awaiting-transport once per generation (RLTP-VTI-1225, 1235)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const other = await side('did:example:another-mediator', 3)
    const lease = mediatorTransport({ did: med.did, clock, net: med.net, network: fakeNetwork() }).lease()
    const { o } = opening(A.root, clock)
    const { h, reports } = handlers()
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }]), contact('c-none', [{ id: 'r-none', self: A }]), contact('c-other', [{ id: 'r-other', self: A, peerHints: [other.hint] }])])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed', 'c-none': 'no-hint', 'c-other': 'hint-unreadable' })
    expect(lease.status.get().carrier).toBe('connected')
    const t = clock.now()
    const v = view([entry('d-none', 'c-none', t), entry('d-other', 'c-other', t)], t)
    lease.reconcile(v)
    lease.reconcile(v)
    await rest(med, lease)
    expect(reports).toEqual([
      { digest: 'd-none', status: 'awaiting-transport', reason: 'transport-unreachable' },
      { digest: 'd-other', status: 'awaiting-transport', reason: 'transport-unreachable' },
    ])
    expect(med.forwarded).toEqual([])
    await lease.stop()
  })

  it('busy() counts the adapter’s own work: a deposit whose carried document is still being hashed (SHA-256 off the event loop) keeps the lease busy until it went out', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o } = opening(A.root, clock)
    const { h, reports } = handlers()
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    // a loaded machine: every digest takes eight turns of the event loop (the carried document's id is a
    // SHA-256 the adapter awaits before the deposit, RLTP-VTI-3150)
    const subtle = globalThis.crypto.subtle
    const digest = subtle.digest.bind(subtle)
    const slow = vi.spyOn(subtle, 'digest').mockImplementation(async (...a: Parameters<SubtleCrypto['digest']>) => {
      for (let i = 0; i < 8; i++) await turn()
      return digest(...a)
    })
    try {
      const t = clock.now()
      lease.reconcile(view([entry('d-1', 'c-b', t)], t))
      await rest(med, lease)
      expect(med.forwarded).toHaveLength(1)
      expect(reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
    } finally {
      slow.mockRestore()
    }
    await lease.stop()
  })

  it('a contact’s documents go through one relationship only, the first carried; deposits are reported accepted in order', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A1 = await side(med.did, 1)
    const A2 = { ...(await side(med.did, 1)) }
    const B1 = await side(med.did, 2)
    const B2 = await side(med.did, 2)
    const seen: string[] = []
    const lease = mediatorTransport({
      did: med.did,
      clock,
      net: med.net,
      seam: (w, relId) => ({ ...w, deposit: (...a) => (seen.push(relId), w.deposit(...a)) }) as VtiWire,
    }).lease()
    const { o, handedOver } = opening(A1.root, clock)
    const { h, reports } = handlers()
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-1', self: A1, peerHints: [B1.hint] }, { id: 'r-2', self: A2, peerHints: [B2.hint] }])])
    await rest(med, lease)
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    expect(handedOver).toEqual(['d-1'])
    expect(seen).toEqual(['r-1'])
    expect(reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
    expect(med.dropped).toEqual([])
    expect(med.forwarded).toHaveLength(1)
    await lease.stop()
  })

  it('a relationship chained into another closes its instance, drops its ack state and gets no successor; the chain is carried under its first N (§6, RLTP-VTI-1230)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const later = await side(med.did, 1)
    const Bl = await side(med.did, 2)
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, acks } = opening(A.root, clock)
    lease.start(handlers().h, o)
    lease.activate()
    // a later enactment of the same contact: its own relationship, carried until the chaining
    lease.carry([contact('c-b', [{ id: 'r-first', self: A, peerHints: [B.hint] }]), contact('c-b2', [{ id: 'r-later', self: later, peerHints: [Bl.hint] }])])
    await rest(med, lease)
    expect([...acks.keys()].sort()).toEqual(['r-first', 'r-later'])
    const sockets = med.openSockets.bind(med)
    const opened = med.opened.length
    lease.carry([contact('c-b', [{ id: 'r-first', self: A, peerHints: [B.hint], chainedFrom: ['r-later'] }])])
    await rest(med, lease)
    expect([...acks.keys()]).toEqual(['r-first'])
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed' })
    expect(med.opened.length).toBe(opened)
    // a view that lists the chained relationship again never revives it
    lease.carry([contact('c-b', [{ id: 'r-first', self: A, peerHints: [B.hint], chainedFrom: ['r-later'] }]), contact('c-b2', [{ id: 'r-later', self: later, peerHints: [Bl.hint] }])])
    await rest(med, lease)
    expect([...acks.keys()]).toEqual(['r-first'])
    void sockets
    await lease.stop()
  })

  it('the ack state survives the instance: a switch to direct (routed-refused) is persisted, restored by the next opening, and never returns to routed', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const carrier = mediatorTransport({
      did: med.did,
      clock,
      net: med.net,
      seam: (w) => ({ ...w, deposit: (t, b, m) => (m === 'routed' ? Promise.reject(new WireError('routed-refused')) : w.deposit(t, b, m)) }) as VtiWire,
    })
    const store = new Map<string, unknown>()
    const first = carrier.lease()
    const one = opening(A.root, clock, store)
    const r1 = handlers()
    first.start(r1.h, one.o)
    first.activate()
    const rel = [contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])]
    first.carry(rel)
    await rest(med, first)
    const t = clock.now()
    first.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, first)
    expect(r1.reports).toEqual([{ digest: 'd-1', status: 'awaiting-transport', reason: 'carrier-refused-retriable' }])
    expect(first.carriage.get().contacts['c-b']).toBe('direct')
    await first.stop()
    expect((store.get('r-b') as AckState).send).toEqual({ mode: 'direct', open: [] })
    // the next opening restores it: the held document goes on the connection DID's session
    const second = carrier.lease()
    const two = opening(A.root, clock, store)
    const r2 = handlers()
    second.start(r2.h, two.o)
    second.activate()
    second.carry(rel)
    await rest(med, second)
    expect(second.carriage.get().contacts['c-b']).toBe('direct')
    second.reconcile(view([entry('d-1', 'c-b', t)], clock.now()))
    await rest(med, second)
    expect(r2.reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
    expect(med.direct).toHaveLength(1)
    // direct under TSP 1.0 (VTI 0.29 §7): the frame on the connection DID's session declares 1.0
    expect(med.frames.filter((f) => f.session === med.direct[0]!.session).map((f) => f.version)).toEqual(['TSP 1.0 (YTSP-BAA)'])
    await second.stop()
  })

  it('an ack state the 3.0.0 build stored in mode egress-session (lib 0.9) is restored as direct: the document goes out alone on the connection DID’s session, and the next write stores direct; one with the refusal of direct delivery stays refused', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const a = await deriveWireIdentities(A.root, med.did, A.nonce)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'egress-session', open: [] } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const r = handlers()
    lease.start(r.h, opening(A.root, clock, store).o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    expect(lease.carriage.get().contacts['c-b']).toBe('direct')
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    expect(r.reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
    expect(med.direct).toEqual([expect.objectContaining({ session: a.conn.did, sender: a.conn.did })])
    expect((store.get('r-b') as AckState).send?.mode).toBe('direct')
    await lease.stop()
    // the lib 0.9 fixture with a recorded refusal (lib test/adapter-fixtures/ack-state-direct-refused-lib-0.9.json)
    const refused = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'egress-session', open: [], directRefusedAt: 1000 } }]])
    const second = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const r2 = handlers()
    second.start(r2.h, opening(A.root, clock, refused).o)
    second.activate()
    second.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, second)
    expect(second.carriage.get().contacts['c-b']).toBe('direct-refused')
    second.reconcile(view([entry('d-2', 'c-b', clock.now())], clock.now()))
    await rest(med, second)
    expect(r2.reports).toEqual([{ digest: 'd-2', status: 'awaiting-transport', reason: 'carrier-refused-retriable' }])
    expect(med.direct).toHaveLength(1)
    await second.stop()
  })

  it('a persisted ack state the library refuses leaves the relationship not carried in this opening, with a diagnostic; it is never replaced by a fresh one (fail-closed)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'routed', open: [], extra: 1 } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o, diagnosed } = opening(A.root, clock, store)
    const { h, reports } = handlers()
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    expect(diagnosed).toEqual(['carrier-ack-state-refused'])
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'ack-state-refused' })
    expect(store.get('r-b')).toEqual({ concluded: [], pending: [], send: { mode: 'routed', open: [], extra: 1 } })
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    expect(reports).toEqual([{ digest: 'd-1', status: 'awaiting-transport', reason: 'transport-unreachable' }])
    expect(med.opened).toEqual([])
    await lease.stop()
  })

  it('a generation ends at deactivate: instances close, an outcome that resolves later reaches no handler, and the next activation builds anew', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    let release: () => void = () => undefined
    const held = new Promise<void>((r) => (release = r))
    const lease = mediatorTransport({ did: med.did, clock, net: med.net, seam: (w) => ({ ...w, deposit: async (...a) => (await held, w.deposit(...a)) }) as VtiWire }).lease()
    const { o } = opening(A.root, clock)
    const { h, reports } = handlers()
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await med.settled()
    await turn()
    lease.deactivate()
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'not-carried' })
    release()
    await rest(med, lease)
    expect(reports).toEqual([])
    lease.activate()
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed' })
    await lease.stop()
  })

  it('restored with an open deposit the holder already answered (a crash cut off the ack state write): the instance answers it before its first advance, and 72 h of quiet switch nothing', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const t0 = clock.now()
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'routed', open: [{ digest: 'd-answered', acceptedAt: t0 }] } }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o } = opening(A.root, clock, store, new Set(['d-answered']))
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    expect(lease.carriage.get().open).toBe(0)
    for (let i = 0; i < 4; i++) {
      clock.advance(19 * 3_600_000)
      await rest(med, lease)
    }
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed' })
    await lease.stop()
  })

  it('a relationship already chained at the opening has its ack state deleted, though no instance of it runs', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>([['r-later', { concluded: [], pending: [] }]])
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const { o } = opening(A.root, clock, store)
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-first', self: A, peerHints: [B.hint], chainedFrom: ['r-later'] }])])
    await rest(med, lease)
    expect(store.has('r-later')).toBe(false)
    await lease.stop()
  })

  it('a restore never reads behind a write: deactivate and activate while the close’s write is still held, the next instance reads what that write stored', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const store = new Map<string, unknown>()
    let hold: (() => void) | null = null
    const lease = mediatorTransport({ did: med.did, clock, net: med.net, seam: (w) => ({ ...w, deposit: (t, b, m) => (m === 'routed' ? Promise.reject(new WireError('routed-refused')) : w.deposit(t, b, m)) }) as VtiWire }).lease()
    const base = opening(A.root, clock, store)
    let gets = 0
    const o: CarrierOpening = { ...base.o, acks: { get: (k) => (lease.carriage.get().contacts['c-b'] === 'starting' && hold ? gets++ : 0, base.o.acks.get(k)), put: async (k, v) => (hold ? await new Promise<void>((r) => { const go = hold!; hold = () => { go(); r() } }) : undefined, base.o.acks.put(k, v)) } }
    const { h } = handlers()
    lease.start(h, o)
    lease.activate()
    const rel = [contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])]
    lease.carry(rel)
    await rest(med, lease)
    // from here every ack state write is held: the switch reaches the store only when released
    let released = false
    hold = () => void (released = true)
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await med.settled()
    for (let i = 0; i < 20; i++) await turn()
    expect(lease.carriage.get().contacts['c-b']).toBe('direct')
    // the next generation's restore asks for the ack state while the write is still held
    const opened = med.opened.length
    lease.deactivate()
    lease.activate()
    // the restore runs up to its read and waits there: no wire of it opens before the write is let go
    for (let i = 0; i < 200; i++) await turn()
    expect(lease.carriage.get().contacts['c-b']).toBe('starting')
    expect(med.opened.length).toBe(opened)
    expect(gets).toBe(0)
    hold!()
    hold = null
    await rest(med, lease)
    expect(released).toBe(true)
    expect(lease.carriage.get().contacts['c-b']).toBe('direct')
    await lease.stop()
  })

  it('a build that fails for a transient reason is planned again on the device clock, without a new view', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const base = opening(A.root, clock)
    let fail = true
    const o: CarrierOpening = { ...base.o, acks: { get: async (k) => (fail ? ((fail = false), Promise.reject(new Error('storage'))) : base.o.acks.get(k)), put: base.o.acks.put } }
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'starting' })
    clock.advance(5000)
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed' })
    await lease.stop()
  })

  it('stop waits for the ack state writes at most the drain limit of device time (rule 4)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const base = opening(A.root, clock)
    let hang = false
    const o: CarrierOpening = { ...base.o, acks: { get: base.o.acks.get, put: (k, v) => (hang ? new Promise<void>(() => undefined) : base.o.acks.put(k, v)) } }
    const lease = mediatorTransport({ did: med.did, clock, net: med.net, seam: (w) => ({ ...w, deposit: () => Promise.reject(new WireError('routed-refused')) }) as VtiWire }).lease()
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    hang = true
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    let stopped = false
    const s = lease.stop().then(() => (stopped = true))
    await turn()
    expect(stopped).toBe(false)
    clock.advance(2000)
    await s
    expect(stopped).toBe(true)
  })

  it('a deposit in a mode the store does not hold waits for the write and, if the write fails, is later (rule 1): nothing goes out in direct until the switch is stored', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    let failWrites = false
    const lease = mediatorTransport({
      did: med.did,
      clock,
      net: med.net,
      seam: (w) => ({ ...w, deposit: (t, b, m) => (m === 'routed' ? Promise.reject(new WireError('routed-refused')) : w.deposit(t, b, m)) }) as VtiWire,
      ackSeam: (st) => ({ get: st.get, put: (k, v) => (failWrites ? Promise.reject(new Error('storage')) : st.put(k, v)) }),
    }).lease()
    const { o } = opening(A.root, clock)
    const { h, reports } = handlers()
    lease.start(h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    await rest(med, lease)
    failWrites = true
    const t = clock.now()
    lease.reconcile(view([entry('d-1', 'c-b', t)], t))
    await rest(med, lease)
    clock.advance(5000)
    await rest(med, lease)
    expect(lease.carriage.get().contacts['c-b']).toBe('direct')
    expect(med.direct).toEqual([])
    expect(reports.every((r) => r.status === 'awaiting-transport')).toBe(true)
    failWrites = false
    clock.advance(5000)
    await rest(med, lease)
    expect(med.direct).toHaveLength(1)
    expect(reports.at(-1)).toEqual({ digest: 'd-1', status: 'accepted' })
    await lease.stop()
  })

  it('an answer the holder commits while the instance is being built reaches it before its first advance', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const t0 = clock.now()
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'routed', open: [{ digest: 'd-x', acceptedAt: t0 }] } }]])
    const base = opening(A.root, clock, store)
    let release: () => void = () => undefined
    let asked = 0
    const o: CarrierOpening = { ...base.o, answered: async () => (asked++, await new Promise<void>((r) => (release = r)), []) }
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    for (let i = 0; i < 200 && asked === 0; i++) await turn()
    expect(asked).toBe(1)
    // the holder commits B's acknowledgement of d-x now, while the restore asks the holder
    lease.answered(['d-x'])
    release()
    await rest(med, lease)
    expect(lease.carriage.get().open).toBe(0)
    await lease.stop()
  })

  it('a build that fails while the opening ends plans nothing on the clock: no timer of the ended opening stays (LIFECYCLE.md #428)', async () => {
    const med = mediatorDouble()
    const vc = virtualClock(Date.now(), 'UTC')
    let live = 0
    const clock = {
      now: () => vc.now(),
      setTimer(at: number, cb: () => void) {
        live++
        let on = true
        const done = () => {
          if (!on) return
          on = false
          live--
        }
        const cancel = vc.setTimer(at, () => {
          done()
          cb()
        })
        return () => {
          done()
          cancel()
        }
      },
    }
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const base = opening(A.root, vc)
    let fail: (e: Error) => void = () => undefined
    let asked = 0
    const o: CarrierOpening = { ...base.o, acks: { get: () => (asked++, new Promise((_, rej) => (fail = rej))), put: base.o.acks.put } }
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    lease.start(handlers().h, o)
    lease.activate()
    lease.carry([contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])])
    for (let i = 0; i < 200 && asked === 0; i++) await turn()
    expect(asked).toBe(1)
    const stopping = lease.stop()
    vc.advance(2000)
    await stopping
    fail(new Error('store sealed'))
    await rest(med, lease)
    expect(live).toBe(0)
  })

  it('a contact met without a carrier offer (no N) shows the reason "no hint" while a mediator is configured', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    lease.start(handlers().h, opening(A.root, clock).o)
    lease.activate()
    lease.carry([{ id: 'c-old', aliases: [], relationships: [{ id: 'r-old', tuples: 1, chainedFrom: [] }] } as unknown as ContactView])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-old': 'no-hint' })
    await lease.stop()
  })

  it('two builds of one relationship overlap (deactivate, activate while the first still asks the holder): an answer committed during the second reaches its instance', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const t0 = clock.now()
    const store = new Map<string, unknown>([['r-b', { concluded: [], pending: [], send: { mode: 'routed', open: [{ digest: 'd-x', acceptedAt: t0 }] } }]])
    const base = opening(A.root, clock, store)
    const releases: (() => void)[] = []
    const o: CarrierOpening = { ...base.o, answered: async () => (await new Promise<void>((r) => releases.push(r)), []) }
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    lease.start(handlers().h, o)
    lease.activate()
    const rel = [contact('c-b', [{ id: 'r-b', self: A, peerHints: [B.hint] }])]
    lease.carry(rel)
    for (let i = 0; i < 200 && releases.length < 1; i++) await turn()
    lease.deactivate()
    lease.activate()
    for (let i = 0; i < 200 && releases.length < 2; i++) await turn()
    expect(releases).toHaveLength(2)
    // the first build ends (its generation is over), then the holder commits an answer, then the second ends
    releases[0]!()
    for (let i = 0; i < 50; i++) await turn()
    lease.answered(['d-x'])
    releases[1]!()
    await rest(med, lease)
    expect(lease.carriage.get().contacts['c-b']).toBe('routed')
    expect(lease.carriage.get().open).toBe(0)
    await lease.stop()
  })
})

