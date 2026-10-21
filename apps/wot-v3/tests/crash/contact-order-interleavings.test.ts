// @vitest-environment node
// Interleavings of the contact order (src/adapters/rltp/CONTACT-ORDER.md, issue #425). Every run
// takes Block → Unblock → Block on one contact (from a blocked or an unblocked start), overlapping and
// without awaiting them. Every step of their handling is a hold point: the dedupe read (before,
// after), the journal write (before, after), each library part (block, unblock, pause, resume;
// before, after) and the finishing write (before, after). Per point a seeded generator lets it pass,
// holds it (the request before, the answer after), fails it (journal, pause or resume, finish) or has
// the library refuse it (pause, resume). Between the steps the session is locked while points are
// held and reopened, or the deadline passes while locked (+89 d + 1 ms).
//
// Observed only from outside the command service: the library's contact view, the intent journal in
// app-db and the library's own act journal (holder.replay). Invariants:
//   1. after rest, the target state is the last gesture taken (journaled: true), in gesture order;
//   2. at every step, a partial state (blocked differs from paused) has an open block or unblock
//      record in the journal, whose recovery completes it; after rest there is none and no open record;
//   3. one library execution per part: a part never runs under an actId the library already
//      committed (replay instead of a double).
// Cells: (gesture 1 to 3, point, behaviour) for the points of that gesture, and (point, lock or
// deadline) for the points held when the session is locked. A cell no run visited fails the file.
// Scheduling is seeded; the asynchronous steps between two decisions run until quiet (macrotask
// turns), so a seed replays the same run on the same code. A failing run names its seed and log;
// `SEED=<n>` reruns it alone, `TRACE=1` writes each step to stderr.
import { afterAll, expect, it, vi } from 'vitest'
import { secret, type Loadable, type ReadStore } from '../../src/port'
import type * as AppDbModule from '../../src/adapters/rltp/app-db'
import type { AppDb, AppWrite } from '../../src/adapters/rltp/app-db'
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

// ── points, behaviours, cells ───────────────────────────────────────────────

type Gesture = 'block' | 'unblock'
const PLAN: readonly Gesture[] = ['block', 'unblock', 'block']
const PARTS: Record<Gesture, readonly [string, string]> = { block: ['block', 'pause'], unblock: ['unblock', 'resume'] }
const pointsOf = (g: Gesture) => [
  'dedupe:before', 'dedupe:after', 'journal:before', 'journal:after',
  ...PARTS[g].flatMap((p) => [`part:${p}:before`, `part:${p}:after`]),
  'finish:before', 'finish:after',
]
type Behaviour = 'pass' | 'hold' | 'fail' | 'refuse'
const behavioursAt = (point: string): readonly Behaviour[] => [
  'pass', 'hold',
  ...(['journal:before', 'finish:before', 'part:pause:before', 'part:resume:before'].includes(point) ? (['fail'] as const) : []),
  ...(['part:pause:before', 'part:resume:before'].includes(point) ? (['refuse'] as const) : []),
]
const ALL_POINTS = [...new Set([...pointsOf('block'), ...pointsOf('unblock')])]
const LOCK_COMBOS = ALL_POINTS.flatMap((point) => [{ point, deadline: false }, { point, deadline: true }])
const CELLS = [
  ...PLAN.flatMap((g, i) => pointsOf(g).flatMap((p) => behavioursAt(p).map((b) => `${i + 1}:${p}/${b}`))),
  ...ALL_POINTS.flatMap((p) => [`lock@${p}`, `deadline@${p}`]),
]

type Res = { ok: boolean }
interface HolderLike {
  block(c: string, o: { when: number; actId: string }): Promise<Res>
  unblock(c: string, o: { when: number; actId: string }): Promise<Res>
  pauseTrust(c: string, p: boolean, o: { when: number; actId: string }): Promise<Res>
  replay(actId: string, when: number): Promise<{ ok: boolean }>
  contacts(): Promise<readonly { blocked: boolean; trust: { paused: boolean } }[]>
}

const S = vi.hoisted(() => ({
  /** null: every point passes (setup, locking, rest) */
  decide: null as null | ((point: string, actId: string) => 'pass' | 'hold' | 'fail' | 'refuse'),
  held: [] as { point: string; release: () => void }[],
  hit: new Set<string>(),
  doubles: [] as string[],
  holders: [] as HolderLike[],
  dbs: [] as AppDb[],
}))

/** gesture number (1 to 3) of an actId, 0 for anything else (the start state) */
let gestureOf: (actId: string) => number = () => 0

async function at(point: string, actId: string): Promise<'refuse' | null> {
  if (!S.decide) return null
  const b = S.decide(point, actId)
  const g = gestureOf(actId.split(':')[0]!)
  if (g > 0) S.hit.add(`${g}:${point}/${b}`)
  if (b === 'fail') throw new Error(`injected failure at ${point}`)
  if (b === 'hold') await new Promise<void>((release) => S.held.push({ point, release }))
  return b === 'refuse' ? 'refuse' : null
}

vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const h = await lib.createHolder(...args)
      S.holders.push(h)
      /** a part: never under an actId the library committed already (invariant 3) */
      const part = async (name: string, o: { when: number; actId: string }, run: () => Promise<Res>) => {
        // a refusal the library gives without committing (the contact exists)
        if ((await at(`part:${name}:before`, o.actId)) === 'refuse') return { ok: false, code: 'log-missing' }
        if ((await h.replay(o.actId, o.when)).ok) S.doubles.push(o.actId)
        const r = await run()
        await at(`part:${name}:after`, o.actId)
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
      S.dbs.push(db)
      return {
        ...db,
        write: async (writes: readonly AppWrite[]) => {
          const recs = writes.map(recOf).filter((r): r is IntentRecord => r !== null && ORDERED.includes(r.command))
          const journal = recs.find((r) => r.state === 'journaled' && r.attempts === 0)
          const finish = recs.find((r) => r.state === 'done' && r.outcome?.ok !== false)
          const kind = journal ? 'journal' : finish ? 'finish' : null
          const actId = (journal ?? finish)?.actId ?? ''
          if (kind) await at(`${kind}:before`, actId)
          await db.write(writes)
          if (kind) await at(`${kind}:after`, actId)
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
  return { B, clock, bId }
}

/** invariant 2 at a step: a partial state has an open record that completes it */
async function noLostPartial(context: object) {
  const c = (await S.holders.at(-1)!.contacts())[0]!
  if (c.blocked === c.trust.paused) return
  const open = [...(await S.dbs.at(-1)!.readAll()).intents.values()].filter((r) => ORDERED.includes((r as IntentRecord).command) && (r as IntentRecord).state !== 'done' && (r as IntentRecord).state !== 'expired')
  expect({ ...context, partial: c, open: open.length > 0 }).toEqual({ ...context, partial: c, open: true })
}

async function run(seed: number): Promise<void> {
  const r = rng(seed)
  const w = await world()
  // the session's own dedupe read, the one point inside the command service (RltpFaults.probe)
  w.B.faults.probe = async (p, actId) => void (await at(p, actId))
  const log: string[] = []
  if (r.next() < 0.5) expect((await w.B.port.trust.block({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
  const plan = [...PLAN]
  const taken: { g: Gesture; actId: string; journaled: Promise<boolean>; done: Promise<unknown> }[] = []
  gestureOf = (actId) => taken.findIndex((t) => t.actId === actId) + 1
  const used = new Set<string>()
  // one lock per run at a point chosen by the seed, so every point meets a lock and a deadline over
  // the runs; a second lock may follow at random
  const combo = LOCK_COMBOS[seed % LOCK_COMBOS.length]!
  const lockAt = { point: combo.point, deadline: combo.deadline, armed: false, done: false }
  S.decide = (p, actId) => {
    const x = r.next()
    const options = behavioursAt(p)
    // a fault at most once per point and gesture: the run must be able to finish
    // this run's lock point is held the first time it is reached; the lock follows as the next step
    if (p === lockAt.point && !lockAt.armed) {
      lockAt.armed = true
      return 'hold'
    }
    const key = `${gestureOf(actId.split(':')[0]!)}:${p}`
    if (options.length > 2 && !used.has(key) && x < 0.3) {
      used.add(key)
      return options[2 + r.int(options.length - 2)]!
    }
    return x < 0.6 ? 'hold' : 'pass'
  }
  let locks = 0
  const releaseAll = async () => {
    while (S.held.length) {
      S.held.splice(0).forEach((h) => h.release())
      await quiet()
    }
  }
  const relock = async (deadline: boolean) => {
    // the lock starts while points are held; what is held is let go only then, so the sections meet
    // the closed opening wherever they stand
    for (const h of S.held) S.hit.add(`${deadline ? 'deadline' : 'lock'}@${h.point}`)
    const decide = S.decide
    S.decide = null
    const locking = w.B.port.runtime.lock('user')
    await releaseAll()
    await locking
    if (deadline) w.clock.advance(89 * 86_400_000 + 1)
    S.decide = decide
    await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.B.port.runtime.unlock.open()
    await quiet()
  }
  const context = () => ({ seed, log: [...log] })
  for (let step = 0; step < 60; step++) {
    const x = r.next()
    if (!lockAt.done && S.held.some((h) => h.point === lockAt.point)) {
      lockAt.done = true
      locks++
      log.push(`${lockAt.deadline ? 'deadline' : 'lock'} holding ${S.held.map((h) => h.point).join(',')}`)
      await relock(lockAt.deadline)
    } else if (plan.length && (x < 0.35 || !S.held.length)) {
      const g = plan.shift()!
      log.push(g)
      const h = g === 'block' ? w.B.port.trust.block({ kind: 'contact', contactId: w.bId }) : w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
      taken.push({ g, actId: h.actId, journaled: h.journaled ?? Promise.resolve(false), done: h.done })
    } else if (S.held.length && (locks >= 2 || r.next() >= 0.1)) {
      const [h] = S.held.splice(r.int(S.held.length), 1)
      log.push(`release ${h!.point}`)
      h!.release()
    } else {
      locks++
      const deadline = r.next() < 0.5
      log.push(`${deadline ? 'deadline' : 'lock'} holding ${S.held.map((h) => h.point).join(',')}`)
      await relock(deadline)
    }
    await quiet()
    if (process.env.TRACE) process.stderr.write(`${seed} ${step} ${log.at(-1)} [${S.held.map((h) => h.point).join(',')}]\n`)
    await noLostPartial(context())
    if (!plan.length && !S.held.length) break
  }
  // rest: nothing is held any more; planned recoveries run (backoff, then every 60 s)
  S.decide = null
  await releaseAll()
  await Promise.all(taken.map((t) => t.done))
  for (let i = 0; i < 5; i++) {
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
  const ctx = { ...context(), accepted }
  if (last) expect({ ...ctx, blocked: contact.blocked }).toEqual({ ...ctx, blocked: last === 'block' })
  expect({ ...ctx, partial: contact.blocked !== contact.trust.paused, open }).toEqual({ ...ctx, partial: false, open: [] })
  expect({ ...ctx, doubles: S.doubles }).toEqual({ ...ctx, doubles: [] })
}

// ── batches ─────────────────────────────────────────────────────────────────

const ONE = process.env.SEED ? Number(process.env.SEED) : null
// small batches: one run takes about 1.5 s alone and up to 4 s under the full suite's load
const BATCH = 4
const BATCHES = 20
for (let b = 0; b < BATCHES; b++) {
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
        S.holders.length = 0
        S.dbs.length = 0
      }
    }
  })
}

afterAll(() => {
  if (ONE !== null) return
  expect(CELLS.filter((c) => !S.hit.has(c))).toEqual([])
})
