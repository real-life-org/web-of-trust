// @vitest-environment node
// Regressions of Astra's eighth review of #420 (rltp/design/store-launch-v3/app-review-420-8-2026-10-20.md).
import { expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { memoryCarrier, type Transport } from '../../src/adapters/rltp/transport'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { webDatabases } from '../../src/platform/web/identity'
import { createRltpPort } from '../../src/adapters/rltp'
import { LOOPBACK_PHRASES, loopbackDevice } from '../../harness/loopback'
import { secret } from '../../src/port'
import { appDbName, holderDbName } from '../../src/adapters/rltp/session'
import { idbAppDb } from '../../src/adapters/rltp/app-db'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import { openDb, req } from '../../src/adapters/rltp/idb'
import type { HolderHandle } from '../../src/adapters/identity/host'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const DAY = 86_400_000

async function pair(wrap: (t: Transport) => Transport = t => t) {
  const carrier = memoryCarrier(), clock = virtualClock(T0, 'UTC')
  const idb = new IDBFactory()
  const keysA = { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) }
  const keysB = { rootIkm: new Uint8Array(64).fill(51), dek: new Uint8Array(32).fill(52) }
  const endpoint = wrap(carrier.endpoint('A'))
  const life = new Set<(s: 'active' | 'background') => void>()
  let seed = 800
  const make = (transport: Transport) => rltpHolderHost({
    idb, clock, entropy: fakeEntropy(seed++), transport,
    writer: { acquire: async () => () => {} },
    publish: () => {}, emit: () => {}, onCurrent: () => {},
    lifecycle: { onState(cb) { life.add(cb); return () => { life.delete(cb) } } },
  })
  let A = make(endpoint)
  const B = make(carrier.endpoint('B'))
  const a = await A.open('A', keysA), b = await B.open('B', keysB)
  if (a.kind !== 'ok' || b.kind !== 'ok') throw Error('open')
  let ah: HolderHandle = a.holder
  A.activate?.(ah); B.activate?.(b.holder)
  const seal = await createSealer(keysA.dek)
  const db = idbAppDb({ idb, name: appDbName('A'), sealer: seal, seal: { sealed: false } })
  const store = idbHolderStore({ idb, name: holderDbName('A'), sealer: seal, seal: { sealed: false }, uuid: () => crypto.randomUUID() })
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      await carrier.settled(); await A.current()?.idle(); await B.current()?.idle()
    }
  }
  await settle()
  const shutdownA = async () => {
    A.deactivate?.()
    await A.quiesce(ah); await A.seal(ah); await A.close(ah)
  }
  return {
    carrier, clock, db, store, settle, shutdownA,
    A: () => A.current()!, B: () => B.current()!,
    foreground: () => { for (const cb of life) cb('active') },
    out: async () => [...(await db.readAll()).kv.keys()].filter(k => k.startsWith('out:')),
    async rawOut() {
      const raw = await openDb(idb, appDbName('A'), ['kv', 'intents', 'log'])
      try {
        const os = raw.transaction('kv', 'readonly').objectStore('kv')
        const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())])
        return values.filter((_, i) => String(keys[i]).startsWith('out:'))
      } finally { raw.close() }
    },
    async reopen(fresh = false) {
      await shutdownA()
      if (fresh) A = make(wrap(carrier.endpoint('A')))
      const r = await A.open('A', keysA)
      if (r.kind !== 'ok') throw Error('reopen')
      ah = r.holder; A.activate?.(ah)
      await settle()
    },
    async scan() {
      const r = await B.current()!.intent<{qr: string}>('showCard', '', 'show', {}).done
      if (!r.ok) throw Error('show')
      return A.current()!.intent('confirmCard', '', 'scan', { card: decodeCardLink(r.value.qr), role: 'displayed' }).done
    },
    async close() {
      await shutdownA()
      await B.quiesce(b.holder); await B.seal(b.holder); await B.close(b.holder)
      db.close(); store.close()
    },
  }
}

it('R8-1: failed durable outbox write must not lose an already successful encounter after restart', async () => {
  const p = await pair()
  p.carrier.setOnline('A', false)
  let failures = 0
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (failures === 0 && this.transaction.db.name === 'wot-v3-app-A' && this.name === 'kv' && String(args[1]).startsWith('out:')) {
      failures++
      throw new DOMException('storage unavailable', 'QuotaExceededError')
    }
    return put.apply(this, args)
  })
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(failures).toBeGreaterThan(0)
    expect(await p.out()).toEqual([])
    // the fix hands nothing on without the stored copy: the library never heard awaiting-transport
    spy.mockRestore()
    await p.reopen(true)
    p.carrier.setOnline('A', true)
    p.foreground()
    await p.settle()
    for (let i = 0; i < 10; i++) { p.clock.advance(60_000); await p.settle() }
    expect(p.B().models()?.decisions).toHaveLength(1)
  } finally { spy.mockRestore(); await p.close() }
})

it('R8-2: the durable outbox must drop items ended by the library and never resubmit them', async () => {
  const submissions = new Map<string, number>()
  const p = await pair(t => ({ ...t, submit(out) {
    for (const o of out) submissions.set(o.digest, (submissions.get(o.digest) ?? 0) + 1)
    t.submit(out)
  } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect((await p.out()).length).toBeGreaterThan(0)
    for (const blob of await p.rawOut()) {
      expect(Object.keys(blob).sort()).toEqual(['ct', 'iv'])
      expect(blob.ct).toBeInstanceOf(Uint8Array)
      expect(blob.iv.length).toBe(12)
    }
    p.clock.advance(8 * DAY)
    p.foreground()
    await p.settle()
    const state = (await p.store.read()).state as { outbox: Record<string, { type: string; history: {status: string; reason?: string}[] }> }
    const ended = Object.entries(state.outbox).filter(([, o]) => o.history.at(-1)?.status === 'failed').map(([d]) => d)
    expect(ended.length).toBeGreaterThan(0)
    expect.soft((await p.out()).filter(k => ended.includes(k.slice(4))).length, 'terminal documents must leave the app outbox').toBe(0)
    const before = ended.map(d => submissions.get(d))
    await p.reopen()
    expect.soft(ended.map(d => submissions.get(d)), 'reopening must not resubmit failed documents').toEqual(before)
  } finally { await p.close() }
})

it('R8 control: duplicate submission after failed cleanup and a fresh host is receiver-idempotent; outbox is encrypted', async () => {
  const p = await pair()
  let failedDeletes = 0
  const del = IDBObjectStore.prototype.delete
  const spy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (this.transaction.db.name === appDbName('A') && this.name === 'kv' && String(key).startsWith('out:')) {
      failedDeletes++
      throw new DOMException('cleanup failed', 'AbortError')
    }
    return del.call(this, key)
  })
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(failedDeletes).toBeGreaterThan(0)
    expect((await p.out()).length).toBeGreaterThan(0)
    expect(p.B().models()?.decisions).toHaveLength(1)
    const before = p.B().models()?.decisions.map(d => d.id)
    spy.mockRestore()
    await p.reopen(true)
    await p.settle()
    expect(p.B().models()?.decisions.map(d => d.id)).toEqual(before)
    expect(await p.out()).toEqual([])
  } finally { spy.mockRestore(); await p.close() }
})

it('R7-2 control: one failed activation handoff recovers without another act', async () => {
  let fail = false, refusals = 0
  const p = await pair(t => ({ ...t, submit(out) {
    if (fail) { fail = false; refusals++; throw Error('temporarily unavailable') }
    t.submit(out)
  } }))
  try {
    p.carrier.setOnline('A', false)
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    fail = true
    await p.reopen()
    expect(refusals).toBe(1)
    expect(p.A()).not.toBeNull()
    p.carrier.setOnline('A', true)
    p.foreground()
    await p.settle()
    for (let i = 0; i < 10; i++) { p.clock.advance(60_000); p.foreground(); await p.settle() }
    expect(p.B().models()?.decisions).toHaveLength(1)
  } finally { await p.close() }
})

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
    const raw = await openDb(idb, appDbName(ns), ['kv', 'intents', 'log'])
    const keys = await req(raw.transaction('kv', 'readonly').objectStore('kv').getAllKeys())
    raw.close()
    expect(keys.some(k => String(k).startsWith('out:'))).toBe(true)
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
