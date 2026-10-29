// @vitest-environment node
// Review 422 round 4 and issue #425: the contact order of block and unblock (src/adapters/rltp/
// CONTACT-ORDER.md). Both counter cases of #425 as regressions: the newest block wins over an unblock
// held at its journal (case 1); a block whose pause failed is completed at the deadline, across a lock
// (case 2). The order is observed only through the library's state and the journal, never through the
// command service's own bookkeeping. Further: the type table under a block (control, round 4).
import { afterEach, expect, it, vi } from 'vitest'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
import { ingest } from '../../src/adapters/rltp/ingest'
import { project, type ProjectionInput } from '../../src/adapters/rltp/projection'
import { EMPTY_ENCOUNTERS, EMPTY_LEDGER } from '../../src/adapters/rltp/app-data'
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
const capture = vi.hoisted(() => ({ holders: [] as HolderLike[], failPause: false, writeHook: null as null | WriteHook }))
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

it('#425 case 1: the newest block wins over an unblock held at its journal, after a block whose pause failed', async () => {
  const w = await world()
  capture.failPause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  await w.settle()
  const entered = deferred(), release = deferred()
  capture.writeHook = async (writes) => {
    if (!journals(writes, 'unblock')) return
    capture.writeHook = null
    entered.resolve()
    await release.promise
  }
  const opposite = w.unblock()
  await entered.promise
  const latest = w.block()
  release.resolve()
  expect(await opposite.journaled).toBe(true)
  expect(await latest.journaled).toBe(true)
  const answers = await Promise.all([opposite.done, latest.done])
  await w.settle()
  await w.A.port.trust.send(`c:${w.aId}`, 'ACCEPTED AFTER NEWEST BLOCK', 'r4-newest').done
  await w.settle()
  const c = value(w.B.port.stores.contacts)[0]!
  expect({ answers, blocked: c.blocked, paused: c.trust.paused, incoming: w.messages().map((m) => m.text), open: w.B.port.stores.intents.get() })
    .toMatchObject({ answers: [{ ok: true }, { ok: true }], blocked: true, paused: true, incoming: [], open: [] })
})

it('#425 case 2: a block whose pause failed is completed after the deadline, across a lock', async () => {
  const w = await world()
  capture.failPause = true
  const h = w.block()
  expect(await h.done).toMatchObject({ ok: false })
  await w.B.port.runtime.lock('user')
  w.clock.advance(89 * 86_400_000 + 1)
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await w.B.port.runtime.unlock.open()
  await w.settle()
  const c = value(w.B.port.stores.contacts)[0]!
  // silently completed (Anton 21.10.): block plus pause, no record left open
  expect({ blocked: c.blocked, paused: c.trust.paused, open: w.B.port.stores.intents.get() }).toEqual({ blocked: true, paused: true, open: [] })
})

it('#425 case 2b: a lock while the pause is failing leaves no partial state once reopened, also past the retention', async () => {
  const w = await world()
  capture.failPause = true
  expect(await w.block().done).toMatchObject({ ok: false })
  await w.B.port.runtime.lock('user')
  w.clock.advance(91 * 86_400_000)
  await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
  await w.B.port.runtime.unlock.open()
  await w.settle()
  const c = value(w.B.port.stores.contacts)[0]!
  expect({ blocked: c.blocked, paused: c.trust.paused, open: w.B.port.stores.intents.get() }).toEqual({ blocked: true, paused: true, open: [] })
})

it('MT type table: encounter status stays visible; profile, trust and group-star updates do not', async () => {
  const w = await world()
  await w.block().done
  await w.settle()
  const raw = (await capture.holders[1]!.contacts())[0]!
  const beforeRaw = { ...raw, verification: 'outgoing' as const }
  const base = { now: w.clock.now(), events: [], prompts: [], encounters: EMPTY_ENCOUNTERS, inbox: [], statuses: [] }
  const before = ingest({ ...base, contacts: [beforeRaw], commitSeq: '100', ledger: EMPTY_LEDGER })
  const afterRaw = { ...raw, verification: 'mutual' as const, displayName: 'HIDDEN_PROFILE', trust: { ...raw.trust, received: true }, sharedGroups: ['HIDDEN_GROUP_STAR'] }
  const after = ingest({ ...base, contacts: [afterRaw], commitSeq: '101', ledger: before.ledger })
  const m = project({
    revision: '1:101:1' as never, now: w.clock.now(), timeZone: 'UTC', anchorShort: 'self', contacts: [afterRaw], prompts: [],
    profile: { commitSeq: '101', revision: '1', name: 'Bea' } as never, encounters: EMPTY_ENCOUNTERS, displayed: {}, lines: after.lines, intents: [], reads: {}, shown: after.ledger.contacts,
  })
  expect(m.contacts[0]).toMatchObject({ verification: 'mutual', trust: { received: false } })
  expect(m.standing.mutuallyVerified).toBe(1)
  expect(m.conversations.get(`c:${w.bId}`)!.items).toContainEqual(expect.objectContaining({ kind: 'system', system: 'nowMutual' }))
  expect(JSON.stringify([m.contacts, [...m.contactDetails], [...m.conversations], m.standing])).not.toContain('HIDDEN_')
})
