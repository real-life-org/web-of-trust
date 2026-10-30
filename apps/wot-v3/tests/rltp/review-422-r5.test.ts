// @vitest-environment node
// Review 422 round 5 (gpt-6.1-sol), the contact order (CONTACT-ORDER.md): two open records left from
// before resolve to the newest gesture (R5-1); a refused part keeps the record open until the state is
// complete (R5-2; the refusal is injected, the pinned library gives none for the pause); a failed
// finish is completed, discard refuses; a failed journal keeps the older completion; the hidden
// history only in `reportable`; a dedupe read held across a reopening writes nothing.
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** the write that journals a gesture of `command` (a new intent record) */
const journals = (writes: readonly AppWrite[], command: string) =>
  writes.some((w) => w.store === 'intents' && (w.value as { command?: string; state?: string } | null)?.command === command && (w.value as { state?: string }).state === 'journaled')


it('R5-1, decided 21.10.: two open records of one contact without a seq are an invalid journal, dropped at opening', async () => {
  const w = await world()
  const db = capture.dbs.at(-1)!
  const newer = { actId: 'a-new-block', command: 'block', target: `c:${w.bId}`, policy: 'replay', state: 'journaled', dedupe: `block|c:${w.bId}`, input: { contactId: w.bId }, when: w.clock.now(), createdAt: w.clock.now(), attempts: 0 }
  const older = { ...newer, actId: 'z-old-unblock', command: 'unblock', dedupe: `unblock|c:${w.bId}`, createdAt: w.clock.now() - 1000 }
  await db.write([ { store: 'intents', key: older.actId, value: older }, { store: 'intents', key: newer.actId, value: newer } ])
  await w.B.port.runtime.lock('user')
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await w.B.port.runtime.unlock.open()
  await w.settle()
  // nothing of either record runs; the journal holds neither; a diagnostic entry without content
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
  expect([...(await capture.dbs.at(-1)!.readAll()).intents.keys()].filter((k) => k === older.actId || k === newer.actId)).toEqual([])
  expect(w.B.port.diagnostics.list().map((e) => ({ code: e.code, detail: e.detail }))).toEqual([{ code: 'contact-order-invalid-journal', detail: undefined }])
})

it('R5 refusal: a refused second part must not abandon a partial contact', async () => {
  const w = await world()
  capture.refusePause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  for (let i = 0; i < 4; i++) { w.clock.advance(61000); await w.settle() }
  const c = value(w.B.port.stores.contacts)[0]!
  expect({ blocked: c.blocked, paused: c.trust.paused, open: w.B.port.stores.intents.get() }).toMatchObject({ blocked: true, paused: true, open: [] })
})

it('R5 finish failure is retried and discard refuses the open ordered record', async () => {
  const w = await world()
  capture.writeHook = async (writes) => {
    if (!writes.some(x => x.store === 'intents' && (x.value as { command?: string; state?: string })?.command === 'block' && (x.value as { state?: string }).state === 'done')) return
    throw Error('finish unavailable')
  }
  const h = w.block()
  expect(await h.done).toMatchObject({ ok: false })
  expect(await w.B.port.session()!.discardIntent(h.actId)).toMatchObject({ ok: false })
  capture.writeHook = null
  w.clock.advance(2001)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get()).toEqual([])
})

it('R5 failed new journal leaves the older partial block scheduled for completion', async () => {
  const w = await world()
  capture.failPause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  capture.writeHook = async writes => { if (journals(writes, 'unblock')) throw Error('journal unavailable') }
  const refused = w.unblock()
  expect(await refused.done).toMatchObject({ ok: false })
  expect(await refused.journaled).toBe(false)
  capture.writeHook = null
  w.clock.advance(2001)
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
  expect(w.B.port.stores.intents.get()).toEqual([])
})

it('R5 hidden history is exposed only by reportable; discarded content never appears there', async () => {
  const w = await world()
  await w.A.port.trust.send(`c:${w.aId}`, 'HIDDEN_BEFORE', 'before').done
  await w.settle()
  await w.block().done
  await w.settle()
  await w.A.port.trust.send(`c:${w.aId}`, 'DISCARDED_DURING', 'during').done
  await w.settle()
  expect(value(w.B.port.stores.reportable(w.bId)).map(x => x.text)).toEqual(['HIDDEN_BEFORE'])
  const stores = w.B.port.stores
  const ordinary = [value(stores.contacts), value(stores.contact(w.bId)), value(stores.conversation(`c:${w.bId}`)), value(stores.blocked), value(stores.profile), value(stores.standing), value(stores.visibility), value(stores.reports), value(stores.decisions)]
  expect(JSON.stringify(ordinary)).not.toContain('HIDDEN_BEFORE')
  expect(JSON.stringify(ordinary)).not.toContain('DISCARDED_DURING')
})

it('R5 a dedupe read held across lock and reopening cannot overwrite the new opening', async () => {
  const w = await world()
  const entered = deferred(), release = deferred()
  w.B.faults.probe = async point => {
    if (point !== 'dedupe:after') return
    w.B.faults.probe = null
    entered.resolve()
    await release.promise
  }
  const old = w.unblock()
  await entered.promise
  await w.B.port.runtime.lock('user')
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await w.B.port.runtime.unlock.open()
  expect(await w.block().done).toMatchObject({ ok: true })
  release.resolve()
  expect(await old.journaled).toBe(false)
  await old.done
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: true, trust: { paused: true } })
})
