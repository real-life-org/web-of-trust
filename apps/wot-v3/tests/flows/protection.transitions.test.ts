// Change protection (architecture §4.2 "Schutz ändern"): every path of the table, the order of the
// effects, the refusal of a change that would remove the last access, failures and the crash rows.
import { describe, expect, it } from 'vitest'
import { planFor, protection, protectionStart, PROTECTION_TABLE } from '../../src/flows/protection'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { createdIdentity, drive, failing, PASSPHRASE, s, tableCoverage, testDevice, type Process, type TestDevice } from './world'

const cover = tableCoverage('protection', PROTECTION_TABLE)

async function unlocked(d: TestDevice, mode: 'passphrase' | 'passphrase+biometric' | 'biometric-only'): Promise<{ ns: string; p: Process }> {
  const { ns, process: p } = await createdIdentity(d, mode)
  const u = mode === 'biometric-only' ? await p.port.identity.unlock.biometric({ title: '', subtitle: '', cancel: '' }) : await p.port.identity.unlock.passphrase(s(PASSPHRASE))
  if (!u.ok) throw new Error('unlock')
  await p.port.identity.unlock.open()
  return { ns, p }
}

function start(p: Process, plan: Record<string, string> = {}) {
  const st = p.runtime.state.get()
  if (st.status !== 'unlocked') throw new Error(st.status)
  return cover.track(createFlowRunner(protection, protectionStart(st.protection, st.biometric), failing(p.exec.protection, plan), p.platform))
}

describe('change protection', () => {
  it('the table: plans per path; no path from or to a state without access', () => {
    expect(planFor('passphrase', 'passphrase+biometric')).toEqual(['prt.ks', 'prt.head'])
    expect(planFor('passphrase+biometric', 'passphrase')).toEqual(['prt.head', 'prt.ksRemove'])
    expect(planFor('biometric-only', 'passphrase+biometric')).toEqual(['prt.rewrap', 'prt.ks'])
    expect(planFor('biometric-only', 'passphrase')).toEqual(['prt.rewrap', 'prt.ks', 'prt.head', 'prt.ksRemove'])
    expect(planFor('passphrase', 'passphrase')).toBeNull()
  })

  it('passphrase → passphrase+biometric: proven passphrase, keystore, head', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d, 'passphrase')
    const r = start(p)
    await drive(r, { type: 'select', target: 'passphrase' })
    expect(r.get()).toMatchObject({ name: 'choose', error: 'last-access' })
    await drive(r, { type: 'select', target: 'passphrase+biometric' })
    expect(r.get().name).toBe('proveCurrent')
    expect(p.platform.screen.current()).toBe('sensitive')
    await drive(r, { type: 'value', value: s('wrong one!') }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'proveCurrent', error: 'wrong' })
    await drive(r, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get().name).toBe('done')
    expect(d.device.keystore.has(ns)).toBe(true)
    expect(p.runtime.state.get()).toMatchObject({ protection: 'passphrase+biometric' })
    expect(d.device.log.filter((l) => l.startsWith('ks.')).at(-1)).toBe(`ks.store:${ns}`)
  })

  it('passphrase+biometric → passphrase: head first, then the keystore entry goes', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d, 'passphrase+biometric')
    const r = start(p)
    await drive(r, { type: 'select', target: 'passphrase' }, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get().name).toBe('done')
    expect(d.device.keystore.has(ns)).toBe(false)
    expect(p.runtime.state.get()).toMatchObject({ protection: 'passphrase' })
  })

  it('biometric-only → passphrase+biometric: biometrics confirm, new passphrase, rewrap, keystore', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d, 'biometric-only')
    d.device.faults.biometric = 'cancel'
    const r = start(p)
    await drive(r, { type: 'select', target: 'passphrase+biometric' })
    expect(r.get()).toMatchObject({ name: 'provingBiometric', error: 'cancelled' })
    d.device.faults.biometric = 'ok'
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('newPassphrase')
    await drive(r, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('other') }, { type: 'submit' })
    expect(r.get().name).toBe('newPassphrase')
    await drive(r, { type: 'p2', value: s('new passphrase') }, { type: 'submit' })
    expect(r.get().name).toBe('done')
    expect(p.runtime.state.get()).toMatchObject({ protection: 'passphrase+biometric' })
    const again = await d.restart()
    expect((await again.port.identity.unlock.passphrase(s('new passphrase'))).ok).toBe(true)
    expect(d.device.keystore.has(ns)).toBe(true)
  })

  it('biometric-only → passphrase: biometrics off only after a passphrase exists', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d, 'biometric-only')
    const r = start(p)
    await drive(r, { type: 'select', target: 'passphrase' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'submit' })
    expect(r.get().name).toBe('done')
    expect(p.runtime.state.get()).toMatchObject({ protection: 'passphrase' })
    expect(d.device.keystore.has(ns)).toBe(false)
  })

  it('the runtime refuses a change that would remove the last access', async () => {
    const d = testDevice()
    const { p } = await unlocked(d, 'biometric-only')
    expect(await p.port.identity.protection.keystoreRemove()).toMatchObject({ ok: false, error: { code: 'last-access' } })
    expect(await p.port.identity.protection.setHead('passphrase')).toMatchObject({ ok: false, error: { code: 'last-access' } })
  })

  it('a failed keystore step ends in failed with the head unchanged; after a rewrap the head is already passphrase+biometric', async () => {
    const d = testDevice()
    let { p } = await unlocked(d, 'passphrase')
    let r = start(p)
    d.device.faults.biometric = 'cancel'
    await drive(r, { type: 'select', target: 'passphrase+biometric' }, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'failed', reason: 'keystore', partial: false })
    expect(p.runtime.state.get()).toMatchObject({ protection: 'passphrase' })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('choose')
    await drive(r, { type: 'close' })
    expect(r.get().name).toBe('exit')
    d.device.faults.biometric = 'ok'

    const d2 = testDevice()
    ;({ p } = await unlocked(d2, 'biometric-only'))
    r = start(p, { 'prt.ks': 'cancelled' })
    await drive(r, { type: 'select', target: 'passphrase+biometric' }, { type: 'p1', value: s('new passphrase') }, { type: 'p2', value: s('new passphrase') }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'failed', reason: 'keystore', partial: true })
    // crash row: head passphrase+biometric, keystore holds the old random secret → unlock falls back
    const again = await d2.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'passphrase+biometric' })
    expect(await again.port.identity.unlock.biometric({ title: '', subtitle: '', cancel: '' })).toEqual({ ok: false, code: 'vault-mismatch' })
  })

  it('a failed head step (stale passphrase) ends in failed', async () => {
    const d = testDevice()
    const { p } = await unlocked(d, 'passphrase+biometric')
    const r = start(p, { 'prt.head': 'passphrase-wrong' })
    await drive(r, { type: 'select', target: 'passphrase' }, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(r.get()).toMatchObject({ name: 'failed', reason: 'head' })
  })

  it('crash after the keystore entry, before the head: boot removes K at head passphrase', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d, 'passphrase')
    expect((await p.port.identity.protection.prove({ passphrase: s(PASSPHRASE) })).ok).toBe(true)
    expect((await p.port.identity.protection.keystoreStore({ title: '', subtitle: '', cancel: '' })).ok).toBe(true)
    expect(d.device.keystore.has(ns)).toBe(true)
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'passphrase' })
    expect(d.device.keystore.has(ns)).toBe(false)
  })
})
