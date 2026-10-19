// Unlock, architecture §4.2 "Entsperren" (Befund 7: one path per protection mode; N8: invalid
// biometrics only set the unauthenticated hint field; the head is re-encrypted only after a
// passphrase proved itself; "keystore ok, vault does not open" falls back to the passphrase
// without rewriting). After an interrupted setup (boot matrix setup/holder) the same machine opens
// the vault and then finishes the setup (onb.init, onb.activate).

import type { LockInfo, Secret } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

export type UnlockMode =
  /** normal unlock of the active identity */
  | 'unlock'
  /** boot matrix setup/holder: unlock by the vault head, then onb.init → onb.activate */
  | 'resume-setup'
  /** interrupted delete before sealing: unlock only to deregister, then back to the delete flow */
  | 'delete-dereg'

type Report = 'invalid' | 'mismatch' | null

export type UnlockState =
  | { readonly name: 'biometricPrompt'; readonly run: number; readonly lock: LockInfo; readonly mode: UnlockMode; readonly report: Report }
  | { readonly name: 'biometricRetry'; readonly run: number; readonly lock: LockInfo; readonly mode: UnlockMode; readonly report: Report }
  | { readonly name: 'biometricLost'; readonly run: number; readonly lock: LockInfo; readonly mode: UnlockMode }
  | {
      readonly name: 'passphrase'
      readonly run: number
      readonly lock: LockInfo
      readonly mode: UnlockMode
      readonly value: Secret<string>
      readonly busy: boolean
      readonly error: 'wrong' | 'empty' | null
      /** why the passphrase is asked although biometrics are set up */
      readonly hint: 'bioUnusable' | 'bioFailed' | null
      readonly report: Report
    }
  | { readonly name: 'unsupported'; readonly run: number; readonly lock: LockInfo }
  | { readonly name: 'opening'; readonly run: number; readonly lock: LockInfo; readonly mode: UnlockMode; readonly report: Report; readonly via: 'biometric' | 'passphrase' }
  | { readonly name: 'otherWriter'; readonly run: number; readonly lock: LockInfo; readonly mode: UnlockMode; readonly report: Report; readonly via: 'biometric' | 'passphrase' }
  | { readonly name: 'resumeInit'; readonly run: number; readonly lock: LockInfo; readonly error: boolean }
  | { readonly name: 'resumeActivate'; readonly run: number; readonly lock: LockInfo; readonly error: boolean }
  | { readonly name: 'repairProtection'; readonly run: number; readonly lock: LockInfo; readonly error: boolean }
  | { readonly name: 'repairKeystore'; readonly run: number; readonly lock: LockInfo; readonly busy: boolean }
  | { readonly name: 'offerBiometric'; readonly run: number; readonly lock: LockInfo; readonly busy: boolean }
  | { readonly name: 'exit'; readonly run: number; readonly to: 'app' | 'recovery' | 'delete' | 'delete-resume' }

export type UnlockEvent =
  | { readonly type: 'retry' }
  | { readonly type: 'usePassphrase' }
  | { readonly type: 'value'; readonly value: Secret<string> }
  | { readonly type: 'submit' }
  | { readonly type: 'recover' }
  | { readonly type: 'delete' }
  | { readonly type: 'enable' }
  | { readonly type: 'notNow' }
  | { readonly type: 'skip' }

export type UnlockEffect =
  | ({ readonly id: 'unl.bio' } & Effect)
  | ({ readonly id: 'unl.vault'; readonly passphrase: Secret<string> } & Effect)
  | ({ readonly id: 'unl.bioUnusable' | 'unl.holder' | 'unl.reprotect' | 'unl.ksRestore' | 'unl.offerEnable' | 'unl.offerDismiss' } & Effect)
  | ({ readonly id: 'onb.init' | 'onb.activate' } & Effect)

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

/** Unlock table, architecture §4.2 (deciding is the initial step; rows for retry and resume-setup added). */
export const UNLOCK_TABLE: readonly Row[] = [
  row('deciding.biometric', 'start', 'biometricPrompt', 'free', '–', { guard: 'head biometric-only or passphrase+biometric, no hint', effects: ['unl.bio'] }),
  row('deciding.passphrase', 'start', 'passphrase', 'free', '–', { guard: 'head passphrase, or hint bioUnusable' }),
  row('deciding.lost', 'start', 'biometricLost', 'free', 'boot matrix: biometric-only without K', { guard: 'biometric-only, keystore entry gone' }),
  row('deciding.unsupported', 'start', 'unsupported', 'free', '–', { guard: 'vault in an unknown format' }),
  row('biometricPrompt.result.ok', 'result unl.bio', 'opening', 'after-effect', 'nothing written', { effects: ['unl.holder'] }),
  row('biometricPrompt.result.cancelled.only', 'result unl.bio', 'biometricRetry', 'free', '–', { guard: 'biometric-only' }),
  row('biometricPrompt.result.lost.only', 'result unl.bio', 'biometricLost', 'free', 'boot matrix biometric-only without K', {
    guard: 'biometric-only; invalid, missing or vault does not open',
  }),
  row('biometricPrompt.result.cancelled.both', 'result unl.bio', 'passphrase{bioFailed}', 'free', '–', { guard: 'passphrase+biometric; cancelled or failed' }),
  row('biometricPrompt.result.invalid.both', 'result unl.bio', 'passphrase{bioUnusable}', 'free', 'nothing at the vault; next start asks the passphrase', {
    guard: 'passphrase+biometric; invalid or missing',
    effects: ['unl.bioUnusable'],
  }),
  row('biometricPrompt.result.mismatch.both', 'result unl.bio', 'passphrase{bioUnusable}', 'free', 'nothing at the vault', {
    guard: 'passphrase+biometric; keystore secret, vault does not open',
    effects: ['unl.bioUnusable'],
  }),
  row('biometricPrompt.usePassphrase', 'usePassphrase', 'passphrase', 'free', '–', { guard: 'passphrase+biometric' }),
  row('biometricRetry.retry', 'retry', 'biometricPrompt', 'free', '–', { effects: ['unl.bio'] }),
  row('passphrase.value', 'value', 'passphrase', 'free', '–'),
  row('passphrase.submit', 'submit', 'passphrase{busy}', 'after-effect', '–', { guard: 'not empty', effects: ['unl.vault'] }),
  row('passphrase.submit.empty', 'submit', 'passphrase{error: empty}', 'free', '–', { guard: 'empty' }),
  row('passphrase.result.ok', 'result unl.vault', 'opening', 'after-effect', '–', { effects: ['unl.holder'] }),
  row('passphrase.result.wrong', 'result unl.vault', 'passphrase{error: wrong}', 'free', '–'),
  row('passphrase.retryBiometric', 'retry', 'biometricPrompt', 'free', '–', { guard: 'passphrase+biometric without hint', effects: ['unl.bio'] }),
  row('opening.result.ok.done', 'result unl.holder', 'exit(app)', 'after-effect', '–', { guard: 'no repair, no offer' }),
  row('opening.result.ok.repairProtection', 'result unl.holder', 'repairProtection', 'locked', 'after setProtection head passphrase, K removed at boot', {
    guard: 'retrieve reported invalidated/missing in this session',
    effects: ['unl.reprotect'],
  }),
  row('opening.result.ok.repairKeystore', 'result unl.holder', 'repairKeystore', 'free', 'nothing at the vault', {
    guard: 'retrieve returned a secret the vault rejected, the passphrase opened',
  }),
  row('opening.result.ok.offer', 'result unl.holder', 'offerBiometric', 'free', '–', { guard: 'head passphrase, biometrics available, offer not dismissed' }),
  row('opening.result.ok.delete', 'result unl.holder', 'exit(delete-resume)', 'free', 'marker wipe/*', { guard: 'mode delete-dereg' }),
  row('opening.result.otherWriter', 'result unl.holder', 'otherWriter', 'free', '–', { guard: 'lock held by another tab' }),
  row('opening.resume', 'vault open', 'resumeInit', 'locked', 'setup/holder', { guard: 'mode resume-setup', effects: ['onb.init'] }),
  row('otherWriter.retry', 'retry', 'opening', 'free', '–', { effects: ['unl.holder'] }),
  row('resumeInit.result.ok', 'result onb.init', 'resumeActivate', 'locked', 'setup/holder', { effects: ['onb.activate'] }),
  row('resumeInit.result.error', 'result onb.init', 'resumeInit{error}', 'locked', 'setup/holder'),
  row('resumeInit.retry', 'retry', 'resumeInit', 'locked', 'setup/holder', { effects: ['onb.init'] }),
  row('resumeActivate.result.ok', 'result onb.activate', 'exit(app)', 'locked', 'no marker, locked'),
  row('resumeActivate.result.error', 'result onb.activate', 'resumeActivate{error}', 'locked', 'setup/holder'),
  row('resumeActivate.retry', 'retry', 'resumeActivate', 'locked', 'setup/holder', { effects: ['onb.activate'] }),
  row('repairProtection.result.ok', 'result unl.reprotect', 'offerBiometric', 'locked', 'head passphrase', { effects: [] }),
  row('repairProtection.result.error', 'result unl.reprotect', 'repairProtection{error}', 'locked', 'unchanged'),
  row('repairProtection.retry', 'retry', 'repairProtection', 'locked', 'unchanged', { effects: ['unl.reprotect'] }),
  row('repairKeystore.enable', 'enable', 'repairKeystore{busy}', 'free', 'nothing at the vault', { effects: ['unl.ksRestore'] }),
  row('repairKeystore.result', 'result unl.ksRestore', 'exit(app)', 'free', 'nothing at the vault'),
  row('repairKeystore.skip', 'skip', 'exit(app)', 'free', 'hint field stays, passphrase next time'),
  row('offerBiometric.enable', 'enable', 'offerBiometric{busy}', 'free', 'protection table row 1', { effects: ['unl.offerEnable'] }),
  row('offerBiometric.result', 'result unl.offerEnable', 'exit(app)', 'free', '–'),
  row('offerBiometric.notNow', 'notNow', 'offerBiometric{busy}', 'free', '–', { effects: ['unl.offerDismiss'] }),
  row('offerBiometric.result.dismissed', 'result unl.offerDismiss', 'exit(app)', 'free', '"not now" remembered'),
  row('any.recover', 'recover', 'exit(recovery)', 'free', '–', { guard: 'before opening' }),
  row('any.delete', 'delete', 'exit(delete)', 'free', '–', { guard: 'biometricLost or unsupported' }),
]

type S = UnlockState
type E = UnlockEvent | ResultEvent
type Out = Step<S, UnlockEffect>

const go = (state: S, row: string, effects: readonly UnlockEffect[] = []): Out => ({ state, effects, row })
function emit(state: S, row: string, make: (run: number) => readonly UnlockEffect[]): Out {
  const run = state.run + 1
  return { state: { ...state, run } as S, effects: make(run), row }
}

const EMPTY = Object.freeze({ reveal: () => '', toJSON: () => '[redacted]', toString: () => '[redacted]' }) as unknown as Secret<string>

const passphraseState = (lock: LockInfo, mode: UnlockMode, run: number, hint: 'bioUnusable' | 'bioFailed' | null, report: Report): S => ({
  name: 'passphrase',
  run,
  lock,
  mode,
  value: EMPTY,
  busy: false,
  error: null,
  hint,
  report,
})

/** The `deciding` step: chooses the path from the vault head, the keystore probe and the hint field. */
export function unlockStart(lock: LockInfo, mode: UnlockMode = 'unlock'): Out {
  const base = { run: 0, lock }
  if (lock.unsupported) return go({ name: 'unsupported', ...base }, 'deciding.unsupported')
  if (lock.protection === 'biometric-only') {
    if (lock.biometricLost) return go({ name: 'biometricLost', ...base, mode }, 'deciding.lost')
    return emit({ name: 'biometricPrompt', ...base, mode, report: null }, 'deciding.biometric', (r) => [{ id: 'unl.bio', run: r }])
  }
  if (lock.protection === 'passphrase+biometric' && !lock.bioUnusable && lock.biometric !== null)
    return emit({ name: 'biometricPrompt', ...base, mode, report: null }, 'deciding.biometric', (r) => [{ id: 'unl.bio', run: r }])
  const hint = lock.protection === 'passphrase+biometric' ? 'bioUnusable' : null
  return go(passphraseState(lock, mode, 0, hint, null), 'deciding.passphrase')
}

function opened(s: { run: number; lock: LockInfo; mode: UnlockMode; report: Report }, via: 'biometric' | 'passphrase', rowId: string): Out {
  if (s.mode === 'resume-setup')
    return emit({ name: 'resumeInit', run: s.run, lock: s.lock, error: false }, 'opening.resume', (r) => [{ id: 'onb.init', run: r }])
  return emit({ name: 'opening', run: s.run, lock: s.lock, mode: s.mode, report: s.report, via }, rowId, (r) => [{ id: 'unl.holder', run: r }])
}

const canLeave = (s: S) => s.name !== 'opening' && s.name !== 'resumeInit' && s.name !== 'resumeActivate' && s.name !== 'repairProtection' && s.name !== 'exit'

export function unlockTransition(s: S, e: E): Out {
  if (e.type === 'recover' && canLeave(s) && s.name !== 'repairKeystore' && s.name !== 'offerBiometric')
    return go({ name: 'exit', run: s.run + 1, to: 'recovery' }, 'any.recover')
  if (e.type === 'delete' && (s.name === 'biometricLost' || s.name === 'unsupported')) return go({ name: 'exit', run: s.run + 1, to: 'delete' }, 'any.delete')

  switch (s.name) {
    case 'biometricPrompt': {
      if (e.type === 'usePassphrase' && s.lock.protection === 'passphrase+biometric')
        return go(passphraseState(s.lock, s.mode, s.run + 1, 'bioFailed', s.report), 'biometricPrompt.usePassphrase')
      if (!isResult(e, s.run, 'unl.bio')) return stay(s)
      if (e.result.ok) return opened(s, 'biometric', 'biometricPrompt.result.ok')
      const code = e.result.code
      if (s.lock.protection === 'biometric-only') {
        if (code === 'cancelled' || code === 'failed') return go({ name: 'biometricRetry', run: s.run, lock: s.lock, mode: s.mode, report: s.report }, 'biometricPrompt.result.cancelled.only')
        return go({ name: 'biometricLost', run: s.run, lock: s.lock, mode: s.mode }, 'biometricPrompt.result.lost.only')
      }
      if (code === 'invalidated' || code === 'missing')
        return emit(passphraseState(s.lock, s.mode, s.run, 'bioUnusable', 'invalid'), 'biometricPrompt.result.invalid.both', (r) => [{ id: 'unl.bioUnusable', run: r }])
      if (code === 'vault-mismatch')
        return emit(passphraseState(s.lock, s.mode, s.run, 'bioUnusable', 'mismatch'), 'biometricPrompt.result.mismatch.both', (r) => [{ id: 'unl.bioUnusable', run: r }])
      // cancelled or failed: never rely on platform codes alone (iOS errSecAuthFailed → USER_CANCELLED, 6bf034dd)
      return go(passphraseState(s.lock, s.mode, s.run, 'bioFailed', s.report), 'biometricPrompt.result.cancelled.both')
    }
    case 'biometricRetry':
      if (e.type === 'retry') return emit({ name: 'biometricPrompt', run: s.run, lock: s.lock, mode: s.mode, report: s.report }, 'biometricRetry.retry', (r) => [{ id: 'unl.bio', run: r }])
      return stay(s)
    case 'biometricLost':
    case 'unsupported':
      return stay(s)
    case 'passphrase':
      if (e.type === 'value') return go({ ...s, value: e.value, error: null }, 'passphrase.value')
      if (e.type === 'submit' && !s.busy) {
        if (s.value.reveal() === '') return go({ ...s, error: 'empty' }, 'passphrase.submit.empty')
        return emit({ ...s, busy: true, error: null }, 'passphrase.submit', (r) => [{ id: 'unl.vault', run: r, passphrase: s.value }])
      }
      if (e.type === 'retry' && s.lock.protection === 'passphrase+biometric' && s.hint === 'bioFailed' && !s.busy)
        return emit({ name: 'biometricPrompt', run: s.run, lock: s.lock, mode: s.mode, report: s.report }, 'passphrase.retryBiometric', (r) => [{ id: 'unl.bio', run: r }])
      if (isResult(e, s.run, 'unl.bioUnusable')) return stay(s) // hint written; nothing to change
      if (isResult(e, s.run, 'unl.vault')) {
        if (!e.result.ok) return go({ ...s, busy: false, error: 'wrong', value: EMPTY }, 'passphrase.result.wrong')
        return opened({ run: s.run, lock: s.lock, mode: s.mode, report: s.report }, 'passphrase', 'passphrase.result.ok')
      }
      return stay(s)
    case 'opening':
      if (!isResult(e, s.run, 'unl.holder')) return stay(s)
      if (!e.result.ok) return go({ name: 'otherWriter', run: s.run, lock: s.lock, mode: s.mode, report: s.report, via: s.via }, 'opening.result.otherWriter')
      if (s.mode === 'delete-dereg') return go({ name: 'exit', run: s.run, to: 'delete-resume' }, 'opening.result.ok.delete')
      if (s.via === 'passphrase' && s.report === 'invalid')
        return emit({ name: 'repairProtection', run: s.run, lock: s.lock, error: false }, 'opening.result.ok.repairProtection', (r) => [{ id: 'unl.reprotect', run: r }])
      if (s.via === 'passphrase' && s.report === 'mismatch') return go({ name: 'repairKeystore', run: s.run, lock: s.lock, busy: false }, 'opening.result.ok.repairKeystore')
      if (s.via === 'passphrase' && s.lock.offerBiometric) return go({ name: 'offerBiometric', run: s.run, lock: s.lock, busy: false }, 'opening.result.ok.offer')
      return go({ name: 'exit', run: s.run, to: 'app' }, 'opening.result.ok.done')
    case 'otherWriter':
      if (e.type === 'retry')
        return emit({ name: 'opening', run: s.run, lock: s.lock, mode: s.mode, report: s.report, via: s.via }, 'otherWriter.retry', (r) => [{ id: 'unl.holder', run: r }])
      return stay(s)
    case 'resumeInit':
      if (isResult(e, s.run, 'onb.init')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'resumeInit.result.error')
        return emit({ name: 'resumeActivate', run: s.run, lock: s.lock, error: false }, 'resumeInit.result.ok', (r) => [{ id: 'onb.activate', run: r }])
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'resumeInit.retry', (r) => [{ id: 'onb.init', run: r }])
      return stay(s)
    case 'resumeActivate':
      if (isResult(e, s.run, 'onb.activate')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'resumeActivate.result.error')
        return go({ name: 'exit', run: s.run, to: 'app' }, 'resumeActivate.result.ok')
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'resumeActivate.retry', (r) => [{ id: 'onb.activate', run: r }])
      return stay(s)
    case 'repairProtection':
      if (isResult(e, s.run, 'unl.reprotect')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'repairProtection.result.error')
        // biometrics again on offer once the protection is a plain passphrase (§4.2 boot matrix row)
        if (s.lock.biometric === null) return go({ name: 'exit', run: s.run, to: 'app' }, 'repairProtection.result.ok')
        return go({ name: 'offerBiometric', run: s.run, lock: { ...s.lock, protection: 'passphrase' }, busy: false }, 'repairProtection.result.ok')
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'repairProtection.retry', (r) => [{ id: 'unl.reprotect', run: r }])
      return stay(s)
    case 'repairKeystore':
      if (e.type === 'enable' && !s.busy) return emit({ ...s, busy: true }, 'repairKeystore.enable', (r) => [{ id: 'unl.ksRestore', run: r }])
      if (isResult(e, s.run, 'unl.ksRestore')) return go({ name: 'exit', run: s.run, to: 'app' }, 'repairKeystore.result')
      if (e.type === 'skip' && !s.busy) return go({ name: 'exit', run: s.run + 1, to: 'app' }, 'repairKeystore.skip')
      return stay(s)
    case 'offerBiometric':
      if (e.type === 'enable' && !s.busy) return emit({ ...s, busy: true }, 'offerBiometric.enable', (r) => [{ id: 'unl.offerEnable', run: r }])
      if (e.type === 'notNow' && !s.busy) return emit({ ...s, busy: true }, 'offerBiometric.notNow', (r) => [{ id: 'unl.offerDismiss', run: r }])
      if (isResult(e, s.run, 'unl.offerEnable')) return go({ name: 'exit', run: s.run, to: 'app' }, 'offerBiometric.result')
      if (isResult(e, s.run, 'unl.offerDismiss')) return go({ name: 'exit', run: s.run, to: 'app' }, 'offerBiometric.result.dismissed')
      return stay(s)
    case 'exit':
      return stay(s)
  }
}

export const unlock: Machine<S, UnlockEvent, UnlockEffect> = {
  name: 'unlock',
  table: UNLOCK_TABLE,
  transition: unlockTransition,
  sensitive: (s) => s.name === 'passphrase',
}
