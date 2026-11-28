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

describe('the same card read again is no meeting (review of #571)', () => {
  const capturing = { name: 'capturing', run: 7, card: null, mutual: [], preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as unknown as VerifyState
  const bundle = { type: 'bundle', verifications: { [KNOWN]: 'mutual' }, aliases: { [FRESH]: KNOWN }, decisions: [] } as never
  const result = { type: 'result', id: 'ver.capture', run: 7, result: { ok: true, value: { outcome: { kind: 'already-captured', contactId: FRESH }, contactId: FRESH, follow: 'mutual', decision: null } } } as never

  it('its stored contact is an alias of a known one, the bundle first: the known contact, neither new nor recognized', () => {
    const end = verifyTransition(verifyTransition(capturing, bundle).state, result).state
    expect(end).toMatchObject({ name: 'success', contactId: KNOWN, isNew: false, recognized: false })
  })

  it('the result first, then a bundle: still neither new nor recognized', () => {
    const first = verifyTransition(capturing, result).state
    expect(first).toMatchObject({ name: 'success', isNew: false, recognized: false })
    expect(verifyTransition(first, bundle).state).toMatchObject({ name: 'success', contactId: KNOWN, isNew: false, recognized: false })
  })
})

describe('the request of a card read again (review of #571)', () => {
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

  it('one open request of the person: it is the card’s, by its id', async () => {
    expect(await capture(port([{ id: 'p1', contactId: KNOWN }]))).toMatchObject({ follow: 'confirm', decision: 'p1' })
  })

  it('two open requests of the person: none is chosen, the counter-step runs under the card’s own contact', async () => {
    expect(await capture(port([{ id: 'p1', contactId: KNOWN }, { id: 'p2', contactId: KNOWN }]))).toMatchObject({ follow: 'counter', decision: null, contactId: FRESH })
  })
})
