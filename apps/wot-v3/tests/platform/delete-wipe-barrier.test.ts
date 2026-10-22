// @vitest-environment node
// Anton 21.10. (#434): the clipboard barrier of a full delete covers the whole delete.wipe step, also
// when wipeNamespace throws before the global layers are reached (#433, delete inventory 12).
import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { memoryCarrier } from '../../src/adapters/rltp/transport'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { createRltpPort } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES } from '../../harness/loopback'
import { secret } from '../../src/port'

it('a copy held by the app is cleared when wipeNamespace throws in delete.wipe', async () => {
  const carrier = memoryCarrier(), clock = virtualClock(Date.parse('2026-10-21T10:00:00Z'), 'UTC')
  const device = fakeDevice()
  const identity = fakeIdentityPlatform(device, { clock, entropy: fakeEntropy(910) })
  let failWipe = false
  const A = createRltpPort({
    identity: { ...identity, vault: { ...identity.vault, wipe: async (ns: string) => { if (failWipe) throw Error('vault wipe failed'); return identity.vault.wipe(ns) } } },
    idb: new IDBFactory(), transport: carrier.endpoint('A'), writer: { acquire: async () => () => {} },
  })
  try {
    await A.runtime.boot()
    const reserved = await A.runtime.setup.reserve('setup', 'passphrase')
    if (!reserved.ok) throw Error('reserve')
    const ns = reserved.value.ns
    expect((await A.runtime.setup.writeVault(ns, {
      mnemonic: secret(LOOPBACK_PHRASES[0].split(' ')) as never,
      protection: { mode: 'passphrase', passphrase: secret('harness passphrase') },
      profile: { name: 'A' }, termsVersion: A.runtime.termsConsent().current,
    })).ok).toBe(true)
    expect((await A.runtime.setup.initHolder(ns)).ok).toBe(true)
    expect((await A.runtime.setup.activate(ns)).ok).toBe(true)
    expect(await identity.clipboard.copy('words on the board', { sensitive: true })).toBe(true)
    expect(identity.clipboard.holdsAppCopy()).toBe(true)
    expect((await A.runtime.delete.quiesce()).ok).toBe(true)
    await A.runtime.delete.deregister('skip')
    expect((await A.runtime.delete.seal()).ok).toBe(true)
    expect((await A.runtime.delete.close()).ok).toBe(true)
    failWipe = true
    // the step's throw reaches the flow runner (fixed code 'bug'); the barrier must have run anyway
    await expect(A.runtime.delete.wipe()).rejects.toThrow('vault wipe failed')
    expect(identity.clipboard.holdsAppCopy(), 'the barrier ran although the step threw').toBe(false)
    expect(device.clipboard.text).toBe('')
  } finally { await A.runtime.lock('user') }
})
