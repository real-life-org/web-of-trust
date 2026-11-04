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

describe('the order of the bundle and the scan result does not matter (review 509)', () => {
  const committing = { ...base, name: 'committing', preview: { name: 'Noah', image: null }, origin: 'camera' } as unknown as VerifyState
  const result = (contactId: ContactId): VerifyEvent => ({ type: 'result', id: 'ver.confirm', run: 1, result: { ok: true, value: { kind: 'scanned', contactId } } }) as unknown as VerifyEvent

  it('bundle first (the alias already published), the scan result after: the survivor\'s success', () => {
    const s1 = step(committing, bundle({ [FRESH]: OLD }))
    expect(s1).toMatchObject({ name: 'committing' })
    expect(step(s1, result(FRESH))).toMatchObject({ name: 'success', contactId: OLD, isNew: false })
  })

  it('the scan result first, the bundle after: the same success', () => {
    const s1 = step(committing, result(FRESH))
    expect(s1).toMatchObject({ name: 'waiting', contactId: FRESH })
    expect(step(s1, bundle({ [FRESH]: OLD }))).toMatchObject({ name: 'success', contactId: OLD, isNew: false })
  })

  it('a bundle while waiting that no longer names the alias does not undo what the machine knows', () => {
    const waitingFresh = step(step(committing, result(FRESH)), { type: 'bundle', verifications: { [OLD]: 'outgoing' }, aliases: { [FRESH]: OLD }, decisions: [] })
    expect(waitingFresh).toMatchObject({ name: 'waiting', contactId: FRESH })
    expect(step(waitingFresh, bundle({ [FRESH]: OLD }))).toMatchObject({ name: 'success', contactId: OLD })
  })
})

describe('the bundle snapshot survives every transition (review 509, #511)', () => {
  const confirm = { ...base, name: 'confirm', raw: 'raw', preview: { name: 'Noah', image: null }, origin: 'camera' } as unknown as VerifyState
  const confirmResult = (contactId: ContactId): VerifyEvent => ({ type: 'result', id: 'ver.confirm', run: 2, result: { ok: true, value: { kind: 'scanned', contactId } } }) as unknown as VerifyEvent

  it('confirm → bundle → yes (an effect) → the scan result: the survivor\'s success', () => {
    const s1 = step(confirm, bundle({ [FRESH]: OLD }))
    const s2 = step(s1, { type: 'yes' } as VerifyEvent)
    expect(s2).toMatchObject({ name: 'committing', aliases: { [FRESH]: OLD } })
    expect(step(s2, confirmResult(FRESH))).toMatchObject({ name: 'success', contactId: OLD, isNew: false })
  })

  it('a plain transition (no effect) keeps the snapshot as well', () => {
    const waiting = { ...base, name: 'waiting', contactId: FRESH, name2: 'Noah', waitLong: false } as unknown as VerifyState
    const s1 = step(waiting, { type: 'bundle', verifications: {}, aliases: { [FRESH]: OLD }, decisions: [] })
    const s2 = step(s1, { type: 'result', id: 'ver.wait', run: 1, result: { ok: true } } as unknown as VerifyEvent)
    expect(s2).toMatchObject({ name: 'waiting', waitLong: true, aliases: { [FRESH]: OLD } })
  })
})

