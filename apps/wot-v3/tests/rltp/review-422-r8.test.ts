// @vitest-environment node
// Review 422 round 8 (gpt-6.1-sol), the invalid journal and the backoff (CONTACT-ORDER.md): a failed
// drop aborts the opening and the next one drops; an opening a lock overtook records no diagnostic
// (R8-1); a finished record resets the backoff and its planned recovery (R8-2); one open record
// beside a running finish is valid.
import { afterEach, expect, it, vi } from 'vitest'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
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
const capture = vi.hoisted(() => ({ holders: [] as HolderLike[], failPause: false, refusePause: false, dbs: [] as AppDbModule.AppDb[], writeHook: null as null | WriteHook, afterWriteHook: null as null | WriteHook, pauseCalls: 0, pauseBroken: false }))
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
          capture.pauseCalls++
          if (capture.pauseBroken) throw new Error('injected storage failure, every pause')
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
        write: async (writes: readonly AppWrite[]) => {
          if (capture.writeHook) await capture.writeHook(writes)
          await db.write(writes)
          await capture.afterWriteHook?.(writes)
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
  capture.afterWriteHook = null
  capture.pauseCalls = 0
  capture.pauseBroken = false
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
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
}
async function invalid(w: Awaited<ReturnType<typeof world>>) {
  const common = { target: `c:${w.bId}`, policy: 'replay', state: 'journaled', input: { contactId: w.bId, marker: 'private-input' }, when: w.clock.now(), createdAt: w.clock.now(), attempts: 0 }
  await capture.dbs.at(-1)!.write(['block', 'unblock'].map(command => ({ store: 'intents', key: `invalid-${command}`, value: { ...common, command, actId: `invalid-${command}` } })))
}
const deletes = (ws: readonly AppWrite[]) => ws.some(x => x.store === 'intents' && x.value === null)
async function reopen(w: Awaited<ReturnType<typeof world>>) {
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  return w.B.port.runtime.unlock.open()
}
it('R8: invalid drop failure aborts opening, preserves records, no parts run; next opening retries', async () => {
  const w = await world()
  await invalid(w)
  await w.B.port.runtime.lock('user')
  capture.writeHook = ws => { if (deletes(ws)) throw Error('drop refused') }
  await expect(reopen(w)).rejects.toThrow('drop refused')
  expect(w.B.port.session()).toBeNull()
  expect(w.B.port.diagnostics.list()).toEqual([])
  capture.writeHook = null
  expect(await w.B.port.runtime.unlock.open()).toMatchObject({ ok: true })
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
  const snap = await capture.dbs.at(-1)!.readAll()
  expect([...snap.intents.keys()].filter(x => x.startsWith('invalid-'))).toEqual([])
  const holder = capture.holders.at(-1)! as unknown as { replay(id: string, when: number): Promise<{ ok: boolean }> }
  for (const id of ['invalid-block:block', 'invalid-block:pause', 'invalid-unblock:unblock', 'invalid-unblock:resume']) {
    expect(await holder.replay(id, w.clock.now())).toMatchObject({ ok: false })
  }
  const entries = w.B.port.diagnostics.list()
  expect(entries).toHaveLength(1)
  expect(Object.keys(entries[0]!).sort()).toEqual(['at', 'code', 'id', 'ref'])
  expect(JSON.stringify(entries)).not.toContain(w.bId)
  expect(JSON.stringify(entries)).not.toContain('private-input')
  await w.B.port.runtime.lock('user')
  expect(w.B.port.diagnostics.list()).toEqual([])
})
it('R8: an opening overtaken by lock must not repopulate diagnostics', async () => {
  const w = await world()
  await invalid(w)
  await w.B.port.runtime.lock('user')
  const entered = deferred(), release = deferred()
  capture.afterWriteHook = async ws => {
    if (!deletes(ws)) return
    capture.afterWriteHook = null
    entered.resolve()
    await release.promise
  }
  const opening = reopen(w)
  await entered.promise
  const locking = w.B.port.runtime.lock('user')
  expect(w.B.port.diagnostics.list()).toEqual([])
  release.resolve()
  await opening
  await locking
  expect(w.B.port.session()).toBeNull()
  expect(w.B.port.diagnostics.list()).toEqual([])
})
it('R8: backoff resets to 2 seconds after successful completion despite an older pending timer', async () => {
  const w = await world()
  const attempts: number[] = [], start = w.clock.now()
  capture.writeHook = ws => {
    if (ws.some(x => x.store === 'intents' && (x.value as { state?: string })?.state === 'done' && (x.value as { command?: string })?.command === 'block')) {
      attempts.push(w.clock.now() - start)
      throw Error('finish refused')
    }
  }
  const first = w.block()
  expect(await first.done).toMatchObject({ ok: false })
  w.clock.advance(2000); await w.settle()
  w.clock.advance(10000); await w.settle()
  expect([...new Set(attempts)]).toEqual([0, 2000, 12000])
  capture.writeHook = null
  expect(await w.B.port.session()!.retryIntent(first.actId).done).toMatchObject({ ok: true })
  expect(w.B.port.stores.intents.get()).toEqual([])
  capture.failPause = true
  expect(await w.unblock().done).toMatchObject({ ok: false })
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: true } })
  let elapsed = 0
  while (elapsed < 62_000) {
    w.clock.advance(2000); elapsed += 2000
    await w.settle()
    if (!value(w.B.port.stores.contacts)[0]!.trust.paused) break
  }
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
  expect({ completionDelayMs: elapsed }).toEqual({ completionDelayMs: 2000 })
})

it('R8: one open record plus a running finish is valid, recovery behind it does not drop it', async () => {
  const w = await world()
  const entered = deferred(), release = deferred()
  capture.afterWriteHook = async ws => {
    if (!ws.some(x => x.store === 'intents' && (x.value as { state?: string })?.state === 'journaled')) return
    capture.afterWriteHook = null
    entered.resolve()
    await release.promise
  }
  const block = w.block()
  await entered.promise
  const retry = w.B.port.session()!.retryIntent(block.actId)
  release.resolve()
  expect(await block.done).toMatchObject({ ok: true })
  await retry.done
  await w.settle()
  expect(w.B.port.diagnostics.list()).toEqual([])
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
})

// #428: every clock timer belongs to its opening (LIFECYCLE.md resource register, CONTACT-ORDER.md
// "Timers"): the end of the opening cancels it, and a timer of an ended opening that fires anyway
// does nothing.
function track(w: Awaited<ReturnType<typeof world>>) {
  const pending = new Set<symbol>(), fired: (() => void)[] = []
  const setTimer = w.clock.setTimer.bind(w.clock)
  w.clock.setTimer = (at, cb) => {
    const key = Symbol()
    pending.add(key)
    fired.push(cb)
    const cancel = setTimer(at, () => { pending.delete(key); cb() })
    return () => { pending.delete(key); cancel() }
  }
  return { pending, fired }
}
it.each([0, 1, 2])('#428: lock cancels every timer of the opening (failed attempts before the lock: %i)', async (failures) => {
  const w = await world()
  const t = track(w)
  if (failures > 0) {
    capture.pauseBroken = true
    expect(await w.block().done).toMatchObject({ ok: false })
    // the backoff grows: 2 s, then 10 s
    if (failures > 1) {
      w.clock.advance(2000)
      await w.settle()
    }
    expect(capture.pauseCalls).toBeGreaterThanOrEqual(failures)
    expect(t.pending.size).toBeGreaterThan(0)
  }
  await w.A.port.runtime.lock('user')
  await w.B.port.runtime.lock('user')
  expect(t.pending.size).toBe(0)
})
it('#428: a timer of an ended opening that fires anyway does nothing', async () => {
  const w = await world()
  const t = track(w)
  capture.failPause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  await w.B.port.runtime.lock('user')
  let writes = 0
  capture.writeHook = () => { writes++ }
  const pauses = capture.pauseCalls
  for (const cb of t.fired) cb()
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  expect({ writes, pauses: capture.pauseCalls - pauses }).toEqual({ writes: 0, pauses: 0 })
})
it('#428: a failed opening leaves no timer behind', async () => {
  const w = await world()
  await invalid(w)
  await w.B.port.runtime.lock('user')
  const t = track(w)
  capture.writeHook = ws => { if (deletes(ws)) throw Error('drop refused') }
  await expect(reopen(w)).rejects.toThrow('drop refused')
  expect(t.pending.size).toBe(0)
})

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
const collect = async () => {
  for (let n = 0; n < 8; n++) {
    await new Promise(r => setTimeout(r, 0))
    gc!()
  }
}
it.skipIf(!gc).each([false, true])('gc-only #428: a locked opening is collectible before its planned recovery is due (partial=%s)', async partial => {
  const w = await world()
  if (partial) {
    capture.failPause = true
    expect(await w.block().done).toMatchObject({ ok: false })
  }
  const weak = new WeakRef(capture.holders.at(-1)!)
  await w.A.port.runtime.lock('user')
  await w.B.port.runtime.lock('user')
  capture.holders.length = 0
  capture.dbs.length = 0
  await collect()
  expect(weak.deref(), 'the planned recovery of a locked opening must not keep its holder').toBeUndefined()
})
