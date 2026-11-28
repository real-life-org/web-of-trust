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

  it('a store in error decides nothing: the capture answers the store\'s error, never "nothing open" (review of #562)', async () => {
    for (const broken of ['decisions', 'contact'] as const) {
      const x = world()
      const pending = verifyExecutor(x.port, x.platform, { current: null })({ id: 'ver.capture', run: 1, raw: 'CARD' })
      x.capture()
      const error = { status: 'error', error: { kind: 'infra', code: 'storage', retryable: true } }
      x.decisions.set(broken === 'decisions' ? error : ready([], REV))
      x.contact.set(broken === 'contact' ? error : ready(WORLDS[1].contact, REV))
      expect(await pending, broken).toEqual({ ok: false, code: 'storage' })
      expect(x.decisions.live() + x.contact.live()).toBe(0)
    }
  })

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

describe('a capture result for a contact the last bundle names mutual (CodeRabbit on #562)', () => {
  it('is the success, never the question again: for the confirm and the counter follow-up', async () => {
    const { verifyTransition } = await import('../src/flows/verify')
    for (const follow of ['confirm', 'counter'] as const) {
      const capturing = { name: 'capturing', run: 7, card: null, mutual: [], preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as never
      // the bundle arrives while the capture runs: capturing ignores it, the machine keeps who is mutual
      const afterBundle = verifyTransition(capturing, { type: 'bundle', verifications: { [CONTACT]: 'mutual' }, decisions: [] }).state
      const out = verifyTransition(afterBundle, { type: 'result', id: 'ver.capture', run: 7, result: { ok: true, value: { outcome: { kind: 'already-captured', contactId: CONTACT }, contactId: CONTACT, follow, decision: follow === 'confirm' ? DECISION : null } } } as never)
      expect(out.state, follow).toMatchObject({ name: 'success', contactId: CONTACT, isNew: false })
    }
  })
})

describe('a capture result and a bundle in every order (review of #562, round 3)', () => {
  it('a mutual known before the capture started does not overrule the capture\'s newer result (round 4)', async () => {
    const { verifyTransition } = await import('../src/flows/verify')
    const ready = verifyTransition({ name: 'ready', run: 2, card: null, mutual: [], hint: null } as never, { type: 'bundle', verifications: { [CONTACT]: 'mutual' }, decisions: [] }).state
    const capturing = { ...ready, name: 'capturing', run: 3, preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as never
    const out = verifyTransition(capturing, { type: 'result', id: 'ver.capture', run: 3, result: { ok: true, value: { outcome: { kind: 'already-captured', contactId: CONTACT }, follow: 'counter-pending', decision: null, contactId: CONTACT } } } as never)
    expect(out.state).toMatchObject({ name: 'counterPending', contactId: CONTACT })
  })

  it('a bundle that names the contact mutual wins over any later capture result; any other bundle changes nothing', async () => {
    const { verifyTransition } = await import('../src/flows/verify')
    type Outcome = { readonly name: string; readonly value: Record<string, unknown>; readonly contact: boolean }
    const outcomes: Outcome[] = [
      { name: 'captured', value: { outcome: { kind: 'captured', contactId: CONTACT, decision: DECISION }, follow: 'none', decision: null, contactId: null }, contact: true },
      ...(['confirm', 'counter', 'counter-pending', 'mutual', 'met'] as const).map((follow) => ({
        name: `again/${follow}`,
        value: { outcome: { kind: 'already-captured', contactId: CONTACT }, follow, decision: follow === 'confirm' ? DECISION : null, contactId: CONTACT },
        contact: true,
      })),
      { name: 'again/none', value: { outcome: { kind: 'already-captured', contactId: null }, follow: 'none', decision: null, contactId: null }, contact: false },
    ]
    const lagen = {
      none: { verifications: {}, decisions: [] },
      open: { verifications: { [CONTACT]: 'incoming' }, decisions: [{ id: DECISION, contactId: CONTACT, card: 'K-other', name: 'Bea' }] },
      'counter-pending': { verifications: { [CONTACT]: 'outgoing' }, decisions: [] },
      mutual: { verifications: { [CONTACT]: 'mutual' }, decisions: [] },
    } as const
    const capturing = { name: 'capturing', run: 7, card: null, mutual: [], preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as never
    const result = (o: Outcome) => ({ type: 'result', id: 'ver.capture', run: 7, result: { ok: true, value: o.value } }) as never
    const bundle = (l: keyof typeof lagen) => ({ type: 'bundle', ...lagen[l] }) as never
    for (const o of outcomes) {
      const alone = verifyTransition(capturing, result(o)).state as { name: string }
      for (const l of Object.keys(lagen) as (keyof typeof lagen)[]) {
        for (const when of ['beforeRun', 'before', 'after'] as const) {
          let end: { name: string }
          if (when === 'beforeRun') {
            // the bundle came before this capture started (the code screen): its lage is carried into the
            // run, and it is older than the result
            const ready = verifyTransition({ name: 'ready', run: 6, card: null, mutual: [], hint: null } as never, bundle(l)).state
            const started = { ...ready, name: 'capturing', run: 7, preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as never
            end = verifyTransition(started, result(o)).state as { name: string }
          } else {
            const s1 = when === 'before' ? verifyTransition(capturing, bundle(l)).state : verifyTransition(capturing, result(o)).state
            end = (when === 'before' ? verifyTransition(s1, result(o)) : verifyTransition(s1, bundle(l))).state as { name: string }
          }
          const label = `${o.name}, bundle ${l} ${when}`
          if (l === 'mutual' && o.contact && (when === 'before' || (when === 'after' && (alone.name === 'confirmationRequired' || alone.name === 'counterPending' || alone.name === 'success')))) expect(end.name, label).toBe('success')
          else expect(end.name, label).toBe(alone.name)
        }
      }
    }
  })
})

describe('the answer to a proposal and the bundles while it runs (#565)', () => {
  type Lage = 'open' | 'in-flight' | 'gone' | 'gone-contact'
  /** a port whose stores say where the request stands: open, our own answer running, gone (no contact), gone with the contact */
  const portAt = (lage: Lage) =>
    ({
      stores: {
        contacts: writableStore(ready([], REV)),
        decisions: writableStore(
          ready(lage === 'open' || lage === 'in-flight' ? [{ id: DECISION, kind: 'connect-confirm', connection: 'e1', name: 'Bea', state: lage, openedAt: 0, expiresAt: null, answers: { card: 'K', validUntil: Number.MAX_SAFE_INTEGER } }] : [], REV),
        ),
        connections: writableStore(
          ready([{ id: 'e1', role: 'inviter', status: 'open', name: 'Bea', contactId: lage === 'gone-contact' ? CONTACT : null, met: true, failure: null, closedAt: null, camera: true, accepted: lage === 'gone-contact', backShown: false, relayed: true, theirDid: null, expiresAt: Number.MAX_SAFE_INTEGER, validUntil: Number.MAX_SAFE_INTEGER, decision: lage === 'open' || lage === 'in-flight' ? DECISION : null }], REV),
        ),
        connectivity: writableStore({ network: 'online', carrier: 'connected' }),
      },
    }) as unknown as AppPort

  it('in every order of the bundles and the refused result: the request still open is asked again with the error, a gone one ends', async () => {
    const { bundleEvent } = await import('../src/hooks/verify')
    const { verifyTransition } = await import('../src/flows/verify')
    const busy = { name: 'connectIncoming', run: 5, card: null, mutual: [], connections: bundle0(), connection: 'e1', decision: DECISION, name2: 'Bea', busy: 'accept', failed: false } as never
    function bundle0() {
      return (bundleEvent(portAt('open')) as { connections: unknown }).connections
    }
    const refused = { type: 'result', id: 'ver.decide', run: 5, result: { ok: false, code: 'not-possible-yet' } } as never
    // [the bundles that arrive while the act runs, the lage they end with, the expected end]
    const cases: [readonly Lage[], string][] = [
      [['in-flight'], 'failed'],
      [['in-flight', 'open'], 'failed'],
      [['gone'], 'showing'],
      [['in-flight', 'gone'], 'showing'],
      [['gone-contact'], 'success'],
      [['gone', 'open'], 'failed'],
      [['gone', 'in-flight', 'open'], 'failed'],
    ]
    for (const [bundles, expected] of cases) {
      let s = busy
      for (const l of bundles) s = verifyTransition(s, bundleEvent(portAt(l))!).state as never
      const end = verifyTransition(s, refused).state as { name: string; busy?: unknown; failed?: boolean }
      const label = bundles.join(' → ')
      if (expected === 'failed') expect(end, label).toMatchObject({ name: 'connectIncoming', busy: null, failed: true })
      else expect(end.name, label).toBe(expected)
    }
    // the result first, then the bundles: the open request stays answerable, a gone one leaves it
    const failedFirst = verifyTransition(busy, refused).state
    expect(failedFirst).toMatchObject({ name: 'connectIncoming', busy: null, failed: true })
    expect(verifyTransition(failedFirst, bundleEvent(portAt('open'))!).state).toMatchObject({ name: 'connectIncoming', failed: true })
    expect((verifyTransition(failedFirst, bundleEvent(portAt('gone'))!).state as { name: string }).name).toBe('showing')
  })
})
