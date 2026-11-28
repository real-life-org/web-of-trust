// Findings of the review of #571 in the verify flow and its executor: the same card read again is no
// meeting, also where its stored contact is an alias; the card's request by the person, the counter-step by
// the card's own contact where several requests of the person are open. (The projection's:
// projection-aliases.test.ts.)
import { describe, expect, it } from 'vitest'
import type { AppPort, ContactId, Loadable } from '../../src/port'
import { verifyTransition, type VerifyState } from '../../src/flows/verify'
import { verifyExecutor } from '../../src/hooks/verify'

const KNOWN = 'c-known' as ContactId
const FRESH = 'c-fresh' as ContactId

describe('a card read again is no meeting (review of #571)', () => {
  const capturing = { name: 'capturing', run: 7, card: null, mutual: [], preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as unknown as VerifyState
  const bundle = { type: 'bundle', verifications: { [KNOWN]: 'mutual' }, aliases: { [FRESH]: KNOWN }, decisions: [] } as never
  const result = (follow: string, decision: string | null = null) =>
    ({ type: 'result', id: 'ver.capture', run: 7, result: { ok: true, value: { outcome: { kind: 'already-captured', contactId: FRESH }, contactId: FRESH, follow, decision } } }) as never

  it('its stored contact is an alias of a known one, the bundle first: the known contact, neither new nor recognized', () => {
    const end = verifyTransition(verifyTransition(capturing, bundle).state, result('mutual')).state
    expect(end).toMatchObject({ name: 'success', contactId: KNOWN, isNew: false, recognized: false })
  })

  it('the result first, then a bundle: still neither new nor recognized', () => {
    const first = verifyTransition(capturing, result('mutual')).state
    expect(first).toMatchObject({ name: 'success', isNew: false, recognized: false })
    expect(verifyTransition(first, bundle).state).toMatchObject({ name: 'success', contactId: KNOWN, isNew: false, recognized: false })
  })

  for (const [follow, decision] of [['confirm', 'p1'], ['counter', null], ['counter-pending', null]] as const) {
    it(`over the detour (${follow}): the mutual bundle ends in a success that is not recognized`, () => {
      const asked = verifyTransition(capturing, result(follow, decision)).state
      expect(asked.name).toBe(follow === 'counter-pending' ? 'counterPending' : 'confirmationRequired')
      expect(verifyTransition(asked, bundle).state).toMatchObject({ name: 'success', contactId: KNOWN, recognized: false })
    })
  }
})

describe('the follow-up of a card read again whose contact was joined (review of #571, rounds 2 and 3)', () => {
  const ready = <T,>(value: T): Loadable<T> => ({ status: 'ready', value }) as Loadable<T>
  const store = <T,>(value: T) => ({ get: () => ready(value), subscribe: () => () => undefined })
  /** a port whose capture answers "already captured" for the fresh contact, an alias of the known one */
  const port = (decisions: readonly { id: string; contactId: string }[]) =>
    ({
      trust: { confirmCard: () => ({ actId: 'x', done: Promise.resolve({ ok: true, value: { kind: 'already-captured', contactId: FRESH } }) }) },
      stores: {
        decisions: store(decisions.map((d) => ({ ...d, kind: 'encounter-confirm', state: 'open' }))),
        contact: () => store({ id: KNOWN, verification: 'incoming', actions: { counterVerify: { ok: true } } }),
      },
    }) as unknown as AppPort
  const capture = async (p: AppPort) => {
    const platform = { scanner: {}, clock: { now: () => 0, setTimer: () => () => undefined } } as never
    const r = await verifyExecutor(p, platform, { current: null })({ id: 'ver.capture', run: 1, raw: 'CARD' } as never)
    if (!r.ok) throw new Error('capture')
    return r.value as { follow: string; decision: string | null; contactId: string }
  }

  it('the card’s contact was joined into another: an open request and the details of that other contact are not the card’s, nothing is offered under it (as on main)', async () => {
    expect(await capture(port([{ id: 'pA', contactId: KNOWN }]))).toMatchObject({ follow: 'none', decision: null, contactId: FRESH })
  })
})
