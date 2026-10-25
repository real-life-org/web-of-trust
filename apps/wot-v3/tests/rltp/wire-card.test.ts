// @vitest-environment node
// The displayed card's instance of the custody lease (src/adapters/rltp/carrier-mediator.ts, TRANSPORT.md
// "The displayed card's instance", VTI 0.26 §1c, RLTP-VTI-1250 to 1270) on its own: a fake opening whose
// holder judges an envelope by script, the real wire and the real adapter over the mediator double. The
// scanner's side is played by hand: its frames are packed with its derived identities and delivered as
// the mediator delivers the inner message of a routed deposit.
import { describe, expect, it } from 'vitest'
import { pack as tspPack } from '@openvtc/vti-tsp-js'
import { deliveryHint } from '@real-life/trust-protocol/adapters/vti-mediator'
import { mediatorTransport, shortDid } from '../../src/adapters/rltp/carrier-mediator'
import { CHALLENGE_MAX_AGE, challengeEnd, type CarrierOpening, type CustodyLease, type DisplayedCard, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { deriveWireIdentities } from '../../src/adapters/rltp/wire'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
import { virtualClock, type VirtualClock } from '../../src/platform/fake'
import type { DiagnosticCode } from '../../src/port/diagnostics'

type ContactView = Parameters<CustodyLease['carry']>[0][number]
type RelationshipView = ContactView['relationships'][number]
type TransportView = Parameters<CustodyLease['reconcile']>[0]
type TransportEntry = TransportView['entries'][number]

const b64u = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const turn = () => new Promise((r) => setTimeout(r, 0))
const sha256hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const te = new TextEncoder()
const CARD_KEY = 'z6LS-the-card-key'

async function party(did: string, fill: number) {
  const root = new Uint8Array(64).fill(fill)
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  return { root, nonce, hint: await deliveryHint(root, did, nonce), ids: await deriveWireIdentities(root, did, nonce) }
}
type Party = Awaited<ReturnType<typeof party>>

/** the relationship the displayer's holder records for the card: its N, the scanner's hints */
const relationship = (displayer: Party, hints: string[]): RelationshipView =>
  ({ id: 'r-card', tuples: 1, chainedFrom: [], carrierNonce: { nonce: b64u(displayer.nonce), generation: '1' }, counterpartDeliveryHints: hints }) as unknown as RelationshipView
const contactOf = (rel: RelationshipView): ContactView => ({ id: 'c-scanner', aliases: [], relationships: [rel] }) as unknown as ContactView
const entry = (digest: string, at: number): TransportEntry =>
  ({ digest, kind: 'document', envelope: { v: digest }, type: 't', threadId: 't', recipient: { contactId: 'c-scanner', rkid: 'r', keyAgreement: 'k' }, attempt: 1, since: at, notAfter: at + 86_400_000 }) as unknown as TransportEntry

async function rest(med: MediatorDouble, lease: CustodyLease) {
  for (let calm = 0; calm < 3; ) {
    await med.settled()
    await turn()
    calm = lease.busy() === 0 ? calm + 1 : 0
  }
}

/** A displaying side: the lease, a fake opening whose holder takes a bundle sealed to the card's key
 *  and then records the card's challenge (the relationship `recorded`). */
async function displayer(med: MediatorDouble, clock: VirtualClock, scanner: Party | null, opts: { recorded?: RelationshipView; transient?: number } = {}) {
  const A = await party(med.did, 1)
  const card: DisplayedCard = { challenge: 'ch-1', nonce: b64u(A.nonce), rkid: CARD_KEY, issuedAt: Math.floor(clock.now() / 1000) * 1000 }
  const diagnosed: { code: DiagnosticCode; detail?: string }[] = []
  const judged: unknown[] = []
  const recorded = opts.recorded ?? (scanner ? relationship(A, [scanner.hint]) : null)
  let bundles = 0
  /** the holder's transient answers still to give (rate-limited): nothing committed */
  let transient = opts.transient ?? 0
  const o: CarrierOpening = {
    rootIkm: A.root,
    gate: { handOver: async (_e, _w, start) => start() },
    acks: { get: async () => undefined, put: async () => undefined },
    when: () => clock.now(),
    offer: () => undefined,
    answered: async () => [],
    // the holder: the first bundle opens the relationship (unique), a copy is duplicate-known, a second
    // bundle of another scanner is its terminal consumed-challenge (RLTP-ENC-5410): no record
    receiveAtCard: async (env) => {
      judged.push(env)
      const kind = (env as { kind?: string }).kind
      if (kind !== 'bundle') return { answer: 'taken', recorded: null }
      if (transient > 0) {
        transient--
        return { answer: 'later', recorded: null }
      }
      bundles++
      if (bundles > 1 && !(env as { copy?: boolean }).copy) return { answer: 'taken', recorded: null }
      return { answer: 'taken', recorded }
    },
    diagnose: (code, detail) => diagnosed.push({ code, ...(detail !== undefined ? { detail } : {}) }),
  }
  const reports: unknown[] = []
  /** what the bound instance hands the holder through the opening's ordinary receive */
  const received: unknown[] = []
  const h: TransportHandlers = { envelope: async (env) => (received.push(env), 'taken'), report: (r) => reports.push(r) }
  const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
  lease.start(h, o)
  lease.activate()
  return { A, card, lease, diagnosed, judged, reports, received }
}

/** a frame from `from`'s egress identity to the card's connection DID, as the mediator hands it on */
async function frame(med: MediatorDouble, from: Party, to: Party, env: unknown): Promise<string> {
  const f = await tspPack(te.encode(JSON.stringify(env)), from.ids.egress.did, to.ids.conn.did, { senderSigningKey: from.ids.egress.edSecret, receiverEncryptionKey: to.ids.conn.xPublic })
  return med.deliver(to.ids.conn.did, f.bytes)
}

describe('the displayed card’s instance (VTI 0.26 §1c)', () => {
  it('opens at display under the card’s connection DID; the bundle the holder takes binds it to the sent card’s hint: one scan, the answer goes back over the mediator (RLTP-VTI-1250, 1255, 1260)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const { A, card, lease, judged } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    expect(lease.status.get().carrier).toBe('connected')
    const text = await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    expect(judged).toHaveLength(1)
    // acknowledged: the mediator lets the bundle go
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(text))
    // the contact view names the relationship: the card's instance carries it, no second instance
    lease.carry([contactOf(relationship(A, [B.hint]))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    const t = clock.now()
    lease.reconcile({ ok: true, commitSeq: '1', at: t, entries: [entry('d-ack', t)] } as unknown as TransportView)
    await rest(med, lease)
    expect(med.forwarded.map((f) => f.outer.route)).toEqual([[B.ids.conn.did]])
    await lease.stop()
  })

  it('before its binding a frame not sealed to the card, or one the holder does not record as the card’s challenge, is dropped: acknowledged, logged with its sender (RLTP-VTI-1265)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const X = await party(med.did, 3)
    const { A, card, lease, judged, diagnosed } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    const t1 = await frame(med, X, A, { rkid: 'another-key', kind: 'bundle' })
    const t2 = await frame(med, X, A, { rkid: CARD_KEY, kind: 'message' })
    await rest(med, lease)
    // the first never reaches the holder; the second does, and records nothing
    expect(judged).toEqual([{ rkid: CARD_KEY, kind: 'message' }])
    const acked = await med.ackedBy(A.ids.conn.did)
    expect(acked).toContain(await sha256hex(t1))
    expect(acked).toContain(await sha256hex(t2))
    expect(diagnosed.map((d) => d.code)).toEqual(['carrier-card-frame-refused', 'carrier-card-frame-refused'])
    // the sender shortened (did:key:z6Mk…xxxx): told apart, no key
    for (const d of diagnosed) expect(d.detail).toContain(shortDid(X.ids.egress.did))
    for (const d of diagnosed) expect(d.detail).not.toContain(X.ids.egress.did)
    // still unbound: the real bundle binds it afterwards
    await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    lease.carry([contactOf(relationship(A, [B.hint]))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    await lease.stop()
  })

  it('a second bundle with another egress identity, after the binding, never reaches the holder: refused by the wire and acknowledged (multi-scan, Open Issue 11)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const B2 = await party(med.did, 4)
    const { A, card, lease, judged, received } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    const second = await frame(med, B2, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    expect(judged).toHaveLength(1)
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(second))
    expect(received).toEqual([])
    // a copy of the first bundle still reaches the holder, now as the relationship's frame (it absorbs it)
    await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle', copy: true })
    await rest(med, lease)
    expect(judged).toHaveLength(1)
    expect(received).toEqual([{ rkid: CARD_KEY, kind: 'bundle', copy: true }])
    await lease.stop()
  })

  it('the frame’s sender and the hint disagree: a diagnosis with the sender, the instance binds to the hint’s identities, never to the frame (RLTP-VTI-1255)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const X = await party(med.did, 3)
    const { A, card, lease, diagnosed } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    await frame(med, X, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    expect(diagnosed.map((d) => d.code)).toEqual(['carrier-hint-mismatch'])
    expect(diagnosed[0]?.detail).toContain(shortDid(X.ids.egress.did))
    lease.carry([contactOf(relationship(A, [B.hint]))])
    const t = clock.now()
    lease.reconcile({ ok: true, commitSeq: '1', at: t, entries: [entry('d-ack', t)] } as unknown as TransportView)
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    expect(med.forwarded.map((f) => f.outer.route)).toEqual([[B.ids.conn.did]])
    await lease.stop()
  })

  it('recorded optically (the contact view names the card’s N first): the instance binds to the hint without a frame; no second socket (RLTP-VTI-1260)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const { A, card, lease, judged, received } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    const opened = med.opened.filter((d) => d === A.ids.conn.did).length
    lease.carry([contactOf(relationship(A, [B.hint]))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    expect(med.opened.filter((d) => d === A.ids.conn.did).length).toBe(opened)
    // the bundle that waited at the mediator comes from the bound counterpart: the holder absorbs it
    await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle', copy: true })
    await rest(med, lease)
    expect(judged).toHaveLength(0)
    expect(received).toHaveLength(1)
    await lease.stop()
  })

  it('a sent card without a readable hint for C: the instance closes, the relationship is not carried (RLTP-VTI-1260, 1235)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const A0 = await party(med.did, 1)
    const { A, card, lease } = await displayer(med, clock, B, { recorded: relationship(A0, []) })
    lease.display([card])
    await rest(med, lease)
    const text = await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(text))
    expect(med.openSockets(A.ids.conn.did)).toBe(0)
    lease.carry([contactOf(relationship(A, []))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'no-hint' })
    expect(med.openSockets(A.ids.conn.did)).toBe(0)
    await lease.stop()
  })

  it('the instance listens while the holder resolves the challenge open: a bundle after CHALLENGE_MAX_AGE, inside the skew tolerance, still binds it (RLTP-VTI-1250)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const { A, card, lease, judged } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    // B scanned offline; its bundle comes one minute past the challenge's age bound
    clock.advance(CHALLENGE_MAX_AGE + 60_000)
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    expect(judged).toHaveLength(1)
    lease.carry([contactOf(relationship(A, [B.hint]))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    // bound, it is the relationship's instance: the end of the challenge closes nothing
    clock.advance(challengeEnd(card) - clock.now())
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    await lease.stop()
  })

  it('unbound when the holder resolves the challenge unknown, the instance closes on the device clock, not a second before; a card already unknown gets none (RLTP-VTI-1270)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const { A, card, lease } = await displayer(med, clock, null)
    lease.display([card])
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    clock.advance(challengeEnd(card) - clock.now() - 1)
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(1)
    clock.advance(1)
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(0)
    expect(lease.status.get().carrier).toBe('idle')
    lease.display([card])
    await rest(med, lease)
    expect(med.openSockets(A.ids.conn.did)).toBe(0)
    await lease.stop()
  })

  it('a transient answer of the holder (rate-limited, not concludable) concludes nothing: the frame is not acknowledged and is judged again (RLTP-VTI-1265, RLTP-DEL-5820)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const { A, card, lease, judged } = await displayer(med, clock, B, { transient: 1 })
    lease.display([card])
    await rest(med, lease)
    const text = await frame(med, B, A, { rkid: CARD_KEY, kind: 'bundle' })
    await rest(med, lease)
    expect(judged).toHaveLength(1)
    expect(await med.ackedBy(A.ids.conn.did)).not.toContain(await sha256hex(text))
    // the next advance offers it again; now the holder takes it and the instance binds
    clock.advance(5000)
    await rest(med, lease)
    expect(judged).toHaveLength(2)
    expect(await med.ackedBy(A.ids.conn.did)).toContain(await sha256hex(text))
    lease.carry([contactOf(relationship(A, [B.hint]))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    await lease.stop()
  })

  it('recorded while a collection of the instance runs, it binds at once, not at the next plan', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const X = await party(med.did, 3)
    const { A, card, lease } = await displayer(med, clock, B)
    lease.display([card])
    await rest(med, lease)
    // a stranger's frame is being judged while the optical record arrives
    await frame(med, X, A, { rkid: CARD_KEY, kind: 'message' })
    lease.carry([contactOf(relationship(A, [B.hint]))])
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    await lease.stop()
  })

  it('the end of the opening closes it; the next opening of a card still valid opens it again, and the bundle that waited at the mediator binds it (restart)', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const B = await party(med.did, 2)
    const first = await displayer(med, clock, B)
    first.lease.display([first.card])
    await rest(med, first.lease)
    first.lease.deactivate()
    await first.lease.stop()
    await rest(med, first.lease)
    expect(med.openSockets(first.A.ids.conn.did)).toBe(0)
    // the scanner's bundle arrives while no opening listens: the mediator keeps it
    await frame(med, B, first.A, { rkid: CARD_KEY, kind: 'bundle' })
    // a new process: the same root, the same card from the app-db
    const A = first.A
    const lease = mediatorTransport({ did: med.did, clock, net: med.net }).lease()
    const judged: unknown[] = []
    lease.start({ envelope: async () => 'taken', report: () => undefined }, {
      rootIkm: A.root,
      gate: { handOver: async (_e, _w, start) => start() },
      acks: { get: async () => undefined, put: async () => undefined },
      when: () => clock.now(),
      offer: () => undefined,
      answered: async () => [],
      receiveAtCard: async (env) => (judged.push(env), { answer: 'taken', recorded: relationship(A, [B.hint]) }),
      diagnose: () => undefined,
    })
    lease.activate()
    clock.advance(60_000)
    lease.display([first.card])
    await rest(med, lease)
    expect(judged).toEqual([{ rkid: CARD_KEY, kind: 'bundle' }])
    lease.carry([contactOf(relationship(A, [B.hint]))])
    await rest(med, lease)
    expect(lease.carriage.get().contacts).toEqual({ 'c-scanner': 'routed' })
    await lease.stop()
  })
})
