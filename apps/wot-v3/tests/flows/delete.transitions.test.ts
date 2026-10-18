// Delete the identity (architecture §4.2 "Identität löschen"): phases S1 to S6, the full wipe
// inventory (namespace layers and global layers), local result and remote deregistration separate,
// survivors keep the marker, every crash phase resumes per the boot matrix.
import { describe, expect, it } from 'vitest'
import { deleteAfterUnlock, deleteMachine, deleteResume, deleteStart, DELETE_TABLE } from '../../src/flows/delete'
import { unlock, unlockStart } from '../../src/flows/unlock'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import type { LockInfo } from '../../src/port'
import { createdIdentity, drive, failing, PASSPHRASE, s, tableCoverage, testDevice, type Process, type TestDevice } from './world'

const cover = tableCoverage('delete', DELETE_TABLE)
const machine = deleteMachine('DELETE')

async function unlocked(d: TestDevice, mode: 'passphrase' | 'passphrase+biometric' = 'passphrase'): Promise<{ ns: string; p: Process }> {
  const { ns, process: p } = await createdIdentity(d, mode)
  await p.port.identity.unlock.passphrase(s(PASSPHRASE))
  await p.port.identity.unlock.open()
  return { ns, p }
}

function start(p: Process, plan: Record<string, string> = {}) {
  return cover.track(createFlowRunner(machine, deleteStart(), failing(p.exec.delete, plan), p.platform))
}

describe('delete identity', () => {
  it('explain, typed confirmation, S1 to S6, every layer gone, local and remote reported separately', async () => {
    const d = testDevice({ relationships: 3 })
    const { ns, p } = await unlocked(d, 'passphrase+biometric')
    // layers that must go: prefs (global and per ns), a notification, the session, the clipboard
    d.device.prefs.set('lang', 'de')
    d.device.prefs.set(`${ns}:bio-offer-dismissed`, '1')
    d.device.notifications.set(`${ns}:1`, { ns, state: 'delivered' })
    d.device.session.add('sessionStorage')
    await p.platform.clipboard.copy('1. awake', { sensitive: true })
    const r = start(p)
    await drive(r, { type: 'back' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'app' })
    const r2 = start(p)
    await drive(r2, { type: 'next' }, { type: 'back' }, { type: 'next' }, { type: 'typed', value: 'delet' }, { type: 'confirm' })
    expect(r2.get().name).toBe('confirm')
    await drive(r2, { type: 'typed', value: ' delete ' }, { type: 'confirm' })
    const st = r2.get()
    expect(st).toMatchObject({ name: 'done', report: { local: { ok: true }, remote: { done: 3, pending: 0, failed: 0 } } })
    expect(p.host.log).toEqual(expect.arrayContaining([`quiesce:${ns}`, 'deregister:run', `seal:${ns}`, `close:${ns}`]))
    expect(p.host.log.indexOf('deregister:run')).toBeLessThan(p.host.log.indexOf(`seal:${ns}`))
    expect(d.device.vault.stores.vaults.size).toBe(0)
    expect(d.device.vault.stores.meta.size).toBe(0)
    expect(d.device.keystore.size).toBe(0)
    expect(d.device.databases.size).toBe(0)
    expect(d.device.prefs.size).toBe(0)
    expect(d.device.notifications.size).toBe(0)
    expect(d.device.session.size).toBe(0)
    expect(d.device.clipboard.byApp).toBe(false)
    expect(p.runtime.state.get()).toEqual({ status: 'none', hint: null })
    await drive(r2, { type: 'continue' })
    expect(r2.get()).toMatchObject({ name: 'exit', to: 'welcome' })
  })

  it('a surviving layer keeps the marker and the error visible; retry; the next start continues', async () => {
    const d = testDevice()
    const { p } = await unlocked(d)
    d.device.faults.wipeSurvivor = 'wot-v3-holder-'
    const r = start(p)
    await drive(r, { type: 'next' }, { type: 'typed', value: 'delete' }, { type: 'confirm' })
    const st = r.get()
    expect(st.name).toBe('failed')
    expect(st.name === 'failed' && st.survivors.some((x) => x.startsWith('indexeddb:wot-v3-holder-'))).toBe(true)
    expect(d.device.vault.stores.meta.get('resume')).toMatchObject({ flow: 'wipe', step: 'sealed' })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('failed')
    // process loss now: the boot continues the wipe after the seal, never opens a holder
    const again = await d.restart()
    expect(again.runtime.state.get()).toMatchObject({ status: 'resuming', step: 'wipe', phase: 'after-seal' })
    d.device.faults.wipeSurvivor = null
    const resumed = cover.track(createFlowRunner(machine, deleteResume('after-seal', null), again.exec.delete, again.platform))
    await drive(resumed)
    expect(resumed.get()).toMatchObject({ name: 'done', report: { local: { ok: true } } })
    expect(again.host.log).not.toContain('open')
  })

  it('crash before the seal: offer to unlock for the deregistration, or delete without it', async () => {
    const d = testDevice({ relationships: 2 })
    const { p } = await unlocked(d)
    await p.port.identity.delete.quiesce()
    await p.port.identity.delete.deregister('run')
    // process loss in phase deregistering
    let again = await d.restart()
    const st = again.runtime.state.get()
    expect(st).toMatchObject({ status: 'resuming', step: 'wipe', phase: 'before-seal' })
    const lock = (st.status === 'resuming' && st.step === 'wipe' ? st.lock : null) as LockInfo
    expect(lock).toMatchObject({ protection: 'passphrase' })
    // without deregistration: remote all failed (counted when the holder is open, else unknown → 0)
    let r = cover.track(createFlowRunner(machine, deleteResume('before-seal', lock), again.exec.delete, again.platform))
    await drive(r, { type: 'deleteWithoutDeregistration' })
    expect(r.get()).toMatchObject({ name: 'done', report: { local: { ok: true } } })

    // the other way: unlock for the deregistration, then continue
    const d2 = testDevice({ relationships: 2 })
    const u = await unlocked(d2)
    await u.p.port.identity.delete.quiesce()
    again = await d2.restart()
    const st2 = again.runtime.state.get()
    const lock2 = (st2.status === 'resuming' && st2.step === 'wipe' ? st2.lock : null) as LockInfo
    r = cover.track(createFlowRunner(machine, deleteResume('before-seal', lock2), again.exec.delete, again.platform))
    await drive(r, { type: 'unlockToDeregister' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'unlock-for-deregistration' })
    const un = createFlowRunner(unlock, unlockStart(lock2, 'delete-dereg'), again.exec.unlock, again.platform)
    await drive(un, { type: 'value', value: s(PASSPHRASE) }, { type: 'submit' })
    expect(un.get()).toMatchObject({ name: 'exit', to: 'delete-resume' })
    const cont = cover.track(createFlowRunner(machine, deleteAfterUnlock(), again.exec.delete, again.platform))
    await drive(cont)
    expect(cont.get()).toMatchObject({ name: 'done', report: { remote: { done: 2, failed: 0 } } })
  })

  it('every phase is resumable: crash after each step, restart, finish', async () => {
    const steps = ['quiesce', 'deregister', 'seal', 'close', 'wipe'] as const
    for (let k = 1; k <= steps.length; k++) {
      const d = testDevice()
      const { p } = await unlocked(d)
      const del = p.port.identity.delete
      for (const step of steps.slice(0, k)) {
        if (step === 'deregister') await del.deregister('run')
        else await del[step]()
      }
      const again = await d.restart()
      const st = again.runtime.state.get()
      expect(st.status, `after ${steps[k - 1]}`).toBe('resuming')
      if (st.status !== 'resuming' || st.step !== 'wipe') throw new Error('not wipe')
      const r = createFlowRunner(machine, deleteResume(st.phase, st.lock), again.exec.delete, again.platform)
      await drive(r)
      if (r.get().name === 'resumeChoice') await drive(r, { type: 'deleteWithoutDeregistration' })
      expect(r.get(), `after ${steps[k - 1]}`).toMatchObject({ name: 'done', report: { local: { ok: true } } })
      expect(d.device.vault.stores.vaults.size + d.device.databases.size + d.device.keystore.size).toBe(0)
    }
  })

  it('a failing quiesce, seal or close stops in failed{phase}; retry repeats that phase', async () => {
    for (const [id, phase] of [
      ['del.quiesce', 'quiescing'],
      ['del.seal', 'sealing'],
      ['del.close', 'closing'],
    ] as const) {
      const d = testDevice()
      const { p } = await unlocked(d)
      const r = start(p, { [id]: 'storage' })
      await drive(r, { type: 'next' }, { type: 'typed', value: 'DELETE' }, { type: 'confirm' })
      expect(r.get(), id).toMatchObject({ name: 'failed', phase })
      await drive(r, { type: 'retry' })
      expect(r.get(), id).toMatchObject({ name: 'done', report: { local: { ok: true } } })
    }
  })

  it('del.done failing itself (exception) is no success', async () => {
    const d = testDevice()
    const { p } = await unlocked(d)
    const r = start(p, { 'del.done': 'bug' })
    await drive(r, { type: 'next' }, { type: 'typed', value: 'DELETE' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'failed', phase: 'verifying', survivors: ['verification did not complete'] })
  })

  it('verification is the judge: a wipe that did not run ends in failed, retry finishes', async () => {
    const d = testDevice()
    const { p } = await unlocked(d)
    const r = start(p, { 'del.wipe': 'storage' })
    await drive(r, { type: 'next' }, { type: 'typed', value: 'DELETE' }, { type: 'confirm' })
    expect(r.get().name).toBe('failed')
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'done', report: { local: { ok: true } } })
  })
})
