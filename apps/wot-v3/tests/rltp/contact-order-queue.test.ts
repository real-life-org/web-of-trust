// @vitest-environment node
// The contact order as a queue (CONTACT-ORDER.md "Queue", review 483 round 3): a taken gesture stays
// binding for every part of the state it sets until it ran or a newer gesture replaced all of them.
// The matrix: the lanes of two gestures independent, the newer covering the older whole, or the two
// overlapping in part; the older one failing in the library's store; completed live or after a
// reopening. Plus the two cases of the round: a failure after a committed part, and a finish lost
// between the library's commit and the app's journal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase } from 'fake-indexeddb'
import { holderDbName } from '../../src/adapters/rltp/session'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import { secret, type ContactId, type Loadable, type ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

type Res = { ok: boolean }
interface HolderLike {
  pauseTrust(...a: unknown[]): Promise<Res>
}
type WriteHook = (writes: readonly AppWrite[]) => Promise<void> | void
const capture = vi.hoisted(() => ({ failPause: 0, refusePause: 0, writeHook: null as null | WriteHook }))
vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      return {
        ...h,
        pauseTrust: async (...a: unknown[]) => {
          if (capture.failPause > 0) {
            capture.failPause -= 1
            throw new Error('injected storage failure in the pause')
          }
          if (capture.refusePause > 0) {
            capture.refusePause -= 1
            return { ok: false, code: 'no-community' }
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
  capture.failPause = 0
  capture.refusePause = 0
  capture.writeHook = null
})

const T0 = Date.parse('2026-10-30T09:00:00+01:00')
const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

async function met() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'Europe/Berlin')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 51 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 53 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(1000)
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  const aId = value(A.port.stores.contacts)[0]!.id
  const reopen = async () => {
    await A.port.runtime.lock('user')
    await A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    const r = await A.port.runtime.unlock.open()
    if (!r.ok) throw new Error('reopen')
  }
  return { carrier, clock, A, B, aId, bId, settle, reopen }
}
type World = Awaited<ReturnType<typeof met>>

const row = (d: LoopbackDevice) => value(d.port.stores.contacts)[0]!
const detail = (d: LoopbackDevice, id: ContactId) => value(d.port.stores.contact(id))!
const lines = (d: LoopbackDevice, id: ContactId) =>
  value(d.port.stores.conversation(`c:${id}`))
    .items.filter((i) => i.kind === 'system')
    .map((i) => (i as { readonly system: string }).system)
const open = (d: LoopbackDevice) => d.port.stores.intents.get().map((i) => i.command)

/** the library's store refuses its next `n` writes: an act's commit fails, its record stays open; a
 *  gesture behind it retries it at once, so a lasting fault takes two */
const fault = async <T>(d: LoopbackDevice, act: () => Promise<T>, n = 1): Promise<T> => {
  const ns = d.port.session()?.ns ?? ''
  const orig = IDBDatabase.prototype.transaction
  let thrown = 0
  const tx = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: unknown[]) {
    if (this.name === holderDbName(ns) && args[1] === 'readwrite' && thrown++ < n) throw new Error('storage unavailable')
    return orig.apply(this, args as never)
  })
  try {
    return await act()
  } finally {
    tx.mockRestore()
  }
}
const WAITING = { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }

interface Case {
  readonly rel: 'independent' | 'covered' | 'partial'
  readonly older: (w: World) => Promise<unknown>
  readonly newer: (w: World) => Promise<unknown>
  /** the newer gesture waits behind the older one (not: replaces it) */
  readonly waits: boolean
  readonly check: (w: World) => void
}
const CASES: readonly Case[] = [
  {
    // the pause sets star and groupStar, the trust sets anchorMapping: nothing in common, the queue still
    // holds the order, the trust waits
    rel: 'independent',
    older: (w) => w.A.port.trust.setPaused(w.aId, true).done,
    newer: (w) => w.A.port.trust.giveTrust(w.aId).done,
    waits: true,
    check: (w) => {
      expect(row(w.A).trust).toMatchObject({ paused: true, given: true })
      expect(lines(w.A, w.aId)).toContain('trustOut')
    },
  },
  {
    // anchorMapping off sets everything the trust sets: the trust is replaced whole and never runs
    rel: 'covered',
    older: (w) => w.A.port.trust.giveTrust(w.aId).done,
    newer: (w) => w.A.port.trust.setClass(w.aId, 'anchorMapping', 'off').done,
    waits: false,
    check: (w) => {
      expect(row(w.A).trust.given).toBe(false)
      expect(lines(w.A, w.aId)).not.toContain('trustOut')
    },
  },
  {
    // the star on sets one of the pause's two parts: the pause stays binding for both, runs first, then
    // the star on (the counter case of round 3: the groupStar stays off)
    rel: 'partial',
    older: (w) => w.A.port.trust.setPaused(w.aId, true).done,
    newer: (w) => w.A.port.trust.setClass(w.aId, 'star', 'on').done,
    waits: true,
    check: (w) => {
      expect(detail(w.A, w.aId).classes.star).toEqual({ setting: 'on', on: true })
      expect(detail(w.A, w.aId).classes.groupStar).toMatchObject({ setting: 'off', on: false })
    },
  },
]

describe('the contact order as a queue', () => {
  describe.each(CASES)('$rel lanes, the older gesture fails in the store', (c) => {
    it.each(['live', 'reopened'] as const)('completed %s', async (mode) => {
      const w = await met()
      expect(await fault(w.A, () => c.older(w))).toMatchObject(WAITING)
      await w.A.port.session()?.idle()
      expect(open(w.A)).toHaveLength(1)
      if (c.waits) {
        // the fault lasts: the newer gesture retries the older one first, which fails again; the newer
        // one is taken (journaled) and waits behind it, both open, oldest first
        expect(await fault(w.A, () => c.newer(w))).toMatchObject(WAITING)
        await w.A.port.session()?.idle()
        expect(open(w.A)).toHaveLength(2)
      } else {
        const r = await c.newer(w)
        expect(r).toMatchObject({ ok: true })
        expect(open(w.A)).toEqual([])
      }
      if (mode === 'reopened') await w.reopen()
      await w.settle()
      c.check(w)
      expect(open(w.A)).toEqual([])
    })
  })

  it('a failure after a committed part: the block (its pause failed) stays binding for the pause; the star on behind it waits, then runs', async () => {
    const w = await met()
    // the pause fails at the block and again at the retry the star on triggers
    capture.failPause = 2
    expect(await w.A.port.trust.block({ kind: 'contact', contactId: w.aId }).done).toMatchObject(WAITING)
    await w.A.port.session()?.idle()
    expect(row(w.A)).toMatchObject({ blocked: true, trust: { paused: false } })
    expect(await w.A.port.trust.setClass(w.aId, 'star', 'on').done).toMatchObject(WAITING)
    await w.A.port.session()?.idle()
    expect(open(w.A)).toEqual(['block', 'setClass'])
    await w.settle()
    expect(open(w.A)).toEqual([])
    expect(row(w.A).blocked).toBe(true)
    // the pause ran whole (the groupStar off), then the star on
    expect(detail(w.A, w.aId).classes.star).toEqual({ setting: 'on', on: true })
    expect(detail(w.A, w.aId).classes.groupStar).toMatchObject({ setting: 'off', on: false })
  })

  it('a finish lost between the library and the journal: the record answers from the library, runs no second act, the one behind it follows', async () => {
    const w = await met()
    let finishes = 0
    capture.writeHook = (ws) => {
      if (ws.some((x) => x.store === 'intents' && (x.value as { command?: string; state?: string } | null)?.command === 'setPaused' && (x.value as { state?: string }).state === 'done') && finishes++ < 2) {
        throw new Error('finish lost')
      }
    }
    expect(await w.A.port.trust.setPaused(w.aId, true).done).toMatchObject(WAITING)
    await w.A.port.session()?.idle()
    // the library committed the pause; the app's record is still open
    expect(row(w.A).trust.paused).toBe(true)
    expect(open(w.A)).toEqual(['setPaused'])
    expect(await w.A.port.trust.setClass(w.aId, 'star', 'on').done).toMatchObject(WAITING)
    await w.reopen()
    await w.settle()
    expect(open(w.A)).toEqual([])
    expect(detail(w.A, w.aId).classes.star).toEqual({ setting: 'on', on: true })
    expect(detail(w.A, w.aId).classes.groupStar).toMatchObject({ setting: 'off', on: false })
    // the finish was lost at the pause and once more at the retry the star on triggered; the library
    // answered the pause from its journal each time, the reopening's finish is the third write
    expect(finishes).toBe(3)
  })

  it('a part refused after a committed one (a block without its pause) keeps the record open until the part ran; the queue behind it waits', async () => {
    const w = await met()
    // the pause is refused for good at the block and again at the retry the star on triggers; the
    // block part committed, so the record stays open (the invariant), not done with the refusal
    capture.refusePause = 2
    expect(await w.A.port.trust.block({ kind: 'contact', contactId: w.aId }).done).toMatchObject({ ok: false, error: { kind: 'refused' } })
    await w.A.port.session()?.idle()
    expect(row(w.A)).toMatchObject({ blocked: true, trust: { paused: false } })
    expect(open(w.A)).toEqual(['block'])
    expect(await w.A.port.trust.setClass(w.aId, 'star', 'on').done).toMatchObject(WAITING)
    await w.A.port.session()?.idle()
    expect(open(w.A)).toEqual(['block', 'setClass'])
    await w.settle()
    expect(open(w.A)).toEqual([])
    expect(row(w.A).blocked).toBe(true)
    expect(detail(w.A, w.aId).classes.star).toEqual({ setting: 'on', on: true })
    expect(detail(w.A, w.aId).classes.groupStar).toMatchObject({ setting: 'off', on: false })
  })

  it('retryIntent answers for the asked record, not with the queue\'s last result (#484)', async () => {
    const w = await met()
    const pause = w.A.port.trust.setPaused(w.aId, true)
    expect(await fault(w.A, () => pause.done)).toMatchObject(WAITING)
    const trust = w.A.port.trust.giveTrust(w.aId)
    expect(await fault(w.A, () => trust.done)).toMatchObject(WAITING)
    await w.A.port.session()?.idle()
    expect(open(w.A)).toEqual(['setPaused', 'giveTrust'])
    // the trust asked while the pause ahead of it fails once more: the trust still waits
    expect(await fault(w.A, () => w.A.port.session()!.retryIntent(trust.actId).done)).toMatchObject(WAITING)
    // the pause asked, refused for good this time; the trust behind it succeeds: the pause's handle
    // carries the refusal, the trust's the success
    capture.refusePause = 1
    expect(await w.A.port.session()!.retryIntent(pause.actId).done).toMatchObject({ ok: false, error: { kind: 'refused' } })
    await w.A.port.session()?.idle()
    expect(open(w.A)).toEqual([])
    expect(row(w.A).trust).toMatchObject({ given: true, paused: false })
    // asked again, the record is done: superseded, nothing runs
    expect(await w.A.port.session()!.retryIntent(pause.actId).done).toEqual({ ok: false, error: { kind: 'refused', code: 'superseded' } })
  })

  it('a final refusal finishes the record; the queue moves on (no endless repetition)', async () => {
    const w = await met()
    // trust given twice: the library refuses the second act for good (already-given); the record is
    // done with the refusal, the next gesture is not held up
    expect(await w.A.port.trust.giveTrust(w.aId).done).toEqual({ ok: true })
    expect(await w.A.port.trust.giveTrust(w.aId).done).toEqual({ ok: false, error: { kind: 'refused', code: 'already-done' } })
    expect(open(w.A)).toEqual([])
    expect(await w.A.port.trust.withdrawTrust(w.aId).done).toEqual({ ok: true })
    await w.settle()
    expect(row(w.A).trust.given).toBe(false)
  })
})
