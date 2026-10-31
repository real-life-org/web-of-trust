// @vitest-environment node
// Incoming confirmations (handshake UX 2.6, E6) and the success moment (2.7, E7), architecture §7.2
// "Übergangstests": every row of the `incoming` table. The queue over real devices on the VTI mediator
// double (the displayed card has an instance, a bundle names the card it answers, E9): two cards and
// two scanners in arrival order, a bundle after the flow was closed, a bundle past the card's end, a
// card ending while it is asked. The holds, the hand-overs from the verify flow and the failures over
// a scripted executor.
import { describe, expect, it } from 'vitest'
import type { AppPort, ContactId, DecisionId, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { incoming, incomingPosition, incomingQueue, incomingStart, INCOMING_TABLE, type IncomingEffect, type IncomingEntry, type IncomingEvent, type IncomingState } from '../../src/flows/incoming'
import { MUTUAL_WATCH, watchMutual, type MutualWatch } from '../../src/flows/mutual'
import { verify, verifyStart, type VerifyState } from '../../src/flows/verify'
import type { EffectResult } from '../../src/flows/machine'
import { createFlowRunner, type FlowRunner } from '../../src/hooks/flow-runner'
import { flowAsks, flowCovers, incomingEntries, incomingExecutor } from '../../src/hooks/incoming'
import { bundleEvent, verifyExecutor } from '../../src/hooks/verify'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES, loopbackDevice, type LoopbackDevice } from '../../harness/loopback'
import { mediatorDouble } from '../../harness/mediator-double'
import { tableCoverage } from './world'

const cover = tableCoverage('incoming', INCOMING_TABLE)

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function world(n = 3) {
  const med = mediatorDouble()
  const clock = virtualClock(Date.now(), 'UTC')
  const names = ['Al', 'Bea', 'Cem']
  const devices: LoopbackDevice[] = []
  for (let i = 0; i < n; i++) {
    devices.push(await loopbackDevice({ carrier: { mediator: med }, id: names[i] ?? `d${i}`, name: names[i] ?? `d${i}`, words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0], clock, seed: 91 + i * 5 }))
  }
  const settle = async () => {
    let last = ''
    let calm = 0
    for (let i = 0; i < 400 && calm < 2; i++) {
      await med.settled()
      for (const d of devices) await d.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
      const busy = devices.reduce((x, d) => x + (d.port.session()?.transportBusy() ?? 0), 0)
      const now = JSON.stringify(devices.map((d) => d.port.session()?.models()?.revision))
      calm = busy === 0 && now === last ? calm + 1 : 0
      last = now
    }
  }
  const tick = async () => {
    clock.advance(CARRIER_TICK_MS)
    await settle()
  }
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 12 && !ok(); i++) await tick()
    if (!ok()) throw new Error(`never ${what}`)
  }
  return { clock, devices, settle, tick, until }
}

/** the shell's queue on a device: the machine over its decisions, the card the flow shows set aside */
function queueOn(d: LoopbackDevice, shown: () => string | null = () => null) {
  const r = cover.track(createFlowRunner(incoming, incomingStart(d.platform.clock.now()), incomingExecutor(d.port, d.platform), d.platform))
  const push = () => {
    const entries = incomingEntries(d.port, shown() as never)
    if (entries) r.send({ type: 'decisions', entries, now: d.platform.clock.now() })
  }
  d.port.stores.decisions.subscribe(push)
  d.port.stores.contacts.subscribe(push)
  push()
  return { r, push, state: () => r.get(), position: () => incomingPosition(r.get()) }
}

const encounterDecisions = (d: LoopbackDevice) => value(d.port.stores.decisions).flatMap((x) => (x.kind === 'encounter-confirm' ? [x] : []))

describe('incoming confirmations over the mediator (real devices)', () => {
  it('two cards, two scanners, the later card scanned first: asked in arrival order, "1 of 2", "2 of 2"; nothing overwrites; both mutual', async () => {
    const { devices, settle, until } = await world()
    const [A, B, C] = devices as [LoopbackDevice, LoopbackDevice, LoopbackDevice]
    const q = queueOn(B)
    const one = await B.port.trust.showCard().done
    const two = await B.port.trust.showCard().done
    if (!one.ok || !two.ok) throw new Error('show')
    // the later card is scanned first: the queue follows arrival, not the cards' order (review 468 #3)
    expect((await C.port.trust.confirmCard(two.value.qr).done).ok).toBe(true)
    await until(() => encounterDecisions(B).length === 1, 'the first bundle')
    expect((await A.port.trust.confirmCard(one.value.qr).done).ok).toBe(true)
    await until(() => encounterDecisions(B).length === 2, 'the second bundle')
    const byCard = new Map(encounterDecisions(B).map((d) => [d.answers?.card ?? null, d] as const))
    expect(byCard.get(one.value.card)?.answers?.validUntil).toBe(one.value.expiresAt)
    expect(byCard.get(two.value.card)).toBeDefined()
    // the first arrival is asked, the second waits behind it
    expect(q.state()).toMatchObject({ name: 'asking', head: { id: byCard.get(two.value.card)?.id, name: 'Cem' } })
    expect(q.position()).toEqual({ n: 1, m: 2 })
    q.r.send({ type: 'confirm' })
    // the expiry timer of the queue runs on: wait for the state, not for the runner to idle
    await expect.poll(() => (q.state() as { head?: { name: string } }).head?.name, { timeout: 20_000 }).toBe('Al')
    await settle()
    expect(q.state()).toMatchObject({ name: 'asking', head: { id: byCard.get(one.value.card)?.id, name: 'Al' } })
    expect(q.position()).toEqual({ n: 2, m: 2 })
    q.r.send({ type: 'confirm' })
    await expect.poll(() => q.state().name, { timeout: 20_000 }).toBe('idle')
    await settle()
    expect(encounterDecisions(B)).toEqual([])
    await until(() => value(A.port.stores.contacts)[0]?.verification === 'mutual' && value(C.port.stores.contacts)[0]?.verification === 'mutual', 'both scanners mutual')
  }, 60_000)

  it('a bundle after the verify flow was closed (×) is asked as a sheet; "not now" leaves it open in the list', async () => {
    const { devices, until } = await world(2)
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    let flowState: VerifyState | null = null
    const fb = createFlowRunner(verify, verifyStart(), verifyExecutor(B.port, B.platform, { current: null }), B.platform)
    const push = () => {
      const e = bundleEvent(B.port)
      if (e) fb.send(e)
    }
    B.port.stores.decisions.subscribe(push)
    fb.subscribe(() => {
      flowState = fb.get().name === 'exit' ? null : fb.get()
    })
    for (let i = 0; i < 50 && fb.get().name !== 'ready'; i++) await new Promise((r) => setTimeout(r, 5))
    const shown = fb.get().card
    // the flow shows this card: it asks for it itself, the queue sets it aside
    const q = queueOn(B, () => (flowState?.name === 'ready' ? (flowState.card?.card ?? null) : null))
    expect(flowAsks(fb.get())).toBe(false)
    fb.send({ type: 'back' })
    expect(fb.get()).toMatchObject({ name: 'exit', to: 'back' })
    expect((await A.port.trust.confirmCard(shown?.qr ?? '').done).ok).toBe(true)
    await until(() => q.state().name === 'asking', 'the sheet')
    expect(q.state()).toMatchObject({ head: { name: 'Al' } })
    const id = (q.state() as Extract<IncomingState, { name: 'asking' }>).head.id
    q.r.send({ type: 'notNow' })
    expect(q.state().name).toBe('idle')
    expect(encounterDecisions(B).map((d) => d.id)).toContain(id)
  }, 60_000)

  it('a bundle that arrives past the card’s end (inside the skew) asks nothing; the list keeps it', async () => {
    const { clock, devices, until, tick } = await world(2)
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const q = queueOn(B)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    A.platform.network.set('offline')
    expect((await A.port.trust.confirmCard(shown.value.qr).done).ok).toBe(true)
    clock.advance(shown.value.expiresAt + 60_000 - clock.now())
    A.platform.network.set('online')
    await until(() => encounterDecisions(B).length === 1, 'the late bundle')
    expect(encounterDecisions(B)[0]?.answers).toMatchObject({ card: shown.value.card, validUntil: shown.value.expiresAt })
    await tick()
    expect(q.state().name).toBe('idle')
  }, 60_000)

  it('the asked card ends: the sheet goes, the decision stays in the list', async () => {
    const { clock, devices, until, settle } = await world(2)
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const q = queueOn(B)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    expect((await A.port.trust.confirmCard(shown.value.qr).done).ok).toBe(true)
    await until(() => q.state().name === 'asking', 'the sheet')
    clock.advance(shown.value.expiresAt - clock.now())
    await expect.poll(() => q.state().name, { timeout: 20_000 }).toBe('idle')
    await settle()
    expect(q.r.rows).toContain('asking.result.expire')
    expect(encounterDecisions(B)).toHaveLength(1)
  }, 60_000)
})

// ── holds, hand-overs and failures over a scripted executor ───────────────────────────────────
describe('incoming transitions over a scripted executor', () => {
  const entry = (id: string, openedAt: number, validUntil = 10_000): IncomingEntry => ({ id: id as DecisionId, contactId: `c-${id}` as ContactId, name: id, openedAt, validUntil })
  function scripted() {
    const counters: { contactId: string; resolve: (r: EffectResult) => void }[] = []
    const timers: { at: number; resolve: (r: EffectResult) => void }[] = []
    const exec = (e: IncomingEffect): Promise<EffectResult> =>
      new Promise((resolve) => {
        if (e.id === 'inc.counter') counters.push({ contactId: e.contactId, resolve })
        else timers.push({ at: e.at, resolve })
      })
    const r: FlowRunner<IncomingState, IncomingEvent> = cover.track(createFlowRunner(incoming, incomingStart(0), exec))
    const tick = () => new Promise((x) => setTimeout(x, 0))
    return { r, counters, timers, tick }
  }

  it('held while a flow asks or the success sheet is open; released, the asked one comes back', async () => {
    const { r } = scripted()
    r.send({ type: 'hold', on: true })
    r.send({ type: 'decisions', entries: [entry('a', 1)], now: 0 })
    expect(r.get().name).toBe('idle')
    r.send({ type: 'hold', on: false })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'a' } })
    r.send({ type: 'hold', on: true })
    expect(r.get().name).toBe('idle')
    r.send({ type: 'hold', on: false })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'a' } })
    expect(r.rows).toEqual(expect.arrayContaining(['idle.hold.off', 'asking.hold.on']))
  })

  it('the verify flow’s "not now" sets an entry aside, asked or waiting', async () => {
    const { r } = scripted()
    r.send({ type: 'decisions', entries: [entry('a', 1), entry('b', 2)], now: 0 })
    r.send({ type: 'defer', id: 'b' as DecisionId })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'a' } })
    expect(incomingPosition(r.get())).toEqual({ n: 1, m: 1 })
    r.send({ type: 'defer', id: 'a' as DecisionId })
    expect(r.get().name).toBe('idle')
    r.send({ type: 'defer', id: 'c' as DecisionId })
    r.send({ type: 'decisions', entries: [entry('a', 1), entry('b', 2), entry('c', 3)], now: 0 })
    expect(r.get().name).toBe('idle')
    expect(r.rows).toEqual(expect.arrayContaining(['asking.defer', 'idle.defer']))
  })

  it('a decision closed elsewhere: the next one is asked; nothing moves while the counter-step runs; a failure keeps the question', async () => {
    const { r, counters, tick } = scripted()
    r.send({ type: 'decisions', entries: [entry('a', 1), entry('b', 2)], now: 0 })
    r.send({ type: 'decisions', entries: [entry('b', 2)], now: 0 })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'b' } })
    expect(r.rows).toContain('asking.decisions.gone')
    r.send({ type: 'confirm' })
    expect(r.get()).toMatchObject({ busy: true })
    // the decision goes in flight (not open), a hold, a defer: the sheet stays until the result
    r.send({ type: 'decisions', entries: [], now: 0 })
    r.send({ type: 'hold', on: true })
    r.send({ type: 'notNow' })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'b' }, busy: true })
    r.send({ type: 'hold', on: false })
    r.send({ type: 'decisions', entries: [entry('b', 2)], now: 0 })
    counters[0]?.resolve({ ok: false, code: 'transport' })
    await tick()
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'b' }, busy: false, failed: true })
    r.send({ type: 'notNow' })
    expect(r.get().name).toBe('idle')
  })

  it('a failed counter-step: the card’s end still takes the sheet away (review 468 #2)', async () => {
    const { r, counters, timers, tick } = scripted()
    r.send({ type: 'decisions', entries: [entry('a', 1, 100)], now: 0 })
    r.send({ type: 'confirm' })
    // the decision comes back open while the counter-step runs, then the step fails
    r.send({ type: 'decisions', entries: [entry('a', 1, 100)], now: 5 })
    counters[0]?.resolve({ ok: false, code: 'transport' })
    await tick()
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'a' }, busy: false, failed: true })
    const t = timers.at(-1)
    expect(t?.at).toBe(100)
    t?.resolve({ ok: true, value: { now: 100 } })
    await tick()
    expect(r.get().name).toBe('idle')
  })

  it('an entry past its card’s end is never asked; the timer of the earliest end takes the next one off', async () => {
    const { r, timers, tick } = scripted()
    r.send({ type: 'decisions', entries: [entry('old', 1, 5), entry('x', 2, 100)], now: 10 })
    expect(r.get()).toMatchObject({ name: 'asking', head: { id: 'x' } })
    r.send({ type: 'notNow' })
    expect(r.get().name).toBe('idle')
    r.send({ type: 'decisions', entries: [entry('y', 3, 50), entry('x', 2, 100)], now: 10 })
    r.send({ type: 'hold', on: true })
    const t = timers.at(-1)
    expect(t?.at).toBe(50)
    t?.resolve({ ok: true, value: { now: 50 } })
    await tick()
    expect(r.rows).toContain('idle.result.expire')
    r.send({ type: 'hold', on: false })
    expect(r.get().name).toBe('idle')
    expect(incomingQueue([entry('y', 3, 50)], 50, [])).toEqual([])
  })
})

describe('the success moment (E7)', () => {
  it('once per relationship, never at the first view, never for a contact first seen mutual', () => {
    const c = (id: string, verification: 'mutual' | 'outgoing' | 'incoming') => ({ id: id as ContactId, verification })
    let w: MutualWatch = MUTUAL_WATCH
    let out = watchMutual(w, [c('a', 'mutual'), c('b', 'outgoing')])
    expect(out.fresh).toEqual([])
    w = out.watch
    out = watchMutual(w, [c('a', 'mutual'), c('b', 'mutual'), c('n', 'mutual')])
    expect(out.fresh).toEqual(['b'])
    w = out.watch
    out = watchMutual(w, [c('a', 'mutual'), c('b', 'incoming')])
    w = out.watch
    out = watchMutual(w, [c('a', 'mutual'), c('b', 'mutual')])
    expect(out.fresh).toEqual([])
  })

  it('both roles see it when the relationship becomes mutual; the verify flow covers its own person', async () => {
    const { devices, until } = await world(2)
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const seen: Record<string, ContactId[]> = { A: [], B: [] }
    for (const [k, d] of [['A', A], ['B', B]] as const) {
      let w: MutualWatch = MUTUAL_WATCH
      const look = () => {
        const v = d.port.stores.contacts.get()
        if (v.status !== 'ready') return
        const out = watchMutual(w, v.value)
        w = out.watch
        seen[k]?.push(...out.fresh)
      }
      d.port.stores.contacts.subscribe(look)
      look()
    }
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    await until(() => encounterDecisions(B).length === 1, 'the bundle')
    const [d] = encounterDecisions(B)
    expect((await B.port.trust.counterVerify(d!.contactId).done).ok).toBe(true)
    await until(() => (seen.A?.length ?? 0) === 1 && (seen.B?.length ?? 0) === 1, 'both moments')
    expect(seen).toEqual({ A: [scanned.value.contactId], B: [d!.contactId] })
    // the flow covers the person it asks for or waits on, not another one, not after it ended
    const waiting = { name: 'waiting', contactId: d!.contactId } as unknown as VerifyState
    expect(flowCovers(waiting, d!.contactId)).toBe(true)
    expect(flowCovers(waiting, 'other' as ContactId)).toBe(false)
    expect(flowCovers(null, d!.contactId)).toBe(false)
    expect(flowAsks(waiting)).toBe(true)
    // committing and capturing run towards the flow's own success (committing.result.mutual): the
    // person they scanned is covered, the mutual bundle may come before the act's result (review 468 #1)
    const preview = { role: 'displayed', name: 'Bea', knownContact: d!.contactId, self: false } as const
    expect(flowCovers({ name: 'committing', run: 1, card: null, mutual: [], preview, origin: 'camera' } as VerifyState, d!.contactId)).toBe(true)
    expect(flowCovers({ name: 'capturing', run: 1, card: null, mutual: [], preview: { ...preview, role: 'sent' }, origin: 'camera' } as VerifyState, d!.contactId)).toBe(true)
    expect(flowCovers({ name: 'committing', run: 1, card: null, mutual: [], preview: { ...preview, knownContact: null }, origin: 'camera' } as VerifyState, d!.contactId)).toBe(false)
    expect(flowAsks(null)).toBe(false)
    void (A.port as AppPort)
  }, 60_000)
})
