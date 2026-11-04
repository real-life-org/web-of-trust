// A second encounter with a known person (Anton 04.11.): the library records it under a fresh contact,
// then its continuity sweep joins that contact into the first one (Trust 6a.4); the fresh id lives on
// only as an alias of the survivor. A verify flow that waits on the fresh id must follow it: the bundle
// names the aliases, and the flow ends in the success of the survivor, as a re-encounter (no confetti).
import { describe, expect, it } from 'vitest'
import type { ContactId } from '../../src/port'
import { verify, type VerifyEvent, type VerifyState } from '../../src/flows/verify'

const FRESH = 'c-fresh' as ContactId
const OLD = 'c-old' as ContactId
const base = { run: 1, card: null, mutual: [] as string[] }
const bundle = (aliases: Record<string, ContactId>): VerifyEvent => ({ type: 'bundle', verifications: { [OLD]: 'mutual' }, aliases, decisions: [] })
const step = (s: VerifyState, e: VerifyEvent) => verify.transition(s, e).state

describe('the verify flow follows a contact joined into an earlier one', () => {
  const waiting: VerifyState[] = [
    { ...base, name: 'waiting', contactId: FRESH, name2: 'Noah', waitLong: false },
    { ...base, name: 'waiting', contactId: FRESH, name2: 'Noah', waitLong: true },
    { ...base, name: 'loadingFallback', contactId: FRESH, name2: 'Noah' },
    { ...base, name: 'fallback', contactId: FRESH, name2: 'Noah', sentQr: 'qr' },
    { ...base, name: 'counterPending', contactId: FRESH, name2: 'Jonas' },
  ] as VerifyState[]

  for (const s of waiting) {
    it(`${s.name}${'waitLong' in s && s.waitLong ? ' (long)' : ''}: the fresh id is an alias of a mutual contact → the survivor's success, a re-encounter`, () => {
      expect(step(s, bundle({ [FRESH]: OLD }))).toMatchObject({ name: 'success', contactId: OLD, isNew: false })
    })
  }

  it('without the alias the flow keeps waiting: the fresh id is not mutual', () => {
    const s = waiting[0] as VerifyState
    expect(step(s, bundle({}))).toMatchObject({ name: 'waiting', contactId: FRESH })
  })

  it('a bundle without aliases (an older port) changes nothing', () => {
    const s = waiting[0] as VerifyState
    expect(step(s, { type: 'bundle', verifications: { [FRESH]: 'mutual' }, decisions: [] })).toMatchObject({ name: 'success', contactId: FRESH, isNew: true })
  })
})
