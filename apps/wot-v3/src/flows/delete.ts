// Delete the identity, architecture §4.2 "Identität löschen" (Befund 9, N2, N6, N12): phased
// shutdown S1 to S6, no step before sealing deletes anything, no step after it needs keys; the
// local result and the deregistration at carriers are reported separately.

import type { LockInfo, WipeReport } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

export type DeleteState =
  | { readonly name: 'explain'; readonly run: number }
  | { readonly name: 'confirm'; readonly run: number; readonly typed: string; readonly word: string }
  | { readonly name: 'quiescing'; readonly run: number }
  | { readonly name: 'deregistering'; readonly run: number; readonly mode: 'run' | 'skip' }
  | { readonly name: 'sealing'; readonly run: number }
  | { readonly name: 'closing'; readonly run: number }
  | { readonly name: 'wiping'; readonly run: number }
  | { readonly name: 'verifying'; readonly run: number; readonly survivors: readonly string[] | null }
  | { readonly name: 'done'; readonly run: number; readonly report: WipeReport }
  | { readonly name: 'failed'; readonly run: number; readonly survivors: readonly string[] }
  /** interrupted before sealing: keys still there (boot matrix wipe/quiescing, wipe/deregistering) */
  | { readonly name: 'resumeChoice'; readonly run: number; readonly lock: LockInfo | null }
  | { readonly name: 'exit'; readonly run: number; readonly to: 'app' | 'welcome' | 'unlock-for-deregistration' }

export type DeleteEvent =
  | { readonly type: 'next' }
  | { readonly type: 'typed'; readonly value: string }
  | { readonly type: 'confirm' }
  | { readonly type: 'back' }
  | { readonly type: 'retry' }
  | { readonly type: 'continue' }
  | { readonly type: 'unlockToDeregister' }
  | { readonly type: 'deleteWithoutDeregistration' }

export type DeleteEffect =
  | ({ readonly id: 'del.quiesce' | 'del.seal' | 'del.close' | 'del.wipe' | 'del.verify' | 'del.done' } & Effect)
  | ({ readonly id: 'del.dereg'; readonly mode: 'run' | 'skip' } & Effect)

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

const RESUME_BEFORE_SEAL = 'marker wipe/quiescing or wipe/deregistering: resuming{wipe}; unlock to deregister, or delete without'

export const DELETE_TABLE: readonly Row[] = [
  row('explain.next', 'next', 'confirm', 'free', 'nothing changed'),
  row('explain.back', 'back', 'exit(app)', 'free', 'nothing changed'),
  row('confirm.typed', 'typed', 'confirm', 'free', 'nothing changed'),
  row('confirm.confirm', 'confirm', 'quiescing', 'locked', RESUME_BEFORE_SEAL, { guard: 'typed word matches', effects: ['del.quiesce'] }),
  row('confirm.back', 'back', 'explain', 'free', 'nothing changed'),
  row('quiescing.result', 'result del.quiesce', 'deregistering', 'locked', RESUME_BEFORE_SEAL, { effects: ['del.dereg'] }),
  row('deregistering.result', 'result del.dereg', 'sealing', 'locked', RESUME_BEFORE_SEAL, { guard: 'done or 10 s', effects: ['del.seal'] }),
  row('sealing.result', 'result del.seal', 'closing', 'locked', 'marker wipe/sealed: the holder never opens again, continue at closing', { effects: ['del.close'] }),
  row('closing.result', 'result del.close', 'wiping', 'locked', 'idempotent', { effects: ['del.wipe'] }),
  row('wiping.result', 'result del.wipe', 'verifying', 'locked', 'idempotent', { effects: ['del.verify'] }),
  row('verifying.result.clean', 'result del.verify', 'verifying', 'locked', '–', { guard: 'all layers gone', effects: ['del.done'] }),
  row('verifying.result.survivors', 'result del.verify', 'verifying{survivors}', 'locked', 'marker stays, the next start continues', { effects: ['del.done'] }),
  row('verifying.result.done', 'result del.done', 'done', 'free', 'no marker'),
  row('verifying.result.failed', 'result del.done', 'failed{survivors}', 'free', 'marker stays, lock released, the next start continues'),
  row('failed.retry', 'retry', 'wiping', 'locked', 'idempotent', { effects: ['del.wipe'] }),
  row('done.continue', 'continue', 'exit(welcome)', 'free', '–'),
  row('resumeChoice.unlock', 'unlockToDeregister', 'exit(unlock-for-deregistration)', 'free', RESUME_BEFORE_SEAL, { guard: 'keys available (lock info)' }),
  row('resumeChoice.skip', 'deleteWithoutDeregistration', 'deregistering{skip}', 'locked', RESUME_BEFORE_SEAL, { effects: ['del.dereg'] }),
]

type S = DeleteState
type E = DeleteEvent | ResultEvent
type Out = Step<S, DeleteEffect>

const go = (state: S, row: string, effects: readonly DeleteEffect[] = []): Out => ({ state, effects, row })
function emit(state: S, row: string, make: (run: number) => readonly DeleteEffect[]): Out {
  const run = state.run + 1
  return { state: { ...state, run } as S, effects: make(run), row }
}

/** The word the person types to confirm (localized, compared case-insensitively). */
export function deleteStart(): S {
  return { name: 'explain', run: 0 }
}

/** Entry after a restart (IdentityState resuming{wipe}). */
export function deleteResume(phase: 'before-seal' | 'after-seal', lock: LockInfo | null): Out {
  if (phase === 'after-seal') return { state: { name: 'closing', run: 1 }, effects: [{ id: 'del.close', run: 1 }], row: 'sealing.result' }
  return { state: { name: 'resumeChoice', run: 0, lock }, effects: [], row: null }
}

/** Entry after unlocking for the deregistration (unlock mode delete-dereg). */
export function deleteAfterUnlock(): Out {
  return { state: { name: 'deregistering', run: 1, mode: 'run' }, effects: [{ id: 'del.dereg', run: 1, mode: 'run' }], row: 'quiescing.result' }
}

export function deleteTransition(s: S, e: E, word = ''): Out {
  switch (s.name) {
    case 'explain':
      if (e.type === 'next') return go({ name: 'confirm', run: s.run, typed: '', word }, 'explain.next')
      if (e.type === 'back') return go({ name: 'exit', run: s.run, to: 'app' }, 'explain.back')
      return stay(s)
    case 'confirm':
      if (e.type === 'typed') return go({ ...s, typed: e.value }, 'confirm.typed')
      if (e.type === 'back') return go({ name: 'explain', run: s.run }, 'confirm.back')
      if (e.type === 'confirm') {
        if (s.typed.trim().toLocaleLowerCase() !== s.word.toLocaleLowerCase() || s.word === '') return stay(s)
        return emit({ name: 'quiescing', run: s.run }, 'confirm.confirm', (r) => [{ id: 'del.quiesce', run: r }])
      }
      return stay(s)
    case 'quiescing':
      if (isResult(e, s.run, 'del.quiesce'))
        return emit({ name: 'deregistering', run: s.run, mode: 'run' }, 'quiescing.result', (r) => [{ id: 'del.dereg', run: r, mode: 'run' }])
      return stay(s)
    case 'deregistering':
      if (isResult(e, s.run, 'del.dereg')) return emit({ name: 'sealing', run: s.run }, 'deregistering.result', (r) => [{ id: 'del.seal', run: r }])
      return stay(s)
    case 'sealing':
      if (isResult(e, s.run, 'del.seal')) return emit({ name: 'closing', run: s.run }, 'sealing.result', (r) => [{ id: 'del.close', run: r }])
      return stay(s)
    case 'closing':
      if (isResult(e, s.run, 'del.close')) return emit({ name: 'wiping', run: s.run }, 'closing.result', (r) => [{ id: 'del.wipe', run: r }])
      return stay(s)
    case 'wiping':
      if (isResult(e, s.run, 'del.wipe')) return emit({ name: 'verifying', run: s.run, survivors: null }, 'wiping.result', (r) => [{ id: 'del.verify', run: r }])
      return stay(s)
    case 'verifying':
      if (isResult(e, s.run, 'del.verify')) {
        const survivors = (e.result.value as { survivors?: readonly string[] } | undefined)?.survivors ?? []
        if (e.result.ok) return emit({ ...s, survivors: [] }, 'verifying.result.clean', (r) => [{ id: 'del.done', run: r }])
        return emit({ ...s, survivors }, 'verifying.result.survivors', (r) => [{ id: 'del.done', run: r }])
      }
      if (isResult(e, s.run, 'del.done')) {
        const report = e.result.value as WipeReport
        if (report.local.ok) return go({ name: 'done', run: s.run, report }, 'verifying.result.done')
        return go({ name: 'failed', run: s.run, survivors: report.local.survivors }, 'verifying.result.failed')
      }
      return stay(s)
    case 'failed':
      if (e.type === 'retry') return emit({ name: 'wiping', run: s.run }, 'failed.retry', (r) => [{ id: 'del.wipe', run: r }])
      return stay(s)
    case 'done':
      if (e.type === 'continue') return go({ name: 'exit', run: s.run, to: 'welcome' }, 'done.continue')
      return stay(s)
    case 'resumeChoice':
      if (e.type === 'unlockToDeregister' && s.lock && !s.lock.unsupported && !s.lock.biometricLost)
        return go({ name: 'exit', run: s.run, to: 'unlock-for-deregistration' }, 'resumeChoice.unlock')
      if (e.type === 'deleteWithoutDeregistration')
        return emit({ name: 'deregistering', run: s.run, mode: 'skip' }, 'resumeChoice.skip', (r) => [{ id: 'del.dereg', run: r, mode: 'skip' }])
      return stay(s)
    case 'exit':
      return stay(s)
  }
}

export function deleteMachine(word: string): Machine<S, DeleteEvent, DeleteEffect> {
  return {
    name: 'delete',
    table: DELETE_TABLE,
    transition: (s, e) => deleteTransition(s, e, word),
    sensitive: () => false,
  }
}
