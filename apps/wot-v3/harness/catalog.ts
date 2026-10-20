// Screen catalog of the identity flows (architecture §7.2 "Darstellung"): every state of every
// identity machine with a set state (FlowOverride), for the screenshots light and dark. This proves
// only that a state looks right; reaching it is the job of tests/flows/*.transitions.test.ts.
// Words in states are the public test phrase of §5.1, never generated ones.
import type { FlowOverride } from '../src/app/flow-override'
import type { IdentityNs, LockInfo, Mnemonic, Secret } from '../src/port'
import { secret } from '../src/port'
import type { SetupCtx, SetupState } from '../src/flows/setup'
import type { UnlockState } from '../src/flows/unlock'
import type { ProtectionState } from '../src/flows/protection'
import type { DeleteState } from '../src/flows/delete'
import type { LegacyState } from '../src/flows/legacy-reset'

export const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const words = secret(TEST_PHRASE.split(' ')) as unknown as Secret<Mnemonic>
const ns = 'ncatalog' as IdentityNs
const empty = secret('')
const pass = secret('harness passphrase')
const TERMS = '2026-10-draft'

const ctx = (flow: 'setup' | 'restore'): SetupCtx => ({
  flow,
  words,
  positions: [2, 6, 10],
  profile: flow === 'setup' ? { name: 'Jonas Weber' } : null,
  termsVersion: TERMS,
  currentTerms: TERMS,
  termsValid: false,
  hasIdentity: false,
})

const lock = (over: Partial<LockInfo> = {}): LockInfo => ({
  protection: 'passphrase',
  biometric: 'fingerprint',
  biometricLost: false,
  bioUnusable: false,
  unsupported: false,
  offerBiometric: true,
  ...over,
})

export interface CatalogEntry {
  readonly id: string
  readonly override: FlowOverride
}

const ob = (id: string, state: SetupState, extra: { hint?: 'setup-interrupted' | 'access-missing'; captured?: boolean } = {}): CatalogEntry => ({
  id: `onboarding-${id}`,
  override: { flow: 'onboarding', state, ...extra },
})
const rec = (id: string, state: SetupState): CatalogEntry => ({ id: `recovery-${id}`, override: { flow: 'recovery', state } })
const unl = (id: string, state: UnlockState): CatalogEntry => ({ id: `unlock-${id}`, override: { flow: 'unlock', state } })
const prt = (id: string, state: ProtectionState): CatalogEntry => ({ id: `protection-${id}`, override: { flow: 'protection', state } })
const del = (id: string, state: DeleteState): CatalogEntry => ({ id: `delete-${id}`, override: { flow: 'delete', state } })
const leg = (id: string, state: LegacyState): CatalogEntry => ({ id: `legacy-${id}`, override: { flow: 'legacy', state } })

const filledInputs = [secret('abandon'), secret('wrong'), secret('abandon')]

export const CATALOG: readonly CatalogEntry[] = [
  // onboarding
  ob('welcome', { name: 'welcome', run: 0, error: null, termsVersion: TERMS }),
  ob('welcome-setup-interrupted', { name: 'welcome', run: 0, error: null, termsVersion: TERMS }, { hint: 'setup-interrupted' }),
  ob('welcome-error', { name: 'welcome', run: 0, error: 'generate', termsVersion: TERMS }),
  ob('generating', { name: 'generating', run: 1, termsVersion: TERMS }),
  ob('showWords', { name: 'showWords', run: 1, words, positions: [2, 6, 10], copy: 'idle', checklist: [true, false, false], termsVersion: TERMS }),
  ob('showWords-copy-failed', { name: 'showWords', run: 1, words, positions: [2, 6, 10], copy: 'failed', checklist: [false, false, false], termsVersion: TERMS }),
  ob('showWords-screenshot', { name: 'showWords', run: 1, words, positions: [2, 6, 10], copy: 'copied', checklist: [true, true, true], termsVersion: TERMS }, { captured: true }),
  ob('lastWarning', { name: 'lastWarning', run: 1, words, positions: [2, 6, 10], termsVersion: TERMS }),
  ob('verifyWords', { name: 'verifyWords', run: 1, words, positions: [2, 6, 10], inputs: filledInputs, wrong: [1], termsVersion: TERMS }),
  ob('profile', { name: 'profile', run: 1, words, positions: [2, 6, 10], displayName: 'Jonas Weber', terms: false, termsVersion: TERMS }),
  ob('protect', { name: 'protect', run: 2, c: ctx('setup'), available: 'fingerprint' }),
  ob('protect-no-biometrics', { name: 'protect', run: 2, c: ctx('setup'), available: null }),
  ob('biometricOnlyExplain', { name: 'biometricOnlyExplain', run: 2, c: ctx('setup'), available: 'fingerprint' }),
  ob('protectPassphrase', { name: 'protectPassphrase', run: 2, c: ctx('setup'), available: 'fingerprint', p1: pass, p2: secret('harness passphrasf'), addBiometric: true }),
  ob('keyBeforeVault', { name: 'keyBeforeVault', run: 3, c: ctx('setup'), phase: 'ks', ns }),
  ob('writingVault', { name: 'writingVault', run: 3, c: ctx('setup'), mode: 'passphrase', phase: 'vault', ns, passphrase: pass }),
  ob('keyAfterVault', { name: 'keyAfterVault', run: 3, c: ctx('setup'), ns, phase: 'ks' }),
  ob('protectFailed', { name: 'protectFailed', run: 3, c: ctx('setup'), available: null, reason: 'keystore', orphan: false }),
  ob('protectFailed-orphan', { name: 'protectFailed', run: 3, c: ctx('setup'), available: null, reason: 'vault', orphan: true }),
  ob('initHolder', { name: 'initHolder', run: 3, c: ctx('setup'), ns, error: false }),
  ob('initHolder-error', { name: 'initHolder', run: 3, c: ctx('setup'), ns, error: true }),
  ob('activating', { name: 'activating', run: 3, c: ctx('setup'), ns, error: false }),
  ob('done', { name: 'done', run: 3, flow: 'setup', recovered: null, oldSurvivors: null }),
  // recovery
  rec('enterWords', { name: 'enterWords', run: 0, text: secret('abandon abandon abandon '), words: null, count: 3, check: 'incomplete', hasIdentity: false, termsValid: false, termsVersion: TERMS }),
  rec('enterWords-checksum', {
    name: 'enterWords',
    run: 0,
    text: secret(Array(12).fill('abandon').join(' ')),
    words: null,
    count: 12,
    check: 'checksum',
    hasIdentity: false,
    termsValid: false,
    termsVersion: TERMS,
  }),
  rec('enterWords-ok', { name: 'enterWords', run: 0, text: secret(TEST_PHRASE), words, count: 12, check: 'ok', hasIdentity: true, termsValid: true, termsVersion: TERMS }),
  rec('replaceWarning', { name: 'replaceWarning', run: 0, c: { ...ctx('restore'), hasIdentity: true } }),
  rec('terms', { name: 'terms', run: 0, c: ctx('restore'), accepted: false }),
  rec('protect', { name: 'protect', run: 1, c: ctx('restore'), available: null }),
  rec('protectPassphrase', { name: 'protectPassphrase', run: 1, c: ctx('restore'), available: null, p1: empty, p2: empty, addBiometric: false }),
  rec('biometricOnlyExplain', { name: 'biometricOnlyExplain', run: 1, c: ctx('restore'), available: 'face' }),
  rec('keyBeforeVault', { name: 'keyBeforeVault', run: 2, c: ctx('restore'), phase: 'ks', ns }),
  rec('writingVault', { name: 'writingVault', run: 2, c: ctx('restore'), mode: 'biometric-only', phase: 'vault', ns, passphrase: null }),
  rec('keyAfterVault', { name: 'keyAfterVault', run: 2, c: ctx('restore'), ns, phase: 'hint' }),
  rec('protectFailed', { name: 'protectFailed', run: 2, c: ctx('restore'), available: 'face', reason: 'keystore', orphan: false }),
  rec('staging', { name: 'staging', run: 2, c: ctx('restore'), ns, error: false }),
  rec('staging-error', { name: 'staging', run: 2, c: ctx('restore'), ns, error: true }),
  rec('switching', { name: 'switching', run: 2, c: ctx('restore'), ns, error: false }),
  rec('wipingOld', { name: 'wipingOld', run: 2, ns }),
  rec('verifyingOld', { name: 'verifyingOld', run: 2, ns, survivors: null }),
  rec('verifyingOld-almost', { name: 'verifyingOld', run: 2, ns, survivors: null, error: true }),
  rec('done', { name: 'done', run: 2, flow: 'restore', recovered: 'keys-only', oldSurvivors: null }),
  rec('done-old-survivors', { name: 'done', run: 2, flow: 'restore', recovered: 'keys-only', oldSurvivors: ['indexeddb:wot-v3-app-n3f9c'] }),
  // unlock
  unl('passphrase', { name: 'passphrase', run: 0, lock: lock(), mode: 'unlock', value: empty, busy: false, error: null, hint: null, report: null }),
  unl('passphrase-wrong', { name: 'passphrase', run: 1, lock: lock(), mode: 'unlock', value: empty, busy: false, error: 'wrong', hint: null, report: null }),
  unl('passphrase-bioUnusable', {
    name: 'passphrase',
    run: 1,
    lock: lock({ protection: 'passphrase+biometric', bioUnusable: true }),
    mode: 'unlock',
    value: empty,
    busy: false,
    error: null,
    hint: 'bioUnusable',
    report: 'invalid',
  }),
  unl('passphrase-bioFailed', {
    name: 'passphrase',
    run: 1,
    lock: lock({ protection: 'passphrase+biometric' }),
    mode: 'unlock',
    value: empty,
    busy: false,
    error: null,
    hint: 'bioFailed',
    report: null,
  }),
  unl('biometricPrompt', { name: 'biometricPrompt', run: 1, lock: lock({ protection: 'passphrase+biometric' }), mode: 'unlock', report: null }),
  unl('biometricRetry', { name: 'biometricRetry', run: 1, lock: lock({ protection: 'biometric-only' }), mode: 'unlock', report: null }),
  unl('biometricLost', { name: 'biometricLost', run: 1, lock: lock({ protection: 'biometric-only', biometricLost: true }), mode: 'unlock' }),
  unl('unsupported', { name: 'unsupported', run: 0, lock: lock({ unsupported: true }) }),
  unl('opening', { name: 'opening', run: 2, lock: lock(), mode: 'unlock', report: null, via: 'passphrase' }),
  unl('otherWriter', { name: 'otherWriter', run: 2, lock: lock(), mode: 'unlock', report: null, via: 'passphrase' }),
  unl('resume-passphrase', { name: 'passphrase', run: 0, lock: lock(), mode: 'resume-setup', value: empty, busy: false, error: null, hint: null, report: null }),
  unl('resumeInit', { name: 'resumeInit', run: 2, lock: lock(), error: false }),
  unl('resumeActivate-error', { name: 'resumeActivate', run: 2, lock: lock(), error: true }),
  unl('repairProtection', { name: 'repairProtection', run: 2, lock: lock(), error: false }),
  unl('repairProtection-error', { name: 'repairProtection', run: 2, lock: lock(), error: true }),
  unl('repairKeystore', { name: 'repairKeystore', run: 2, lock: lock({ protection: 'passphrase+biometric' }), busy: false }),
  unl('offerBiometric', { name: 'offerBiometric', run: 2, lock: lock(), busy: false }),
  // protection
  prt('choose', { name: 'choose', run: 0, current: 'passphrase', biometric: 'fingerprint', error: null }),
  prt('choose-biometric-only', { name: 'choose', run: 0, current: 'biometric-only', biometric: 'face', error: null }),
  prt('proveCurrent', { name: 'proveCurrent', run: 1, current: 'passphrase', target: 'passphrase+biometric', value: empty, busy: false, error: 'wrong' }),
  prt('provingBiometric', { name: 'provingBiometric', run: 1, current: 'biometric-only', target: 'passphrase', error: 'cancelled' }),
  prt('newPassphrase', { name: 'newPassphrase', run: 1, current: 'biometric-only', target: 'passphrase', p1: empty, p2: empty }),
  prt('applying', { name: 'applying', run: 2, current: 'passphrase', target: 'passphrase+biometric', plan: ['prt.ks', 'prt.head'], step: 0, passphrase: null }),
  prt('done', { name: 'done', run: 2, target: 'passphrase+biometric' }),
  prt('failed', { name: 'failed', run: 2, current: 'passphrase', target: 'passphrase+biometric', reason: 'keystore', partial: false }),
  // delete
  del('explain', { name: 'explain', run: 0 }),
  del('confirm', { name: 'confirm', run: 0, typed: 'DEL', word: 'DELETE' }),
  del('wiping', { name: 'wiping', run: 5 }),
  del('done', { name: 'done', run: 7, report: { local: { ok: true }, remote: { done: 3, pending: 0, failed: 1 } } }),
  del('failed-sealing', { name: 'failed', run: 5, phase: 'sealing', survivors: [] }),
  del('failed', { name: 'failed', run: 7, phase: 'verifying', survivors: ['indexeddb:wot-v3-holder-n3f9c', 'keystore:n3f9c'] }),
  del('resumeChoice', { name: 'resumeChoice', run: 0, lock: lock() }),
  // Gen-2 reset
  leg('notice', { name: 'notice', run: 0 }),
  leg('wiping', { name: 'wiping', run: 1 }),
  leg('failed', { name: 'failed', run: 2, survivors: ['indexeddb:wot-identity'] }),
  // states without a flow
  { id: 'status-booting', override: { flow: 'status', status: 'booting' } },
  { id: 'status-storage-blocked', override: { flow: 'status', status: 'storage-blocked' } },
  { id: 'status-crypto-unavailable', override: { flow: 'status', status: 'crypto-unavailable' } },
  { id: 'status-other-writer', override: { flow: 'status', status: 'other-writer' } },
  { id: 'status-restore-switch', override: { flow: 'status', status: 'restore-switch' } },
]

export function catalogEntry(id: string | null): CatalogEntry | null {
  return CATALOG.find((e) => e.id === id) ?? null
}
