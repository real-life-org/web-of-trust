// Gen-2 reset, architecture §4.2 "Gen-2-Reset" (Anton: Gen-2 users get a new identity with a
// notice, the old seed is not migrated). The notice appears once; an interrupted wipe continues
// without it (marker legacy-wipe). The marker goes only after a verified wipe.

import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

export type LegacyState =
  | { readonly name: 'notice'; readonly run: number }
  | { readonly name: 'wiping'; readonly run: number }
  | { readonly name: 'verifying'; readonly run: number }
  | { readonly name: 'marking'; readonly run: number }
  | { readonly name: 'failed'; readonly run: number; readonly survivors: readonly string[] }
  | { readonly name: 'exit'; readonly run: number }

export type LegacyEvent = { readonly type: 'acknowledge' } | { readonly type: 'retry' }

export type LegacyEffect = { readonly id: 'leg.wipe' | 'leg.verify' | 'leg.mark' } & Effect

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

export const LEGACY_TABLE: readonly Row[] = [
  row('notice.acknowledge', 'acknowledge', 'wiping', 'locked', 'marker legacy-wipe: continue at wiping without the notice', { effects: ['leg.wipe'] }),
  row('wiping.result', 'result leg.wipe', 'verifying', 'locked', 'marker legacy-wipe', { effects: ['leg.verify'] }),
  row('verifying.result.clean', 'result leg.verify', 'marking', 'locked', 'marker legacy-wipe', { guard: 'no survivors', effects: ['leg.mark'] }),
  row('verifying.result.survivors', 'result leg.verify', 'failed{survivors}', 'free', 'marker legacy-wipe stays'),
  row('marking.result', 'result leg.mark', 'exit(welcome)', 'free', 'no marker, no legacy data'),
  row('failed.retry', 'retry', 'wiping', 'locked', 'marker legacy-wipe', { effects: ['leg.wipe'] }),
]

type S = LegacyState
type E = LegacyEvent | ResultEvent
type Out = Step<S, LegacyEffect>

function emit(state: S, row: string, make: (run: number) => readonly LegacyEffect[]): Out {
  const run = state.run + 1
  return { state: { ...state, run } as S, effects: make(run), row }
}

/** resume: the marker legacy-wipe exists, the notice was shown already */
export function legacyStart(resume: boolean): Out {
  if (resume) return { state: { name: 'wiping', run: 1 }, effects: [{ id: 'leg.wipe', run: 1 }], row: 'notice.acknowledge' }
  return { state: { name: 'notice', run: 0 }, effects: [], row: null }
}

export function legacyTransition(s: S, e: E): Out {
  switch (s.name) {
    case 'notice':
      if (e.type === 'acknowledge') return emit({ name: 'wiping', run: s.run }, 'notice.acknowledge', (r) => [{ id: 'leg.wipe', run: r }])
      return stay(s)
    case 'wiping':
      if (isResult(e, s.run, 'leg.wipe')) return emit({ name: 'verifying', run: s.run }, 'wiping.result', (r) => [{ id: 'leg.verify', run: r }])
      return stay(s)
    case 'verifying':
      if (isResult(e, s.run, 'leg.verify')) {
        if (e.result.ok) return emit({ name: 'marking', run: s.run }, 'verifying.result.clean', (r) => [{ id: 'leg.mark', run: r }])
        const survivors = (e.result.value as { survivors?: readonly string[] } | undefined)?.survivors ?? []
        return { state: { name: 'failed', run: s.run, survivors }, effects: [], row: 'verifying.result.survivors' }
      }
      return stay(s)
    case 'marking':
      if (isResult(e, s.run, 'leg.mark')) return { state: { name: 'exit', run: s.run }, effects: [], row: 'marking.result' }
      return stay(s)
    case 'failed':
      if (e.type === 'retry') return emit({ name: 'wiping', run: s.run }, 'failed.retry', (r) => [{ id: 'leg.wipe', run: r }])
      return stay(s)
    case 'exit':
      return stay(s)
  }
}

export const legacyReset: Machine<S, LegacyEvent, LegacyEffect> = {
  name: 'legacy-reset',
  table: LEGACY_TABLE,
  transition: legacyTransition,
  sensitive: () => false,
}
