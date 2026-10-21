// @vitest-environment node
// Interleavings of the contact order (src/adapters/rltp/CONTACT-ORDER.md, issue #425). Gestures from
// {block, unblock} on one contact are taken overlapping, without awaiting them. Every step of their
// handling is a hold point: the dedupe read (before, after), the journal write (before, after), each
// library part (block, unblock, pause, resume; before, after) and the finishing write (before, after).
// Per point a seeded generator lets it pass, holds it (the request before, the answer after) or, at
// the journal and the pause or resume part, fails it once. Between the steps the session is reopened
// (lock, unlock) or the deadline passes while locked (+89 d + 1 ms).
//
// Observed only from outside the command service: the library's contact view, the intent journal in
// app-db and the library's own act journal (holder.replay). Invariants, after rest:
//   1. the target state is the last gesture the command service took (journaled: true), in the order
//      the gestures were made;
//   2. no partial state: blocked equals paused, and no block or unblock record is open;
//   3. one library execution per part: a part never runs under an actId the library already
//      committed (replay instead of a double).
// Cells: every (point, behaviour) pair below, and the reopen and the deadline, must be hit by some
// run; a cell no run visited fails the file. A failing run names its seed; `SEED=<n>` reruns it alone,
// `TRACE=1` writes each step to stderr.
import { afterAll, expect, it, vi } from 'vitest'
import { secret, type Loadable, type ReadStore } from '../../src/port'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { AppWrite } from '../../src/adapters/rltp/app-db'
import type { IntentRecord } from '../../src/adapters/rltp/journal'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

// ── seeded randomness ───────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0 || 1
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n) }
}

// ── the scheduler between the command service, app-db and the library ───────

const POINTS = [
  'dedupe:before', 'dedupe:after', 'journal:before', 'journal:after',
  'part:block:before', 'part:block:after', 'part:unblock:before', 'part:unblock:after',
  'part:pause:before', 'part:pause:after', 'part:resume:before', 'part:resume:after',
  'finish:before', 'finish:after',
] as const
type Point = (typeof POINTS)[number]
const FAILABLE: readonly Point[] = ['journal:before', 'part:pause:before', 'part:resume:before']
const CELLS = [...POINTS.flatMap((p) => [`${p}/pass`, `${p}/hold`]), ...FAILABLE.map((p) => `${p}/fail`), 'reopen', 'deadline']

type Res = { ok: boolean }
interface HolderLike {
  block(c: string, o: { when: number; actId: string }): Promise<Res>
  unblock(c: string, o: { when: number; actId: string }): Promise<Res>
  pauseTrust(c: string, p: boolean, o: { when: number; actId: string }): Promise<Res>
  replay(actId: string, when: number): Promise<{ ok: boolean }>
}

const S = vi.hoisted(() => ({
  /** null: every point passes (setup, rest) */
  decide: null as null | ((p: string) => 'pass' | 'hold' | 'fail'),
  held: [] as { point: string; release: () => void }[],
  hit: new Set<string>(),
  doubles: [] as string[],
}))

async function at(point: Point): Promise<void> {
  if (!S.decide) return
  const b = S.decide(point)
  S.hit.add(`${point}/${b}`)
  if (b === 'fail') throw new Error(`injected failure at ${point}`)
  if (b === 'hold') await new Promise<void>((release) => S.held.push({ point, release }))
}

vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      /** a part: never under an actId the library committed already (invariant 3) */
      const part = async (name: 'block' | 'unblock' | 'pause' | 'resume', o: { when: number; actId: string }, run: () => Promise<Res>) => {
        await at(`part:${name}:before` as Point)
        if ((await h.replay(o.actId, o.when)).ok) S.doubles.push(o.actId)
        const r = await run()
        await at(`part:${name}:after` as Point)
        return r
      }
      return {
        ...h,
        block: (c: string, o: { when: number; actId: string }) => part('block', o, () => h.block(c, o)),
        unblock: (c: string, o: { when: number; actId: string }) => part('unblock', o, () => h.unblock(c, o)),
        pauseTrust: (c: string, p: boolean, o: { when: number; actId: string }) => part(p ? 'pause' : 'resume', o, () => h.pauseTrust(c, p, o)),
      }
    },
  }
})

const ORDERED = ['block', 'unblock']
const recOf = (w: AppWrite) => (w.store === 'intents' ? (w.value as IntentRecord | null) : null)
vi.mock('../../src/adapters/rltp/app-db', async (original) => {
  const lib = await original<typeof AppDbModule>()
  return {
    ...lib,
    idbAppDb: (opts: Parameters<typeof lib.idbAppDb>[0]) => {
      const db = lib.idbAppDb(opts)
      return {
        ...db,
        write: async (writes: readonly AppWrite[]) => {
          const recs = writes.map(recOf).filter((r): r is IntentRecord => r !== null && ORDERED.includes(r.command))
          const kind = recs.some((r) => r.state === 'journaled' && r.attempts === 0) ? 'journal' : recs.some((r) => r.state === 'done') ? 'finish' : null
          if (kind) await at(`${kind}:before`)
          await db.write(writes)
          if (kind) await at(`${kind}:after`)
        },
      }
    },
  }
})

// ── one run ─────────────────────────────────────────────────────────────────

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw Error(v.status)
  return v.value
}
const quiet = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}

async function world() {
  const carrier = memoryCarrier(), clock = virtualClock(Date.parse('2026-10-15T20:30:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], seed: 141 })
  const B = await loopbackDevice({ carrier, clock, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], seed: 143 })
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await carrier.settled()
      await quiet()
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  return { B, clock, bId, settle }
}

type Gesture = 'block' | 'unblock'

async function run(seed: number): Promise<void> {
  const r = rng(seed)
  const w = await world()
  // the session's own dedupe read, the one point inside the command service (RltpFaults.probe)
  w.B.faults.probe = (p) => at(p === 'dedupe:before' ? 'dedupe:before' : 'dedupe:after')
  const log: string[] = []
  // a start state of its own: blocked or not
  if (r.next() < 0.5) expect((await w.B.port.trust.block({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
  const plan: Gesture[] = Array.from({ length: 2 + r.int(3) }, () => (r.next() < 0.5 ? 'block' : 'unblock'))
  const taken: { g: Gesture; journaled: Promise<boolean>; done: Promise<unknown> }[] = []
  const failed = new Set<Point>()
  S.decide = (p) => {
    const x = r.next()
    if (FAILABLE.includes(p as Point) && !failed.has(p as Point) && x < 0.2) {
      failed.add(p as Point)
      return 'fail'
    }
    return x < 0.55 ? 'hold' : 'pass'
  }
  let locks = 0
  const releaseAll = async () => {
    while (S.held.length) {
      S.held.splice(0).forEach((h) => h.release())
      await quiet()
    }
  }
  const reopen = async (deadline: boolean) => {
    // what is held is let go first, then the lock ends the opening wherever its sections stand
    const decide = S.decide
    S.decide = null
    await releaseAll()
    await w.B.port.runtime.lock('user')
    if (deadline) w.clock.advance(89 * 86_400_000 + 1)
    S.hit.add(deadline ? 'deadline' : 'reopen')
    S.decide = decide
    await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.B.port.runtime.unlock.open()
    await quiet()
  }
  for (let step = 0; step < 40; step++) {
    const x = r.next()
    if (plan.length && (x < 0.45 || !S.held.length)) {
      const g = plan.shift()!
      log.push(g)
      const h = g === 'block' ? w.B.port.trust.block({ kind: 'contact', contactId: w.bId }) : w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
      taken.push({ g, journaled: h.journaled ?? Promise.resolve(false), done: h.done })
    } else if (S.held.length && x < 0.9) {
      const [h] = S.held.splice(r.int(S.held.length), 1)
      log.push(`release ${h!.point}`)
      h!.release()
    } else if (locks < 2) {
      locks++
      const deadline = r.next() < 0.5
      log.push(deadline ? 'deadline' : 'reopen')
      await reopen(deadline)
    } else if (S.held.length) {
      S.held.splice(0, 1)[0]!.release()
    }
    await quiet()
    if (process.env.TRACE) process.stderr.write(`${seed} ${step} ${log.at(-1)} [${S.held.map((h) => h.point).join(',')}] ${Date.now()}\n`)
    if (!plan.length && !S.held.length) break
  }
  // rest: nothing is held any more; due retries run (backoff, activation)
  S.decide = null
  await releaseAll()
  await Promise.all(taken.map((t) => t.done))
  for (let i = 0; i < 4; i++) {
    w.clock.advance(61_000)
    await quiet()
  }
  await w.B.port.session()?.idle()
  await quiet()
  const accepted: Gesture[] = []
  for (const t of taken) if (await t.journaled) accepted.push(t.g)
  const contact = value(w.B.port.stores.contacts)[0]!
  const open = w.B.port.stores.intents.get().filter((i) => ORDERED.includes(i.command))
  const last = accepted.at(-1)
  const context = { seed, log, accepted }
  if (last) expect({ ...context, blocked: contact.blocked }).toEqual({ ...context, blocked: last === 'block' })
  expect({ ...context, partial: contact.blocked !== contact.trust.paused, open }).toEqual({ ...context, partial: false, open: [] })
  expect({ ...context, doubles: S.doubles }).toEqual({ ...context, doubles: [] })
}

// ── batches ─────────────────────────────────────────────────────────────────

const ONE = process.env.SEED ? Number(process.env.SEED) : null
// small batches: one run takes about 1.3 s alone and up to 4 s under the full suite's load
const BATCH = 4
for (let b = 0; b < 10; b++) {
  it(`contact order interleavings, batch ${b + 1}`, { timeout: 25_000 }, async () => {
    const seeds = ONE !== null ? (b === 0 ? [ONE] : []) : Array.from({ length: BATCH }, (_, i) => 1000 + b * BATCH + i)
    for (const seed of seeds) {
      S.held.length = 0
      S.doubles.length = 0
      S.decide = null
      const t0 = Date.now()
      try {
        await run(seed)
        if (process.env.TRACE) process.stderr.write(`seed ${seed}: ${Date.now() - t0} ms\n`)
      } finally {
        S.decide = null
        S.held.splice(0).forEach((h) => h.release())
      }
    }
  })
}

afterAll(() => {
  if (ONE !== null) return
  expect(CELLS.filter((c) => !S.hit.has(c))).toEqual([])
})
