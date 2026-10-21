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
//      record in the journal, and its completion is running (a gesture unanswered, a step held) or
//      planned: with nothing running, the clock alone completes it within 4 × 61 s; after rest (the
//      state stops changing, with an upper bound) there is no partial state and no open record;
//   3. one library execution per part: a part never runs under an actId the library already
//      committed (replay instead of a double).
// Cells: (gesture 1 to 3, point, behaviour) for the points of that gesture, (point, lock or
// deadline) for the points held when the session is locked, and the lock or deadline taken while a
// recovery is planned on the clock (an open record, nothing running). After every lock no timer of
// the ended opening is left on device B's clock (#428). A cell no run visited fails the file.
// Scheduling is seeded; between two decisions the asynchronous steps run until calm: no holder or
// app-db call in flight (beyond the held ones) and no new call for a few macrotask turns. The rule
// depends only on the order of events, never on wall time, so a seed replays the same run on the
// same code, on a fast machine and under CI load alike. Each run keeps its own state (holders, dbs,
// held points, decisions); a run whose test timed out is aborted at its next step and cannot touch
// the next run. A failing run names its seed and log; `SEED=<n>` reruns it alone, `TRACE=1` writes
// each step and each run's duration to stderr.
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
  'lock@planned-recovery', 'deadline@planned-recovery',
]

type Res = { ok: boolean }
interface HolderLike {
  block(c: string, o: { when: number; actId: string }): Promise<Res>
  unblock(c: string, o: { when: number; actId: string }): Promise<Res>
  pauseTrust(c: string, p: boolean, o: { when: number; actId: string }): Promise<Res>
  replay(actId: string, when: number): Promise<{ ok: boolean }>
  contacts(): Promise<readonly { blocked: boolean; trust: { paused: boolean } }[]>
}

/** The state of one run: the devices' holders and app-dbs created while it is current take it with
 *  them, so a run overtaken by its test's timeout only ever touches its own state. */
const S = vi.hoisted(() => {
  const fresh = () => ({
    /** null: every point passes (setup, locking, rest) */
    decide: null as null | ((point: string, actId: string) => 'pass' | 'hold' | 'fail' | 'refuse'),
    held: [] as { point: string; release: () => void }[],
    doubles: [] as string[],
    /** raw holders and dbs, for the observer's reads (not counted as activity) */
    holders: [] as unknown[],
    dbs: [] as unknown[],
    /** gesture number (1 to 3) of an actId, 0 for anything else (the start state) */
    gestureOf: ((): number => 0) as (actId: string) => number,
    /** holder and app-db calls started or ended; calls in flight that are not held at a point */
    activity: 0,
    busy: 0,
  })
  return { fresh, cur: fresh(), hit: new Set<string>() }
})
type Run = ReturnType<typeof S.fresh>
const holderOf = (run: Run) => run.holders.at(-1) as HolderLike
const dbOf = (run: Run) => run.dbs.at(-1) as AppDb

/** a holder or app-db call: activity at its start and end, in flight until it settles */
function counted<F extends (...a: never[]) => unknown>(run: Run, f: F): F {
  return ((...a: Parameters<F>) => {
    run.activity++
    const r = f(...a)
    if (!(r instanceof Promise)) return r
    run.busy++
    return r.finally(() => {
      run.busy--
      run.activity++
    })
  }) as F
}
function countedAll<T extends object>(run: Run, o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'function' ? counted(run, v as (...a: never[]) => unknown) : v
  return out as T
}

/** a hold point; `inside`: reached within a counted call, which is not busy while held */
async function at(run: Run, point: string, actId: string, inside = true): Promise<'refuse' | null> {
  if (!run.decide) return null
  const b = run.decide(point, actId)
  const g = run.gestureOf(actId.split(':')[0]!)
  if (g > 0) S.hit.add(`${g}:${point}/${b}`)
  if (b === 'fail') throw new Error(`injected failure at ${point}`)
  if (b === 'hold') {
    if (inside) run.busy--
    await new Promise<void>((release) => run.held.push({ point, release }))
    if (inside) run.busy++
    run.activity++
  }
  return b === 'refuse' ? 'refuse' : null
}

vi.mock('@real-life/trust-protocol', async (original) => {
  const lib = await original<{ createHolder: (...args: unknown[]) => Promise<HolderLike> }>()
  return {
    ...lib,
    createHolder: async (...args: unknown[]) => {
      const run = S.cur
      const h = await lib.createHolder(...args)
      run.holders.push(h)
      /** a part: never under an actId the library committed already (invariant 3) */
      const part = async (name: string, o: { when: number; actId: string }, call: () => Promise<Res>) => {
        // a refusal the library gives without committing (the contact exists)
        if ((await at(run, `part:${name}:before`, o.actId)) === 'refuse') return { ok: false, code: 'log-missing' }
        if ((await h.replay(o.actId, o.when)).ok) run.doubles.push(o.actId)
        const r = await call()
        await at(run, `part:${name}:after`, o.actId)
        return r
      }
      return countedAll(run, {
        ...h,
        block: (c: string, o: { when: number; actId: string }) => part('block', o, () => h.block(c, o)),
        unblock: (c: string, o: { when: number; actId: string }) => part('unblock', o, () => h.unblock(c, o)),
        pauseTrust: (c: string, p: boolean, o: { when: number; actId: string }) => part(p ? 'pause' : 'resume', o, () => h.pauseTrust(c, p, o)),
      })
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
      const run = S.cur
      const db = lib.idbAppDb(opts)
      run.dbs.push(db)
      return countedAll(run, {
        ...db,
        write: async (writes: readonly AppWrite[]) => {
          const recs = writes.map(recOf).filter((r): r is IntentRecord => r !== null && ORDERED.includes(r.command))
          const journal = recs.find((r) => r.state === 'journaled' && r.attempts === 0)
          const finish = recs.find((r) => r.state === 'done' && r.outcome?.ok !== false)
          const kind = journal ? 'journal' : finish ? 'finish' : null
          const actId = (journal ?? finish)?.actId ?? ''
          if (kind) await at(run, `${kind}:before`, actId)
          await db.write(writes)
          if (kind) await at(run, `${kind}:after`, actId)
        },
      })
    },
  }
})

// ── one run ─────────────────────────────────────────────────────────────────

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw Error(v.status)
  return v.value
}
/** Calm: no counted call in flight beyond the held ones, and no call started or ended for CALM_TURNS
 *  macrotask turns in a row. Counted in turns, never in wall time. */
const CALM_TURNS = 3
const CALM_MAX = 5000
async function calm(run: Run, signal: AbortSignal) {
  let last = -1, still = 0
  for (let i = 0; i < CALM_MAX; i++) {
    await new Promise((r) => setTimeout(r, 0))
    signal.throwIfAborted()
    still = run.busy === 0 && run.activity === last ? still + 1 : 0
    if (still >= CALM_TURNS) return
    last = run.activity
  }
  throw Error(`no calm within ${CALM_MAX} turns (busy ${run.busy})`)
}

async function world(run: Run, signal: AbortSignal) {
  const carrier = memoryCarrier(), clock = virtualClock(Date.parse('2026-10-15T20:30:00Z'), 'UTC')
  const A = await loopbackDevice({ carrier, clock, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], seed: 141 })
  // device B's own view of the clock: the timers it has pending (#428)
  const pending = new Set<symbol>()
  const bClock: typeof clock = {
    now: () => clock.now(),
    timeZone: () => clock.timeZone(),
    advance: (ms) => clock.advance(ms),
    set: (at) => clock.set(at),
    rewind: (ms) => clock.rewind(ms),
    setTimer(at, cb) {
      const key = Symbol()
      pending.add(key)
      const cancel = clock.setTimer(at, () => {
        pending.delete(key)
        cb()
      })
      return () => {
        pending.delete(key)
        cancel()
      }
    },
  }
  const B = await loopbackDevice({ carrier, clock: bClock, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], seed: 143 })
  // like pair.settle: until the carrier, both sessions and the calls are at rest
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      const before = run.activity
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
      await calm(run, signal)
      if (run.activity === before) return
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const bId = value(B.port.stores.contacts)[0]!.id
  await B.port.trust.counterVerify(bId).done
  await settle()
  return { B, clock, bId, pending }
}

const libState = async (run: Run) => {
  const c = (await holderOf(run).contacts())[0]!
  return { blocked: c.blocked, paused: c.trust.paused }
}
const openRecords = async (run: Run) =>
  ([...(await dbOf(run).readAll()).intents.values()] as IntentRecord[]).filter((r) => ORDERED.includes(r.command) && r.state !== 'done' && r.state !== 'expired')

/** Invariant 2 at a step: a partial state has an open record, and its completion is running or
 *  planned. Running: a gesture is unanswered or a step is held. Otherwise only the clock can complete
 *  it: with every point passing, the clock goes on in steps of 61 s (the longest wait of the backoff)
 *  until the state is whole, at most 4 steps; a partial state that outlasts them had nothing planned. */
async function noLostPartial(run: Run, signal: AbortSignal, context: object, running: boolean, clock: { advance(ms: number): void }) {
  const c = await libState(run)
  if (c.blocked === c.paused) return
  expect({ ...context, partial: c, open: (await openRecords(run)).length > 0 }).toEqual({ ...context, partial: c, open: true })
  if (running) return
  const decide = run.decide
  run.decide = null
  let after = c
  for (let i = 0; i < 4 && after.blocked !== after.paused; i++) {
    clock.advance(61_000)
    await calm(run, signal)
    after = await libState(run)
  }
  run.decide = decide
  expect({ ...context, partial: c, completedByPlan: after.blocked === after.paused }).toEqual({ ...context, partial: c, completedByPlan: true })
}

/** Rest like pair.settle: the clock goes on by 61 s per round until the library state, the open
 *  records and the session's sections stop changing for two rounds; an upper bound fails the run. */
async function rest(run: Run, signal: AbortSignal, B: { port: { session(): { idle(): Promise<void> } | null } }, clock: { advance(ms: number): void }, context: object) {
  const REST_MAX = 30
  let last = '', still = 0
  for (let i = 0; i < REST_MAX; i++) {
    await B.port.session()?.idle()
    await calm(run, signal)
    const now = JSON.stringify([await libState(run), (await openRecords(run)).map((r) => [r.actId, r.state, r.attempts])])
    still = now === last ? still + 1 : 0
    last = now
    if (still >= 2) return
    clock.advance(61_000)
  }
  throw Error(`no rest after ${REST_MAX} rounds (${JSON.stringify(context)}), last ${last}`)
}

async function play(run: Run, seed: number, signal: AbortSignal): Promise<void> {
  const r = rng(seed)
  const w = await world(run, signal)
  // the session's own dedupe read, the one point inside the command service (RltpFaults.probe)
  w.B.faults.probe = async (p, actId) => void (await at(run, p, actId, false))
  const log: string[] = []
  if (r.next() < 0.5) expect((await w.B.port.trust.block({ kind: 'contact', contactId: w.bId }).done).ok).toBe(true)
  const plan = [...PLAN]
  const taken: { g: Gesture; actId: string; journaled: Promise<boolean>; done: Promise<unknown>; answered: boolean }[] = []
  run.gestureOf = (actId) => taken.findIndex((t) => t.actId === actId) + 1
  const used = new Set<string>()
  // one lock per run at a point chosen by the seed, so every point meets a lock and a deadline over
  // the runs; a second lock may follow at random
  const combo = LOCK_COMBOS[seed % LOCK_COMBOS.length]!
  const lockAt = { point: combo.point, deadline: combo.deadline, armed: false, done: false }
  run.decide = (p, actId) => {
    const x = r.next()
    const options = behavioursAt(p)
    // a fault at most once per point and gesture: the run must be able to finish
    // this run's lock point is held the first time it is reached; the lock follows as the next step
    if (p === lockAt.point && !lockAt.armed) {
      lockAt.armed = true
      return 'hold'
    }
    const key = `${run.gestureOf(actId.split(':')[0]!)}:${p}`
    if (options.length > 2 && !used.has(key) && x < 0.3) {
      used.add(key)
      return options[2 + r.int(options.length - 2)]!
    }
    return x < 0.6 ? 'hold' : 'pass'
  }
  let locks = 0
  const releaseAll = async () => {
    while (run.held.length) {
      run.held.splice(0).forEach((h) => h.release())
      await calm(run, signal)
    }
  }
  const relock = async (deadline: boolean) => {
    // the lock starts while points are held; what is held is let go only then, so the sections meet
    // the closed opening wherever they stand
    for (const h of run.held) S.hit.add(`${deadline ? 'deadline' : 'lock'}@${h.point}`)
    // a recovery planned on the clock: an open record that failed an attempt, nothing running
    const planned = !run.held.length && taken.every((t) => t.answered) && (await openRecords(run)).length > 0
    if (planned) S.hit.add(`${deadline ? 'deadline' : 'lock'}@planned-recovery`)
    const decide = run.decide
    run.decide = null
    const locking = w.B.port.runtime.lock('user')
    await releaseAll()
    await locking
    // the ended opening keeps no timer, a planned recovery included (#428)
    expect({ ...context(), planned, timersAfterLock: w.pending.size }).toEqual({ ...context(), planned, timersAfterLock: 0 })
    if (deadline) w.clock.advance(89 * 86_400_000 + 1)
    run.decide = decide
    await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.B.port.runtime.unlock.open()
    await calm(run, signal)
  }
  const context = () => ({ seed, log: [...log] })
  for (let step = 0; step < 60; step++) {
    signal.throwIfAborted()
    const x = r.next()
    if (!lockAt.done && run.held.some((h) => h.point === lockAt.point)) {
      lockAt.done = true
      locks++
      log.push(`${lockAt.deadline ? 'deadline' : 'lock'} holding ${run.held.map((h) => h.point).join(',')}`)
      await relock(lockAt.deadline)
    } else if (plan.length && (x < 0.35 || !run.held.length)) {
      const g = plan.shift()!
      log.push(g)
      const h = g === 'block' ? w.B.port.trust.block({ kind: 'contact', contactId: w.bId }) : w.B.port.trust.unblock({ kind: 'contact', contactId: w.bId })
      const t = { g, actId: h.actId, journaled: h.journaled ?? Promise.resolve(false), done: h.done, answered: false }
      void h.done.then(() => (t.answered = true))
      taken.push(t)
    } else if (run.held.length && (locks >= 2 || r.next() >= 0.1)) {
      const [h] = run.held.splice(r.int(run.held.length), 1)
      log.push(`release ${h!.point}`)
      h!.release()
    } else {
      locks++
      const deadline = r.next() < 0.5
      log.push(`${deadline ? 'deadline' : 'lock'} holding ${run.held.map((h) => h.point).join(',')}`)
      await relock(deadline)
    }
    await calm(run, signal)
    if (process.env.TRACE) process.stderr.write(`${seed} ${step} ${log.at(-1)} [${run.held.map((h) => h.point).join(',')}]\n`)
    await noLostPartial(run, signal, context(), run.held.length > 0 || taken.some((t) => !t.answered), w.clock)
    if (!plan.length && !run.held.length) break
  }
  // a recovery still planned (an open record, nothing running) meets a lock or the deadline
  if (!run.held.length && taken.every((t) => t.answered) && (await openRecords(run)).length > 0 && r.next() < 0.8) {
    const deadline = r.next() < 0.5
    log.push(`${deadline ? 'deadline' : 'lock'} with a planned recovery`)
    await relock(deadline)
    await noLostPartial(run, signal, context(), false, w.clock)
  }
  // rest: nothing is held any more; planned recoveries run (backoff, then every 60 s)
  run.decide = null
  await releaseAll()
  await Promise.all(taken.map((t) => t.done))
  await rest(run, signal, w.B, w.clock, context())
  const accepted: Gesture[] = []
  for (const t of taken) if (await t.journaled) accepted.push(t.g)
  const contact = value(w.B.port.stores.contacts)[0]!
  const open = w.B.port.stores.intents.get().filter((i) => ORDERED.includes(i.command))
  const last = accepted.at(-1)
  const ctx = { ...context(), accepted }
  if (last) expect({ ...ctx, blocked: contact.blocked }).toEqual({ ...ctx, blocked: last === 'block' })
  expect({ ...ctx, partial: contact.blocked !== contact.trust.paused, open }).toEqual({ ...ctx, partial: false, open: [] })
  expect({ ...ctx, doubles: run.doubles }).toEqual({ ...ctx, doubles: [] })
}

// ── batches ─────────────────────────────────────────────────────────────────

const ONE = process.env.SEED ? Number(process.env.SEED) : null
// 80 seeds (1000 to 1079) in batches of two: a run takes 1 to 3 s alone and up to about 6 s under
// the full suite's load in CI (2 to 3 times slower), so a batch stays well below its timeout
const SEEDS = 80
const BATCH = 2
for (let b = 0; b < SEEDS / BATCH; b++) {
  it(`contact order interleavings, batch ${b + 1}`, { timeout: 25_000 }, async ({ signal }) => {
    const seeds = ONE !== null ? (b === 0 ? [ONE] : []) : Array.from({ length: BATCH }, (_, i) => 1000 + b * BATCH + i)
    for (const seed of seeds) {
      const run = (S.cur = S.fresh())
      const t0 = Date.now()
      try {
        await play(run, seed, signal)
        if (process.env.TRACE) process.stderr.write(`seed ${seed}: ${Date.now() - t0} ms\n`)
      } finally {
        run.decide = null
        run.held.splice(0).forEach((h) => h.release())
      }
    }
  })
}

afterAll(() => {
  if (ONE !== null) return
  expect(CELLS.filter((c) => !S.hit.has(c))).toEqual([])
})
