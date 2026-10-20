// @vitest-environment node
// Regressions of Astra's seventh review of #420 (rltp/design/store-launch-v3/app-review-420-7-2026-10-20.md).
import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createRltpPort } from '../../src/adapters/rltp'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { secret } from '../../src/port'

const T0 = Date.parse('2026-10-20T10:00:00Z')

async function setup(A: ReturnType<typeof createRltpPort>) {
  await A.runtime.boot()
  const r = await A.runtime.setup.reserve('setup', 'passphrase')
  if (!r.ok) throw Error('reserve')
  expect((await A.runtime.setup.writeVault(r.value.ns, {
    mnemonic: secret(LOOPBACK_PHRASES[0].split(' ')) as never,
    protection: { mode: 'passphrase', passphrase: secret('harness passphrase') },
    profile: { name: 'A' }, termsVersion: A.runtime.termsConsent().current,
  })).ok).toBe(true)
  expect((await A.runtime.setup.initHolder(r.value.ns)).ok).toBe(true)
  expect((await A.runtime.setup.activate(r.value.ns)).ok).toBe(true)
}

it.each([false, true])('R7: offline committed submission survives a fresh host=%s', async (freshHost) => {
  const carrier = memoryCarrier(), clock = virtualClock(T0, 'UTC')
  const device = fakeDevice(), idb = new IDBFactory()
  let entropySeed = 700
  const build = () => createRltpPort({
    identity: fakeIdentityPlatform(device, { clock, entropy: fakeEntropy(entropySeed++) }),
    idb, transport: carrier.endpoint('A'), writer: { acquire: async () => () => {} },
  })
  let A = build()
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'B', words: LOOPBACK_PHRASES[1], seed: 710 })
  const settle = async () => {
    for (let i = 0; i < 8; i++) { await carrier.settled(); await A.session()?.idle(); await B.port.session()?.idle() }
  }
  try {
    await setup(A)
    carrier.setOnline('A', false)
    const card = await B.port.trust.showCard().done
    if (!card.ok) throw Error('show')
    expect((await A.trust.confirmCard(card.value.qr).done).ok).toBe(true)
    await settle()
    expect(A.stores.intents.get()).toEqual([])
    expect(B.port.stores.decisions.get()).toMatchObject({ status: 'ready', value: [] })
    await A.runtime.lock('user')
    // Discard every host/transport map while retaining the vault and both encrypted IDBs.
    if (freshHost) A = build()
    await A.runtime.boot()
    expect((await A.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    expect((await A.runtime.unlock.open()).ok).toBe(true)
    carrier.setOnline('A', true)
    await settle()
    for (let i = 0; i < 10; i++) { clock.advance(60_000); await settle() }
    expect(B.port.stores.decisions.get()).toMatchObject({ status: 'ready', value: [{ kind: 'encounter-confirm' }] })
  } finally { await A.runtime.lock('user'); await B.port.runtime.lock('user') }
})

it('R7: a submit failure during handOn must not strand the activated session', async () => {
  const carrier = memoryCarrier(), clock = virtualClock(T0, 'UTC')
  const device = fakeDevice(), idb = new IDBFactory(), endpoint = carrier.endpoint('A')
  let fail = false
  const A = createRltpPort({
    identity: fakeIdentityPlatform(device, { clock, entropy: fakeEntropy(720) }),
    idb, writer: { acquire: async () => () => {} },
    transport: { ...endpoint, submit(out) { if (fail) { fail = false; throw Error('transport unavailable') }; endpoint.submit(out) } },
  })
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'B', words: LOOPBACK_PHRASES[1], seed: 721 })
  const settle = async () => { for (let i = 0; i < 8; i++) { await carrier.settled(); await A.session()?.idle(); await B.port.session()?.idle() } }
  try {
    await setup(A)
    carrier.setOnline('A', false)
    const card = await B.port.trust.showCard().done
    if (!card.ok) throw Error('show')
    expect((await A.trust.confirmCard(card.value.qr).done).ok).toBe(true)
    await settle()
    await A.runtime.lock('user')
    expect((await A.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    fail = true
    // the fix: a refused hand-on never fails the activation; the documents are held and go out later
    expect((await A.runtime.unlock.open()).ok).toBe(true)
    expect(A.runtime.state.get()).toMatchObject({ status: 'unlocked' })
    expect.soft(A.session(), 'unlocked identity must expose the active session').not.toBeNull()
    expect(await A.trust.showCard().done).toMatchObject({ ok: true })
  } finally { await A.runtime.lock('user'); await B.port.runtime.lock('user') }
})

it('R7: failed finishRestore marker removal is repaired by a fresh runtime', async () => {
  const carrier = memoryCarrier(), clock = virtualClock(T0, 'UTC'), device = fakeDevice(), idb = new IDBFactory()
  let seed = 730
  const build = () => createRltpPort({
    identity: fakeIdentityPlatform(device, { clock, entropy: fakeEntropy(seed++) }),
    idb, transport: carrier.endpoint('A'), writer: { acquire: async () => () => {} },
  })
  let A = build()
  try {
    await setup(A)
    const r = await A.runtime.setup.reserve('restore', 'passphrase')
    if (!r.ok) throw Error('reserve')
    expect((await A.runtime.setup.writeVault(r.value.ns, {
      mnemonic: secret(LOOPBACK_PHRASES[2].split(' ')) as never,
      protection: { mode: 'passphrase', passphrase: secret('restored password') },
      profile: { name: 'Restored' }, termsVersion: A.runtime.termsConsent().current,
    })).ok).toBe(true)
    expect((await A.runtime.setup.initHolder(r.value.ns)).ok).toBe(true)
    expect((await A.runtime.setup.switchTo(r.value.ns)).ok).toBe(true)
    expect((await A.runtime.setup.wipeOld()).ok).toBe(true)
    expect((await A.runtime.setup.verifyOld()).ok).toBe(true)
    device.vault.beforeCommit = writes => {
      if (writes.some(w => w.store === 'meta' && w.key === 'resume' && w.value === undefined)) throw Error('storage unavailable')
    }
    await expect(A.runtime.setup.finishRestore()).rejects.toThrow('storage unavailable')
    expect(A.runtime.state.get()).toMatchObject({ status: 'unlocked' })
    expect(A.session()?.ns).toBe(r.value.ns)
    expect((await A.trust.showCard().done).ok).toBe(true)
    device.vault.beforeCommit = null
    await A.runtime.lock('user')
    A = build()
    expect(await A.runtime.boot()).toMatchObject({ status: 'locked' })
    expect(await fakeIdentityPlatform(device, { clock, entropy: fakeEntropy(740) }).vault.resume()).toBeNull()
    expect((await A.runtime.unlock.passphrase(secret('restored password'))).ok).toBe(true)
    expect((await A.runtime.unlock.open()).ok).toBe(true)
    expect(A.session()?.ns).toBe(r.value.ns)
    expect((await A.trust.showCard().done).ok).toBe(true)
  } finally { device.vault.beforeCommit = null; await A.runtime.lock('user') }
})
