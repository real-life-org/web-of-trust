// @vitest-environment node
// Review 422 round 3 (gpt-6.1-sol): block and unblock are ordered when they are taken: a later block
// never joins an older in-flight block across an unblock (R3-1), an earlier gesture runs to its end
// before a later one (R3-2), an older gesture delayed before its journal never undoes a newer one
// (R3-4); trust received from a blocked contact is processed, not shown (R3-3, Message Tasks 6230,
// anchor-mapping/0.3). Since the contact order (CONTACT-ORDER.md, #425) a later gesture waits for the
// section of the earlier one: the tests release the held step before they wait for the later answer.
import { afterEach, expect, it, vi } from 'vitest'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
import { ingest } from '../../src/adapters/rltp/ingest'
import { project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import { EMPTY_ENCOUNTERS, EMPTY_LEDGER } from '../../src/adapters/rltp/app-data'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

type Res = { ok: boolean }
interface HolderLike {
  setClass(contactId: string, cls: string, v: string, o: { when: number; actId: string }): Promise<Res>
  setProfile(p: { name: string }, o: { when: number; actId: string }): Promise<Res>
  contacts(): Promise<ProjectionInput['contacts']>
  resume(when: number): Promise<unknown>
  pauseTrust(...a: unknown[]): Promise<Res>
}
const capture = vi.hoisted(() => ({ holders: [] as HolderLike[], failPause: false, pauseHook: null as null | (() => Promise<void>), readHook: null as null | (() => Promise<void>) }))
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
          if (capture.pauseHook) { const hook = capture.pauseHook; capture.pauseHook = null; await hook() }
          if (capture.failPause) {
            capture.failPause = false
            throw new Error('injected storage failure between block and pause')
          }
          return h.pauseTrust(...a)
        },
      }
    },
  }
})
vi.mock('../../src/adapters/rltp/app-db', async (original) => {
  const lib = await original<typeof AppDbModule>()
  return { ...lib, idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
    const db = lib.idbAppDb(opts)
    return { ...db, readAll: async () => {
      if (capture.readHook) { const hook = capture.readHook; capture.readHook = null; await hook() }
      return db.readAll()
    } }
  } }
})
afterEach(() => { capture.holders.length = 0; capture.failPause = false; capture.pauseHook = null; capture.readHook = null })
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get(); if (v.status !== 'ready') throw Error(v.status); return v.value
}
async function world() {
  const carrier = memoryCarrier(), clock = virtualClock(Date.parse('2026-10-15T20:30:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], seed: 141 })
  const ah = capture.holders.at(-1)!
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], seed: 143 })
  const settle = async () => { for (let i = 0; i < 8; i++) { await carrier.settled(); await A.port.session()?.idle(); await B.port.session()?.idle(); await new Promise(r => setTimeout(r, 0)) } }
  const shown = await B.port.trust.showCard().done; if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done; await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done; await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  const block = () => B.port.trust.block({ kind: 'contact', contactId: bId })
  const reopen = async () => { await B.port.runtime.lock('user'); await B.port.runtime.unlock.passphrase(secret('harness passphrase')); await B.port.runtime.unlock.open(); await settle() }
  const messages = (id: ContactId = bId) => value(B.port.stores.conversation(`c:${id}`)).items.filter(x => x.kind === 'message')
  return { A, B, ah, clock, settle, aId, bId, block, reopen, messages }
}


function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

it('R3-1: newest block replaces an in-flight block separated by an unblock', async () => {
  const w = await world()
  const entered = deferred(), release = deferred()
  capture.pauseHook = async () => { entered.resolve(); await release.promise }
  const first = w.block()
  await entered.promise
  const opposite = w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
  const latest = w.block()
  expect(latest.actId).not.toBe(first.actId)
  release.resolve()
  await Promise.all([first.done, opposite.done])
  expect(await latest.done).toMatchObject({ ok: true })
  await w.A.port.trust.send(`c:${w.aId}`, 'MESSAGE AFTER NEWEST BLOCK', 'after-latest-block').done
  await w.settle()
  const c = value(w.B.port.stores.contacts)[0]!
  expect({ blocked: c.blocked, paused: c.trust.paused, incoming: w.messages().map(m => m.text) })
    .toEqual({ blocked: true, paused: true, incoming: [] })
})

it('R3-2: a running block finishes before the unblock taken after it; the unblock stands', async () => {
  const w = await world()
  const entered = deferred(), release = deferred()
  capture.pauseHook = async () => { entered.resolve(); await release.promise }
  const first = w.block()
  await entered.promise
  const opposite = w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
  release.resolve()
  // the block's answer is true: it ran to its end before the unblock began
  expect(await first.done).toMatchObject({ ok: true })
  expect(await opposite.done).toMatchObject({ ok: true })
  await w.settle()
  expect(value(w.B.port.stores.contacts)[0]).toMatchObject({ blocked: false, trust: { paused: false } })
})

// The fresh app cannot give trust yet (no community anchor). Test the legal view supplied by a
// peer with a community: received is a verified anchor-mapping/0.3 (library views.js), which 6230
// requires to be processed without display. Start with the real blocked contact's view.
it('R3-3: received mapping under block does not appear as trust, system line or preview', async () => {
  const w = await world()
  await w.block().done
  await w.settle()
  const raw = (await capture.holders[1]!.contacts())[0]!
  const base = { now: w.clock.now(), events: [], contacts: [raw], prompts: [], encounters: EMPTY_ENCOUNTERS, inbox: [], statuses: [] }
  const before = ingest({ ...base, commitSeq: '100', ledger: EMPTY_LEDGER })
  const after = ingest({ ...base, commitSeq: '101', ledger: before.ledger,
    contacts: [{ ...raw, trust: { ...raw.trust, received: true } }] })
  const m = project({ revision: '1:101:1' as never, now: w.clock.now(), timeZone: 'UTC', anchorShort: 'self',
    contacts: [{ ...raw, trust: { ...raw.trust, received: true } }], prompts: [],
    profile: { commitSeq: '101', revision: '1', name: 'Bea' } as never,
    encounters: EMPTY_ENCOUNTERS, displayed: {}, lines: after.lines, intents: [], reads: {}, shown: after.ledger.contacts })
  expect({ received: m.contacts[0]!.trust.received, trustYou: m.standing.trustYou,
    system: m.conversations.get(`c:${w.bId}`)!.items.filter(i => i.kind === 'system').map(i => i.system),
    preview: m.contacts[0]!.conversation.preview?.i18n?.key }).toEqual({ received: false, trustYou: 0, system: [], preview: undefined })
})

it('R3-4: an older gesture delayed before journaling does not undo a newer block', async () => {
  const w = await world()
  await w.block().done
  await w.settle()
  const entered = deferred(), release = deferred()
  capture.readHook = async () => { entered.resolve(); await release.promise }
  const older = w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
  await entered.promise
  const newer = w.block()
  release.resolve()
  expect(await newer.done).toMatchObject({ ok: true })
  await older.done
  await w.A.port.trust.send(`c:${w.aId}`, 'OLDER UNBLOCK UNDID NEWER BLOCK', 'reordered').done
  await w.settle()
  const c = value(w.B.port.stores.contacts)[0]!
  expect({ blocked: c.blocked, paused: c.trust.paused, incoming: w.messages().map(m => m.text) })
    .toEqual({ blocked: true, paused: true, incoming: [] })
})
