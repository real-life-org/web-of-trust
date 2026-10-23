// @vitest-environment node
// The custody lease of the VTI mediator (src/adapters/rltp/carrier-mediator.ts, TRANSPORT.md "The VTI
// mediator") on its own: synthesized contact views with real delivery hints, a fake opening (a gate that
// says yes, an ack store in a map), the real wire over the mediator double. What carries, what does not,
// the chaining, the ack state across instances, the routing of a contact's documents, the generation.
import { describe, expect, it } from 'vitest'
import { deliveryHint, type AckState } from '@real-life/trust-protocol/adapters/vti-mediator'
import { mediatorTransport } from '../../src/adapters/rltp/carrier-mediator'
import type { CarrierOpening, CustodyLease, TransportHandlers } from '../../src/adapters/rltp/transport'
import { WireError } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { VtiWire } from '../../src/adapters/rltp/wire'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
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

const entry = (digest: string, contactId: string, at: number): TransportEntry =>
  ({ digest, kind: 'document', envelope: { v: digest }, type: 't', threadId: 't', recipient: { contactId, rkid: 'r', keyAgreement: 'k' }, attempt: 1, since: at, notAfter: at + 86_400_000 }) as unknown as TransportEntry
const view = (entries: TransportEntry[], at: number): TransportView => ({ ok: true, commitSeq: '1', at, entries }) as unknown as TransportView

function opening(root: Uint8Array, clock: VirtualClock, acks = new Map<string, unknown>()) {
  const diagnosed: DiagnosticCode[] = []
  const handedOver: string[] = []
  const o: CarrierOpening = {
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
    diagnose: (code) => diagnosed.push(code),
  }
  return { o, acks, diagnosed, handedOver }
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
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'routed', 'c-none': 'not-carried', 'c-other': 'not-carried' })
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

  it('the ack state survives the instance: a switch to egress-session (routed-refused) is persisted, restored by the next opening, and never returns to routed', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const A = await side(med.did, 1)
    const B = await side(med.did, 2)
    const carrier = mediatorTransport({
      did: med.did,
      clock,
      net: med.net,
      seam: (w) => ({ ...w, deposit: (t, b, e, m) => (m === 'routed' ? Promise.reject(new WireError('routed-refused')) : w.deposit(t, b, e, m)) }) as VtiWire,
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
    expect(first.carriage.get().contacts['c-b']).toBe('egress-session')
    await first.stop()
    expect((store.get('r-b') as AckState).send).toEqual({ mode: 'egress-session', open: [] })
    // the next opening restores it: the held document goes on the egress identity's session
    const second = carrier.lease()
    const two = opening(A.root, clock, store)
    const r2 = handlers()
    second.start(r2.h, two.o)
    second.activate()
    second.carry(rel)
    await rest(med, second)
    expect(second.carriage.get().contacts['c-b']).toBe('egress-session')
    second.reconcile(view([entry('d-1', 'c-b', t)], clock.now()))
    await rest(med, second)
    expect(r2.reports).toEqual([{ digest: 'd-1', status: 'accepted' }])
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
    expect(lease.carriage.get().contacts).toEqual({ 'c-b': 'not-carried' })
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
})
