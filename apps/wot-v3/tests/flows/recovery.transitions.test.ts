// Recovery transitions (architecture §4.2 "Wiederherstellen"): every word length, checksum, staged
// namespace restore (the old identity stays usable until the switch), wipeNamespace of the old
// namespace only (N6), the content-rules consent when none is valid, keys-only result.
import { describe, expect, it } from 'vitest'
import { recovery, recoveryStart, RECOVERY_TABLE, onboarding, onboardingStart, type SetupEvent, type WordsCheck } from '../../src/flows/setup'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { TERMS_VERSION } from '../../src/adapters/identity'
import { mnemonicWords } from '../../src/lib/mnemonic-format'
import type { Mnemonic, Secret } from '../../src/port'
import { drive, failing, s, tableCoverage, testDevice, type Process, type TestDevice } from './world'

const cover = tableCoverage('recovery', RECOVERY_TABLE)
const WORDS24 =
  'cake clip physical have paper balance canvas rather result theme end notice announce talent lab lunch example orphan control series index chunk surprise high'
const WORDS15 = 'before slab path face tennis argue various cotton profit marble educate learn embrace student excess'

function start(p: Process, plan: Parameters<typeof failing>[1] = {}) {
  const consent = p.port.identity.termsConsent()
  const hasIdentity = p.runtime.state.get().status === 'locked'
  return cover.track(
    createFlowRunner(
      recovery,
      recoveryStart({ hasIdentity, termsValid: consent.valid, termsVersion: consent.current }),
      failing(p.exec.setup, plan),
      p.platform,
    ),
  )
}

/** What the screen does on every keystroke: clean, count, check through the port. */
function typed(p: Process, text: string): SetupEvent {
  const words = mnemonicWords(text)
  let check: WordsCheck = 'incomplete'
  if (words.length === 0) check = 'empty'
  else if ([12, 15, 18, 21, 24].includes(words.length)) {
    const r = p.port.identity.checkMnemonic(words)
    check = r.ok ? 'ok' : r.error.kind === 'refused' && r.error.code === 'mnemonic-checksum' ? 'checksum' : 'unknown-word'
  }
  return { type: 'words', text: s(text), words: check === 'ok' ? (s(words) as unknown as Secret<Mnemonic>) : null, count: words.length, check }
}

/** An existing identity created through onboarding, then locked. */
async function existing(d: TestDevice): Promise<{ ns: string; words: string[] }> {
  const p = await d.restart()
  const r = createFlowRunner(onboarding, onboardingStart(TERMS_VERSION), p.exec.setup, p.platform)
  await drive(r, { type: 'create' })
  const st = r.get()
  if (st.name !== 'showWords') throw new Error(st.name)
  const words = [...st.words.reveal()]
  await drive(r, { type: 'toggle', index: 0 }, { type: 'toggle', index: 1 }, { type: 'toggle', index: 2 }, { type: 'next' }, { type: 'next' })
  const v = r.get()
  if (v.name !== 'verifyWords') throw new Error(v.name)
  await drive(r, ...v.positions.map((pos, i): SetupEvent => ({ type: 'input', index: i, value: s(words[pos] ?? '') })), { type: 'check' })
  await drive(r, { type: 'name', value: 'Old' }, { type: 'next' }, { type: 'choosePassphrase' })
  await drive(r, { type: 'addBiometric', value: false }, { type: 'p1', value: s('old passphrase') }, { type: 'p2', value: s('old passphrase') }, { type: 'next' })
  await d.restart()
  return { ns: String(d.device.vault.stores.meta.get('active')), words }
}

describe('recovery', () => {
  it('accepts every valid length; checksum and unknown words keep next locked', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await drive(r, typed(p, 'abandon abandon'), { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'enterWords', check: 'incomplete', count: 2 })
    await drive(r, typed(p, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'), { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'enterWords', check: 'checksum' })
    await drive(r, typed(p, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzz'))
    expect(r.get()).toMatchObject({ check: 'unknown-word' })
    // a pasted numbered list of 24 words counts 24
    await drive(r, typed(p, WORDS24.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n')))
    expect(r.get()).toMatchObject({ check: 'ok', count: 24 })
    await drive(r, typed(p, WORDS15))
    expect(r.get()).toMatchObject({ check: 'ok', count: 15 })
  })

  it('fresh device: consent asked, passphrase protection, staging, switch, done keys-only', async () => {
    const d = testDevice({ faults: { biometric: 'unavailable' } })
    const p = await d.restart()
    const r = start(p)
    await drive(r, typed(p, WORDS24), { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'terms' })
    // Next under the consent sentence is the consent
    await drive(r, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'protect', available: null })
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'done', flow: 'restore', recovered: 'keys-only', oldSurvivors: null })
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', recovered: 'keys-only', termsAccepted: true })
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
    await drive(r, { type: 'continue' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
  })

  it('valid consent on the device: no terms step', async () => {
    const d = testDevice()
    const p = await d.restart()
    d.device.prefs.set('terms', TERMS_VERSION)
    const r = start(p)
    await drive(r, typed(p, WORDS15), { type: 'next' })
    expect(r.get().name).toBe('protect')
  })

  it('with a local identity: replace warning, the old identity stays until the switch, then only its namespace goes', async () => {
    const d = testDevice()
    const old = await existing(d)
    const p = d.current()
    expect(p.runtime.state.get().status).toBe('locked')
    const r = start(p)
    await drive(r, typed(p, WORDS24), { type: 'next' })
    expect(r.get().name).toBe('replaceWarning')
    await drive(r, { type: 'back' })
    expect(r.get().name).toBe('enterWords')
    await drive(r, typed(p, WORDS24), { type: 'next' }, { type: 'next' })
    expect(r.get().name).toBe('protect') // consent from onboarding is still valid
    await drive(r, { type: 'chooseBiometric' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'done', recovered: 'keys-only' })
    const active = String(d.device.vault.stores.meta.get('active'))
    expect(active).not.toBe(old.ns)
    expect(d.device.vault.stores.vaults.has(old.ns)).toBe(false)
    expect([...d.device.databases].some((n) => n.includes(old.ns))).toBe(false)
    expect(d.device.keystore.has(active)).toBe(true)
  })

  it('replace warning to terms when no consent is valid; cancel goes back to unlock', async () => {
    const d = testDevice()
    await existing(d)
    d.device.prefs.delete('terms')
    const p = d.current()
    let r = start(p)
    await drive(r, typed(p, WORDS24), { type: 'next' }, { type: 'next' })
    expect(r.get().name).toBe('terms')
    await drive(r, { type: 'back' })
    expect(r.get().name).toBe('enterWords')
    await drive(r, { type: 'cancel' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'unlock' })
    r = start(p)
    await drive(r, typed(p, WORDS24), { type: 'next' }, { type: 'next' }, { type: 'next' })
    expect(r.get().name).toBe('protect')
    await drive(r, { type: 'cancel' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'unlock' })
  })

  it('cancel without an identity goes to welcome; back from protect to the words', async () => {
    const d = testDevice()
    const p = await d.restart()
    d.device.prefs.set('terms', TERMS_VERSION)
    const r = start(p)
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'back' })
    expect(r.get().name).toBe('enterWords')
    await drive(r, { type: 'cancel' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'welcome' })
  })

  it('protection rows as in onboarding: back, keystore failure, passphrase+biometric with and without keystore', async () => {
    const d = testDevice()
    const p = await d.restart()
    d.device.prefs.set('terms', TERMS_VERSION)
    let r = start(p)
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'chooseBiometric' }, { type: 'back' }, { type: 'choosePassphrase' }, { type: 'back' })
    expect(r.get().name).toBe('protect')
    d.device.faults.biometric = 'cancel'
    await drive(r, { type: 'chooseBiometric' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', orphan: false })
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
    await drive(r, { type: 'retry' })
    // passphrase+biometric, keystore fails → hint, continue
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get().name).toBe('done')
    d.device.faults.biometric = 'ok'
    // the same again with a working keystore, over the identity just restored
    const p2 = d.current()
    r = start(p2)
    await drive(r, typed(p2, WORDS24), { type: 'next' }, { type: 'next' })
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'addBiometric', value: true }, { type: 'next' })
    expect(r.get().name).toBe('done')
    expect(p2.runtime.state.get()).toMatchObject({ protection: 'passphrase+biometric' })
  })

  it('staging over a holder store the library refuses: back to the identity there was, never retry', async () => {
    const d = testDevice()
    await existing(d)
    const p = d.current()
    const r = start(p, { 'rec.init': { ok: false, code: 'state-unreadable', value: { cause: 'newer' } } })
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'next' }, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'stateUnreadable', cause: 'newer' })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('stateUnreadable')
    await drive(r, { type: 'cancel' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'unlock' })
  })

  it('error rows: marker, vault, staging, switch; the old namespace surviving keeps the marker', async () => {
    const d = testDevice()
    let p = await d.restart()
    d.device.prefs.set('terms', TERMS_VERSION)
    let r = start(p, { 'rec.marker': 'storage' })
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'chooseBiometric' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'protectFailed' })
    r = start(p, { 'rec.marker': 'storage' })
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', reason: 'vault' })
    r = start(p, { 'rec.vault': 'storage' })
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', reason: 'vault', orphan: false })

    await existing(d)
    p = d.current()
    r = start(p, { 'rec.init': 'storage', 'rec.switch': 'storage' })
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'next' }, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'staging', error: true })
    await drive(r, { type: 'cancel' })
    expect(r.get().name).toBe('staging') // locked from the vault on
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'switching', error: true })
    d.device.faults.wipeSurvivor = 'wot-v3-app-' // the old app db refuses to go
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'done', recovered: 'keys-only' })
    const st = r.get()
    expect(st.name === 'done' && st.oldSurvivors?.some((x) => x.startsWith('indexeddb:wot-v3-app-'))).toBe(true)
    expect(d.device.vault.stores.meta.get('resume')).toMatchObject({ flow: 'restore', step: 'switched' })
    // the next start retries the old namespace and clears the marker once it is gone
    d.device.faults.wipeSurvivor = null
    const again = await d.restart()
    expect(again.runtime.state.get().status).toBe('locked')
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
  })

  it('a failed closing write is visible: almost done with a retry, never done with the marker left (20.10.)', async () => {
    const d = testDevice()
    await d.restart()
    await existing(d)
    const p = d.current()
    const r = start(p, { 'rec.done': 'storage' })
    await drive(r, typed(p, WORDS15), { type: 'next' }, { type: 'next' }, { type: 'choosePassphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'verifyingOld', error: true })
    // the marker stays until the retry removes it (the runtime side: review-420-r6)
    expect(d.device.vault.stores.meta.get('resume')).toMatchObject({ flow: 'restore' })
    await drive(r, { type: 'cancel' })
    expect(r.get()).toMatchObject({ name: 'verifyingOld', error: true })
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'done', recovered: 'keys-only' })
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
  })
})
