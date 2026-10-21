// @vitest-environment node
// Review 422 round 7 (gpt-6.1-sol), the contact order (CONTACT-ORDER.md) on its regular path: a
// recovery held between the parts orders the gestures after it; a lasting refusal and failed writes
// keep the completion planned; the backoff grows with repeated finish failures (R7-1).
import { afterEach, expect, it, vi } from 'vitest'
import type { ContactId, Loadable, ReadStore } from '../../src/port'
import type { ProjectionInput } from '../../src/adapters/rltp/projection'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

type Res = { ok: boolean }
interface HolderLike {
  contacts(): Promise<ProjectionInput['contacts']>
  pauseTrust(...a: unknown[]): Promise<Res>
}
type WriteHook = (writes: readonly AppWrite[]) => Promise<void> | void
const capture = vi.hoisted(() => ({ holders: [] as HolderLike[], failPause: false, refusePause: false, dbs: [] as AppDbModule.AppDb[], writeHook: null as null | WriteHook, pauseHook: null as null | (() => Promise<void> | void), readHook: null as null | (() => void) }))
vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      capture.holders.push(h)
      return {
        ...h,
        pauseTrust: async (...a: unknown[]) => {
          await capture.pauseHook?.()
          if (capture.failPause) {
            capture.failPause = false
            throw new Error('injected storage failure between block and pause')
          }
          if (capture.refusePause) { capture.refusePause = false; return { ok: false, code: 'log-failure' } }
          return h.pauseTrust(...a)
        },
      }
    },
  }
})
vi.mock('../../src/adapters/rltp/app-db', async (original) => {
  const lib = await original<typeof AppDbModule>()
  return {
    ...lib,
    idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
      const db = lib.idbAppDb(opts)
      capture.dbs.push(db)
      return {
        ...db,
        readAll: () => { capture.readHook?.(); return db.readAll() },
        write: async (writes: readonly AppWrite[]) => {
          if (capture.writeHook) await capture.writeHook(writes)
          return db.write(writes)
        },
      }
    },
  }
})
afterEach(() => {
  capture.holders.length = 0
  capture.failPause = false
  capture.refusePause = false
  capture.dbs.length = 0
  capture.writeHook = null
  capture.pauseHook = null
  capture.readHook = null
})
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw Error(v.status)
  return v.value
}
async function world() {
  const carrier = memoryCarrier(), clock = virtualClock(Date.parse('2026-10-15T20:30:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], seed: 141 })
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], seed: 143 })
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  const block = () => B.port.trust.block({ kind: 'contact', contactId: bId })
  const unblock = () => B.port.trust.unblock({ kind: 'contact', contactId: bId })
  const messages = (id: ContactId = bId) => value(B.port.stores.conversation(`c:${id}`)).items.filter((x) => x.kind === 'message')
  return { A, B, clock, settle, aId, bId, block, unblock, messages }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

it('R7 regular: recovery held between parts serializes subsequent unblock and block', async () => {
  const w = await world()
  capture.failPause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  const entered = deferred(), release = deferred()
  capture.pauseHook = async () => { capture.pauseHook = null; entered.resolve(); await release.promise }
  w.clock.advance(2001)
  await entered.promise
  const un = w.unblock(), bl = w.block()
  release.resolve()
  expect(await un.journaled).toBe(true)
  expect(await bl.journaled).toBe(true)
  expect(await un.done).toMatchObject({ ok: true })
  expect(await bl.done).toMatchObject({ ok: true })
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get()).toEqual([])
})

it('R7 regular: persistent refusal survives exhausted backoff and failed markOpen writes', async () => {
  const w = await world()
  let calls = 0
  capture.pauseHook = () => { calls++; capture.refusePause = true }
  capture.writeHook = writes => {
    if (writes.some(x => x.store === 'intents' && (x.value as { state?: string })?.state === 'outcome-unknown')) throw Error('markOpen unavailable')
  }
  expect(await w.block().done).toMatchObject({ ok: false })
  for (let i = 0; i < 6; i++) { w.clock.advance(61_000); await w.settle() }
  expect(calls).toBeGreaterThanOrEqual(7)
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: false } })
  capture.pauseHook = null
  capture.writeHook = null
  w.clock.advance(61_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get()).toEqual([])
})

it('R7 regular: repeated finish failure keeps completion scheduled beyond three attempts', async () => {
  const w = await world()
  let finishes = 0
  capture.writeHook = writes => {
    if (writes.some(x => x.store === 'intents' && (x.value as { command?: string; state?: string })?.command === 'block' && (x.value as { state?: string }).state === 'done')) {
      finishes++; throw Error('finish unavailable')
    }
  }
  expect(await w.block().done).toMatchObject({ ok: false })
  for (let i = 0; i < 6; i++) { w.clock.advance(61_000); await w.settle() }
  expect(finishes).toBeGreaterThanOrEqual(7)
  capture.writeHook = null
  w.clock.advance(61_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get()).toEqual([])
})

it('R7 regular: failed recovery read schedules a further attempt without lifecycle activity', async () => {
  const w = await world()
  capture.failPause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  capture.readHook = () => { throw Error('recovery read unavailable') }
  w.clock.advance(2001)
  await new Promise(r => setTimeout(r, 20))
  capture.readHook = null
  w.clock.advance(61_000)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get()).toEqual([])
})

it('R7 regular: repeated finish failure must advance the documented 2s, 10s, 60s backoff', async () => {
  const w = await world()
  const start = w.clock.now(), attempts: number[] = []
  capture.writeHook = writes => {
    if (writes.some(x => x.store === 'intents' && (x.value as { command?: string; state?: string })?.command === 'block' && (x.value as { state?: string }).state === 'done')) {
      attempts.push(w.clock.now() - start)
      throw Error('finish unavailable')
    }
  }
  expect(await w.block().done).toMatchObject({ ok: false })
  w.clock.advance(2000)
  await w.settle()
  expect(attempts[0]).toBe(0)
  expect(attempts).toContain(2000)
  const afterFirstRetry = [...attempts]
  // The next attempt belongs at 12000 (10s after the second failure), not at 4000.
  w.clock.advance(2000)
  await w.settle()
  expect(attempts).toEqual(afterFirstRetry)
})
