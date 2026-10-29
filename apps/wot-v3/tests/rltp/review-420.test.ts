// @vitest-environment node
// Regressions of Astra's first review of #420 (rltp/design/store-launch-v3/app-review-420-1-2026-10-20.md):
// each case reproduced the finding before the fix and checks the contract now.
import { expect, it, vi } from 'vitest'
import { IDBFactory, IDBDatabase } from 'fake-indexeddb'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { virtualClock, fakeEntropy } from '../../src/platform/fake'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
import { verify, type VerifyState } from '../../src/flows/verify'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { bundleEvent, verifyExecutor } from '../../src/hooks/verify'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { webLockWriter } from '../../src/adapters/rltp/single-writer'
import { memoryCarrier as carrierOf, unconfiguredTransport } from '../../src/adapters/rltp/transport'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const DAY = 86_400_000

async function pair() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'UTC')
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'A', words: LOOPBACK_PHRASES[0], seed: 71 })
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'B', words: LOOPBACK_PHRASES[1], seed: 72 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  return { A, B, carrier, clock, settle }
}
const val = <T>(s: ReadStore<Loadable<T>>): T => {
  const r = s.get()
  if (r.status !== 'ready') throw Error('not ready')
  return r.value
}
const keys = () => ({ rootIkm: new Uint8Array(64).fill(1), dek: new Uint8Array(32).fill(2) })

it('R1-7: a repeated optical capture finds its contact again and lands at the open decision', async () => {
  const { A, B, carrier, settle } = await pair()
  carrier.setOnline('A', false)
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  const scan = await A.port.trust.confirmCard(shown.value.qr).done
  if (!scan.ok) throw Error('scan')
  const sent = await A.port.trust.sentCardFor(scan.value.contactId!)
  if (!sent.ok) throw Error('sent')
  const first = await B.port.trust.confirmCard(sent.value.qr).done
  if (!first.ok || first.value.kind !== 'captured') throw Error('capture')
  await settle()
  const result = await verifyExecutor(B.port, B.platform, { current: null })({ id: 'ver.capture', run: 1, raw: sent.value.qr })
  expect(result).toMatchObject({ ok: true, value: { outcome: { kind: 'already-captured', contactId: first.value.contactId }, follow: 'confirm', contactId: first.value.contactId } })
})

it('R1-6: the counter result after the only mutual bundle still ends in success', async () => {
  const { A, B, carrier, settle } = await pair()
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  carrier.setOnline('B', false)
  const d = val(B.port.stores.decisions)[0]
  if (!d || d.kind !== 'encounter-confirm') throw Error('decision')
  const state: VerifyState = { name: 'confirmationRequired', run: 1, card: null, mutual: [], contactId: d.contactId, decision: d.id, name2: 'A', busy: false }
  const runner = createFlowRunner(verify, state, verifyExecutor(B.port, B.platform, { current: null }))
  const push = () => {
    const e = bundleEvent(B.port)
    if (e) runner.send(e)
  }
  B.port.stores.contacts.subscribe(push)
  B.port.stores.decisions.subscribe(push)
  runner.send({ type: 'accept' })
  await runner.idle()
  await settle()
  expect(val(B.port.stores.contacts)[0]?.verification).toBe('mutual')
  expect(runner.get().name).toBe('success')
  runner.dispose()
})

it('R1-1: a failed first take-over does not lose the sent card of an act that reports success', async () => {
  const { A, B, carrier, settle } = await pair()
  carrier.setOnline('A', false)
  await settle()
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  const original = IDBDatabase.prototype.transaction
  let failed = false
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const [stores, mode] = args
    // the first take-over write of a sync (kv and log, no intent): the journal itself works
    if (!failed && this.name.startsWith('wot-v3-app-') && mode === 'readwrite' && Array.isArray(stores) && stores.includes('kv') && !stores.includes('intents')) {
      failed = true
      throw Error('injected app transaction failure')
    }
    return original.apply(this, args)
  })
  try {
    const scan = await A.port.trust.confirmCard(shown.value.qr).done
    expect(failed).toBe(true)
    if (!scan.ok) throw Error('scan')
    expect(await A.port.trust.sentCardFor(scan.value.contactId!)).toMatchObject({ ok: true })
  } finally {
    spy.mockRestore()
  }
})

it('R1-8: an own decision stays in the history after the journal clean-up', async () => {
  const { A, B, clock, settle } = await pair()
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const d = val(B.port.stores.decisions)[0]
  if (!d || d.kind !== 'encounter-confirm') throw Error('decision')
  await B.port.trust.decide(d.id, 'decline').done
  await settle()
  const history = () => val(B.port.stores.conversation(`c:${d.contactId}`)).items.find((i) => i.kind === 'decision')
  expect(history()).toMatchObject({ resolution: { choice: 'decline', basis: 'own-act', by: 'this-device' } })
  await B.port.runtime.lock('user')
  clock.advance(8 * DAY)
  await B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await B.port.runtime.unlock.open()
  await B.port.session()?.idle()
  expect(history()).toMatchObject({ resolution: { choice: 'decline', basis: 'own-act' } })
})

it('R1-4: a staged restore opens beside the old holder under the same lock; the lock goes with the last opening', async () => {
  let held = false
  let released = 0
  const locks = {
    request: async (_n: string, _o: unknown, cb: (l: unknown) => Promise<void>) => {
      if (held) return cb(null)
      held = true
      try {
        return await cb({ name: 'wot-v3-holder' })
      } finally {
        held = false
        released++
      }
    },
  } as unknown as LockManager
  const host = rltpHolderHost({ idb: new IDBFactory(), clock: virtualClock(T0, 'UTC'), entropy: fakeEntropy(91), transport: unconfiguredTransport(), writer: webLockWriter(locks), publish: () => {}, emit: () => {}, onCurrent: () => {} })
  const a = await host.open('old', keys())
  const b = await host.open('staged', keys())
  expect([a.kind, b.kind]).toEqual(['ok', 'ok'])
  if (a.kind !== 'ok' || b.kind !== 'ok') return
  await host.close(a.holder)
  await Promise.resolve()
  expect(released).toBe(0)
  await host.close(b.holder)
  await new Promise((r) => setTimeout(r, 0))
  expect(released).toBe(1)
})

it('R1-3: a failed opening stops its transport before the writer is released', async () => {
  const tr = unconfiguredTransport()
  const order: string[] = []
  vi.spyOn(tr, 'stop').mockImplementation(() => void order.push('stop'))
  const host = rltpHolderHost({ idb: new IDBFactory(), clock: virtualClock(T0, 'UTC'), entropy: fakeEntropy(92), transport: tr, writer: { acquire: async () => () => void order.push('release') }, publish: () => {}, emit: () => {}, onCurrent: () => {} })
  const original = IDBDatabase.prototype.transaction
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    if (this.name.startsWith('wot-v3-app-') && args[1] === 'readwrite') throw Error('injected first ingest failure')
    return original.apply(this, args)
  })
  const start = vi.spyOn(tr, 'start')
  try {
    await expect(host.open('broken', keys())).rejects.toThrow()
    // an opening that never became active never started the device's transport (R4-1); the writer goes
    expect(start).not.toHaveBeenCalled()
    expect(order).toEqual(['release'])
  } finally {
    spy.mockRestore()
  }
})

it('R1-2: a late commit after seal and close never recreates a deleted database', async () => {
  const idb = new IDBFactory()
  const seal = { sealed: false }
  const real = await createSealer(new Uint8Array(32).fill(3))
  let release!: () => void
  const barrier = new Promise<void>((r) => (release = r))
  let slow = false
  const store = idbHolderStore({ idb, name: 'wot-v3-holder-late', seal, uuid: () => crypto.randomUUID(), sealer: { open: real.open, seal: async (a, v) => (slow && (await barrier), real.seal(a, v)) } })
  const first = await store.commit(null, { v: 1 } as never)
  if (!first.ok) throw Error('commit')
  slow = true
  const late = store.commit(first.version, { v: 2 } as never)
  seal.sealed = true
  store.close()
  await new Promise<void>((resolve, reject) => {
    const q = idb.deleteDatabase('wot-v3-holder-late')
    q.onsuccess = () => resolve()
    q.onerror = () => reject(q.error)
  })
  const rejected = expect(late).rejects.toThrow('sealed')
  release()
  await rejected
  expect(await idb.databases()).toEqual([])
})

it('R1-5: closing the old opening leaves the staged opening its transport', async () => {
  const carrier = carrierOf()
  const device = carrier.endpoint('me')
  const other = carrier.endpoint('other')
  const stop = vi.spyOn(device, 'stop')
  const host = rltpHolderHost({ idb: new IDBFactory(), clock: virtualClock(T0, 'UTC'), entropy: fakeEntropy(93), transport: device, writer: { acquire: async () => () => {} }, publish: () => {}, emit: () => {}, onCurrent: () => {} })
  const a = await host.open('old', keys())
  const b = await host.open('staged', keys())
  if (a.kind !== 'ok' || b.kind !== 'ok') throw Error('open')
  await host.quiesce(a.holder)
  await host.seal(a.holder)
  await host.close(a.holder)
  // closing promotes nothing; the switch activates the staged opening (R3 R2-2)
  expect(host.current()).toBeNull()
  host.activate?.(b.holder)
  expect(host.current()?.ns).toBe('staged')
  expect(stop).not.toHaveBeenCalled()
  void other
  await host.close(b.holder)
  expect(stop).toHaveBeenCalledOnce()
})

// lib 0.6.1 (review 421 R10-1): a record left running by a process end is settled through holder.replay
// after the next resume; the library never committed it, so it is not run blind
it('R1-9, R1-10: an act cut off by a process end is settled from the library journal, never run blind', async () => {
  const { A, B, clock, settle } = await pair()
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const d = val(B.port.stores.decisions)[0]
  if (!d || d.kind !== 'encounter-confirm') throw Error('decision')
  B.faults.killAt = 'after-journal'
  await B.port.trust.decide(d.id, 'decline').done
  await B.port.runtime.lock('user')
  clock.advance(8 * DAY)
  await B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await B.port.runtime.unlock.open()
  await settle()
  expect(B.port.stores.intents.get()).toEqual([])
  void (null as unknown as ContactId)
})
