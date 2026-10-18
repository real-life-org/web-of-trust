// Unlock transitions (architecture §4.2 "Entsperren"): one path per protection mode; invalid
// biometrics set only the hint field (bioUnusable), the head changes only after a proven passphrase;
// "keystore ok, vault does not open" falls back to the passphrase and repairs the keystore; lost
// biometrics with biometric-only leave recovery or delete; resume after an interrupted setup.
import { describe, expect, it } from 'vitest'
import { unlock, unlockStart, UNLOCK_TABLE, type UnlockMode } from '../../src/flows/unlock'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import type { IdentityState, LockInfo } from '../../src/port'
import { createdIdentity, drive, failing, PASSPHRASE, PHRASE12, s, tableCoverage, testDevice, type Process } from './world'

const cover = tableCoverage('unlock', UNLOCK_TABLE)

function lockOf(st: IdentityState): LockInfo {
  if (st.status !== 'locked' && !(st.status === 'resuming' && st.step === 'setup')) throw new Error(st.status)
  const { protection, biometric, biometricLost, bioUnusable, unsupported, offerBiometric } = st
  return { protection, biometric, biometricLost, bioUnusable, unsupported, offerBiometric }
}

function start(p: Process, mode: UnlockMode = 'unlock', plan: Record<string, string> = {}) {
  return cover.track(createFlowRunner(unlock, unlockStart(lockOf(p.runtime.state.get()), mode), failing(p.exec.unlock, plan), p.platform))
}

const enc = new TextEncoder()

describe('unlock', () => {
  it('passphrase: empty and wrong stay, right opens; the biometric offer once, "not now" remembered', async () => {
    const d = testDevice()
    const { process: p } = await createdIdentity(d, 'passphrase')
    expect(p.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'passphrase', offerBiometric: true })
    let r = start(p)
    expect(r.get()).toMatchObject({ name: 'passphrase', hint: null })
    expect(p.platform.screen.current()).toBe('sensitive')
    await drive(r, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'passphrase', error: 'empty' })
    await drive(r, { type: 'value', value: s('wrong passphrase') }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'passphrase', error: 'wrong' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get().name).toBe('offerBiometric')
    expect(p.runtime.state.get().status).toBe('unlocked')
    await drive(r, { type: 'notNow' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', offerBiometric: false })
    r = start(again)
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
  })

  it('offer accepted: keystore first, then head passphrase+biometric', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    const r = start(p)
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' }, { type: 'enable' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    expect(d.device.keystore.has(ns)).toBe(true)
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase+biometric' })
  })

  it('passphrase+biometric: biometrics open the vault; cancel falls back to the passphrase, retry works', async () => {
    const d = testDevice()
    const { process: p } = await createdIdentity(d, 'passphrase+biometric')
    let r = start(p)
    await drive(r)
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    await p.runtime.lock('user')
    d.device.faults.biometric = 'cancel'
    r = start(p)
    await drive(r)
    expect(r.get()).toMatchObject({ name: 'passphrase', hint: 'bioFailed' })
    d.device.faults.biometric = 'ok'
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    await p.runtime.lock('user')
    r = start(p)
    r.send({ type: 'usePassphrase' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
  })

  it('invalid biometrics: hint field only, passphrase, then the head is re-encrypted, keystore removed, biometrics offered again', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase+biometric')
    const headBefore = JSON.stringify(d.device.vault.stores.vaults.get(ns))
    d.device.invalidated.add(ns)
    const r = start(p)
    await drive(r)
    expect(r.get()).toMatchObject({ name: 'passphrase', hint: 'bioUnusable', report: 'invalid' })
    expect(d.device.vault.stores.meta.get(`bioUnusable:${ns}`)).toBe(true)
    expect(JSON.stringify(d.device.vault.stores.vaults.get(ns))).toBe(headBefore) // nothing written at the vault
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get().name).toBe('offerBiometric')
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase' })
    expect(d.device.keystore.has(ns)).toBe(false)
    expect(d.device.vault.stores.meta.get(`bioUnusable:${ns}`)).toBeUndefined()
    await drive(r, { type: 'enable' })
    expect(p.runtime.state.get()).toMatchObject({ protection: 'passphrase+biometric' })
  })

  it('the hint field alone never lowers the protection; next start asks the passphrase first', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase+biometric')
    d.device.vault.stores.meta.set(`bioUnusable:${ns}`, true)
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', bioUnusable: true })
    const r = start(again)
    expect(r.get()).toMatchObject({ name: 'passphrase', hint: 'bioUnusable', report: null })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    expect(again.runtime.state.get()).toMatchObject({ protection: 'passphrase+biometric' })
    // reprotect refuses without a report of this session
    expect((await again.port.identity.unlock.reprotect()).ok).toBe(false)
    void p
  })

  it('keystore ok, vault does not open (interrupted rewrap): passphrase without rewriting, then repair the keystore', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase+biometric')
    d.device.keystore.set(ns, enc.encode('an old random secret'))
    const vault = JSON.stringify(d.device.vault.stores.vaults.get(ns))
    let r = start(p)
    await drive(r)
    expect(r.get()).toMatchObject({ name: 'passphrase', report: 'mismatch' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get().name).toBe('repairKeystore')
    expect(JSON.stringify(d.device.vault.stores.vaults.get(ns))).toBe(vault)
    await drive(r, { type: 'skip' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    await p.runtime.lock('user')
    r = start(p)
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    // the hint from last time asks the passphrase first; biometric retrieve did not run in this session
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    d.device.vault.stores.meta.delete(`bioUnusable:${ns}`)
    await p.runtime.lock('user')
    r = start(p)
    await drive(r)
    expect(r.get()).toMatchObject({ name: 'passphrase', report: 'mismatch' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' }, { type: 'enable' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    await p.runtime.lock('user')
    r = start(p)
    await drive(r)
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' }) // biometrics work again
  })

  it('biometric-only: cancel offers retry; invalidated means lost (recovery or delete)', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'biometric-only')
    d.device.faults.biometric = 'cancel'
    let r = start(p)
    await drive(r)
    expect(r.get().name).toBe('biometricRetry')
    d.device.faults.biometric = 'ok'
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    await p.runtime.lock('user')
    d.device.invalidated.add(ns)
    r = start(p)
    await drive(r)
    expect(r.get().name).toBe('biometricLost')
    await drive(r, { type: 'delete' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'delete' })
    // keystore entry gone at boot: deciding goes straight to biometricLost
    d.device.keystore.delete(ns)
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', biometricLost: true })
    r = start(again)
    expect(r.get().name).toBe('biometricLost')
    await drive(r, { type: 'recover' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'recovery' })
  })

  it('unsupported vault format: recovery or delete only', async () => {
    const d = testDevice()
    const { ns } = await createdIdentity(d, 'passphrase')
    d.device.vault.stores.vaults.set(ns, { type: 'wot.identity.seed', v: 1 })
    const p = await d.restart()
    expect(p.runtime.state.get()).toMatchObject({ status: 'locked', unsupported: true })
    const r = start(p)
    expect(r.get().name).toBe('unsupported')
    await drive(r, { type: 'delete' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'delete' })
  })

  it('other writer: lock held elsewhere, retry', async () => {
    const d = testDevice()
    const { process: p } = await createdIdentity(d, 'passphrase')
    const r = start(p, 'unlock', { 'unl.holder': 'in-flight' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get().name).toBe('otherWriter')
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('offerBiometric')
  })

  it('delete-dereg mode: unlock only to deregister, then back to the delete flow', async () => {
    const d = testDevice()
    const { process: p } = await createdIdentity(d, 'passphrase')
    const r = start(p, 'delete-dereg')
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'delete-resume' })
  })

  it('resume after an interrupted setup: unlock by the head, then onb.init and onb.activate with the sealed inputs', async () => {
    const d = testDevice()
    const p0 = d.current()
    await p0.runtime.boot()
    const id = p0.port.identity
    const r0 = await id.setup.reserve('setup', 'passphrase')
    if (!r0.ok) throw new Error('reserve')
    await id.setup.writeVault(r0.value.ns, {
      mnemonic: s(PHRASE12.split(' ')) as never,
      protection: { mode: 'passphrase', passphrase: s(PASSPHRASE) },
      profile: { name: 'Resumed Name' },
      termsVersion: '2026-10-draft',
    })
    // process loss after the vault transaction (marker setup/holder)
    const p = await d.restart()
    expect(p.runtime.state.get()).toMatchObject({ status: 'resuming', step: 'setup', protection: 'passphrase' })
    const r = start(p, 'resume-setup', { 'onb.init': 'storage', 'onb.activate': 'storage' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'resumeInit', error: true })
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'resumeActivate', error: true })
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked' })
    expect(d.holders.get(r0.value.ns)?.name).toBe('Resumed Name')
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
  })

  it('repairProtection error and retry', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase+biometric')
    d.device.invalidated.add(ns)
    const r = start(p, 'unlock', { 'unl.reprotect': 'storage' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) })
    await drive(r, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'repairProtection', error: true })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('offerBiometric')
  })

})
