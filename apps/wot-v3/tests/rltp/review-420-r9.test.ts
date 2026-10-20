// @vitest-environment node
// Regressions of Astra's ninth review of #420 (rltp/design/store-launch-v3/app-review-420-9-2026-10-20.md).
// Adversarial confirmation of #420 at 6bf89f44 (round 9).
// Copy this file to apps/wot-v3/tests/rltp/ and run pnpm exec vitest run tests/rltp/review-420-r9-probe.test.ts.
// Uses the real holder, real encrypted stores, and memory carrier; no app-port double.
import { expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { memoryCarrier, type Transport } from '../../src/adapters/rltp/transport'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { appDbName, holderDbName } from '../../src/adapters/rltp/session'
import { idbAppDb } from '../../src/adapters/rltp/app-db'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import { openDb, req } from '../../src/adapters/rltp/idb'
import type { HolderHandle } from '../../src/adapters/identity/host'

const T0 = Date.parse('2026-10-20T10:00:00Z')

async function pair(wrap: (t: Transport) => Transport = t => t, wrapB: (t: Transport) => Transport = t => t) {
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
  const B = make(wrapB(carrier.endpoint('B')))
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


it.each([false, true])('R9 probe: an offline held ACK must survive process loss; run reconcile=%s', async (runReconcile) => {
  let offlineAck: (() => void) | undefined
  const ackSubmissions: string[] = []
  const p = await pair(t => ({ ...t, submit(out) {
    for (const o of out) if (o.type.includes('delivery-ack')) {
      ackSubmissions.push(o.digest)
      offlineAck?.()
    }
    t.submit(out)
  } }))
  try {
    offlineAck = () => p.carrier.setOnline('A', false)
    const card = await p.A().intent<{qr: string}>('showCard', '', 'show', {}).done
    if (!card.ok) throw Error('show')
    expect((await p.B().intent('confirmCard', '', 'scan', {card: decodeCardLink(card.value.qr), role: 'displayed'}).done).ok).toBe(true)
    await p.settle()
    expect(ackSubmissions).toHaveLength(1)
    const digest = ackSubmissions[0]!
    expect(await p.out()).toContain(`out:${digest}`)
    const state = (await p.store.read()).state as {effects: Record<string, {ack?: {digest: string; sent: boolean}}> }
    expect(Object.values(state.effects).some(e => e.ack?.digest === digest && e.ack.sent)).toBe(true)
    if (runReconcile) {
      p.foreground()
      // the fix: a running reconcile keeps the ACK (it is outside the outbox view)
      await p.settle()
      expect(await p.out()).toContain(`out:${digest}`)
    }
    offlineAck = undefined
    await p.reopen(true)
    p.carrier.setOnline('A', true)
    p.foreground()
    for (let i = 0; i < 10; i++) { p.clock.advance(60_000); await p.settle() }
    expect.soft(ackSubmissions.filter(d => d === digest).length, 'restart must hand on the ACK again').toBeGreaterThan(1)
  } finally { await p.close() }
})

it('R9 control: saved document without any report survives a fresh host through resume', async () => {
  let noReport = true
  const p = await pair(t => ({...t, submit(out) { if (!noReport) t.submit(out) }}))
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(await p.out()).toHaveLength(1)
    expect(p.B().models()?.decisions).toHaveLength(0)
    noReport = false
    await p.reopen(true)
    for (let i=0; i<10; i++) { p.clock.advance(60_000); await p.settle() }
    expect(p.B().models()?.decisions).toHaveLength(1)
  } finally { await p.close() }
})

it('R9 control: a failed durable copy retries with timers alone in the same opening', async () => {
  const p = await pair()
  let failures = 0
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (!failures && this.transaction.db.name === appDbName('A') && this.name === 'kv' && String(args[1]).startsWith('out:')) {
      failures++; throw new DOMException('temporary', 'QuotaExceededError')
    }
    return put.apply(this, args)
  })
  try {
    expect((await p.scan()).ok).toBe(true)
    await p.settle()
    expect(failures).toBe(1)
    expect(p.B().models()?.decisions).toHaveLength(0)
    spy.mockRestore()
    for (let i=0; i<10; i++) { p.clock.advance(60_000); await p.settle() }
    expect(p.B().models()?.decisions).toHaveLength(1)
  } finally { spy.mockRestore(); await p.close() }
})
