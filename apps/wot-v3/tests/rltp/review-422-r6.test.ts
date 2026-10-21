// @vitest-environment node
// Review 422 round 6 (gpt-6.1-sol), several open records of one contact (CONTACT-ORDER.md "Invalid
// journal", Anton 21.10.): the app never shipped a journal without the contact order, so there is no
// order to reconstruct. Equal or rewound times (R6-1) and parts committed out of order (R6-2): the
// records are dropped at opening, nothing of them runs, a diagnostic entry without content remains.
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
const capture = vi.hoisted(() => ({ holders: [] as HolderLike[], failPause: false, refusePause: false, dbs: [] as AppDbModule.AppDb[], writeHook: null as null | WriteHook }))
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

type ActOpts = { when: number; actId: string }
interface PartHolder {
  block(c: string, o: ActOpts): Promise<{ ok: boolean }>
  unblock(c: string, o: ActOpts): Promise<{ ok: boolean }>
  pauseTrust(c: string, p: boolean, o: ActOpts): Promise<{ ok: boolean }>
  replay(actId: string, when: number): Promise<{ ok: boolean }>
}

async function expectDropped(w: { B: { port: { diagnostics: { list(): readonly { code: string; detail?: string }[] } } } }, ids: readonly string[]) {
  const keys = [...(await capture.dbs.at(-1)!.readAll()).intents.keys()]
  expect(keys.filter((k) => ids.includes(k))).toEqual([])
  expect(w.B.port.diagnostics.list().map((e) => ({ code: e.code, detail: e.detail }))).toEqual([{ code: 'contact-order-invalid-journal', detail: undefined }])
}

it.each(['equal', 'rewound'])('R6-1: %s timestamps, an invalid journal: dropped, nothing runs', async (mode) => {
  const w = await world()
  const db = capture.dbs.at(-1)!
  const t = w.clock.now()
  const common = { target: `c:${w.bId}`, policy: 'replay', state: 'journaled', input: { contactId: w.bId }, when: t, createdAt: t, attempts: 0 }
  const older = { ...common, actId: 'z-old-unblock', command: 'unblock', dedupe: `unblock|c:${w.bId}` }
  const newer = { ...common, actId: 'a-new-block', command: 'block', dedupe: `block|c:${w.bId}`, ...(mode === 'rewound' ? { createdAt: t - 1000, when: t + 1 } : {}) }
  // Explicit persisted acceptance order; dates may coincide or the wall clock may move back.
  await db.write([{ store: 'intents', key: older.actId, value: older }])
  await db.write([{ store: 'intents', key: newer.actId, value: newer }])
  await w.B.port.runtime.lock('user')
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await w.B.port.runtime.unlock.open()
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
  await expectDropped(w, [older.actId, newer.actId])
})

it('R6-2: parts committed out of order, an invalid journal: dropped, the library state stays', async () => {
  const w = await world()
  const db = capture.dbs.at(-1)!
  const t = w.clock.now()
  const common = { target: `c:${w.bId}`, policy: 'replay', state: 'outcome-unknown', input: { contactId: w.bId }, when: t, attempts: 1 }
  const older = { ...common, actId: 'z-old-unblock', command: 'unblock', dedupe: `unblock|c:${w.bId}`, createdAt: t - 1000 }
  const newer = { ...common, actId: 'a-new-block', command: 'block', dedupe: `block|c:${w.bId}`, createdAt: t }
  await db.write([{ store: 'intents', key: older.actId, value: older }])
  await db.write([{ store: 'intents', key: newer.actId, value: newer }])
  const h = capture.holders.at(-1)! as unknown as PartHolder
  // A pre-fix recovery processed records by key; both finish writes failed, then the process died.
  expect(await h.block(w.bId, { when: t, actId: `${newer.actId}:block` })).toMatchObject({ ok: true })
  expect(await h.pauseTrust(w.bId, true, { when: t, actId: `${newer.actId}:pause` })).toMatchObject({ ok: true })
  expect(await h.unblock(w.bId, { when: t, actId: `${older.actId}:unblock` })).toMatchObject({ ok: true })
  expect(await h.pauseTrust(w.bId, false, { when: t, actId: `${older.actId}:resume` })).toMatchObject({ ok: true })
  expect(await h.replay(`${newer.actId}:block`, t)).toMatchObject({ ok: true })
  await w.B.port.runtime.lock('user')
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await w.B.port.runtime.unlock.open()
  await w.settle()
  expect(w.B.port.stores.intents.get()).toEqual([])
  // no part runs again: the last committed parts (the unblock) stand
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
  await expectDropped(w, [older.actId, newer.actId])
})
