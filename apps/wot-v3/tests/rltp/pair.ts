// Two real holders (A, B) on a memory carrier with encrypted fake IndexedDB, for the custody tests
// (Delivery 0.83 RLTP-DEL-6120 to 6135, lib 0.6.0). A can be shut down and reopened, with a fresh
// host for a process end. `store` reads A's holder state read-only (codec 3).
import { IDBFactory } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { memoryCarrier, type Transport } from '../../src/adapters/rltp/transport'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { appDbName, holderDbName } from '../../src/adapters/rltp/session'
import { idbAppDb } from '../../src/adapters/rltp/app-db'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import type { HolderHandle } from '../../src/adapters/identity/host'

export const T0 = Date.parse('2026-10-20T10:00:00Z')
export const DAY = 86_400_000

export interface CodecState {
  outbox: Record<string, { type: string; history: { status: string; reason?: string }[] }>
  effects: Record<string, { ack?: { digest: string; sent?: boolean; sentBy?: string; held?: unknown; answerDue?: unknown } }>
}

export async function pair(wrap: (t: Transport) => Transport = (t) => t, wrapB: (t: Transport) => Transport = (t) => t) {
  const carrier = memoryCarrier(), clock = virtualClock(T0, 'UTC')
  const idb = new IDBFactory()
  const keysA = { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) }
  const keysB = { rootIkm: new Uint8Array(64).fill(51), dek: new Uint8Array(32).fill(52) }
  const life = new Set<(s: 'active' | 'background') => void>()
  let seed = 800
  const make = (transport: Transport) => rltpHolderHost({
    idb, clock, entropy: fakeEntropy(seed++), transport,
    writer: { acquire: async () => () => {} },
    publish: () => {}, emit: () => {}, onCurrent: () => {},
    lifecycle: { onState(cb) { life.add(cb); return () => { life.delete(cb) } } },
  })
  let A = make(wrap(carrier.endpoint('A')))
  const B = make(wrapB(carrier.endpoint('B')))
  const a = await A.open('A', keysA), b = await B.open('B', keysB)
  if (a.kind !== 'ok' || b.kind !== 'ok') throw Error('open')
  let ah: HolderHandle = a.holder
  A.activate?.(ah); B.activate?.(b.holder)
  const seal = await createSealer(keysA.dek)
  const db = idbAppDb({ idb, name: appDbName('A'), sealer: seal, seal: { sealed: false } })
  const store = idbHolderStore({ idb, name: holderDbName('A'), sealer: seal, seal: { sealed: false }, uuid: () => crypto.randomUUID() })
  /** until rest: nothing in flight at the carrier, no session work, no holder call, and both published
   *  revisions unchanged over two rounds; a pair that never rests fails loudly, never by a count */
  const SETTLE_MAX = 200
  const settle = async () => {
    let last = '', calm = 0
    for (let i = 0; i < SETTLE_MAX; i++) {
      await carrier.settled(); await A.current()?.idle(); await B.current()?.idle()
      await new Promise((r) => setTimeout(r, 0))
      const now = JSON.stringify([A.current()?.models()?.revision ?? null, B.current()?.models()?.revision ?? null])
      calm = now === last ? calm + 1 : 0
      last = now
      if (calm >= 2) return
    }
    throw Error(`pair.settle: no rest after ${SETTLE_MAX} rounds, revisions still moving (last ${last})`)
  }
  await settle()
  const shutdownA = async () => {
    A.deactivate?.()
    await A.quiesce(ah); await A.seal(ah); await A.close(ah)
  }
  const p = {
    carrier, clock, db, settle, shutdownA,
    A: () => A.current()!, B: () => B.current()!,
    foreground: () => { for (const cb of life) cb('active') },
    /** A's holder state, read-only */
    state: async () => (await store.read()).state as unknown as CodecState,
    /** every app-db kv key of A: the adapter keeps no outbound store of its own */
    kvKeys: async () => [...(await db.readAll()).kv.keys()],
    /** a lock (or, fresh, a process end) and the next opening; onActive runs right before it is in use */
    async reopen(fresh = false, onActive?: () => void) {
      await shutdownA()
      if (fresh) A = make(wrap(carrier.endpoint('A')))
      const r = await A.open('A', keysA)
      if (r.kind !== 'ok') throw Error('reopen')
      ah = r.holder
      onActive?.()
      A.activate?.(ah)
      await settle()
    },
    /** A scans B's card: A's bundle goes to B */
    async scan() {
      const r = await B.current()!.intent<{ qr: string }>('showCard', '', 'show', {}).done
      if (!r.ok) throw Error('show')
      return A.current()!.intent('confirmCard', '', 'scan', { card: decodeCardLink(r.value.qr), role: 'displayed' }).done
    },
    /** B scans A's card: B's bundle goes to A, A acknowledges it */
    async scanned() {
      const card = await A.current()!.intent<{ qr: string }>('showCard', '', 'show', {}).done
      if (!card.ok) throw Error('show')
      return B.current()!.intent('confirmCard', '', 'scan', { card: decodeCardLink(card.value.qr), role: 'displayed' }).done
    },
    async rounds(n = 10, step = 60_000) {
      for (let i = 0; i < n; i++) { clock.advance(step); p.foreground(); await settle() }
    },
    async close() {
      await shutdownA().catch(() => undefined)
      await B.quiesce(b.holder); await B.seal(b.holder); await B.close(b.holder)
      db.close(); store.close()
    },
  }
  return p
}

/** a transport wrapper counting what reaches the device, by digest */
export function counting(seen: { digest: string; type: string }[], filter: (o: { type: string }) => boolean = () => true) {
  return (t: Transport): Transport => ({ ...t, submit(out) { seen.push(...out.map((o) => ({ digest: o.digest, type: o.type }))); t.submit(out.filter(filter)) } })
}
export const isAck = (o: { type: string }) => o.type.includes('delivery-ack')
