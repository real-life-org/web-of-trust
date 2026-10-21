// @vitest-environment node
// Regressions of Astra's eighth review of #420 (rltp/design/store-launch-v3/app-review-420-8-2026-10-20.md).
// R8-1, R8-2 and the controls moved to custody.test.ts (the app outbox is gone, lib 0.6.0 custody).
import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { memoryCarrier } from '../../src/adapters/rltp/transport'
import { appDbName } from '../../src/adapters/rltp/session'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { webDatabases } from '../../src/platform/web/identity'
import { createRltpPort } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES, loopbackDevice } from '../../harness/loopback'
import { secret } from '../../src/port'

const T0 = Date.parse('2026-10-20T10:00:00Z')

it.each([true])('R8-3: delete verification checks the real adapter database; shared inventory=%s', async (sharedInventory) => {
  const carrier = memoryCarrier(), clock = virtualClock(T0, 'UTC')
  const idb = new IDBFactory(), device = fakeDevice()
  const identity = fakeIdentityPlatform(device, { clock, entropy: fakeEntropy(900) })
  const A = createRltpPort({
    identity: sharedInventory ? { ...identity, databases: webDatabases(idb) } : identity,
    idb, transport: carrier.endpoint('A'), writer: { acquire: async () => () => {} },
  })
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'B', words: LOOPBACK_PHRASES[1], seed: 901 })
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
    carrier.setOnline('A', false)
    const card = await B.port.trust.showCard().done
    if (!card.ok) throw Error('show')
    expect((await A.trust.confirmCard(card.value.qr).done).ok).toBe(true)
    for (let i = 0; i < 12; i++) { await carrier.settled(); await A.session()?.idle() }
    // A's bundle is held by A's holder (custody, lib 0.6.0) when the delete starts
    expect((await A.runtime.delete.quiesce()).ok).toBe(true)
    await A.runtime.delete.deregister('skip')
    expect((await A.runtime.delete.seal()).ok).toBe(true)
    expect((await A.runtime.delete.close()).ok).toBe(true)
    expect((await A.runtime.delete.wipe()).ok).toBe(true)
    expect(await A.runtime.delete.verify()).toEqual({ ok: true })
    expect((await A.runtime.delete.finish()).local).toEqual({ ok: true })
    expect((await idb.databases()).map(d => d.name)).not.toContain(appDbName(ns))
  } finally { await A.runtime.lock('user'); await B.port.runtime.lock('user') }
})
