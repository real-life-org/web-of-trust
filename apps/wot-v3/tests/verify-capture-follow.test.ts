// A sent card captured before (`already-captured`): where the encounter goes on is read from the
// published stores, never from a store that is still loading (#556). The capture's result, the
// decisions store and the contact's store arrive in any order; the follow-up is decided only once
// both stores have published, and it is the one the published stores say.
import { describe, expect, it } from 'vitest'
import { LOADING, ready, revision, writableStore, type AppPort, type ContactId, type DecisionId, type Result } from '../src/port'
import type { EffectResult } from '../src/flows/machine'
import { verifyExecutor } from '../src/hooks/verify'

const CONTACT = 'c-1' as ContactId
const DECISION = 'd-1' as DecisionId
const REV = revision(1, 1, 1)

type Step = 'capture' | 'decisions' | 'contact'
const STEPS: readonly Step[] = ['capture', 'decisions', 'contact']
const orders = (xs: readonly Step[]): Step[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x) => orders(xs.filter((y) => y !== x)).map((rest) => [x, ...rest])))

/** what the two stores publish, and the follow-up they mean */
const WORLDS = [
  {
    name: 'an open request',
    decisions: [{ id: DECISION, kind: 'encounter-confirm', contactId: CONTACT, state: 'open', openedAt: 0, expiresAt: null, answers: null }],
    contact: { id: CONTACT, verification: 'incoming', actions: { counterVerify: { ok: true } } },
    follow: { follow: 'confirm', decision: DECISION },
  },
  {
    name: 'mutual, nothing open',
    decisions: [],
    contact: { id: CONTACT, verification: 'mutual', actions: { counterVerify: { ok: false, reason: 'already-done' } } },
    follow: { follow: 'mutual', decision: null },
  },
  {
    name: 'the own step issued',
    decisions: [],
    contact: { id: CONTACT, verification: 'outgoing', actions: { counterVerify: { ok: false, reason: 'already-done' } } },
    follow: { follow: 'counter-pending', decision: null },
  },
] as const

/** a store that counts its live subscriptions */
function counted() {
  const s = writableStore<unknown>(LOADING)
  let live = 0
  return {
    get: s.get,
    set: s.set,
    live: () => live,
    subscribe(cb: () => void) {
      live++
      const off = s.subscribe(cb)
      return () => {
        live--
        off()
      }
    },
  }
}

function world() {
  const decisions = counted()
  const contact = counted()
  let resolveCapture: (r: Result<unknown>) => void = () => undefined
  const port = {
    stores: { decisions, contact: (id: string) => (id === CONTACT ? contact : writableStore(LOADING)) },
    trust: {
      confirmCard: () => ({ actId: 'a', done: new Promise<Result<unknown>>((r) => (resolveCapture = r)) }),
    },
  } as unknown as AppPort
  const platform = { scanner: {}, clock: { now: () => 0, setTimer: () => () => undefined } } as never
  return { port, platform, decisions, contact, capture: () => resolveCapture({ ok: true, value: { kind: 'already-captured', contactId: CONTACT } }) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the follow-up of a card captured before (#556)', () => {
  for (const w of WORLDS) {
    it(`${w.name}: in every order of the capture's result and the two stores, decided only after both published, as they say`, async () => {
      for (const order of orders(STEPS)) {
        const x = world()
        let result: EffectResult | null = null
        void verifyExecutor(x.port, x.platform, { current: null })({ id: 'ver.capture', run: 1, raw: 'CARD' }).then((r) => (result = r))
        const published = new Set<Step>()
        for (const step of order) {
          if (step === 'capture') x.capture()
          if (step === 'decisions') x.decisions.set(ready(w.decisions, REV))
          if (step === 'contact') x.contact.set(ready(w.contact, REV))
          published.add(step)
          await tick()
          // no answer while a store has not published
          if (!(published.has('decisions') && published.has('contact'))) expect(result, `${order.join(' → ')}: answered after ${step}`).toBeNull()
        }
        await tick()
        expect(result, order.join(' → ')).toEqual({ ok: true, value: { outcome: { kind: 'already-captured', contactId: CONTACT }, contactId: CONTACT, ...w.follow } })
        expect(x.decisions.live() + x.contact.live()).toBe(0)
      }
    })
  }

  it('the effect whose lifetime ended while a store loads answers cancelled and holds no subscription', async () => {
    const x = world()
    const life = new AbortController()
    const pending = verifyExecutor(x.port, x.platform, { current: null })({ id: 'ver.capture', run: 1, raw: 'CARD' }, life.signal)
    x.capture()
    await tick()
    life.abort()
    expect(await pending).toEqual({ ok: false, code: 'cancelled' })
    expect(x.decisions.live() + x.contact.live()).toBe(0)
  })

  it('without a contact (the card names none known) nothing is read: none at once', async () => {
    const x = world()
    let resolve: (r: Result<unknown>) => void = () => undefined
    ;(x.port.trust as { confirmCard: unknown }).confirmCard = () => ({ actId: 'a', done: new Promise<Result<unknown>>((r) => (resolve = r)) })
    const pending = verifyExecutor(x.port, x.platform, { current: null })({ id: 'ver.capture', run: 1, raw: 'CARD' })
    resolve({ ok: true, value: { kind: 'already-captured', contactId: null } })
    expect(await pending).toEqual({ ok: true, value: { outcome: { kind: 'already-captured', contactId: null }, contactId: null, follow: 'none', decision: null } })
  })
})

describe('the bundle the verify flow decides against', () => {
  it('is no bundle while the connections store loads: a ceremony not published yet is not "no ceremony"', async () => {
    const { bundleEvent } = await import('../src/hooks/verify')
    const connections = writableStore<unknown>(LOADING)
    const port = {
      stores: {
        contacts: writableStore(ready([], REV)),
        decisions: writableStore(ready([], REV)),
        connections,
        connectivity: writableStore({ network: 'online', carrier: 'connected' }),
      },
    } as unknown as AppPort
    expect(bundleEvent(port)).toBeNull()
    connections.set(ready([], REV))
    expect(bundleEvent(port)).toMatchObject({ type: 'bundle', connections: {} })
  })
})
