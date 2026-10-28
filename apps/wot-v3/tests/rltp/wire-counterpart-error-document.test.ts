// @vitest-environment node
// A counterpart's framework answer to a carried document (VTI Mediator Adapter Profile 0.29 §5,
// RLTP-VTI-5040 to 5080; TRANSPORT.md "Counterpart answers"), over the mediator double: this side has
// an own document deposited and accepted; the counterpart answers with `trust-task-error/0.5`
// `unsupportedType` or `trust-task-next-step/0.1`, as trust-tasks-rs sends them, a TSP 1.0 `direct`
// message from its connection DID to this side's. The library's adapter binds the answer by the
// carried document's id and applies it; the carrier records the report at the holder
// (`CarrierOpening.record`) before it concludes the collection, which acknowledges the answer. The
// delivery line shows the refusal with its code, or the document held at the recipient. An
// `indeterminate` (`trust-task-error/0.6`, lib 0.10.1) is never a refusal: the unchanged report is recorded,
// the answer acknowledged at the conclusion and its diagnosis noted. The late
// acknowledgement after held (delivered) runs with real holders in the mediator matrix (seed 24).
import { expect, it } from 'vitest'
import { pack as tspPack } from '@openvtc/vti-tsp-js'
import { deliveryHint, sealedEnvelopeId, SEALED_ENVELOPE_TYPE, TRUST_TASK_ERROR_TYPE, TRUST_TASK_ERROR_TYPES, TRUST_TASK_NEXT_STEP_TYPE, TSP_BINDING_ENVELOPE_TYPE } from '@real-life/trust-protocol/adapters/vti-mediator'
import { mediatorTransport } from '../../src/adapters/rltp/carrier-mediator'
import { deliveryOf } from '../../src/adapters/rltp/ingest'

type DeliveryItemView = Parameters<typeof deliveryOf>[0][number]
import type { CarrierOpening, CustodyLease, TransportHandlers } from '../../src/adapters/rltp/transport'
import { deriveWireIdentities, peerKeys } from '../../src/adapters/rltp/wire'
import { deliveryWord } from '../../src/screens/chat/delivery-word'
import { de } from '../../src/i18n/de'
import { en } from '../../src/i18n/en'
import { interpolate } from '../../src/i18n/utils'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
import { fakeNetwork, virtualClock } from '../../src/platform/fake'

type ContactView = Parameters<CustodyLease['carry']>[0][number]
type TransportView = Parameters<CustodyLease['reconcile']>[0]
type TransportEntry = TransportView['entries'][number]
type DeliveryReport = Parameters<TransportHandlers['report']>[0]

const b64u = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const turn = () => new Promise((r) => setTimeout(r, 0))
const te = new TextEncoder()
/** canonical JSON (the binding envelope a counterpart writes, JCS) */
const canon = (v: unknown): string =>
  v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
/** the seal vector's public test key */
const RKID = 'z6LStLK2kxribiLHz6U4vpGfzMtmgc4q5WjR4mvhS6KG1W16'

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

/** the line under the message, from the holder's view of the report */
const lineOf = (r: DeliveryReport, lang: 'en' | 'de') => {
  const base = { digest: r.digest, type: '', threadId: '', contactId: '', attempt: 1, submittedAt: 0, updatedAt: 0 }
  const x = r as { status: DeliveryItemView['status']; reason?: DeliveryItemView['reason']; code?: DeliveryItemView['code']; held?: true }
  const view: DeliveryItemView = { ...base, status: x.status, ...(x.reason ? { reason: x.reason } : {}), ...(x.code ? { code: x.code } : {}), ...(x.held ? { held: x.held } : {}) }
  return deliveryWord(deliveryOf([view]), { lang, t: lang === 'en' ? en : de, f: interpolate })
}

async function world() {
  const med = mediatorDouble()
  const clock = virtualClock(Date.now(), 'UTC')
  const A = await side(med.did, 1)
  const B = await side(med.did, 2)
  const reports: DeliveryReport[] = []
  const recorded: DeliveryReport[] = []
  const received: unknown[] = []
  const diagnosed: Array<{ code: string; detail?: string }> = []
  let recordFails = false
  const h: TransportHandlers = { envelope: async (env) => (received.push(env), 'taken'), report: (r) => reports.push(r) }
  const o: CarrierOpening = {
    answered: async () => [],
    record: async (r) => {
      if (recordFails) throw new Error('injected: the holder could not record the report')
      recorded.push(r)
    },
    rootIkm: A.root,
    gate: { handOver: async (_e, _w, start) => start() },
    acks: { get: async () => undefined, put: async () => undefined },
    when: () => clock.now(),
    offer: () => undefined,
    receiveAtCard: async () => ({ answer: 'taken', recorded: null }),
    diagnose: (code, detail) => diagnosed.push({ code, ...(detail !== undefined ? { detail } : {}) }),
  }
  const lease = mediatorTransport({ did: med.did, clock, net: med.net, network: fakeNetwork() }).lease()
  lease.start(h, o)
  lease.activate()
  const rel = { id: 'r-b', tuples: 1, chainedFrom: [], carrierNonce: { nonce: b64u(A.nonce), generation: '1' }, counterpartDeliveryHints: [B.hint] }
  lease.carry([{ id: 'c-b', aliases: [], relationships: [rel] } as unknown as ContactView])
  await rest(med, lease)
  const t = clock.now()
  // a well-formed seal (random ciphertext): the counterpart never opens it
  const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
  const envelope = { rkid: RKID, epk: b64u(rnd(32)), nonce: b64u(rnd(12)), ciphertext: b64u(rnd(48)) }
  const own = { digest: 'd-own', kind: 'document', envelope, type: 't', threadId: 't', recipient: { contactId: 'c-b', rkid: RKID, keyAgreement: RKID }, attempt: 1, since: t, notAfter: t + 86_400_000 }
  lease.reconcile({ ok: true, commitSeq: '1', at: t, entries: [own as unknown as TransportEntry], answerable: [] } as unknown as TransportView)
  await rest(med, lease)
  expect(reports).toEqual([{ digest: 'd-own', status: 'accepted' }])
  // the carried document's id: from the seal and both connection DIDs (Delivery RLTP-DEL-4620)
  const outerId = await sealedEnvelopeId(envelope, A.ids.conn.did, B.ids.conn.did)
  /** the counterpart's answer, a TSP 1.0 frame from B's connection DID to A's; its mediator queue */
  const answer = async (kind: 'unsupportedType' | 'next-step' | 'indeterminate' | 'indeterminate-final') => {
    const inResponseTo = { id: outerId, typeUri: SEALED_ENVELOPE_TYPE }
    const common = { id: `urn:uuid:${crypto.randomUUID()}`, issuedAt: '2026-10-27T17:27:50.395371028Z', issuer: B.ids.conn.did, recipient: A.ids.conn.did, threadId: outerId }
    // trust-task-error/0.6 `indeterminate` as trust-tasks-rs 0.36.0 sends it (the double's --indeterminate)
    const T06 = TRUST_TASK_ERROR_TYPES.find((u) => u.endsWith('/0.6'))
    const document =
      kind === 'unsupportedType'
        ? { ...common, type: TRUST_TASK_ERROR_TYPE, payload: { code: 'unsupportedType', inResponseTo, message: `no handler for ${SEALED_ENVELOPE_TYPE}`, retryable: false } }
        : kind === 'indeterminate' || kind === 'indeterminate-final'
          ? { ...common, type: T06, payload: { code: 'indeterminate', details: { reference: 'schema' }, inResponseTo, message: 'a reference could not be obtained', retryable: kind === 'indeterminate' } }
          : { ...common, type: TRUST_TASK_NEXT_STEP_TYPE, payload: { continuation: 'proceed', expects: [{ typeUri: 'https://trusttasks.org/spec/trust-task-ok/0.1' }], inResponseTo, message: 'sealed-envelope/0.1 understood; waiting' } }
    const f = await tspPack(te.encode(canon({ document, type: TSP_BINDING_ENVELOPE_TYPE })), B.ids.conn.did, A.ids.conn.did, { senderSigningKey: B.ids.conn.edSecret, receiverEncryptionKey: peerKeys(A.ids.conn.did).encPub })
    med.deliver(A.ids.conn.did, f.bytes)
    await rest(med, lease)
    for (let i = 0; i < 20 && (await med.unacked(A.ids.conn.did)) > 0; i++) {
      clock.advance(5000)
      await rest(med, lease)
    }
  }
  return {
    med,
    lease,
    A,
    clock,
    reports,
    recorded,
    received,
    diagnosed,
    answer,
    failRecord: (on: boolean) => {
      recordFails = on
    },
  }
}

it('a terminal refusal of the counterpart (unsupportedType) fails the own document: recorded at the holder before the answer is acknowledged; the line names the code', async () => {
  const w = await world()
  await w.answer('unsupportedType')
  const refused = { digest: 'd-own', status: 'failed', reason: 'rejected-by-receiver', code: 'unsupportedType' }
  expect(w.recorded).toEqual([refused])
  // the carrier's own report of the submission follows at its next tick, the same
  w.clock.advance(5000)
  await rest(w.med, w.lease)
  expect(w.reports.at(-1)).toEqual(refused)
  // never an envelope for the holder; acknowledged at the mediator after the record
  expect(w.received).toEqual([])
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(0)
  expect(lineOf(refused as DeliveryReport, 'en')).toBe('Rejected by the recipient (unsupportedType)')
  expect(lineOf(refused as DeliveryReport, 'de')).toBe('Vom Empfänger abgelehnt (unsupportedType)')
  await w.lease.stop()
})

it('a next step of the counterpart makes the own document accepted and held; the line says it arrived and is open there', async () => {
  const w = await world()
  await w.answer('next-step')
  const held = { digest: 'd-own', status: 'accepted', held: true }
  expect(w.recorded).toEqual([held])
  // the carrier's own report of the submission follows at its next tick, the same
  w.clock.advance(5000)
  await rest(w.med, w.lease)
  expect(w.reports.at(-1)).toEqual(held)
  expect(w.received).toEqual([])
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(0)
  expect(lineOf(held as DeliveryReport, 'en')).toBe('Arrived, open at the recipient')
  expect(lineOf(held as DeliveryReport, 'de')).toBe('Beim Empfänger angekommen, dort offen')
  // held is no horizon's: past the adapter's give-up horizon (72 h) it stays accepted and held
  w.clock.advance(73 * 3_600_000)
  await rest(w.med, w.lease)
  expect(w.reports.at(-1)).toEqual(held)
  await w.lease.stop()
})

it('a report the holder cannot record keeps the answer unacknowledged; a later collection records it and acknowledges it (RLTP-VTI-5080)', async () => {
  const w = await world()
  w.failRecord(true)
  await w.answer('unsupportedType').catch(() => undefined)
  expect(w.recorded).toEqual([])
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(1)
  w.failRecord(false)
  for (let i = 0; i < 20 && (await w.med.unacked(w.A.ids.conn.did)) > 0; i++) {
    w.clock.advance(5000)
    await rest(w.med, w.lease)
  }
  expect(w.recorded).toEqual([{ digest: 'd-own', status: 'failed', reason: 'rejected-by-receiver', code: 'unsupportedType' }])
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(0)
  await w.lease.stop()
})

it.each([
  ['indeterminate', true],
  ['indeterminate-final', false],
] as const)('an indeterminate of the counterpart (%s) is never a refusal: the unchanged report is recorded, the answer acknowledged at the conclusion, its diagnosis noted (RLTP-VTI-5020)', async (kind, retryable) => {
  const w = await world()
  await w.answer(kind)
  const accepted = { digest: 'd-own', status: 'accepted' }
  // the report the answer travels with is the submission's own, unchanged
  expect(w.recorded).toEqual([accepted])
  w.clock.advance(5000)
  await rest(w.med, w.lease)
  expect(w.reports.at(-1)).toEqual(accepted)
  expect(w.received).toEqual([])
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(0)
  expect(w.diagnosed.filter((d) => d.code === 'carrier-answer-indeterminate')).toEqual([{ code: 'carrier-answer-indeterminate', detail: `retryable ${retryable}` }])
  // the line says what the report says: sent, no new line
  expect(lineOf(accepted as DeliveryReport, 'en')).toBe('Sent ✓')
  expect(lineOf(accepted as DeliveryReport, 'de')).toBe('Gesendet ✓')
  await w.lease.stop()
})

it('an indeterminate whose report the holder cannot record is neither acknowledged nor noted; a later collection records, concludes and notes it once', async () => {
  const w = await world()
  w.failRecord(true)
  await w.answer('indeterminate').catch(() => undefined)
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(1)
  expect(w.diagnosed.filter((d) => d.code === 'carrier-answer-indeterminate')).toEqual([])
  w.failRecord(false)
  for (let i = 0; i < 20 && (await w.med.unacked(w.A.ids.conn.did)) > 0; i++) {
    w.clock.advance(5000)
    await rest(w.med, w.lease)
  }
  expect(w.recorded).toEqual([{ digest: 'd-own', status: 'accepted' }])
  expect(await w.med.unacked(w.A.ids.conn.did)).toBe(0)
  expect(w.diagnosed.filter((d) => d.code === 'carrier-answer-indeterminate')).toEqual([{ code: 'carrier-answer-indeterminate', detail: 'retryable true' }])
  await w.lease.stop()
})
