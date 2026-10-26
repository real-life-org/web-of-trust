// Onboarding transitions (architecture §4.2 table, §7.2): every row reached through real events,
// guards and effects against the simulation adapter and the fake platform, no state set directly.
import { describe, expect, it } from 'vitest'
import { onboarding, onboardingStart, ONBOARDING_TABLE, type SetupEvent, type SetupState } from '../../src/flows/setup'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { TERMS_VERSION } from '../../src/adapters/identity'
import { drive, failing, s, tableCoverage, testDevice, type Process } from './world'

const cover = tableCoverage('onboarding', ONBOARDING_TABLE)

function start(p: Process, plan: Parameters<typeof failing>[1] = {}) {
  return cover.track(
    createFlowRunner(onboarding, onboardingStart(TERMS_VERSION), failing(p.exec.setup, plan), p.platform),
  )
}

type R = ReturnType<typeof start>

/** welcome → … → profile with the right words */
async function toProfile(r: R): Promise<SetupState> {
  await drive(r, { type: 'create' })
  const shown = r.get()
  if (shown.name !== 'showWords') throw new Error(shown.name)
  const words = shown.words.reveal()
  await drive(r, { type: 'toggle', index: 0 }, { type: 'toggle', index: 1 }, { type: 'toggle', index: 2 }, { type: 'next' }, { type: 'next' })
  const v = r.get()
  if (v.name !== 'verifyWords') throw new Error(v.name)
  const typed: SetupEvent[] = v.positions.map((pos, i) => ({ type: 'input', index: i, value: s(` ${words[pos]?.toUpperCase()} `) }))
  return drive(r, ...typed, { type: 'check' })
}

async function toProtect(r: R): Promise<SetupState> {
  await toProfile(r)
  return drive(r, { type: 'name', value: '  Jonas Weber ' }, { type: 'next' })
}

describe('onboarding', () => {
  it('passphrase path: words, check, profile, protect, vault, holder, activation', async () => {
    const d = testDevice({ faults: { biometric: 'unavailable' } })
    const p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'none', hint: null })
    const r = start(p)
    await drive(r, { type: 'create' })
    let st = r.get()
    expect(st.name).toBe('showWords')
    if (st.name !== 'showWords') return
    expect(st.words.reveal()).toHaveLength(12)
    expect(st.positions).toHaveLength(3)
    // copying keeps the numbered format; the next step needs all three checks
    await drive(r, { type: 'copy' })
    expect(r.get()).toMatchObject({ name: 'showWords', copy: 'copied' })
    expect(d.device.clipboard.text?.split('\n')[0]).toMatch(/^1\. [a-z]+$/)
    await drive(r, { type: 'toggle', index: 0 }, { type: 'next' })
    expect(r.get().name).toBe('showWords')
    await drive(r, { type: 'toggle', index: 1 }, { type: 'toggle', index: 2 }, { type: 'next' })
    expect(r.get().name).toBe('lastWarning')
    await drive(r, { type: 'next' })
    st = r.get()
    if (st.name !== 'verifyWords') throw new Error(st.name)
    // a wrong word stays in the step and names the position
    await drive(r, { type: 'input', index: 0, value: s('wrong') }, { type: 'input', index: 1, value: s('x') }, { type: 'input', index: 2, value: s('y') }, { type: 'check' })
    expect(r.get()).toMatchObject({ name: 'verifyWords', wrong: [0, 1, 2] })
    await toProfileFrom(r)
    // the profile needs a name; Next under the consent sentence is the consent
    await drive(r, { type: 'next' })
    expect(r.get().name).toBe('profile')
    await drive(r, { type: 'name', value: 'Jonas Weber' }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'protect', available: null })
    // no biometrics: only the passphrase
    await drive(r, { type: 'chooseBiometric' })
    expect(r.get().name).toBe('protect')
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('short') }, { type: 'p2', value: s('short') }, { type: 'next' })
    expect(r.get().name).toBe('protectPassphrase')
    await drive(r, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horsE') }, { type: 'next' })
    expect(r.get().name).toBe('protectPassphrase')
    await drive(r, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'done', flow: 'setup' })
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase', termsAccepted: true })
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
    expect([...d.holders.values()][0]?.name).toBe('Jonas Weber')
    await drive(r, { type: 'continue' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    // the stored identity unlocks after a restart with the passphrase
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'passphrase' })
  })

  it('copy failure is visible, never a crash (legacy de1644a7)', async () => {
    const d = testDevice({ faults: { clipboard: 'fails' } })
    const r = start(await d.restart())
    await drive(r, { type: 'create' }, { type: 'copy' })
    expect(r.get()).toMatchObject({ name: 'showWords', copy: 'failed' })
  })

  it('back goes one step back up to the profile; import leaves to recovery', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'back' })
    expect(r.get().name).toBe('protect')
    await drive(r, { type: 'chooseBiometric' }, { type: 'back' })
    expect(r.get().name).toBe('protect')
    await drive(r, { type: 'back' })
    expect(r.get()).toMatchObject({ name: 'profile', displayName: 'Jonas Weber' })
    await drive(r, { type: 'back' })
    expect(r.get()).toMatchObject({ name: 'verifyWords', inputs: [] })
    await drive(r, { type: 'back' })
    expect(r.get()).toMatchObject({ name: 'showWords', checklist: [true, true, true] })
    await drive(r, { type: 'next' }, { type: 'back' })
    expect(r.get().name).toBe('showWords')
    await drive(r, { type: 'back' })
    expect(r.get().name).toBe('welcome')
    await drive(r, { type: 'import' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'recovery' })
  })

  it('biometric-only: keystore before the vault, then holder and activation', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await toProtect(r)
    expect(r.get()).toMatchObject({ name: 'protect', available: 'fingerprint' })
    await drive(r, { type: 'chooseBiometric' })
    expect(r.get().name).toBe('biometricOnlyExplain')
    await drive(r, { type: 'confirm' })
    expect(r.get().name).toBe('done')
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'biometric-only' })
    expect(d.device.keystore.size).toBe(1)
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'biometric-only', biometricLost: false })
  })

  it('biometric-only: a cancelled prompt removes the entry and stores nothing (6729fe59)', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await toProtect(r)
    d.device.faults.biometric = 'cancel'
    await drive(r, { type: 'chooseBiometric' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', reason: 'keystore', orphan: false })
    expect(d.device.vault.stores.vaults.size).toBe(0)
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
    d.device.faults.biometric = 'ok'
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('protect')
  })

  it('passphrase+biometric: keystore after the vault', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' })
    expect(r.get()).toMatchObject({ name: 'protectPassphrase', addBiometric: true })
    await drive(r, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(r.get().name).toBe('done')
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase+biometric' })
    expect(d.device.keystore.size).toBe(1)
  })

  it('passphrase+biometric: a failed keystore marks biometrics unusable and continues', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') })
    d.device.faults.biometric = 'cancel'
    await drive(r, { type: 'next' })
    expect(r.get().name).toBe('done')
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase+biometric' })
    expect([...d.device.vault.stores.meta.keys()].some((k) => k.startsWith('bioUnusable:'))).toBe(true)
    d.device.faults.biometric = 'ok'
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', bioUnusable: true })
  })

  it('addBiometric off writes a plain passphrase head', async () => {
    const d = testDevice()
    const r = start(await d.restart())
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'addBiometric', value: false }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(d.current().runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase' })
  })

  it('error rows: generate, marker, vault, init and activate failures', async () => {
    const d = testDevice()
    let p = await d.restart()
    let r = start(p, { 'onb.gen': 'bug' })
    await drive(r, { type: 'create' })
    expect(r.get()).toMatchObject({ name: 'welcome', error: 'generate' })

    r = start(p, { 'onb.marker': 'storage' })
    await toProtect(r)
    await drive(r, { type: 'chooseBiometric' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', orphan: false })

    r = start(p, { 'onb.marker': 'storage' })
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', reason: 'vault' })

    // the vault transaction aborts: undo, nothing stays behind
    d.device.vault.beforeCommit = (writes) => {
      if (writes.some((w) => w.store === 'vaults')) throw new Error('quota')
    }
    r = start(p)
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'protectFailed', reason: 'vault', orphan: false })
    expect(d.device.vault.stores.vaults.size).toBe(0)
    d.device.vault.beforeCommit = null

    p = await d.restart()
    r = start(p, { 'onb.init': 'storage', 'onb.activate': 'storage' })
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'initHolder', error: true })
    await drive(r, { type: 'back' })
    expect(r.get().name).toBe('initHolder') // locked: back has no effect
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'activating', error: true })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('done')
  })

  it('a fresh holder store the library refuses: restore with the words or start over, never retry', async () => {
    const d = testDevice()
    let p = await d.restart()
    const unreadable = { ok: false, code: 'state-unreadable', value: { cause: 'damaged' } }
    let r = start(p, { 'onb.init': unreadable })
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    expect(r.get()).toMatchObject({ name: 'stateUnreadable', cause: 'damaged' })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('stateUnreadable')
    await drive(r, { type: 'import' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'recovery' })
    p = await d.restart()
    r = start(p, { 'onb.init': unreadable })
    await toProtect(r)
    await drive(r, { type: 'choosePassphrase' }, { type: 'p1', value: s('correct horse') }, { type: 'p2', value: s('correct horse') }, { type: 'next' })
    await drive(r, { type: 'cancel' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'welcome' })
  })

  it('drops the result of an older run (late effect after back)', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await toProfile(r)
    r.send({ type: 'name', value: 'A' })
    r.send({ type: 'next' }) // emits onb.probe in run n
    r.send({ type: 'back' }) // run n+1: the probe result is stale
    await r.idle()
    expect(r.get().name).toBe('profile')
  })

  it('marks words and passphrase states sensitive for the screen protection', async () => {
    const d = testDevice()
    const p = await d.restart()
    const r = start(p)
    await drive(r, { type: 'create' })
    expect(p.platform.screen.current()).toBe('sensitive')
    await toProfileFrom(r, true)
    expect(p.platform.screen.current()).toBe('normal')
    r.dispose()
    expect(p.platform.screen.current()).toBe('normal')
  })
})

/** from showWords or verifyWords to profile with the right words */
async function toProfileFrom(r: R, fromShow = false): Promise<void> {
  let st = r.get()
  if (fromShow && st.name === 'showWords') {
    await drive(r, { type: 'toggle', index: 0 }, { type: 'toggle', index: 1 }, { type: 'toggle', index: 2 }, { type: 'next' }, { type: 'next' })
    st = r.get()
  }
  if (st.name !== 'verifyWords') throw new Error(st.name)
  const words = st.words.reveal()
  const events: SetupEvent[] = st.positions.map((pos, i) => ({ type: 'input', index: i, value: s(words[pos] ?? '') }))
  await drive(r, ...events, { type: 'check' })
  expect(r.get().name).toBe('profile')
}
