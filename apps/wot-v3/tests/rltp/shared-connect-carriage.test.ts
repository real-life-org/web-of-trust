// @vitest-environment node
// The shared-connect carriage (src/adapters/rltp/shared-connect-carriage.ts) between two holders of
// the library over the mediator double: the whole ceremony through the wires, the restart of one
// side in the middle (the outbox goes out again), a wire that does not open at first, and the end of
// the wires (the link expired unanswered; the linger after an enactment closed).
import { describe, expect, it, vi } from 'vitest'
import { createSharedConnectCarriage, SC_LINGER_MS, type SharedConnectCarriage } from '../../src/adapters/rltp/shared-connect-carriage'
import { openSharedConnectWire } from '../../src/adapters/rltp/shared-connect-wire'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
import { virtualClock, type VirtualClock } from '../../src/platform/fake'

// the library itself (the lint rule keeps tests away from a direct import)
type Ev = { type: string; [k: string]: unknown }
type Res = { ok: boolean; code?: string; events?: Ev[] }
type View = { id: string; link: { exp: number }; theirPair: string | null; role: string; status: string; did: string; theirDid: string | null; contactId: string | null; outbox: unknown[]; promptId: string | null; name: string | null }
type H = {
  sharedConnectShow(input: object, opts: object): Promise<Res>
  sharedConnectPropose(input: object, opts: object): Promise<Res>
  sharedConnectReceive(doc: unknown, sender: string, when: number): Promise<Res>
  sharedConnect(): Promise<View[]>
  decide(promptId: string, choice: 'accept' | 'decline', opts: object): Promise<Res>
  contacts(): Promise<{ id: string; sharedConnect?: { met: boolean } }[]>
  subscribe(l: (c: { events: Ev[] }) => void): () => void
  close(): Promise<void>
}
const lib = await vi.importActual<{ createHolder(o: object): Promise<H>; seedKeys(seed: Uint8Array): object }>('@real-life/trust-protocol')
const { InMemoryStore } = await vi.importActual<{ InMemoryStore: new () => object }>('@real-life/trust-protocol/testing')

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))
// a session reads a frame in steps of its own before the wire counts it: a real millisecond per turn
const turn = () => new Promise((r) => setTimeout(r, 1))

interface Side {
  h: H
  carriage: SharedConnectCarriage
  events: Ev[]
  diagnosed: string[]
  /** the next receives of the holder fail (storage) */
  failReceives: number
  /** the wire's sends fail while set (the socket takes nothing) */
  failSends: boolean
  /** wires opened so far */
  opened: number
  /** the hand-over marks as the opening's app-db keeps them (they survive a restart) */
  marks: Record<string, number>
  /** a new holder and carriage over the same store and root (the app restarted) */
  restart(): Promise<void>
}

async function side(med: MediatorDouble, clock: VirtualClock): Promise<Side> {
  const store = new InMemoryStore()
  const keys = lib.seedKeys(rand(64))
  const s = { events: [] as Ev[], diagnosed: [] as string[], failReceives: 0, failSends: false, opened: 0, marks: {} } as Side
  const start = async () => {
    const h = await lib.createHolder({ store, keys })
    const carriage = createSharedConnectCarriage({
      open: async (cfg) => {
        const wire = await openSharedConnectWire({ ...cfg, mediatorDid: med.did, clock, net: med.net })
        s.opened++
        return { ...wire, send: (to, docs) => (s.failSends ? Promise.reject(new Error('down')) : wire.send(to, docs)) }
      },
      sent: { read: async () => s.marks, write: async (next) => void (s.marks = { ...next }) },
      keys: keys as never,
      views: () => h.sharedConnect() as never,
      receive: (doc, sender) => {
        if (s.failReceives > 0) {
          s.failReceives--
          return Promise.reject(new Error('storage'))
        }
        return h.sharedConnectReceive(doc, sender, clock.now()) as never
      },
      now: () => clock.now(),
      setTimer: (at, cb) => clock.setTimer(at, cb),
      diagnose: (code, detail) => void s.diagnosed.push(`${code}:${detail ?? ''}`),
    })
    h.subscribe(({ events }) => {
      s.events.push(...events)
      carriage.events(events as never)
    })
    s.h = h
    s.carriage = carriage
  }
  s.restart = async () => {
    s.carriage.stop()
    await s.h.close()
    await start()
    s.carriage.resume()
  }
  await start()
  return s
}

async function flush(med: MediatorDouble, ...sides: Side[]) {
  for (let calm = 0, rounds = 0; calm < 5; rounds++) {
    if (rounds > 2000) throw new Error('flush: the sides never came to rest')
    await med.settled()
    await turn()
    calm = sides.reduce((n, s) => n + s.carriage.busy(), 0) === 0 ? calm + 1 : 0
  }
}

const RELAYS = (med: MediatorDouble) => [{ kind: 'tsp-mediator', address: med.did }]
let act = 0
const opts = (clock: VirtualClock) => ({ when: clock.now(), actId: `act-${++act}` })
const of = (s: Side, type: string) => s.events.filter((e) => e.type === type)

async function setup() {
  const med = mediatorDouble()
  const clock = virtualClock(Date.parse('2026-11-09T10:00:00Z'), 'UTC')
  const A = await side(med, clock)
  const B = await side(med, clock)
  return { med, clock, A, B }
}

/** A shows, B proposes from the link; the propose is at A, its prompt open */
async function untilPending(x: Awaited<ReturnType<typeof setup>>) {
  const { med, clock, A, B } = x
  const shown = await A.h.sharedConnectShow({ relays: RELAYS(med), name: 'Anton' }, opts(clock))
  expect(shown.ok).toBe(true)
  await flush(med, A, B)
  const link = String(of(A, 'sharedconnect.shown')[0]?.link)
  const prop = await B.h.sharedConnectPropose({ link, relays: RELAYS(med), channel: 'scan', name: 'Bea' }, opts(clock))
  expect(prop.ok).toBe(true)
  await flush(med, A, B)
}

describe('shared-connect carriage', () => {
  it('carries the whole ceremony between two holders: a contact on both sides, both met', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await untilPending(x)
    const pending = of(A, 'sharedconnect.pending')
    expect(pending.map((e) => e.name)).toEqual(['Bea'])
    expect((await A.h.decide(String(pending[0]?.promptId), 'accept', opts(clock))).ok).toBe(true)
    await flush(med, A, B)
    const [vA] = await A.h.sharedConnect()
    const [vB] = await B.h.sharedConnect()
    expect([vA?.status, vB?.status]).toEqual(['complete', 'complete'])
    const cA = await A.h.contacts()
    const cB = await B.h.contacts()
    expect([cA.length, cB.length]).toEqual([1, 1])
    expect([cA[0]?.sharedConnect?.met, cB[0]?.sharedConnect?.met]).toEqual([true, true])
    expect([...A.diagnosed, ...B.diagnosed]).toEqual([])
    // the enactments closed: their wires stay for the linger, then the sockets are gone
    expect(med.sockets.has(String(vA?.did)) && med.sockets.has(String(vB?.did))).toBe(true)
    clock.advance(SC_LINGER_MS + 1000)
    await flush(med, A, B)
    expect(med.sockets.has(String(vA?.did)) || med.sockets.has(String(vB?.did))).toBe(false)
    A.carriage.stop()
    B.carriage.stop()
  })

  it('a decline reaches the responder: both enactments end declined, no contact', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await untilPending(x)
    expect((await A.h.decide(String(of(A, 'sharedconnect.pending')[0]?.promptId), 'decline', opts(clock))).ok).toBe(true)
    await flush(med, A, B)
    expect([(await A.h.sharedConnect())[0]?.status, (await B.h.sharedConnect())[0]?.status]).toEqual(['declined', 'declined'])
    expect([(await A.h.contacts()).length, (await B.h.contacts()).length]).toEqual([0, 0])
    A.carriage.stop()
    B.carriage.stop()
  })

  it('a restart of either side in the middle continues from the view: the outbox goes out again', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await untilPending(x)
    // the responder restarts while the inviter has not decided: its wire comes back under the same identity
    const didB = (await B.h.sharedConnect())[0]?.did
    await B.restart()
    await flush(med, A, B)
    expect((await B.h.sharedConnect())[0]?.did).toBe(didB)
    expect(med.sockets.has(String(didB))).toBe(true)
    // the inviter restarts with the prompt open, then the person accepts
    await A.restart()
    await flush(med, A, B)
    const [vA0] = await A.h.sharedConnect()
    expect(vA0?.promptId).not.toBeNull()
    expect((await A.h.decide(String(vA0?.promptId), 'accept', opts(clock))).ok).toBe(true)
    await flush(med, A, B)
    expect([(await A.h.sharedConnect())[0]?.status, (await B.h.sharedConnect())[0]?.status]).toEqual(['complete', 'complete'])
    expect([(await A.h.contacts()).length, (await B.h.contacts()).length]).toEqual([1, 1])
    A.carriage.stop()
    B.carriage.stop()
  })

  it('documents of a commit made while the wire could not open leave once it opens', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    const shown = await A.h.sharedConnectShow({ relays: RELAYS(med) }, opts(clock))
    expect(shown.ok).toBe(true)
    await flush(med, A, B)
    // the responder's mediator handshake fails: the propose is committed, nothing leaves
    med.faults.authDown = true
    const prop = await B.h.sharedConnectPropose({ link: String(of(A, 'sharedconnect.shown')[0]?.link), relays: RELAYS(med), channel: 'scan' }, opts(clock))
    expect(prop.ok).toBe(true)
    await flush(med, A, B)
    expect(of(A, 'sharedconnect.pending').length).toBe(0)
    med.faults.authDown = false
    // the next attempt is on the device clock
    for (let i = 0; i < 8 && of(A, 'sharedconnect.pending').length === 0; i++) {
      clock.advance(1000)
      await flush(med, A, B)
    }
    expect(of(A, 'sharedconnect.pending').length).toBe(1)
    A.carriage.stop()
    B.carriage.stop()
  })

  it("an inviter's wire ends when its link expired unanswered; a stop closes every wire", async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await A.h.sharedConnectShow({ relays: RELAYS(med), minutes: 1 }, opts(clock))
    await A.h.sharedConnectShow({ relays: RELAYS(med), minutes: 10 }, opts(clock))
    await flush(med, A, B)
    const views = (await A.h.sharedConnect()).sort((a, b) => a.link.exp - b.link.exp)
    expect(views.every((v) => med.sockets.has(v.did))).toBe(true)
    // one minute and the ceremony's clock tolerance later the first link is over
    clock.advance(125_000)
    await flush(med, A, B)
    expect(views.map((v) => med.sockets.has(v.did))).toEqual([false, true])
    A.carriage.stop()
    await flush(med, A, B)
    expect(views.some((v) => med.sockets.has(v.did))).toBe(false)
    B.carriage.stop()
  })

  it('a document the holder could not take is not acknowledged: the mediator delivers it again at the next connect', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    const shown = await A.h.sharedConnectShow({ relays: RELAYS(med), name: 'Anton' }, opts(clock))
    expect(shown.ok).toBe(true)
    await flush(med, A, B)
    A.failReceives = 1
    expect((await B.h.sharedConnectPropose({ link: String(of(A, 'sharedconnect.shown')[0]?.link), relays: RELAYS(med), channel: 'scan' }, opts(clock))).ok).toBe(true)
    await flush(med, A, B)
    expect(of(A, 'sharedconnect.pending').length).toBe(0)
    expect(A.diagnosed).toEqual(['shared-connect-refused:not-received'])
    // the inviter's socket drops and comes back: the frame is still at the mediator
    const [vA] = await A.h.sharedConnect()
    med.sockets.get(String(vA?.did))?.close()
    for (let i = 0; i < 8 && of(A, 'sharedconnect.pending').length === 0; i++) {
      clock.advance(1000)
      await flush(med, A, B)
    }
    expect(of(A, 'sharedconnect.pending').length).toBe(1)
    A.carriage.stop()
    B.carriage.stop()
  })

  it('a proposal nobody decides keeps no socket: both wires end a moment after the code', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await untilPending(x)
    const [vA] = await A.h.sharedConnect()
    const [vB] = await B.h.sharedConnect()
    expect(med.sockets.has(String(vA?.did)) && med.sockets.has(String(vB?.did))).toBe(true)
    // ten minutes of the code, the ceremony's clock tolerance, the linger
    clock.advance(600_000 + 60_000 + SC_LINGER_MS + 5000)
    await flush(med, A, B)
    expect(med.sockets.has(String(vA?.did)) || med.sockets.has(String(vB?.did))).toBe(false)
    A.carriage.stop()
    B.carriage.stop()
  })

  it('closed here is not delivered there: a last receipt that never left keeps the wire wanted across the linger and a restart, until it is handed over', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await untilPending(x)
    // the inviter's sends fail from its acceptance on... its acceptance and issue must leave first
    expect((await A.h.decide(String(of(A, 'sharedconnect.pending')[0]?.promptId), 'accept', opts(clock))).ok).toBe(true)
    // let the acceptance out, then cut the inviter's sends before its receipt of the responder's issue
    for (let i = 0; i < 200 && (await B.h.sharedConnect())[0]?.theirPair === null; i++) await new Promise((r) => setTimeout(r, 1))
    A.failSends = true
    await flush(med, A, B)
    const [vA] = await A.h.sharedConnect()
    expect(vA?.status).toBe('complete')
    expect((await B.h.sharedConnect())[0]?.status).toBe('open')
    expect(A.marks[String(vA?.id)]).toBeUndefined()
    // past the linger the wire is still wanted: nothing was handed over
    clock.advance(SC_LINGER_MS + 5000)
    await flush(med, A, B)
    expect(med.sockets.has(String(vA?.did))).toBe(true)
    // the app restarts, later: the wire opens again and the receipt leaves; the counterpart completes
    A.failSends = false
    clock.advance(3_600_000)
    await A.restart()
    await B.restart()
    for (let i = 0; i < 8 && (await B.h.sharedConnect())[0]?.status !== 'complete'; i++) {
      clock.advance(1000)
      await flush(med, A, B)
    }
    expect((await B.h.sharedConnect())[0]?.status).toBe('complete')
    // on the socket is not handed over: the mark comes once the mediator kept the frame for the linger
    expect(A.marks[String(vA?.id)]).toBeUndefined()
    clock.advance(SC_LINGER_MS + 5000)
    await flush(med, A, B)
    expect(A.marks[String(vA?.id)]).toEqual(expect.any(Number))
    expect(med.sockets.has(String(vA?.did))).toBe(false)
    const opened = A.opened
    await A.restart()
    await flush(med, A, B)
    expect(A.opened).toBe(opened)
    A.carriage.stop()
    B.carriage.stop()
  })

  it('a frame the mediator took from the socket and refused is not handed over: the receipt goes again, the mark waits', async () => {
    const x = await setup()
    const { med, clock, A, B } = x
    await untilPending(x)
    // the mediator refuses the next direct frame of anyone: the inviter's acceptance
    med.faults.refuseNextDirect = 'e.p.test.refused'
    expect((await A.h.decide(String(of(A, 'sharedconnect.pending')[0]?.promptId), 'accept', opts(clock))).ok).toBe(true)
    await flush(med, A, B)
    expect([...A.diagnosed, ...B.diagnosed]).toContain('wire-deposit-refused:direct/e.p.test.refused')
    // the refusal sent the outbox again; both complete, and the mark comes after the linger
    for (let i = 0; i < 8 && !((await A.h.sharedConnect())[0]?.status === 'complete' && (await B.h.sharedConnect())[0]?.status === 'complete'); i++) {
      clock.advance(1000)
      await flush(med, A, B)
    }
    const [vA] = await A.h.sharedConnect()
    expect([vA?.status, (await B.h.sharedConnect())[0]?.status]).toEqual(['complete', 'complete'])
    expect(A.marks[String(vA?.id)]).toBeUndefined()
    clock.advance(SC_LINGER_MS + 5000)
    await flush(med, A, B)
    expect(A.marks[String(vA?.id)]).toEqual(expect.any(Number))
    expect(med.sockets.has(String(vA?.did))).toBe(false)
    A.carriage.stop()
    B.carriage.stop()
  })
})
