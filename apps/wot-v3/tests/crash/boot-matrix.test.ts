// Boot matrix (architecture §4.2, N7): every row is a resume case. A process loss is a runtime that
// stops after a step and a new runtime over the same device; the boot reconciles marker and actual
// holdings (keystore K, vault V, sealed init I, holder/app db H, active pointer A) per row.
import { describe, expect, it } from 'vitest'
import { createdIdentity, PASSPHRASE, PHRASE12, s, TEXTS, testDevice, type TestDevice } from '../flows/world'
import type { Mnemonic, Secret } from '../../src/port'

const WORDS = s(PHRASE12.split(' ')) as unknown as Secret<Mnemonic>
const WORDS15 = s('before slab path face tennis argue various cotton profit marble educate learn embrace student excess'.split(' ')) as unknown as Secret<Mnemonic>

const has = (d: TestDevice, ns: string) => ({
  K: d.device.keystore.has(ns),
  V: d.device.vault.stores.vaults.has(ns),
  I: d.device.vault.stores.meta.has(`init:${ns}`),
  H: [...d.device.databases].some((n) => n.includes(ns)),
  A: d.device.vault.stores.meta.get('active') === ns,
})
const marker = (d: TestDevice) => d.device.vault.stores.meta.get('resume') as { flow: string; step: string } | undefined

async function setupUntil(d: TestDevice, mode: 'passphrase' | 'passphrase+biometric' | 'biometric-only', until: 'marker' | 'ks' | 'vault' | 'ksAfter' | 'init') {
  const p = await d.restart()
  const id = p.port.identity
  const r = await id.setup.reserve('setup', mode)
  if (!r.ok) throw new Error('reserve')
  const ns = r.value.ns
  if (until === 'marker') return ns
  if (mode === 'biometric-only') await id.setup.keystoreFirst(ns, TEXTS.enrollPrompt)
  if (until === 'ks') return ns
  const protection = mode === 'biometric-only' ? ({ mode } as const) : ({ mode, passphrase: s(PASSPHRASE) } as const)
  await id.setup.writeVault(ns, { mnemonic: WORDS, protection, profile: { name: 'Jonas' }, termsVersion: '2026-10-draft' })
  if (until === 'vault') return ns
  if (mode === 'passphrase+biometric') await id.setup.keystoreAfter(ns, TEXTS.enrollPrompt)
  if (until === 'ksAfter') return ns
  await id.setup.initHolder(ns)
  return ns
}

async function restoreUntil(d: TestDevice, until: 'marker' | 'vault' | 'init' | 'switch' | 'wipeOld') {
  const p = await d.restart()
  const id = p.port.identity
  const r = await id.setup.reserve('restore', 'passphrase')
  if (!r.ok) throw new Error('reserve')
  const ns = r.value.ns
  if (until === 'marker') return ns
  await id.setup.writeVault(ns, { mnemonic: WORDS15, protection: { mode: 'passphrase', passphrase: s('new passphrase') }, profile: null, termsVersion: null })
  if (until === 'vault') return ns
  await id.setup.initHolder(ns)
  if (until === 'init') return ns
  await id.setup.switchTo(ns)
  if (until === 'switch') return ns
  await id.setup.wipeOld()
  return ns
}

describe('boot matrix', () => {
  it('storage blocked and crypto missing come before everything', async () => {
    const d = testDevice({ faults: { storage: 'blocked' } })
    expect((await d.restart()).runtime.state.get()).toEqual({ status: 'storage-blocked' })
    d.device.faults.storage = 'ok'
    d.device.faults.crypto = 'unavailable'
    expect((await d.restart()).runtime.state.get()).toEqual({ status: 'crypto-unavailable', missing: ['crypto.subtle'] })
  })

  it('setup/keystore, V missing: K removed, marker deleted, none with hint (crash after onb.marker and after onb.ks)', async () => {
    for (const until of ['marker', 'ks'] as const) {
      const d = testDevice()
      const ns = await setupUntil(d, 'biometric-only', until)
      expect(marker(d)).toMatchObject({ flow: 'setup', step: 'keystore' })
      expect(has(d, ns).K).toBe(until === 'ks')
      const p = await d.restart()
      expect(p.runtime.state.get()).toEqual({ status: 'none', hint: 'setup-interrupted' })
      expect(has(d, ns)).toEqual({ K: false, V: false, I: false, H: false, A: false })
      expect(marker(d)).toBeUndefined()
    }
  })

  it('setup/keystore with V present (one transaction makes it impossible) is treated as setup/holder', async () => {
    const d = testDevice()
    const ns = await setupUntil(d, 'biometric-only', 'vault')
    d.device.vault.stores.meta.set('resume', { flow: 'setup', step: 'keystore', ns, startedAt: 0 })
    const p = await d.restart()
    expect(p.runtime.state.get()).toMatchObject({ status: 'resuming', step: 'setup', protection: 'biometric-only' })
  })

  it('passphrase setup crashing before the vault leaves nothing (no marker yet)', async () => {
    const d = testDevice()
    await setupUntil(d, 'passphrase', 'marker')
    expect(marker(d)).toBeUndefined()
    expect((await d.restart()).runtime.state.get()).toEqual({ status: 'none', hint: null })
  })

  it('setup/holder with V and I: resuming{setup}, nothing deleted (crash after onb.vault and after onb.init)', async () => {
    for (const until of ['vault', 'init'] as const) {
      const d = testDevice()
      const ns = await setupUntil(d, 'passphrase', until)
      expect(marker(d)).toMatchObject({ flow: 'setup', step: 'holder' })
      const p = await d.restart()
      expect(p.runtime.state.get()).toMatchObject({ status: 'resuming', step: 'setup', protection: 'passphrase', bioUnusable: false })
      expect(has(d, ns)).toMatchObject({ V: true, I: true, A: false })
      // finishing applies setProfile once (same actIds from I)
      await p.port.identity.unlock.passphrase(s(PASSPHRASE))
      expect((await p.port.identity.setup.initHolder(null)).ok).toBe(true)
      expect((await p.port.identity.setup.activate(null)).ok).toBe(true)
      expect(p.host.log.filter((l) => l.startsWith('setProfile')).length).toBe(until === 'init' ? 0 : 1)
      expect(p.runtime.state.get()).toMatchObject({ status: 'unlocked' })
      expect(marker(d)).toBeUndefined()
      expect(has(d, ns)).toMatchObject({ I: false, A: true })
    }
  })

  it('setup/holder, head passphrase+biometric, K missing: biometrics marked unusable (crash between vault and keystore)', async () => {
    const d = testDevice()
    const ns = await setupUntil(d, 'passphrase+biometric', 'vault')
    const p = await d.restart()
    expect(p.runtime.state.get()).toMatchObject({ status: 'resuming', step: 'setup', protection: 'passphrase+biometric', bioUnusable: true })
    expect(d.device.vault.stores.meta.get(`bioUnusable:${ns}`)).toBe(true)
  })

  it('setup/holder, V missing (outside interference): K, I, H removed, none with hint', async () => {
    const d = testDevice()
    const ns = await setupUntil(d, 'biometric-only', 'init')
    d.device.vault.stores.vaults.delete(ns)
    const p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'none', hint: 'setup-interrupted' })
    expect(has(d, ns)).toEqual({ K: false, V: false, I: false, H: false, A: false })
  })

  it('after onb.activate: no marker, locked', async () => {
    const d = testDevice()
    const { ns } = await createdIdentity(d, 'passphrase')
    expect(marker(d)).toBeUndefined()
    expect(d.current().runtime.state.get()).toMatchObject({ status: 'locked' })
    expect(has(d, ns)).toMatchObject({ V: true, A: true, I: false })
  })

  it('restore/staging: the new namespace goes, the old identity stays active (crash after rec.marker, rec.vault, rec.init)', async () => {
    for (const until of ['marker', 'vault', 'init'] as const) {
      const d = testDevice()
      const { ns: old } = await createdIdentity(d, 'passphrase')
      const ns = await restoreUntil(d, until)
      expect(marker(d)).toMatchObject({ flow: 'restore', step: 'staging' })
      const p = await d.restart()
      expect(p.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'passphrase' })
      expect(has(d, ns)).toEqual({ K: false, V: false, I: false, H: false, A: false })
      expect(has(d, old)).toMatchObject({ V: true, A: true })
      expect(marker(d)).toBeUndefined()
    }
  })

  it('restore/staging without an old identity: none', async () => {
    const d = testDevice()
    await d.restart()
    await restoreUntil(d, 'vault')
    expect((await d.restart()).runtime.state.get()).toEqual({ status: 'none', hint: null })
  })

  it('restore/switched, A = ns_new: the old namespace is wiped at boot, locked for the new (crash after rec.switch, rec.wipeOld)', async () => {
    for (const until of ['switch', 'wipeOld'] as const) {
      const d = testDevice()
      const { ns: old } = await createdIdentity(d, 'passphrase')
      const ns = await restoreUntil(d, until)
      expect(marker(d)).toMatchObject({ flow: 'restore', step: 'switched' })
      const p = await d.restart()
      expect(p.runtime.state.get()).toMatchObject({ status: 'locked' })
      expect(has(d, old)).toEqual({ K: false, V: false, I: false, H: false, A: false })
      expect(has(d, ns)).toMatchObject({ V: true, A: true })
      expect(marker(d)).toBeUndefined()
      expect((await p.port.identity.unlock.passphrase(s('new passphrase'))).ok).toBe(true)
    }
  })

  it('restore/switched, A ≠ ns_new: storage-blocked, nothing deleted on suspicion', async () => {
    const d = testDevice()
    const { ns: old } = await createdIdentity(d, 'passphrase')
    const ns = await restoreUntil(d, 'switch')
    d.device.vault.stores.meta.set('active', old)
    const p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'storage-blocked' })
    expect(has(d, old).V && has(d, ns).V).toBe(true)
  })

  it('no marker, A = null: orphans of any namespace removed, none', async () => {
    const d = testDevice()
    const ns = await setupUntil(d, 'passphrase', 'init')
    d.device.vault.stores.meta.delete('resume')
    d.device.keystore.set('stray', new Uint8Array([1]))
    const p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'none', hint: null })
    expect(has(d, ns)).toEqual({ K: false, V: false, I: false, H: false, A: false })
  })

  it('no marker, A = ns: orphans of other namespaces removed; K removed at head passphrase; locked', async () => {
    const d = testDevice()
    const { ns } = await createdIdentity(d, 'passphrase')
    d.device.keystore.set(ns, new Uint8Array([9]))
    d.device.databases.add('wot-v3-app-norphan')
    d.device.vault.stores.meta.set('init:norphan2', { iv: '', ct: '' })
    const p = await d.restart()
    expect(p.runtime.state.get()).toMatchObject({ status: 'locked', protection: 'passphrase' })
    expect(d.device.keystore.has(ns)).toBe(false)
    expect(d.device.databases.has('wot-v3-app-norphan')).toBe(false)
    expect(d.device.vault.stores.meta.has('init:norphan2')).toBe(false)
    expect(has(d, ns)).toMatchObject({ V: true, A: true, H: true })
  })

  it('no marker, A = ns, biometric-only without K: locked{biometricLost}', async () => {
    const d = testDevice()
    const { ns } = await createdIdentity(d, 'biometric-only')
    d.device.keystore.delete(ns)
    expect((await d.restart()).runtime.state.get()).toMatchObject({ status: 'locked', biometricLost: true })
  })

  it('no marker, A = ns, unknown format: locked{unsupported}', async () => {
    const d = testDevice()
    const { ns } = await createdIdentity(d, 'passphrase')
    d.device.vault.stores.vaults.set(ns, { head: { format: 'wot-v3-vault', v: 2 } })
    expect((await d.restart()).runtime.state.get()).toMatchObject({ status: 'locked', unsupported: true })
  })

  it('no marker, A = ns, V missing: none{access-missing}, nothing deleted', async () => {
    const d = testDevice()
    const { ns } = await createdIdentity(d, 'passphrase')
    d.device.vault.stores.vaults.delete(ns)
    expect((await d.restart()).runtime.state.get()).toEqual({ status: 'none', hint: 'access-missing' })
    expect(has(d, ns)).toMatchObject({ A: true, H: true })
  })
})
