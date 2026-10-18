// Counter-probes of the review of #414 (bba0ba10): session generations and the phased shutdown of
// the identity runtime (architecture §2.1 rules 7 and 9, §4.2 delete S1 to S6, restore with
// wipeNamespace). Each probe failed on bba0ba10. The probes of the review at 924ca0b1 (publish
// contract, pending holder) failed on 924ca0b1, except the boot probe, which guards the staging wipe;
// the probe of the review at 81c90012 (holder ownership) failed on 81c90012; the probes of the review
// at 63507ca4 (a failed close keeps its opening) and of the coordinator failed on 63507ca4.
import { describe, expect, it } from 'vitest'
import { deleteMachine, deleteStart } from '../../src/flows/delete'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import type { Mnemonic, Secret } from '../../src/port'
import type { HolderHost } from '../../src/adapters/identity'
import { createdIdentity, drive, failing, PASSPHRASE, s, testDevice, type TestDevice } from '../flows/world'

const WORDS15 = s('before slab path face tennis argue various cotton profit marble educate learn embrace student excess'.split(' ')) as unknown as Secret<Mnemonic>

async function unlocked(d: TestDevice, mode: 'passphrase' | 'passphrase+biometric' = 'passphrase') {
  const { ns, process: p } = await createdIdentity(d, mode)
  expect((await p.port.identity.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
  expect((await p.port.identity.unlock.open()).ok).toBe(true)
  return { ns, p }
}

/** Holds the next vault read (the open of the unlock) until release(); later reads pass. */
function holdVaultReads(d: TestDevice) {
  const original = d.device.vault.read.bind(d.device.vault)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let held = false
  d.device.vault.read = async (fn) => {
    if (!held) {
      held = true
      await gate
    }
    return original(fn)
  }
  return { release: () => release(), restore: () => (d.device.vault.read = original) }
}

describe('review #414, finding 1: delete succeeds only with a verified clean wipe', () => {
  it('wipe and verification failing (storage errors): no success, marker kept, identity not none', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d)
    const r = createFlowRunner(deleteMachine('DELETE'), deleteStart(), failing(p.exec.delete, { 'del.wipe': 'storage', 'del.verify': 'storage' }), p.platform)
    await drive(r, { type: 'next' }, { type: 'typed', value: 'DELETE' }, { type: 'confirm' })
    expect(r.get().name).toBe('failed')
    expect(d.device.vault.stores.vaults.has(ns)).toBe(true)
    expect(d.device.vault.stores.meta.get('resume')).toMatchObject({ flow: 'wipe' })
    expect(p.runtime.state.get().status).not.toBe('none')
    // retry: now the wipe runs and is verified
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'done', report: { local: { ok: true } } })
  })

  it('finish without a verification of this run never reports success', async () => {
    const d = testDevice()
    const { p } = await unlocked(d)
    const del = p.port.identity.delete
    await del.quiesce()
    await del.deregister('run')
    await del.seal()
    await del.close()
    const report = await del.finish()
    expect(report.local.ok).toBe(false)
    expect(d.device.vault.stores.meta.get('resume')).toMatchObject({ flow: 'wipe' })
  })

  it('a failed seal or close stops the flow with retry instead of moving on', async () => {
    const d = testDevice()
    const { p } = await unlocked(d)
    const r = createFlowRunner(deleteMachine('DELETE'), deleteStart(), failing(p.exec.delete, { 'del.seal': 'storage' }), p.platform)
    await drive(r, { type: 'next' }, { type: 'typed', value: 'DELETE' }, { type: 'confirm' })
    expect(r.get()).toMatchObject({ name: 'failed', phase: 'sealing' })
    await drive(r, { type: 'retry' })
    expect(r.get()).toMatchObject({ name: 'done', report: { local: { ok: true } } })
  })
})

describe('review #414, finding 2: an unlock started before lock() never brings the session back', () => {
  it('passphrase: the vault opens after lock() completed; the result is dropped, open() refuses', async () => {
    const d = testDevice()
    const { process: p } = await createdIdentity(d, 'passphrase')
    const hold = holdVaultReads(d)
    const pending = p.port.identity.unlock.passphrase(s(PASSPHRASE))
    await p.port.identity.lock('user')
    hold.release()
    expect((await pending).ok).toBe(false)
    hold.restore()
    expect((await p.port.identity.unlock.open()).ok).toBe(false)
    expect(p.runtime.state.get().status).toBe('locked')
  })

  it('biometric: same', async () => {
    const d = testDevice()
    const { process: p } = await createdIdentity(d, 'passphrase+biometric')
    const hold = holdVaultReads(d)
    const pending = p.port.identity.unlock.biometric({ title: '', subtitle: '', cancel: '' })
    await new Promise((r) => setTimeout(r, 0)) // the prompt answered; the vault open is now held
    await p.port.identity.lock('user')
    hold.release()
    expect((await pending).ok).toBe(false)
    hold.restore()
    expect((await p.port.identity.unlock.open()).ok).toBe(false)
    expect(p.runtime.state.get().status).toBe('locked')
  })

  it('a holder that opens after lock() is closed again and nothing is published', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    expect((await p.port.identity.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    const open = p.port.identity.unlock.open()
    await p.port.identity.lock('user')
    expect((await open).ok).toBe(false)
    expect(p.host.isOpen(ns)).toBe(false)
    expect(p.runtime.state.get().status).toBe('locked')
  })

  it('refresh (boot) closes an open session first', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d)
    await p.port.identity.refresh()
    expect(p.host.isOpen(ns)).toBe(false)
    expect(p.runtime.state.get().status).toBe('locked')
    expect((await p.port.identity.unlock.open()).ok).toBe(false)
  })
})

describe('review #414, finding 3: restore from an open session closes the old holder, not the new', () => {
  it('old identity unlocked and open → restore → the new holder is the open one', async () => {
    const d = testDevice()
    const { ns: old, p } = await unlocked(d)
    const id = p.port.identity
    const r = await id.setup.reserve('restore', 'passphrase')
    if (!r.ok) throw new Error('reserve')
    const ns = r.value.ns
    expect((await id.setup.writeVault(ns, { mnemonic: WORDS15, protection: { mode: 'passphrase', passphrase: s('new passphrase') }, profile: null, termsVersion: null })).ok).toBe(true)
    // the old identity stays usable until the switch
    expect(p.host.isOpen(old)).toBe(true)
    expect((await id.setup.initHolder(ns)).ok).toBe(true)
    expect((await id.setup.switchTo(ns)).ok).toBe(true)
    expect(p.host.isOpen(old)).toBe(false)
    expect(p.host.isOpen(ns)).toBe(true)
    expect((await id.setup.wipeOld()).ok).toBe(true)
    expect((await id.setup.verifyOld()).ok).toBe(true)
    await id.setup.finishRestore()
    expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked', recovered: 'keys-only' })
    expect(p.host.current()).toBe(ns)
    expect(p.host.isOpen(ns)).toBe(true)
  })
})

describe('CodeRabbit #414: a biometric-only session has no proven passphrase', () => {
  it('after biometric-only onboarding, enableBiometric and reprotect refuse', async () => {
    const d = testDevice()
    const p = await d.restart()
    const id = p.port.identity
    const r = await id.setup.reserve('setup', 'biometric-only')
    if (!r.ok) throw new Error('reserve')
    await id.setup.keystoreFirst(r.value.ns, { title: '', subtitle: '', cancel: '' })
    await id.setup.writeVault(r.value.ns, { mnemonic: WORDS15, protection: { mode: 'biometric-only' }, profile: { name: 'A' }, termsVersion: null })
    await id.setup.initHolder(r.value.ns)
    await id.setup.activate(r.value.ns)
    expect((await id.unlock.enableBiometric({ title: '', subtitle: '', cancel: '' })).ok).toBe(false)
    expect(p.runtime.state.get()).toMatchObject({ protection: 'biometric-only' })
  })
})

describe('review #414 (924ca0b1), P1: the generation check holds until the state commit', () => {
  it('lock() completes while open() waits inside the publish: state stays locked, open() reports no success', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    expect((await p.port.identity.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    const hold = holdVaultReads(d)
    const open = p.port.identity.unlock.open()
    await new Promise((r) => setTimeout(r, 0)) // the holder is open; the publish waits on the vault head
    await p.port.identity.lock('user')
    expect(p.runtime.state.get().status).toBe('locked')
    hold.release()
    expect((await open).ok).toBe(false)
    hold.restore()
    expect(p.runtime.state.get().status).toBe('locked')
    expect(p.host.isOpen(ns)).toBe(false)
  })

  it('a lock that waits on the vault while an unlock completes does not publish locked over it', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    const hold = holdVaultReads(d)
    const lock = p.port.identity.lock('user') // holds at the vault read of lock
    await new Promise((r) => setTimeout(r, 0))
    hold.restore()
    expect((await p.port.identity.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    expect((await p.port.identity.unlock.open()).ok).toBe(true)
    hold.release()
    await lock
    expect(p.runtime.state.get().status).toBe('unlocked')
    expect(p.host.isOpen(ns)).toBe(true)
  })
})

describe('review #414 (924ca0b1), CodeRabbit: the pending holder belongs to the lock inventory', () => {
  async function stagedRestore() {
    const d = testDevice()
    const { ns: old, p } = await unlocked(d)
    const id = p.port.identity
    const r = await id.setup.reserve('restore', 'passphrase')
    if (!r.ok) throw new Error('reserve')
    const ns = r.value.ns
    expect((await id.setup.writeVault(ns, { mnemonic: WORDS15, protection: { mode: 'passphrase', passphrase: s('new passphrase') }, profile: null, termsVersion: null })).ok).toBe(true)
    expect((await id.setup.initHolder(ns)).ok).toBe(true)
    expect(p.host.isOpen(ns)).toBe(true)
    return { old, ns, p }
  }

  it('lock closes the staged holder of a restore, not only the session', async () => {
    const { old, ns, p } = await stagedRestore()
    await p.port.identity.lock('user')
    expect(p.host.isOpen(old)).toBe(false)
    expect(p.host.isOpen(ns)).toBe(false)
    expect((await p.port.identity.setup.switchTo(ns as never)).ok).toBe(false)
  })

  it('boot (refresh) closes the staged holder too', async () => {
    const { old, ns, p } = await stagedRestore()
    await p.port.identity.refresh()
    expect(p.host.isOpen(old)).toBe(false)
    expect(p.host.isOpen(ns)).toBe(false)
  })

  it('a new reserve closes the staged holder of the abandoned one', async () => {
    const { ns, p } = await stagedRestore()
    expect((await p.port.identity.setup.reserve('restore', 'passphrase')).ok).toBe(true)
    expect(p.host.isOpen(ns)).toBe(false)
  })
})

describe('review #414 (81c90012), CodeRabbit: a holder is closed only by the opening that owns it', () => {
  it('a stale holder open cannot close a newer session of the same namespace', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    const id = p.port.identity
    const original = p.host.open.bind(p.host)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    p.host.open = async (...args: Parameters<typeof original>) => {
      const r = await original(...args)
      await gate // the holder is open; its result reaches the first open() only after release
      return r
    }
    expect((await id.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    const first = id.unlock.open()
    await new Promise((r) => setTimeout(r, 0))
    await id.lock('user')
    p.host.open = original
    expect((await id.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    expect((await id.unlock.open()).ok).toBe(true)
    expect(p.runtime.state.get().status).toBe('unlocked')
    release()
    expect((await first).ok).toBe(false)
    expect(p.runtime.state.get().status).toBe('unlocked')
    expect(p.host.isOpen(ns)).toBe(true)
  })
})

/** The next call after arm() waits until release(); calls before and after pass. */
function armable() {
  let armed = false
  let hit = false
  let release: () => void = () => {}
  return {
    arm: () => void (armed = true),
    get hit() {
      return hit
    },
    async pass() {
      if (!armed) return
      armed = false
      hit = true
      await new Promise<void>((r) => (release = r))
    },
    release: () => release(),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A host whose close throws inside the host, before closing, while `failures` is above zero. */
function flakyClose(failures: { left: number; calls: number }) {
  return (h: HolderHost): HolderHost => ({
    ...h,
    async close(x) {
      failures.calls++
      if (failures.left > 0) {
        failures.left--
        throw new Error('host close failed')
      }
      return h.close(x)
    },
  })
}

describe('review #414 (924ca0b1), P1 as reproduced: the availability answer inside the publish is held', () => {
  it('lock() completes while unlock.open waits on biometric availability; the late answer publishes nothing', async () => {
    const gate = armable()
    const d = testDevice({ platform: (pl) => ({ ...pl, biometric: { ...pl.biometric, availability: async () => (await gate.pass(), pl.biometric.availability()) } }) })
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    expect((await p.port.identity.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    gate.arm()
    const open = p.port.identity.unlock.open()
    while (!gate.hit) await tick()
    await p.port.identity.lock('user')
    expect(p.runtime.state.get().status).toBe('locked')
    gate.release()
    expect((await open).ok).toBe(false)
    expect(p.runtime.state.get().status).toBe('locked')
    expect(p.host.isOpen(ns)).toBe(false)
  })
})

describe('review #414 (63507ca4), P1: a failed close keeps its opening for the retry', () => {
  it('delete close retries the same holder after a transient host close failure', async () => {
    const failures = { left: 0, calls: 0 }
    const keys: Uint8Array[] = []
    const d = testDevice({
      host: (h) => {
        const flaky = flakyClose(failures)(h)
        return { ...flaky, open: async (ns, k) => (keys.push(k.rootIkm, k.dek), h.open(ns, k)) }
      },
    })
    const { ns, p } = await unlocked(d)
    const sessionKeys = keys.slice(-2) // the open of this session (the setup process before the restart is gone)
    const del = p.port.identity.delete
    expect((await del.quiesce()).ok).toBe(true)
    await del.deregister('run')
    expect((await del.seal()).ok).toBe(true)
    failures.left = 1
    expect((await del.close()).ok).toBe(false)
    console.log('DBG', failures, p.host.log, p.runtime.inventory())
    expect(p.host.isOpen(ns)).toBe(true)
    expect(p.runtime.inventory()).toMatchObject([{ ns, state: 'closing' }])
    // the keys do not wait for the host: overwritten although the close failed
    expect(sessionKeys).toHaveLength(2)
    expect(sessionKeys.every((b) => b.length > 0 && b.every((x) => x === 0))).toBe(true)
    expect((await del.close()).ok).toBe(true)
    expect(failures.calls).toBe(2)
    expect(p.host.isOpen(ns)).toBe(false)
    expect(p.runtime.inventory()).toEqual([])
    expect((await del.wipe()).ok).toBe(true)
    expect((await del.verify()).ok).toBe(true)
    expect((await del.finish()).local.ok).toBe(true)
  })

  it('a delete never verifies clean while an opening is still registered', async () => {
    const failures = { left: 99, calls: 0 }
    const d = testDevice({ host: flakyClose(failures) })
    const { ns, p } = await unlocked(d)
    const del = p.port.identity.delete
    await del.quiesce()
    await del.deregister('run')
    await del.seal()
    expect((await del.close()).ok).toBe(false)
    await del.wipe()
    const v = await del.verify()
    expect(v).toMatchObject({ ok: false })
    expect(v.ok ? [] : v.survivors).toContain(`holder:${ns}`)
    expect((await del.finish()).local.ok).toBe(false)
  })

  it('lock with a failing host close: locked at once, the opening stays registered, the next lock closes it', async () => {
    const failures = { left: 1, calls: 0 }
    const d = testDevice({ host: flakyClose(failures) })
    const { ns, p } = await unlocked(d)
    const locking = p.port.identity.lock('user')
    expect(p.runtime.state.get().status).toBe('locked') // synchronous, before the first await
    await locking
    expect(p.runtime.state.get().status).toBe('locked')
    expect(p.host.isOpen(ns)).toBe(true)
    expect(p.runtime.inventory()).toMatchObject([{ ns, state: 'closing', owner: 'session' }])
    expect((await p.port.identity.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    expect((await p.port.identity.unlock.open()).ok).toBe(true) // a new opening; the old one is not reused
    await p.port.identity.lock('user')
    expect(p.host.isOpen(ns)).toBe(false)
    expect(p.runtime.inventory()).toEqual([])
  })

  it('the staged holder of a restore (pending) survives a failing close the same way', async () => {
    const failures = { left: 0, calls: 0 }
    const d = testDevice({ host: flakyClose(failures) })
    const { ns: old, p } = await unlocked(d)
    const id = p.port.identity
    const r = await id.setup.reserve('restore', 'passphrase')
    if (!r.ok) throw new Error('reserve')
    const ns = r.value.ns
    await id.setup.writeVault(ns, { mnemonic: WORDS15, protection: { mode: 'passphrase', passphrase: s('new passphrase') }, profile: null, termsVersion: null })
    expect((await id.setup.initHolder(ns)).ok).toBe(true)
    failures.left = 2
    await id.lock('user')
    expect(p.host.isOpen(old) || p.host.isOpen(ns)).toBe(true)
    expect(p.runtime.inventory().every((e) => e.state === 'closing')).toBe(true)
    await id.lock('user')
    expect(p.host.isOpen(old)).toBe(false)
    expect(p.host.isOpen(ns)).toBe(false)
    expect(p.runtime.inventory()).toEqual([])
  })
})

describe('lifecycle contract: coordinator', () => {
  it('a pending biometric prompt does not block lock(); the late proof is dropped', async () => {
    const gate = armable()
    const d = testDevice({ platform: (pl) => ({ ...pl, biometric: { ...pl.biometric, retrieve: async (ns, pr) => (await gate.pass(), pl.biometric.retrieve(ns, pr)) } }) })
    const { p } = await unlocked(d, 'passphrase+biometric')
    gate.arm()
    const prove = p.port.identity.protection.prove({ biometric: { title: '', subtitle: '', cancel: '' } })
    while (!gate.hit) await tick()
    const locking = p.port.identity.lock('user')
    expect(p.runtime.state.get().status).toBe('locked')
    await locking
    gate.release()
    expect(await prove).toMatchObject({ ok: false, error: { kind: 'locked' } })
    expect(p.runtime.state.get().status).toBe('locked')
  })

  it('a second unlock.open joins the first; a conflicting step is refused as in-flight', async () => {
    const d = testDevice()
    const { ns, process: p } = await createdIdentity(d, 'passphrase')
    const id = p.port.identity
    expect((await id.unlock.passphrase(s(PASSPHRASE))).ok).toBe(true)
    const a = id.unlock.open()
    const b = id.unlock.open()
    expect(await id.unlock.passphrase(s(PASSPHRASE))).toMatchObject({ ok: false, error: { kind: 'unavailable', reason: 'in-flight' } })
    expect(await a).toEqual(await b)
    expect(p.host.log.filter((l) => l === `open:${ns}`)).toHaveLength(1)
    expect(p.runtime.state.get().status).toBe('unlocked')
  })

  it('two locks: the second waits for the cleanup of the first', async () => {
    const d = testDevice()
    const { ns, p } = await unlocked(d)
    const first = p.port.identity.lock('user')
    await p.port.identity.lock('user')
    expect(p.host.isOpen(ns)).toBe(false)
    await first
    expect(p.runtime.state.get().status).toBe('locked')
  })
})
