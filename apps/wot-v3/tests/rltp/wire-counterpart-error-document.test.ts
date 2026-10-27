// @vitest-environment node
// What a counterpart's error document (trust-task-error/0.5, VTI Mediator Adapter Profile 0.28 §5)
// does when it reaches this side today, over the mediator double: this side has an own document
// deposited and open; the counterpart answers with a terminal refusal, a TSP 1.0 `direct` message from
// its egress identity to this side's connection DID. The wire hands it to the adapter, the carrier to
// the holder (which reads no error document and judges it for good); the frame is acknowledged and
// the own document keeps its state: no verdict is applied. The profile leaves validating the document
// (proof, parties, that it answers a document of this side) to the delivery layer; the carrier cannot
// do that alone (TRANSPORT.md "Counterpart error documents"). This test pins that limit.
import { expect, it } from 'vitest'
import { pack as tspPack } from '@openvtc/vti-tsp-js'
import { deliveryHint, readTrustTaskError, TRUST_TASK_ERROR_TYPE } from '@real-life/trust-protocol/adapters/vti-mediator'
import { mediatorTransport } from '../../src/adapters/rltp/carrier-mediator'
import type { CarrierOpening, CustodyLease, TransportHandlers } from '../../src/adapters/rltp/transport'
import { deriveWireIdentities } from '../../src/adapters/rltp/wire'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
import { fakeNetwork, virtualClock } from '../../src/platform/fake'

type ContactView = Parameters<CustodyLease['carry']>[0][number]
type TransportView = Parameters<CustodyLease['reconcile']>[0]
type TransportEntry = TransportView['entries'][number]
type DeliveryReport = Parameters<TransportHandlers['report']>[0]

const b64u = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const turn = () => new Promise((r) => setTimeout(r, 0))
const te = new TextEncoder()

async function side(did: string, fill: number) {
  const root = new Uint8Array(64).fill(fill)
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  return { root, nonce, hint: await deliveryHint(root, did, nonce), ids: await deriveWireIdentities(root, did, nonce) }
}

async function rest(med: MediatorDouble, lease: CustodyLease) {
  for (let calm = 0; calm < 3; ) {
    await med.settled()
    await turn()
    calm = lease.busy() === 0 ? calm + 1 : 0
  }
}

it('a terminal refusal of the counterpart reaches the holder, is acknowledged, and leaves the own open document as it was', async () => {
  const med = mediatorDouble()
  const clock = virtualClock(Date.now(), 'UTC')
  const A = await side(med.did, 1)
  const B = await side(med.did, 2)
  const reports: DeliveryReport[] = []
  const received: unknown[] = []
  const h: TransportHandlers = { envelope: async (env) => (received.push(env), 'taken'), report: (r) => reports.push(r) }
  const o: CarrierOpening = {
    answered: async () => [],
    rootIkm: A.root,
    gate: { handOver: async (_e, _w, start) => start() },
    acks: { get: async () => undefined, put: async () => undefined },
    when: () => clock.now(),
    offer: () => undefined,
    receiveAtCard: async () => ({ answer: 'taken', recorded: null }),
    diagnose: () => undefined,
  }
  const lease = mediatorTransport({ did: med.did, clock, net: med.net, network: fakeNetwork() }).lease()
  lease.start(h, o)
  lease.activate()
  const rel = { id: 'r-b', tuples: 1, chainedFrom: [], carrierNonce: { nonce: b64u(A.nonce), generation: '1' }, counterpartDeliveryHints: [B.hint] }
  lease.carry([{ id: 'c-b', aliases: [], relationships: [rel] } as unknown as ContactView])
  await rest(med, lease)
  const t = clock.now()
  const own = { digest: 'd-own', kind: 'document', envelope: { v: 'd-own' }, type: 't', threadId: 't', recipient: { contactId: 'c-b', rkid: 'r', keyAgreement: 'k' }, attempt: 1, since: t, notAfter: t + 86_400_000 }
  lease.reconcile({ ok: true, commitSeq: '1', at: t, entries: [own as unknown as TransportEntry] } as unknown as TransportView)
  await rest(med, lease)
  expect(reports).toEqual([{ digest: 'd-own', status: 'accepted' }])

  const doc = { type: TRUST_TASK_ERROR_TYPE, payload: { code: 'permissionDenied', retryable: false, inResponseTo: { typeUri: 't' } } }
  expect(readTrustTaskError(doc)).toEqual({ verdict: 'refused', code: 'permissionDenied' })
  const frame = await tspPack(te.encode(JSON.stringify(doc)), B.ids.egress.did, A.ids.conn.did, { senderSigningKey: B.ids.egress.edSecret, receiverEncryptionKey: A.ids.conn.xPublic })
  med.deliver(A.ids.conn.did, frame.bytes)
  await rest(med, lease)
  for (let i = 0; i < 20 && (await med.unacked(A.ids.conn.did)) > 0; i++) await rest(med, lease)

  expect(received).toEqual([doc])
  expect(await med.unacked(A.ids.conn.did)).toBe(0)
  expect(reports).toEqual([{ digest: 'd-own', status: 'accepted' }])
  await lease.stop()
})
