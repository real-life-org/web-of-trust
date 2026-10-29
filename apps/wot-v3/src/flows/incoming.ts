// Incoming confirmations (handshake UX 2.6, E6): a queue over the port's `decisions`, nothing of its
// own in the port. The open encounter-confirm decisions that answer an own displayed card still valid
// (E9: the card is named exactly; E6: while the person can still be in front of you) are asked one
// after the other in the order they arrived, as a sheet wherever the person is in the app. Nothing
// overwrites: a decision that arrives while one is asked waits behind it ("2 of 3"). "Not now" sets a
// decision aside for this session (local, transient); it stays open in the list and the conversation,
// which ask "Did you meet {name}?" once the card has ended. The shell holds the queue while a flow asks
// for a person itself or the success sheet is open (E7: success first, then the next one).

import type { ContactId, DecisionId } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

/** One open encounter-confirm that answers an own card (from the hook, over `decisions`). */
export interface IncomingEntry {
  readonly id: DecisionId
  readonly contactId: ContactId
  readonly name: string | null
  /** arrival: the order of the queue */
  readonly openedAt: number
  /** the answered card's end (AnsweredCard.validUntil): asked only before it */
  readonly validUntil: number
}

interface Base {
  readonly run: number
  /** what the decisions store says is open, as the hook last saw it */
  readonly entries: readonly IncomingEntry[]
  /** the device time the queue was last judged at */
  readonly now: number
  /** "not now" in this session (also from the verify flow) */
  readonly deferred: readonly DecisionId[]
  /** a flow asks for a person itself, or the success sheet is open */
  readonly held: boolean
  /** confirmations done since the queue was last empty: the "n of m" */
  readonly handled: number
  /** the end the running expiry timer waits for (null: none) */
  readonly timerAt: number | null
}

export type IncomingState =
  | (Base & { readonly name: 'idle' })
  | (Base & { readonly name: 'asking'; readonly head: IncomingEntry; readonly busy: boolean; readonly failed: boolean })

export type IncomingEvent =
  | { readonly type: 'decisions'; readonly entries: readonly IncomingEntry[]; readonly now: number }
  | { readonly type: 'hold'; readonly on: boolean }
  /** set aside by another screen (the verify flow's "not now") */
  | { readonly type: 'defer'; readonly id: DecisionId }
  | { readonly type: 'confirm' }
  | { readonly type: 'notNow' }

export type IncomingEffect = ({ readonly id: 'inc.counter'; readonly contactId: ContactId } & Effect) | ({ readonly id: 'inc.expire'; readonly at: number } & Effect)

export const INCOMING_STATES = ['idle', 'asking'] as const satisfies readonly IncomingState['name'][]

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

const NOTHING = 'nothing stored: the queue is a view of `decisions`, "not now" is transient'

export const INCOMING_TABLE: readonly Row[] = [
  row('idle.decisions.ask', 'decisions', 'asking{head}', 'free', NOTHING, { guard: 'not held, an entry before its card’s end and not set aside', effects: ['inc.expire'] }),
  row('idle.hold.off', 'hold', 'asking{head}', 'free', NOTHING, { guard: 'released, the queue not empty' }),
  row('idle.defer', 'defer', 'idle', 'free', NOTHING),
  row('idle.result.expire', 'result inc.expire', 'idle', 'free', NOTHING, { guard: 'an entry’s card ended', effects: ['inc.expire'] }),
  row('asking.confirm', 'confirm', 'asking{busy}', 'after-effect', 'intent replay: the counter-step completes after a loss, the decision closes', { effects: ['inc.counter'] }),
  row('asking.result.ok', 'result inc.counter', 'asking{next} | idle', 'free', '–', { guard: 'the next entry, else idle (the success sheet comes from the mutual bundle, E7)' }),
  row('asking.result.failed', 'result inc.counter', 'asking{failed}', 'free', 'the decision stays open'),
  row('asking.notNow', 'notNow', 'asking{next} | idle', 'free', NOTHING, { guard: 'not busy' }),
  row('asking.defer', 'defer', 'asking{next} | idle', 'free', NOTHING, { guard: 'the asked entry, not busy' }),
  row('asking.decisions.gone', 'decisions', 'asking{next} | idle', 'free', NOTHING, { guard: 'not busy; the asked decision is no longer open (decided elsewhere)' }),
  row('asking.hold.on', 'hold', 'idle', 'free', 'the asked entry stays in the queue', { guard: 'not busy' }),
  row('asking.result.expire', 'result inc.expire', 'asking{next} | idle', 'free', NOTHING, { guard: 'the asked entry’s card ended, not busy', effects: ['inc.expire'] }),
]

type S = IncomingState
type E = IncomingEvent | ResultEvent
type Out = Step<S, IncomingEffect>

/** The queue as it stands: before the card's end, not set aside, by arrival (then by id). */
export function incomingQueue(entries: readonly IncomingEntry[], now: number, deferred: readonly DecisionId[]): IncomingEntry[] {
  return entries.filter((e) => now < e.validUntil && !deferred.includes(e.id)).sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const base = (s: S): Base => ({ run: s.run, entries: s.entries, now: s.now, deferred: s.deferred, held: s.held, handled: s.handled, timerAt: s.timerAt })

/** Where the queue goes from `b`: the asked entry stays asked while it is in the queue; else the
 *  first one; idle when held or empty. The expiry timer follows the earliest card end. */
function judge(b: Base, keep: IncomingEntry | null, rowId: string | null): Out {
  const queue = incomingQueue(b.entries, b.now, b.deferred)
  const handled = queue.length === 0 ? 0 : b.handled
  const next = keep && queue.some((e) => e.id === keep.id) ? (queue.find((e) => e.id === keep.id) ?? keep) : (queue[0] ?? null)
  const ends = queue.map((e) => e.validUntil)
  const end = ends.length > 0 ? Math.min(...ends) : null
  const effects: IncomingEffect[] = []
  let run = b.run
  let timerAt = b.timerAt
  if (end !== null && end !== timerAt) {
    run += 1
    timerAt = end
    effects.push({ id: 'inc.expire', run, at: end })
  }
  if (end === null) timerAt = null
  const nb: Base = { ...b, run, handled, timerAt }
  const state: S = b.held || next === null ? { ...nb, name: 'idle' } : { ...nb, name: 'asking', head: next, busy: false, failed: false }
  return { state, effects, row: rowId }
}

export function incomingStart(now: number): S {
  return { name: 'idle', run: 1, entries: [], now, deferred: [], held: false, handled: 0, timerAt: null }
}

/** "n of m": the asked one among those done and those still waiting since the queue was last empty */
export function incomingPosition(s: S): { readonly n: number; readonly m: number } | null {
  if (s.name !== 'asking') return null
  return { n: s.handled + 1, m: s.handled + incomingQueue(s.entries, s.now, s.deferred).length }
}

export function incomingTransition(s: S, e: E): Out {
  switch (s.name) {
    case 'idle': {
      if (e.type === 'decisions') {
        const out = judge({ ...base(s), entries: e.entries, now: e.now }, null, null)
        return out.state.name === 'asking' ? { ...out, row: 'idle.decisions.ask' } : out
      }
      if (e.type === 'hold') {
        const out = judge({ ...base(s), held: e.on }, null, null)
        return out.state.name === 'asking' ? { ...out, row: 'idle.hold.off' } : out
      }
      if (e.type === 'defer') return judge({ ...base(s), deferred: [...s.deferred, e.id] }, null, 'idle.defer')
      if (isResult(e, s.run, 'inc.expire')) {
        const now = Math.max(s.now, (e.result.value as { now?: number } | undefined)?.now ?? s.timerAt ?? s.now)
        return judge({ ...base(s), now, timerAt: null }, null, 'idle.result.expire')
      }
      return stay(s)
    }
    case 'asking': {
      if (isResult(e, s.run, 'inc.counter')) {
        if (!e.result.ok) return { state: { ...s, busy: false, failed: true }, effects: [], row: 'asking.result.failed' }
        return judge({ ...base(s), handled: s.handled + 1, deferred: [...s.deferred, s.head.id] }, null, 'asking.result.ok')
      }
      if (s.busy) {
        // the counter-step runs: the asked decision goes in flight; nothing moves the sheet until its result
        if (e.type === 'decisions') return { state: { ...s, entries: e.entries, now: e.now }, effects: [], row: null }
        if (e.type === 'hold') return { state: { ...s, held: e.on }, effects: [], row: null }
        if (e.type === 'defer') return { state: { ...s, deferred: [...s.deferred, e.id] }, effects: [], row: null }
        return stay(s)
      }
      if (e.type === 'confirm') {
        const run = s.run + 1
        return { state: { ...s, run, busy: true, failed: false, timerAt: null }, effects: [{ id: 'inc.counter', run, contactId: s.head.contactId }], row: 'asking.confirm' }
      }
      if (e.type === 'notNow') return judge({ ...base(s), deferred: [...s.deferred, s.head.id] }, null, 'asking.notNow')
      if (e.type === 'defer') {
        const b = { ...base(s), deferred: [...s.deferred, e.id] }
        return e.id === s.head.id ? judge(b, null, 'asking.defer') : judge(b, s.head, null)
      }
      if (e.type === 'decisions') {
        const b = { ...base(s), entries: e.entries, now: e.now }
        const still = incomingQueue(b.entries, b.now, b.deferred).some((x) => x.id === s.head.id)
        return judge(b, s.head, still ? null : 'asking.decisions.gone')
      }
      if (e.type === 'hold') return e.on ? judge({ ...base(s), held: true }, s.head, 'asking.hold.on') : stay(s)
      if (isResult(e, s.run, 'inc.expire')) {
        const now = Math.max(s.now, (e.result.value as { now?: number } | undefined)?.now ?? s.timerAt ?? s.now)
        return judge({ ...base(s), now, timerAt: null }, s.head, 'asking.result.expire')
      }
      return stay(s)
    }
  }
}

export const incoming: Machine<S, IncomingEvent, IncomingEffect> = {
  name: 'incoming',
  table: INCOMING_TABLE,
  transition: incomingTransition,
  sensitive: () => false,
}
