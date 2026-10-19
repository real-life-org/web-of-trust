// Change protection, architecture §4.2 "Schutz ändern" (Befund 7, N8). The head changes only by
// re-encryption with a passphrase or keystore secret proven in this session; no path removes the
// last access ('last-access'). Biometrics off from biometric-only first sets a passphrase.

import type { BiometricKind, ProtectionMode, Secret } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

export type ProtectionTarget = 'passphrase' | 'passphrase+biometric'

type Plan = readonly ('prt.ks' | 'prt.head' | 'prt.ksRemove' | 'prt.rewrap')[]

/** Effects per path, in the order of the table. */
export function planFor(from: ProtectionMode, to: ProtectionTarget): Plan | null {
  if (from === 'passphrase' && to === 'passphrase+biometric') return ['prt.ks', 'prt.head']
  if (from === 'passphrase+biometric' && to === 'passphrase') return ['prt.head', 'prt.ksRemove']
  if (from === 'biometric-only' && to === 'passphrase+biometric') return ['prt.rewrap', 'prt.ks']
  if (from === 'biometric-only' && to === 'passphrase') return ['prt.rewrap', 'prt.ks', 'prt.head', 'prt.ksRemove']
  return null
}

const EMPTY = Object.freeze({ reveal: () => '', toJSON: () => '[redacted]', toString: () => '[redacted]' }) as unknown as Secret<string>

export type ProtectionState =
  | { readonly name: 'choose'; readonly run: number; readonly current: ProtectionMode; readonly biometric: BiometricKind | null; readonly error: 'last-access' | null }
  | {
      readonly name: 'proveCurrent'
      readonly run: number
      readonly current: ProtectionMode
      readonly target: ProtectionTarget
      readonly value: Secret<string>
      readonly busy: boolean
      readonly error: 'wrong' | null
    }
  | { readonly name: 'provingBiometric'; readonly run: number; readonly current: ProtectionMode; readonly target: ProtectionTarget; readonly error: 'cancelled' | null }
  | {
      readonly name: 'newPassphrase'
      readonly run: number
      readonly current: ProtectionMode
      readonly target: ProtectionTarget
      readonly p1: Secret<string>
      readonly p2: Secret<string>
    }
  | {
      readonly name: 'applying'
      readonly run: number
      readonly current: ProtectionMode
      readonly target: ProtectionTarget
      readonly plan: Plan
      readonly step: number
      readonly passphrase: Secret<string> | null
    }
  | { readonly name: 'done'; readonly run: number; readonly target: ProtectionTarget }
  | {
      readonly name: 'failed'
      readonly run: number
      readonly current: ProtectionMode
      readonly target: ProtectionTarget
      /** keystore: the prompt was cancelled or failed; head: re-encryption failed */
      readonly reason: 'keystore' | 'head' | 'rewrap'
      /** after a rewrap the head is already passphrase+biometric (the next unlock repairs the keystore) */
      readonly partial: boolean
    }
  | { readonly name: 'exit'; readonly run: number }

export type ProtectionEvent =
  | { readonly type: 'select'; readonly target: ProtectionTarget }
  | { readonly type: 'value'; readonly value: Secret<string> }
  | { readonly type: 'p1'; readonly value: Secret<string> }
  | { readonly type: 'p2'; readonly value: Secret<string> }
  | { readonly type: 'submit' }
  | { readonly type: 'retry' }
  | { readonly type: 'back' }
  | { readonly type: 'close' }

export type ProtectionEffect =
  | ({ readonly id: 'prt.prove'; readonly passphrase: Secret<string> | null } & Effect)
  | ({ readonly id: 'prt.ks' | 'prt.ksRemove' } & Effect)
  | ({ readonly id: 'prt.head'; readonly mode: ProtectionTarget } & Effect)
  | ({ readonly id: 'prt.rewrap'; readonly passphrase: Secret<string> } & Effect)

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

export const PROTECTION_TABLE: readonly Row[] = [
  row('choose.select.passphrase', 'select', 'proveCurrent', 'free', '–', { guard: 'current has a passphrase' }),
  row('choose.select.biometric', 'select', 'provingBiometric', 'free', '–', { guard: 'current biometric-only', effects: ['prt.prove'] }),
  row('choose.select.lastAccess', 'select', 'choose{error: last-access}', 'free', '–', { guard: 'no path keeps an access' }),
  row('proveCurrent.value', 'value', 'proveCurrent', 'free', '–'),
  row('proveCurrent.submit', 'submit', 'proveCurrent{busy}', 'after-effect', '–', { effects: ['prt.prove'] }),
  row('proveCurrent.result.ok', 'result prt.prove', 'applying', 'locked', 'see the row of the path', { effects: ['prt.ks|prt.head'] }),
  row('proveCurrent.result.wrong', 'result prt.prove', 'proveCurrent{error}', 'free', '–'),
  row('provingBiometric.result.ok', 'result prt.prove', 'newPassphrase', 'free', '–'),
  row('provingBiometric.result.failed', 'result prt.prove', 'provingBiometric{error}', 'free', '–'),
  row('provingBiometric.retry', 'retry', 'provingBiometric', 'free', '–', { effects: ['prt.prove'] }),
  row('newPassphrase.p1', 'p1', 'newPassphrase', 'free', '–'),
  row('newPassphrase.p2', 'p2', 'newPassphrase', 'free', '–'),
  row('newPassphrase.submit', 'submit', 'applying', 'locked', 'crash between rewrap and keystore: head passphrase+biometric, keystore holds the old secret → unlock falls back to the passphrase → repairKeystore', {
    guard: '≥ 8 characters, equal',
    effects: ['prt.rewrap'],
  }),
  row('applying.result.next', 'result prt.*', 'applying{step+1}', 'locked', 'entry without head: boot removes K at head passphrase; head without removal: boot removes K', {
    effects: ['prt.ks|prt.head|prt.ksRemove'],
  }),
  row('applying.result.done', 'result prt.*', 'done', 'locked', '–', { guard: 'last step' }),
  row('applying.result.failed', 'result prt.*', 'failed', 'free', 'head unchanged or passphrase+biometric after rewrap'),
  row('failed.retry', 'retry', 'choose', 'free', '–'),
  row('any.close', 'close|back', 'exit', 'free', '–', { guard: 'not applying' }),
]

type S = ProtectionState
type E = ProtectionEvent | ResultEvent
type Out = Step<S, ProtectionEffect>

const go = (state: S, row: string, effects: readonly ProtectionEffect[] = []): Out => ({ state, effects, row })
function emit(state: S, row: string, make: (run: number) => readonly ProtectionEffect[]): Out {
  const run = state.run + 1
  return { state: { ...state, run } as S, effects: make(run), row }
}

function effectFor(id: Plan[number], run: number, target: ProtectionTarget, passphrase: Secret<string> | null): ProtectionEffect {
  if (id === 'prt.head') return { id, run, mode: target }
  if (id === 'prt.rewrap') return { id, run, passphrase: passphrase ?? EMPTY }
  return { id, run }
}

export function protectionStart(current: ProtectionMode, biometric: BiometricKind | null): S {
  return { name: 'choose', run: 0, current, biometric, error: null }
}

export function protectionTransition(s: S, e: E): Out {
  if ((e.type === 'close' || e.type === 'back') && s.name !== 'applying' && s.name !== 'exit') return go({ name: 'exit', run: s.run + 1 }, 'any.close')
  switch (s.name) {
    case 'choose':
      if (e.type !== 'select') return stay(s)
      if (!planFor(s.current, e.target)) return go({ ...s, error: 'last-access' }, 'choose.select.lastAccess')
      if (s.current === 'biometric-only')
        return emit({ name: 'provingBiometric', run: s.run, current: s.current, target: e.target, error: null }, 'choose.select.biometric', (r) => [
          { id: 'prt.prove', run: r, passphrase: null },
        ])
      return go({ name: 'proveCurrent', run: s.run, current: s.current, target: e.target, value: EMPTY, busy: false, error: null }, 'choose.select.passphrase')
    case 'proveCurrent':
      if (e.type === 'value') return go({ ...s, value: e.value, error: null }, 'proveCurrent.value')
      if (e.type === 'submit' && !s.busy && s.value.reveal() !== '')
        return emit({ ...s, busy: true }, 'proveCurrent.submit', (r) => [{ id: 'prt.prove', run: r, passphrase: s.value }])
      if (isResult(e, s.run, 'prt.prove')) {
        if (!e.result.ok) return go({ ...s, busy: false, error: 'wrong', value: EMPTY }, 'proveCurrent.result.wrong')
        const plan = planFor(s.current, s.target) ?? []
        const first = plan[0]
        if (!first) return go({ name: 'done', run: s.run, target: s.target }, 'applying.result.done')
        return emit({ name: 'applying', run: s.run, current: s.current, target: s.target, plan, step: 0, passphrase: null }, 'proveCurrent.result.ok', (r) => [
          effectFor(first, r, s.target, null),
        ])
      }
      return stay(s)
    case 'provingBiometric':
      if (isResult(e, s.run, 'prt.prove')) {
        if (!e.result.ok) return go({ ...s, error: 'cancelled' }, 'provingBiometric.result.failed')
        return go({ name: 'newPassphrase', run: s.run, current: s.current, target: s.target, p1: EMPTY, p2: EMPTY }, 'provingBiometric.result.ok')
      }
      if (e.type === 'retry') return emit({ ...s, error: null }, 'provingBiometric.retry', (r) => [{ id: 'prt.prove', run: r, passphrase: null }])
      return stay(s)
    case 'newPassphrase':
      if (e.type === 'p1') return go({ ...s, p1: e.value }, 'newPassphrase.p1')
      if (e.type === 'p2') return go({ ...s, p2: e.value }, 'newPassphrase.p2')
      if (e.type === 'submit') {
        const a = s.p1.reveal()
        if (a.length < 8 || a !== s.p2.reveal()) return stay(s)
        const plan = planFor(s.current, s.target) ?? []
        return emit({ name: 'applying', run: s.run, current: s.current, target: s.target, plan, step: 0, passphrase: s.p1 }, 'newPassphrase.submit', (r) => [
          effectFor('prt.rewrap', r, s.target, s.p1),
        ])
      }
      return stay(s)
    case 'applying': {
      const id = s.plan[s.step]
      if (!id || !isResult(e, s.run, id)) return stay(s)
      if (!e.result.ok) {
        const reason = id === 'prt.rewrap' ? 'rewrap' : id === 'prt.head' ? 'head' : 'keystore'
        return go({ name: 'failed', run: s.run, current: s.current, target: s.target, reason, partial: s.plan.indexOf('prt.rewrap') > -1 && s.step > 0 }, 'applying.result.failed')
      }
      const nextStep = s.step + 1
      const next = s.plan[nextStep]
      if (!next) return go({ name: 'done', run: s.run, target: s.target }, 'applying.result.done')
      return emit({ ...s, step: nextStep }, 'applying.result.next', (r) => [effectFor(next, r, s.target, s.passphrase)])
    }
    case 'failed':
      if (e.type === 'retry') return go({ name: 'choose', run: s.run + 1, current: s.partial ? 'passphrase+biometric' : s.current, biometric: null, error: null }, 'failed.retry')
      return stay(s)
    case 'done':
    case 'exit':
      return stay(s)
  }
}

export const protection: Machine<S, ProtectionEvent, ProtectionEffect> = {
  name: 'protection',
  table: PROTECTION_TABLE,
  transition: protectionTransition,
  sensitive: (s) => s.name === 'proveCurrent' || s.name === 'newPassphrase',
}
