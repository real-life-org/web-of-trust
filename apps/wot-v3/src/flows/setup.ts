// Onboarding and recovery (architecture §4.2 "Onboarding", "Wiederherstellen"). One machine for both,
// because from `protect` to the vault they are the same steps with other effect ids (`onb.*`,
// `rec.*`): onboarding continues with initHolder → activating, recovery with staging → switching →
// wipingOld → verifyingOld. The words and passphrases live in the state only as Secret.

import type { BiometricKind, IdentityNs, Mnemonic, ProtectionMode, Secret } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

type Words = Secret<Mnemonic>
type Flow = 'setup' | 'restore'
const P = (flow: Flow) => (flow === 'setup' ? 'onb' : 'rec')

/** What both flows carry from the word step to the vault. */
export interface SetupCtx {
  readonly flow: Flow
  readonly words: Words
  /** onboarding: the three checked positions (kept for going back) */
  readonly positions: readonly number[]
  readonly profile: { readonly name: string } | null
  /** version of the accepted content rules to record; null = a valid consent exists (recovery) */
  readonly termsVersion: string | null
  /** the current content-rules version */
  readonly currentTerms: string
  /** recovery: a valid consent existed on this device at the start */
  readonly termsValid: boolean
  /** recovery: a local identity exists (cancel goes to unlock, replace warning shown) */
  readonly hasIdentity: boolean
}

export type WordsCheck = 'empty' | 'incomplete' | 'unknown-word' | 'checksum' | 'ok'
type Availability = BiometricKind | null | 'probing'

export type SetupState =
  // onboarding
  | { readonly name: 'welcome'; readonly run: number; readonly error: 'generate' | null; readonly termsVersion: string }
  | { readonly name: 'generating'; readonly run: number; readonly termsVersion: string }
  | {
      readonly name: 'showWords'
      readonly run: number
      readonly words: Words
      readonly positions: readonly number[]
      readonly copy: 'idle' | 'copied' | 'failed'
      readonly checklist: readonly [boolean, boolean, boolean]
      readonly termsVersion: string
    }
  | { readonly name: 'lastWarning'; readonly run: number; readonly words: Words; readonly positions: readonly number[]; readonly termsVersion: string }
  | {
      readonly name: 'verifyWords'
      readonly run: number
      readonly words: Words
      readonly positions: readonly number[]
      readonly inputs: readonly Secret<string>[]
      /** positions whose input was wrong at the last check */
      readonly wrong: readonly number[]
      readonly termsVersion: string
    }
  | {
      readonly name: 'profile'
      readonly run: number
      readonly words: Words
      readonly positions: readonly number[]
      readonly displayName: string
      readonly terms: boolean
      readonly termsVersion: string
    }
  // recovery
  | {
      readonly name: 'enterWords'
      readonly run: number
      readonly text: Secret<string>
      readonly words: Words | null
      readonly count: number
      readonly check: WordsCheck
      readonly hasIdentity: boolean
      readonly termsValid: boolean
      readonly termsVersion: string
    }
  | { readonly name: 'replaceWarning'; readonly run: number; readonly c: SetupCtx }
  | { readonly name: 'terms'; readonly run: number; readonly c: SetupCtx; readonly accepted: boolean }
  // shared: protection
  | { readonly name: 'protect'; readonly run: number; readonly c: SetupCtx; readonly available: Availability }
  | { readonly name: 'biometricOnlyExplain'; readonly run: number; readonly c: SetupCtx; readonly available: Availability }
  | {
      readonly name: 'protectPassphrase'
      readonly run: number
      readonly c: SetupCtx
      readonly available: Availability
      readonly p1: Secret<string>
      readonly p2: Secret<string>
      readonly addBiometric: boolean
    }
  | { readonly name: 'keyBeforeVault'; readonly run: number; readonly c: SetupCtx; readonly phase: 'marker' | 'ks'; readonly ns: IdentityNs | null }
  | {
      readonly name: 'writingVault'
      readonly run: number
      readonly c: SetupCtx
      readonly mode: ProtectionMode
      readonly phase: 'marker' | 'vault'
      readonly ns: IdentityNs | null
      readonly passphrase: Secret<string> | null
    }
  | { readonly name: 'keyAfterVault'; readonly run: number; readonly c: SetupCtx; readonly ns: IdentityNs; readonly phase: 'ks' | 'hint' }
  | {
      readonly name: 'protectFailed'
      readonly run: number
      readonly c: SetupCtx
      readonly available: Availability
      readonly reason: 'keystore' | 'vault'
      /** keystore entry could not be removed; null while the undo runs */
      readonly orphan: boolean | null
    }
  // onboarding after the vault
  | { readonly name: 'initHolder'; readonly run: number; readonly c: SetupCtx; readonly ns: IdentityNs; readonly error: boolean }
  | { readonly name: 'activating'; readonly run: number; readonly c: SetupCtx; readonly ns: IdentityNs; readonly error: boolean }
  // recovery after the vault
  | { readonly name: 'staging'; readonly run: number; readonly c: SetupCtx; readonly ns: IdentityNs; readonly error: boolean }
  | { readonly name: 'switching'; readonly run: number; readonly c: SetupCtx; readonly ns: IdentityNs; readonly error: boolean }
  | { readonly name: 'wipingOld'; readonly run: number; readonly ns: IdentityNs }
  /** error: the restored identity is in use, but removing the marker failed: not finished (20.10.) */
  | { readonly name: 'verifyingOld'; readonly run: number; readonly ns: IdentityNs; readonly survivors: readonly string[] | null; readonly error?: boolean }
  // end
  | {
      readonly name: 'done'
      readonly run: number
      readonly flow: Flow
      /** recovery: what came back (Identity §9.3: keys only, until a state copy exists) */
      readonly recovered: 'keys-only' | null
      readonly oldSurvivors: readonly string[] | null
    }
  | { readonly name: 'exit'; readonly run: number; readonly to: 'recovery' | 'unlock' | 'welcome' | 'app' }

export type SetupEvent =
  | { readonly type: 'create' }
  | { readonly type: 'import' }
  | { readonly type: 'copy' }
  | { readonly type: 'toggle'; readonly index: 0 | 1 | 2 }
  | { readonly type: 'next' }
  | { readonly type: 'back' }
  | { readonly type: 'cancel' }
  | { readonly type: 'input'; readonly index: number; readonly value: Secret<string> }
  | { readonly type: 'check' }
  | { readonly type: 'name'; readonly value: string }
  | { readonly type: 'terms'; readonly value: boolean }
  | { readonly type: 'words'; readonly text: Secret<string>; readonly words: Words | null; readonly count: number; readonly check: WordsCheck }
  | { readonly type: 'chooseBiometric' }
  | { readonly type: 'choosePassphrase' }
  | { readonly type: 'confirm' }
  | { readonly type: 'p1'; readonly value: Secret<string> }
  | { readonly type: 'p2'; readonly value: Secret<string> }
  | { readonly type: 'addBiometric'; readonly value: boolean }
  | { readonly type: 'retry' }
  | { readonly type: 'continue' }

export type SetupEffect =
  | ({ readonly id: 'onb.gen' } & Effect)
  | ({ readonly id: 'onb.copy'; readonly words: Words } & Effect)
  | ({ readonly id: 'onb.probe' | 'rec.probe' } & Effect)
  | ({ readonly id: 'onb.marker' | 'rec.marker'; readonly flow: Flow; readonly mode: ProtectionMode } & Effect)
  | ({ readonly id: 'onb.ks' | 'rec.ks'; readonly ns: IdentityNs; readonly phase: 'before' | 'after' } & Effect)
  | ({ readonly id: 'onb.ksUndo' | 'rec.ksUndo' | 'onb.vaultUndo' | 'rec.vaultUndo'; readonly ns: IdentityNs } & Effect)
  | ({
      readonly id: 'onb.vault' | 'rec.vault'
      readonly ns: IdentityNs
      readonly words: Words
      readonly mode: ProtectionMode
      readonly passphrase: Secret<string> | null
      readonly profile: { readonly name: string } | null
      readonly termsVersion: string | null
    } & Effect)
  | ({ readonly id: 'onb.bioUnusable' | 'rec.bioUnusable'; readonly ns: IdentityNs } & Effect)
  | ({ readonly id: 'onb.init' | 'rec.init' | 'onb.activate' | 'rec.switch'; readonly ns: IdentityNs } & Effect)
  | ({ readonly id: 'rec.wipeOld' | 'rec.verifyOld' | 'rec.done' } & Effect)

export const MIN_PASSPHRASE = 8

const row = (
  id: string,
  event: string,
  to: string,
  cancel: CancelPolicy,
  resume: string,
  extra: { guard?: string; effects?: readonly string[] } = {},
): Row => ({ id, from: id.split('.')[0] ?? '', event, to, cancel, resume, ...extra })

const NOTHING = 'nothing stored: words lost, welcome with new words'

/** Onboarding table, architecture §4.2 (rows for back/cancel, copy failure and init retry added). */
export const ONBOARDING_TABLE: readonly Row[] = [
  row('welcome.create', 'create', 'generating', 'free', 'nothing stored', { guard: 'storage and crypto ok (boot)', effects: ['onb.gen'] }),
  row('welcome.import', 'import', 'exit(recovery)', 'free', 'nothing stored'),
  row('generating.result.ok', 'result onb.gen', 'showWords', 'free', NOTHING),
  row('generating.result.error', 'result onb.gen', 'welcome{error}', 'free', 'nothing stored'),
  row('showWords.copy', 'copy', 'showWords', 'free', NOTHING, { effects: ['onb.copy'] }),
  row('showWords.result.copied', 'result onb.copy', 'showWords{copy: copied}', 'free', NOTHING),
  row('showWords.result.copyFailed', 'result onb.copy', 'showWords{copy: failed}', 'free', NOTHING),
  row('showWords.toggle', 'toggle', 'showWords', 'free', NOTHING),
  row('showWords.next', 'next', 'lastWarning', 'free', NOTHING, { guard: 'three checks' }),
  row('showWords.back', 'back', 'welcome', 'free', NOTHING),
  row('lastWarning.next', 'next', 'verifyWords', 'free', NOTHING),
  row('lastWarning.back', 'back', 'showWords', 'free', NOTHING),
  row('verifyWords.input', 'input', 'verifyWords', 'free', NOTHING),
  row('verifyWords.check.right', 'check', 'profile', 'free', NOTHING, { guard: 'three positions right' }),
  row('verifyWords.check.wrong', 'check', 'verifyWords{wrong}', 'free', NOTHING, { guard: 'a position wrong' }),
  row('verifyWords.back', 'back', 'showWords', 'free', NOTHING),
  row('profile.name', 'name', 'profile', 'free', NOTHING),
  row('profile.terms', 'terms', 'profile', 'free', NOTHING),
  row('profile.next', 'next', 'protect', 'free', NOTHING, { guard: 'name not empty, terms checked', effects: ['onb.probe'] }),
  row('profile.back', 'back', 'verifyWords', 'free', NOTHING),
  row('protect.result.probe', 'result onb.probe', 'protect{available}', 'free', NOTHING),
  row('protect.chooseBiometric', 'chooseBiometric', 'biometricOnlyExplain', 'free', NOTHING, { guard: 'availability = available' }),
  row('protect.choosePassphrase', 'choosePassphrase', 'protectPassphrase', 'free', NOTHING),
  row('protect.back', 'back', 'profile', 'free', NOTHING),
  row('biometricOnlyExplain.confirm', 'confirm', 'keyBeforeVault', 'after-effect', 'boot matrix setup/keystore', { effects: ['onb.marker', 'onb.ks'] }),
  row('biometricOnlyExplain.back', 'back', 'protect', 'free', NOTHING),
  row('keyBeforeVault.result.marker', 'result onb.marker', 'keyBeforeVault{ks}', 'locked', 'boot matrix setup/keystore', { effects: ['onb.ks'] }),
  row('keyBeforeVault.result.ksOk', 'result onb.ks', 'writingVault', 'locked', 'before the transaction setup/keystore, after it setup/holder', { effects: ['onb.vault'] }),
  row('keyBeforeVault.result.markerFailed', 'result onb.marker', 'protectFailed', 'free', 'nothing stored'),
  row('keyBeforeVault.result.ksFailed', 'result onb.ks', 'protectFailed{orphan}', 'free', 'boot matrix setup/keystore', { effects: ['onb.ksUndo'] }),
  row('protectFailed.result.undo', 'result onb.ksUndo|onb.vaultUndo', 'protectFailed{orphan}', 'free', 'boot matrix setup/keystore or nothing'),
  row('protectFailed.retry', 'retry', 'protect', 'free', NOTHING),
  row('protectPassphrase.p1', 'p1', 'protectPassphrase', 'free', NOTHING),
  row('protectPassphrase.p2', 'p2', 'protectPassphrase', 'free', NOTHING),
  row('protectPassphrase.addBiometric', 'addBiometric', 'protectPassphrase', 'free', NOTHING),
  row('protectPassphrase.next', 'next', 'writingVault', 'after-effect', 'before the transaction nothing stored, after it setup/holder', {
    guard: '≥ 8 characters, equal',
    effects: ['onb.marker', 'onb.vault'],
  }),
  row('protectPassphrase.back', 'back', 'protect', 'free', NOTHING),
  row('writingVault.result.marker', 'result onb.marker', 'writingVault{vault}', 'after-effect', 'nothing stored', { effects: ['onb.vault'] }),
  row('writingVault.result.markerFailed', 'result onb.marker', 'protectFailed', 'free', 'nothing stored'),
  row('writingVault.result.ok.passphrase', 'result onb.vault', 'initHolder', 'locked', 'setup/holder', { guard: 'head passphrase', effects: ['onb.init'] }),
  row('writingVault.result.ok.biometric', 'result onb.vault', 'keyAfterVault', 'locked', 'setup/holder; K missing → biometrics unusable', {
    guard: 'head passphrase+biometric',
    effects: ['onb.ks'],
  }),
  row('writingVault.result.ok.biometricOnly', 'result onb.vault', 'initHolder', 'locked', 'setup/holder', { guard: 'head biometric-only', effects: ['onb.init'] }),
  row('writingVault.result.error', 'result onb.vault', 'protectFailed', 'free', 'boot matrix setup/keystore or nothing', { effects: ['onb.vaultUndo'] }),
  row('keyAfterVault.result.ksOk', 'result onb.ks', 'initHolder', 'locked', 'setup/holder', { effects: ['onb.init'] }),
  row('keyAfterVault.result.ksFailed', 'result onb.ks', 'keyAfterVault{hint}', 'locked', 'setup/holder', { effects: ['onb.bioUnusable'] }),
  row('keyAfterVault.result.hint', 'result onb.bioUnusable', 'initHolder', 'locked', 'setup/holder', { effects: ['onb.init'] }),
  row('initHolder.result.ok', 'result onb.init', 'activating', 'locked', 'setup/holder: after unlocking onb.init with the same inputs', { effects: ['onb.activate'] }),
  row('initHolder.result.error', 'result onb.init', 'initHolder{error}', 'locked', 'setup/holder'),
  row('initHolder.retry', 'retry', 'initHolder', 'locked', 'setup/holder', { effects: ['onb.init'] }),
  row('activating.result.ok', 'result onb.activate', 'done', 'locked', 'before the transaction setup/holder, after it no marker, locked'),
  row('activating.result.error', 'result onb.activate', 'activating{error}', 'locked', 'setup/holder'),
  row('activating.retry', 'retry', 'activating', 'locked', 'setup/holder', { effects: ['onb.activate'] }),
  row('done.continue', 'continue', 'exit(app)', 'free', 'unlocked'),
]

/** Recovery table, architecture §4.2 (protection rows as in onboarding with `rec.*`). */
export const RECOVERY_TABLE: readonly Row[] = [
  row('enterWords.words', 'words', 'enterWords', 'free', 'nothing stored'),
  row('enterWords.next.replace', 'next', 'replaceWarning', 'free', 'nothing stored', { guard: 'checkMnemonic ok, a local identity exists' }),
  row('enterWords.next.terms', 'next', 'terms', 'free', 'nothing stored', { guard: 'checkMnemonic ok, no valid consent' }),
  row('enterWords.next.protect', 'next', 'protect', 'free', 'nothing stored', { guard: 'checkMnemonic ok, consent valid', effects: ['rec.probe'] }),
  row('enterWords.cancel', 'cancel', 'exit(unlock|welcome)', 'free', 'nothing stored'),
  row('replaceWarning.next.terms', 'next', 'terms', 'free', 'nothing stored', { guard: 'no valid consent' }),
  row('replaceWarning.next.protect', 'next', 'protect', 'free', 'nothing stored', { guard: 'consent valid', effects: ['rec.probe'] }),
  row('replaceWarning.back', 'back', 'enterWords', 'free', 'nothing stored'),
  row('terms.terms', 'terms', 'terms', 'free', 'nothing stored'),
  row('terms.next', 'next', 'protect', 'free', 'nothing stored', { guard: 'checked', effects: ['rec.probe'] }),
  row('terms.back', 'back', 'enterWords', 'free', 'nothing stored'),
  row('protect.result.probe', 'result rec.probe', 'protect{available}', 'free', 'nothing stored'),
  row('protect.chooseBiometric', 'chooseBiometric', 'biometricOnlyExplain', 'free', 'nothing stored', { guard: 'availability = available' }),
  row('protect.choosePassphrase', 'choosePassphrase', 'protectPassphrase', 'free', 'nothing stored'),
  row('protect.back', 'back', 'enterWords', 'free', 'nothing stored'),
  row('protect.cancel', 'cancel', 'exit(unlock|welcome)', 'free', 'nothing stored'),
  row('biometricOnlyExplain.confirm', 'confirm', 'keyBeforeVault', 'after-effect', 'boot matrix restore/staging', { effects: ['rec.marker', 'rec.ks'] }),
  row('biometricOnlyExplain.back', 'back', 'protect', 'free', 'nothing stored'),
  row('keyBeforeVault.result.marker', 'result rec.marker', 'keyBeforeVault{ks}', 'locked', 'boot matrix restore/staging', { effects: ['rec.ks'] }),
  row('keyBeforeVault.result.ksOk', 'result rec.ks', 'writingVault', 'locked', 'boot matrix restore/staging', { effects: ['rec.vault'] }),
  row('keyBeforeVault.result.markerFailed', 'result rec.marker', 'protectFailed', 'free', 'boot matrix restore/staging'),
  row('keyBeforeVault.result.ksFailed', 'result rec.ks', 'protectFailed{orphan}', 'free', 'boot matrix restore/staging', { effects: ['rec.ksUndo'] }),
  row('protectFailed.result.undo', 'result rec.ksUndo|rec.vaultUndo', 'protectFailed{orphan}', 'free', 'boot matrix restore/staging'),
  row('protectFailed.retry', 'retry', 'protect', 'free', 'nothing stored'),
  row('protectPassphrase.p1', 'p1', 'protectPassphrase', 'free', 'nothing stored'),
  row('protectPassphrase.p2', 'p2', 'protectPassphrase', 'free', 'nothing stored'),
  row('protectPassphrase.addBiometric', 'addBiometric', 'protectPassphrase', 'free', 'nothing stored'),
  row('protectPassphrase.next', 'next', 'writingVault', 'after-effect', 'boot matrix restore/staging: wipeNamespace(ns_new), old identity active', {
    guard: '≥ 8 characters, equal',
    effects: ['rec.marker', 'rec.vault'],
  }),
  row('protectPassphrase.back', 'back', 'protect', 'free', 'nothing stored'),
  row('writingVault.result.marker', 'result rec.marker', 'writingVault{vault}', 'after-effect', 'boot matrix restore/staging', { effects: ['rec.vault'] }),
  row('writingVault.result.markerFailed', 'result rec.marker', 'protectFailed', 'free', 'boot matrix restore/staging'),
  row('writingVault.result.ok.passphrase', 'result rec.vault', 'staging', 'locked', 'boot matrix restore/staging', { guard: 'head passphrase', effects: ['rec.init'] }),
  row('writingVault.result.ok.biometric', 'result rec.vault', 'keyAfterVault', 'locked', 'boot matrix restore/staging', {
    guard: 'head passphrase+biometric',
    effects: ['rec.ks'],
  }),
  row('writingVault.result.ok.biometricOnly', 'result rec.vault', 'staging', 'locked', 'boot matrix restore/staging', { guard: 'head biometric-only', effects: ['rec.init'] }),
  row('writingVault.result.error', 'result rec.vault', 'protectFailed', 'free', 'boot matrix restore/staging', { effects: ['rec.vaultUndo'] }),
  row('keyAfterVault.result.ksOk', 'result rec.ks', 'staging', 'locked', 'boot matrix restore/staging', { effects: ['rec.init'] }),
  row('keyAfterVault.result.ksFailed', 'result rec.ks', 'keyAfterVault{hint}', 'locked', 'boot matrix restore/staging', { effects: ['rec.bioUnusable'] }),
  row('keyAfterVault.result.hint', 'result rec.bioUnusable', 'staging', 'locked', 'boot matrix restore/staging', { effects: ['rec.init'] }),
  row('staging.result.ok', 'result rec.init', 'switching', 'locked', 'boot matrix restore/staging', { effects: ['rec.switch'] }),
  row('staging.result.error', 'result rec.init', 'staging{error}', 'locked', 'boot matrix restore/staging'),
  row('staging.retry', 'retry', 'staging', 'locked', 'boot matrix restore/staging', { effects: ['rec.init'] }),
  row('switching.result.ok', 'result rec.switch', 'wipingOld', 'locked', 'boot matrix restore/switched', { effects: ['rec.wipeOld'] }),
  row('switching.result.error', 'result rec.switch', 'switching{error}', 'locked', 'boot matrix restore/staging'),
  row('switching.retry', 'retry', 'switching', 'locked', 'boot matrix restore/staging', { effects: ['rec.switch'] }),
  row('wipingOld.result', 'result rec.wipeOld', 'verifyingOld', 'locked', 'marker restore/switched stays; wipeNamespace is idempotent', { effects: ['rec.verifyOld'] }),
  row('verifyingOld.result.ok', 'result rec.verifyOld', 'verifyingOld', 'locked', 'restore/switched until rec.done', { effects: ['rec.done'] }),
  row('verifyingOld.result.survivors', 'result rec.verifyOld', 'verifyingOld{survivors}', 'locked', 'marker stays, next start tries again', { effects: ['rec.done'] }),
  row('verifyingOld.result.done', 'result rec.done', 'done', 'free', 'no marker (or restore/switched with survivors)'),
  row('verifyingOld.result.error', 'result rec.done', 'verifyingOld{error}', 'locked', 'identity in use, marker stays: almost done, never done'),
  row('verifyingOld.retry', 'retry', 'verifyingOld', 'locked', 'marker removal again', { effects: ['rec.done'] }),
  row('done.continue', 'continue', 'exit(app)', 'free', 'unlocked'),
]

// ── initial states ────────────────────────────────────────────────────────

export function onboardingStart(termsVersion: string): SetupState {
  return { name: 'welcome', run: 0, error: null, termsVersion }
}

export function recoveryStart(opts: { hasIdentity: boolean; termsValid: boolean; termsVersion: string }): SetupState {
  return {
    name: 'enterWords',
    run: 0,
    text: EMPTY,
    words: null,
    count: 0,
    check: 'empty',
    hasIdentity: opts.hasIdentity,
    termsValid: opts.termsValid,
    termsVersion: opts.termsVersion,
  }
}

// ── transition ────────────────────────────────────────────────────────────

type E = SetupEvent | ResultEvent
type S = SetupState
type Out = Step<S, SetupEffect>

const go = (state: S, row: string, effects: readonly SetupEffect[] = []): Out => ({ state, effects, row })

/** Emits effects under a new run; results of older runs are then stale. */
function emit(state: S, row: string, make: (run: number) => readonly SetupEffect[]): Out {
  const run = state.run + 1
  return { state: { ...state, run } as S, effects: make(run), row }
}

const protectStart = (c: SetupCtx, run: number, row: string): Out =>
  emit({ name: 'protect', run, c, available: 'probing' }, row, (r) => [{ id: c.flow === 'setup' ? 'onb.probe' : 'rec.probe', run: r }])

function afterVault(s: Extract<S, { name: 'writingVault' | 'keyAfterVault' | 'keyBeforeVault' }>, ns: IdentityNs, rowId: string): Out {
  const p = P(s.c.flow)
  if (s.c.flow === 'setup') return emit({ name: 'initHolder', run: s.run, c: s.c, ns, error: false }, rowId, (r) => [{ id: 'onb.init', run: r, ns }])
  return emit({ name: 'staging', run: s.run, c: s.c, ns, error: false }, rowId, (r) => [{ id: `${p}.init` as 'rec.init', run: r, ns }])
}

function vaultEffect(c: SetupCtx, run: number, ns: IdentityNs, mode: ProtectionMode, passphrase: Secret<string> | null): SetupEffect {
  return { id: c.flow === 'setup' ? 'onb.vault' : 'rec.vault', run, ns, words: c.words, mode, passphrase, profile: c.profile, termsVersion: c.termsVersion }
}

const nsOf = (r: ResultEvent): IdentityNs | null => {
  const v = r.result.value as { ns?: IdentityNs } | undefined
  return v?.ns ?? null
}

function cancelTo(hasIdentity: boolean, run: number, row: string): Out {
  return go({ name: 'exit', run, to: hasIdentity ? 'unlock' : 'welcome' }, row)
}

export function setupTransition(s: S, e: E): Out {
  switch (s.name) {
    // ── onboarding ──
    case 'welcome':
      if (e.type === 'create') return emit({ name: 'generating', run: s.run, termsVersion: s.termsVersion }, 'welcome.create', (r) => [{ id: 'onb.gen', run: r }])
      if (e.type === 'import') return go({ name: 'exit', run: s.run, to: 'recovery' }, 'welcome.import')
      return stay(s)
    case 'generating':
      if (isResult(e, s.run, 'onb.gen')) {
        const v = e.result.value as { words: Words; positions: readonly number[] } | undefined
        if (!e.result.ok || !v) return go({ name: 'welcome', run: s.run, error: 'generate', termsVersion: s.termsVersion }, 'generating.result.error')
        return go(
          { name: 'showWords', run: s.run, words: v.words, positions: v.positions, copy: 'idle', checklist: [false, false, false], termsVersion: s.termsVersion },
          'generating.result.ok',
        )
      }
      return stay(s)
    case 'showWords':
      if (e.type === 'copy') return emit(s, 'showWords.copy', (r) => [{ id: 'onb.copy', run: r, words: s.words }])
      if (isResult(e, s.run, 'onb.copy'))
        return e.result.ok ? go({ ...s, copy: 'copied' }, 'showWords.result.copied') : go({ ...s, copy: 'failed' }, 'showWords.result.copyFailed')
      if (e.type === 'toggle') {
        const checklist = s.checklist.map((v, i) => (i === e.index ? !v : v)) as unknown as readonly [boolean, boolean, boolean]
        return go({ ...s, checklist }, 'showWords.toggle')
      }
      if (e.type === 'next') {
        if (!s.checklist.every(Boolean)) return stay(s)
        return go({ name: 'lastWarning', run: s.run, words: s.words, positions: s.positions, termsVersion: s.termsVersion }, 'showWords.next')
      }
      if (e.type === 'back') return go({ name: 'welcome', run: s.run + 1, error: null, termsVersion: s.termsVersion }, 'showWords.back')
      return stay(s)
    case 'lastWarning':
      if (e.type === 'next')
        return go(
          { name: 'verifyWords', run: s.run, words: s.words, positions: s.positions, inputs: [], wrong: [], termsVersion: s.termsVersion },
          'lastWarning.next',
        )
      if (e.type === 'back')
        return go({ name: 'showWords', run: s.run, words: s.words, positions: s.positions, copy: 'idle', checklist: [true, true, true], termsVersion: s.termsVersion }, 'lastWarning.back')
      return stay(s)
    case 'verifyWords':
      if (e.type === 'input') {
        const inputs = [...s.inputs]
        inputs[e.index] = e.value
        return go({ ...s, inputs, wrong: s.wrong.filter((w) => w !== e.index) }, 'verifyWords.input')
      }
      if (e.type === 'check') {
        const words = s.words.reveal()
        const wrong = s.positions.flatMap((pos, i) => {
          const typed = s.inputs[i]?.reveal().trim().toLowerCase() ?? ''
          return typed === words[pos] ? [] : [i]
        })
        if (wrong.length > 0) return go({ ...s, wrong }, 'verifyWords.check.wrong')
        return go({ name: 'profile', run: s.run, words: s.words, positions: s.positions, displayName: '', terms: false, termsVersion: s.termsVersion }, 'verifyWords.check.right')
      }
      if (e.type === 'back')
        return go({ name: 'showWords', run: s.run, words: s.words, positions: s.positions, copy: 'idle', checklist: [true, true, true], termsVersion: s.termsVersion }, 'verifyWords.back')
      return stay(s)
    case 'profile':
      if (e.type === 'name') return go({ ...s, displayName: e.value }, 'profile.name')
      if (e.type === 'terms') return go({ ...s, terms: e.value }, 'profile.terms')
      if (e.type === 'next') {
        if (s.displayName.trim() === '' || !s.terms) return stay(s)
        const c: SetupCtx = {
          flow: 'setup',
          words: s.words,
          positions: s.positions,
          profile: { name: s.displayName.trim() },
          termsVersion: s.termsVersion,
          currentTerms: s.termsVersion,
          termsValid: false,
          hasIdentity: false,
        }
        return protectStart(c, s.run, 'profile.next')
      }
      if (e.type === 'back')
        return go({ name: 'verifyWords', run: s.run, words: s.words, positions: s.positions, inputs: [], wrong: [], termsVersion: s.termsVersion }, 'profile.back')
      return stay(s)

    // ── recovery ──
    case 'enterWords':
      if (e.type === 'words') return go({ ...s, text: e.text, words: e.words, count: e.count, check: e.check }, 'enterWords.words')
      if (e.type === 'next') {
        if (s.check !== 'ok' || !s.words) return stay(s)
        const c: SetupCtx = {
          flow: 'restore',
          words: s.words,
          positions: [],
          profile: null,
          termsVersion: null,
          currentTerms: s.termsVersion,
          termsValid: s.termsValid,
          hasIdentity: s.hasIdentity,
        }
        if (s.hasIdentity) return go({ name: 'replaceWarning', run: s.run, c }, 'enterWords.next.replace')
        if (!s.termsValid) return go({ name: 'terms', run: s.run, c, accepted: false }, 'enterWords.next.terms')
        return protectStart(c, s.run, 'enterWords.next.protect')
      }
      if (e.type === 'cancel' || e.type === 'back') return cancelTo(s.hasIdentity, s.run, 'enterWords.cancel')
      return stay(s)
    case 'replaceWarning':
      if (e.type === 'next') {
        if (!s.c.termsValid) return go({ name: 'terms', run: s.run, c: s.c, accepted: false }, 'replaceWarning.next.terms')
        return protectStart(s.c, s.run, 'replaceWarning.next.protect')
      }
      if (e.type === 'back' || e.type === 'cancel') return backToWords(s.c, s.run, 'replaceWarning.back')
      return stay(s)
    case 'terms':
      if (e.type === 'terms') return go({ ...s, accepted: e.value }, 'terms.terms')
      if (e.type === 'next') {
        if (!s.accepted) return stay(s)
        return protectStart({ ...s.c, termsVersion: s.c.currentTerms }, s.run, 'terms.next')
      }
      if (e.type === 'back' || e.type === 'cancel') return backToWords(s.c, s.run, 'terms.back')
      return stay(s)

    // ── protection (both) ──
    case 'protect':
      if (isResult(e, s.run, `${P(s.c.flow)}.probe`))
        return go({ ...s, available: (e.result.value as BiometricKind | null | undefined) ?? null }, 'protect.result.probe')
      if (e.type === 'chooseBiometric') {
        if (s.available === null || s.available === 'probing') return stay(s)
        return go({ name: 'biometricOnlyExplain', run: s.run, c: s.c, available: s.available }, 'protect.chooseBiometric')
      }
      if (e.type === 'choosePassphrase')
        return go(
          { name: 'protectPassphrase', run: s.run, c: s.c, available: s.available, p1: EMPTY, p2: EMPTY, addBiometric: s.available !== null && s.available !== 'probing' },
          'protect.choosePassphrase',
        )
      if (e.type === 'back') {
        if (s.c.flow === 'setup')
          return go(
            { name: 'profile', run: s.run + 1, words: s.c.words, positions: s.c.positions, displayName: s.c.profile?.name ?? '', terms: true, termsVersion: s.c.currentTerms },
            'protect.back',
          )
        return backToWords(s.c, s.run + 1, 'protect.back')
      }
      if (e.type === 'cancel' && s.c.flow === 'restore') return cancelTo(s.c.hasIdentity, s.run + 1, 'protect.cancel')
      return stay(s)
    case 'biometricOnlyExplain':
      if (e.type === 'confirm')
        return emit({ name: 'keyBeforeVault', run: s.run, c: s.c, phase: 'marker', ns: null }, 'biometricOnlyExplain.confirm', (r) => [
          { id: s.c.flow === 'setup' ? 'onb.marker' : 'rec.marker', run: r, flow: s.c.flow, mode: 'biometric-only' },
        ])
      if (e.type === 'back') return go({ name: 'protect', run: s.run, c: s.c, available: s.available }, 'biometricOnlyExplain.back')
      return stay(s)
    case 'keyBeforeVault': {
      const p = P(s.c.flow)
      if (s.phase === 'marker' && isResult(e, s.run, `${p}.marker`)) {
        const ns = nsOf(e)
        if (!e.result.ok || !ns) return go({ name: 'protectFailed', run: s.run, c: s.c, available: null, reason: 'keystore', orphan: false }, 'keyBeforeVault.result.markerFailed')
        return emit({ ...s, phase: 'ks', ns }, 'keyBeforeVault.result.marker', (r) => [{ id: `${p}.ks` as 'onb.ks', run: r, ns, phase: 'before' }])
      }
      if (s.phase === 'ks' && s.ns && isResult(e, s.run, `${p}.ks`)) {
        const ns = s.ns
        if (!e.result.ok)
          return emit({ name: 'protectFailed', run: s.run, c: s.c, available: null, reason: 'keystore', orphan: null }, 'keyBeforeVault.result.ksFailed', (r) => [
            { id: `${p}.ksUndo` as 'onb.ksUndo', run: r, ns },
          ])
        return emit({ name: 'writingVault', run: s.run, c: s.c, mode: 'biometric-only', phase: 'vault', ns, passphrase: null }, 'keyBeforeVault.result.ksOk', (r) => [
          vaultEffect(s.c, r, ns, 'biometric-only', null),
        ])
      }
      return stay(s) // locked: back has no effect
    }
    case 'protectPassphrase':
      if (e.type === 'p1') return go({ ...s, p1: e.value }, 'protectPassphrase.p1')
      if (e.type === 'p2') return go({ ...s, p2: e.value }, 'protectPassphrase.p2')
      if (e.type === 'addBiometric') return go({ ...s, addBiometric: e.value }, 'protectPassphrase.addBiometric')
      if (e.type === 'next') {
        const a = s.p1.reveal()
        if (a.length < MIN_PASSPHRASE || a !== s.p2.reveal()) return stay(s)
        const mode: ProtectionMode = s.addBiometric && s.available !== null && s.available !== 'probing' ? 'passphrase+biometric' : 'passphrase'
        return emit({ name: 'writingVault', run: s.run, c: s.c, mode, phase: 'marker', ns: null, passphrase: s.p1 }, 'protectPassphrase.next', (r) => [
          { id: s.c.flow === 'setup' ? 'onb.marker' : 'rec.marker', run: r, flow: s.c.flow, mode },
        ])
      }
      if (e.type === 'back') return go({ name: 'protect', run: s.run, c: s.c, available: s.available }, 'protectPassphrase.back')
      return stay(s)
    case 'writingVault': {
      const p = P(s.c.flow)
      if (s.phase === 'marker' && isResult(e, s.run, `${p}.marker`)) {
        const ns = nsOf(e)
        if (!e.result.ok || !ns) return go({ name: 'protectFailed', run: s.run, c: s.c, available: null, reason: 'vault', orphan: false }, 'writingVault.result.markerFailed')
        return emit({ ...s, phase: 'vault', ns }, 'writingVault.result.marker', (r) => [vaultEffect(s.c, r, ns, s.mode, s.passphrase)])
      }
      if (s.phase === 'vault' && s.ns && isResult(e, s.run, `${p}.vault`)) {
        const ns = s.ns
        if (!e.result.ok)
          return emit({ name: 'protectFailed', run: s.run, c: s.c, available: null, reason: 'vault', orphan: null }, 'writingVault.result.error', (r) => [
            { id: `${p}.vaultUndo` as 'onb.vaultUndo', run: r, ns },
          ])
        if (s.mode === 'passphrase+biometric')
          return emit({ name: 'keyAfterVault', run: s.run, c: s.c, ns, phase: 'ks' }, 'writingVault.result.ok.biometric', (r) => [
            { id: `${p}.ks` as 'onb.ks', run: r, ns, phase: 'after' },
          ])
        return afterVault(s, ns, s.mode === 'passphrase' ? 'writingVault.result.ok.passphrase' : 'writingVault.result.ok.biometricOnly')
      }
      return stay(s)
    }
    case 'keyAfterVault': {
      const p = P(s.c.flow)
      if (s.phase === 'ks' && isResult(e, s.run, `${p}.ks`)) {
        if (e.result.ok) return afterVault(s, s.ns, 'keyAfterVault.result.ksOk')
        return emit({ ...s, phase: 'hint' }, 'keyAfterVault.result.ksFailed', (r) => [{ id: `${p}.bioUnusable` as 'onb.bioUnusable', run: r, ns: s.ns }])
      }
      if (s.phase === 'hint' && isResult(e, s.run, `${p}.bioUnusable`)) return afterVault(s, s.ns, 'keyAfterVault.result.hint')
      return stay(s)
    }
    case 'protectFailed': {
      const p = P(s.c.flow)
      if (s.orphan === null && (isResult(e, s.run, `${p}.ksUndo`) || isResult(e, s.run, `${p}.vaultUndo`))) {
        const v = (e as ResultEvent).result.value as { orphan?: boolean } | undefined
        return go({ ...s, orphan: v?.orphan === true }, 'protectFailed.result.undo')
      }
      if (e.type === 'retry' || e.type === 'back') return protectStart(s.c, s.run, 'protectFailed.retry')
      return stay(s)
    }

    // ── onboarding after the vault ──
    case 'initHolder':
      if (isResult(e, s.run, 'onb.init')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'initHolder.result.error')
        return emit({ name: 'activating', run: s.run, c: s.c, ns: s.ns, error: false }, 'initHolder.result.ok', (r) => [{ id: 'onb.activate', run: r, ns: s.ns }])
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'initHolder.retry', (r) => [{ id: 'onb.init', run: r, ns: s.ns }])
      return stay(s)
    case 'activating':
      if (isResult(e, s.run, 'onb.activate')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'activating.result.error')
        return go({ name: 'done', run: s.run, flow: 'setup', recovered: null, oldSurvivors: null }, 'activating.result.ok')
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'activating.retry', (r) => [{ id: 'onb.activate', run: r, ns: s.ns }])
      return stay(s)

    // ── recovery after the vault ──
    case 'staging':
      if (isResult(e, s.run, 'rec.init')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'staging.result.error')
        return emit({ name: 'switching', run: s.run, c: s.c, ns: s.ns, error: false }, 'staging.result.ok', (r) => [{ id: 'rec.switch', run: r, ns: s.ns }])
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'staging.retry', (r) => [{ id: 'rec.init', run: r, ns: s.ns }])
      return stay(s)
    case 'switching':
      if (isResult(e, s.run, 'rec.switch')) {
        if (!e.result.ok) return go({ ...s, error: true }, 'switching.result.error')
        return emit({ name: 'wipingOld', run: s.run, ns: s.ns }, 'switching.result.ok', (r) => [{ id: 'rec.wipeOld', run: r }])
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'switching.retry', (r) => [{ id: 'rec.switch', run: r, ns: s.ns }])
      return stay(s)
    case 'wipingOld':
      if (isResult(e, s.run, 'rec.wipeOld'))
        return emit({ name: 'verifyingOld', run: s.run, ns: s.ns, survivors: null }, 'wipingOld.result', (r) => [{ id: 'rec.verifyOld', run: r }])
      return stay(s)
    case 'verifyingOld':
      if (isResult(e, s.run, 'rec.verifyOld')) {
        const survivors = (e.result.value as { survivors?: readonly string[] } | undefined)?.survivors ?? []
        if (e.result.ok) return emit({ ...s, survivors: [] }, 'verifyingOld.result.ok', (r) => [{ id: 'rec.done', run: r }])
        return emit({ ...s, survivors }, 'verifyingOld.result.survivors', (r) => [{ id: 'rec.done', run: r }])
      }
      if (isResult(e, s.run, 'rec.done')) {
        // a failed closing write is visible: almost done, try again (never "done" with the marker left)
        if (!e.result.ok) return go({ ...s, error: true }, 'verifyingOld.result.error')
        return go(
          { name: 'done', run: s.run, flow: 'restore', recovered: 'keys-only', oldSurvivors: s.survivors && s.survivors.length > 0 ? s.survivors : null },
          'verifyingOld.result.done',
        )
      }
      if (e.type === 'retry' && s.error) return emit({ ...s, error: false }, 'verifyingOld.retry', (r) => [{ id: 'rec.done', run: r }])
      return stay(s)

    case 'done':
      if (e.type === 'continue') return go({ name: 'exit', run: s.run, to: 'app' }, 'done.continue')
      return stay(s)
    case 'exit':
      return stay(s)
  }
}

/** The value of an empty field. Flows import the port only as types (architecture §1.1), so this
 *  is not a port Secret; an empty string has nothing to protect, and it serializes as redacted. */
const EMPTY = Object.freeze({ reveal: () => '', toJSON: () => '[redacted]', toString: () => '[redacted]' }) as unknown as Secret<string>

function backToWords(c: SetupCtx, run: number, rowId: string): Out {
  return go(
    { name: 'enterWords', run, text: EMPTY, words: null, count: 0, check: 'empty', hasIdentity: c.hasIdentity, termsValid: c.termsValid, termsVersion: c.currentTerms },
    rowId,
  )
}

const SENSITIVE = new Set<S['name']>(['showWords', 'lastWarning', 'verifyWords', 'enterWords', 'protectPassphrase'])

export const onboarding: Machine<S, SetupEvent, SetupEffect> = {
  name: 'onboarding',
  table: ONBOARDING_TABLE,
  transition: setupTransition,
  sensitive: (s) => SENSITIVE.has(s.name),
}

export const recovery: Machine<S, SetupEvent, SetupEffect> = {
  name: 'recovery',
  table: RECOVERY_TABLE,
  transition: setupTransition,
  sensitive: (s) => SENSITIVE.has(s.name),
}
