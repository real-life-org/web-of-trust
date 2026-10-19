// Machine form of the flows (architecture §4.1 "Maschinenform"): `transition(state, event) →
// { state, effects }`, pure. Effects are data with an effect id (`onb.vault`, `unl.bio`, …); an effect
// runner in hooks/ executes them against port and platform and sends the outcome back as a
// `result` event with the same id and the run it belongs to. Every machine counts its runs: a result
// of an older run (late effect after navigation or cancel) is dropped (§4.1, Befund 8).
//
// Each machine exports its transition table as data (`TABLE`): one row per (state × event × guard),
// with the effect id, the cancel policy and the resume rule of architecture §4.2. `transition`
// reports the row it took, so the transition tests can prove every row is reached.

/** Cancel policy of a state (architecture §4.2 "Abbruchpolitik"). */
export type CancelPolicy = 'free' | 'after-effect' | 'locked'

export interface Row {
  /** `<state>.<event>[.<guard>]`, unique within the machine */
  readonly id: string
  readonly from: string
  readonly event: string
  readonly guard?: string
  /** effect ids emitted, in order */
  readonly effects?: readonly string[]
  readonly to: string
  readonly cancel: CancelPolicy
  /** what holds after a process loss in or after this row (boot matrix, intent, nothing stored) */
  readonly resume: string
}

/** The outcome of an effect, normalized by the runner. */
export interface EffectResult {
  readonly ok: boolean
  /** refusal or platform code when not ok (`passphrase-wrong`, `cancelled`, `invalidated`, …) */
  readonly code?: string
  readonly value?: unknown
}

export interface ResultEvent {
  readonly type: 'result'
  readonly id: string
  readonly run: number
  readonly result: EffectResult
}

export interface Effect {
  readonly id: string
  readonly run: number
}

export interface Step<S, F extends Effect = Effect> {
  readonly state: S
  readonly effects: readonly F[]
  /** the table row taken, null when the event did not apply (ignored) */
  readonly row: string | null
}

export interface Machine<S extends { readonly name: string; readonly run: number }, E, F extends Effect> {
  readonly name: string
  readonly table: readonly Row[]
  transition(state: S, event: E | ResultEvent): Step<S, F>
  /** states that show words or passphrase fields: ScreenProtectionPort 'sensitive' (architecture §5) */
  sensitive(state: S): boolean
}

/** No transition: the event is ignored (unknown event, guard failed without a row, stale result). */
export function stay<S, F extends Effect>(state: S): Step<S, F> {
  return { state, effects: [], row: null }
}

/** A result of the current run for this effect id? (The predicate names the id, so a failed check
 *  does not remove ResultEvent from the event type for the next check.) */
export function isResult<I extends string>(event: { type: string }, run: number, id: I): event is ResultEvent & { readonly id: I } {
  return event.type === 'result' && (event as ResultEvent).id === id && (event as ResultEvent).run === run
}

export function rowIds(table: readonly Row[]): string[] {
  const ids = table.map((r) => r.id)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup) throw new Error(`duplicate row ${dup}`)
  return ids
}
