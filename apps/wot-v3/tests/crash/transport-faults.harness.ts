// Fault injection against the transport adapter contract (src/adapters/rltp/TRANSPORT.md) through the
// real rltp adapter and two real holders. A seeded simulated carrier misbehaves at every callback the
// adapter has with it: connect (status), start, stop, deposit, receive, answer (a report) and close
// (holder.close in the shutdown order); each one throws, is late and answers after the next step,
// answers to an earlier generation, or answers twice. A seeded generator runs acts on both sides,
// deliveries, resumes, locks, process ends, reopenings and clock jumps (forward and back).
// Invariants after every step and at the end:
//  - custody: the holder records accepted (or an ack sent) only for what the carrier durably accepted,
//    gives up nothing on a fault, so pendingTransport names every document the carrier has not taken;
//  - nothing is deposited again once the holder recorded it accepted;
//  - nothing is deposited while no opening is in use (after a lock began, before the next activation);
//  - an answer of a retired generation (or while no opening is in use) is 'later', never final, and a
//    report to a retired generation has no effect;
//  - an envelope for this holder is never answered 'not-mine'; 'taken' only for what the holder keeps;
//  - every cell (callback × behaviour) is hit by some run, else red.
// At the end (online, no faults) every document of A is accepted or given up by its deadline, and the
// carrier holds nothing for A any more. A failing run names its seed and the step log; `SEED=<n>`
// reruns one seed alone.
import { expect } from 'vitest'
import { lib } from './transport-faults.lib'
import { IDBFactory } from 'fake-indexeddb'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { memoryCarrier, type Transport, type TransportHandlers, type TransportStatus } from '../../src/adapters/rltp/transport'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import { holderDbName } from '../../src/adapters/rltp/session'
import { RETRY_HORIZON_MS } from '../../src/adapters/rltp/journal'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import type { HolderHandle } from '../../src/adapters/identity/host'
import type { ClockPort } from '../../src/platform/ports'

type Outbound = Parameters<Transport['submit']>[0][number]
type DeliveryReport = Parameters<TransportHandlers['report']>[0]
/** the reason a stale report carries: the carrier sends it never else, so a holder that records it obeyed a retired generation */
const STALE = 'oversize'
/** the reason of a valid failure the carrier reports to the generation in use */
const UNROUTABLE = 'unroutable'

const isAckType = (type: string) => type.includes('delivery-ack')
const CALLBACKS = ['connect', 'start', 'stop', 'deposit', 'receive', 'answer', 'close'] as const
const BEHAVIOURS = ['throws', 'late', 'stale', 'double'] as const
/** the further forms of a callback's fault, each a cell of its own */
const FORMS = [
  'deposit/throws-after-acceptance',
  'deposit/throws-after-start',
  'deposit/withdraw-throws',
  'deposit/withdraw-late-effect',
  'stop/late-effect',
  'deposit/slow-across-due-times',
  'answer/failed-with-open-deposits',
  'answer/during-withdraw',
  'answer/ended',
  'deposit/handOver-rejects',
  'deposit/pendingTransport-rejects',
  'receive/rate-limited',
  'answer/next-state',
  'close/throws-holder-open',
  'close/direct-during-receive',
  'report/late-delivered-after-failed',
  // a duplicate's answer begun while the regular acknowledgement of its digest is still pending, then
  // the regular retries end (#426): the carrier takes the answer, the carrier fails one regular
  // deposit first, or the opening shuts down with both pending
  'answer/begun-before-horizon',
  'answer/begun-before-horizon-regular-failed',
  'answer/begun-before-horizon-shutdown',
] as const
type Cell = `${(typeof CALLBACKS)[number]}/${(typeof BEHAVIOURS)[number]}` | (typeof FORMS)[number]
export const CELLS: Cell[] = [...CALLBACKS.flatMap((c) => BEHAVIOURS.map((b) => `${c}/${b}` as Cell)), ...FORMS]
export const visited = new Set<Cell>()

function rng(seed: number) {
  let a = seed >>> 0 || 1
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T }
}

const T0 = Date.parse('2026-10-20T10:00:00Z')
const DAY = 86_400_000
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** one start of a device transport, as the carrier sees it */
interface Gen {
  readonly id: number
  readonly h: TransportHandlers
  /** the carrier still delivers to it */
  live: boolean
  /** the adapter retired it: stop was called, a newer start replaced it, or its process ended */
  retired: boolean
}
interface Mail {
  readonly digest: string
  readonly env: unknown
}

/** The simulated carrier of device A: a mailbox for A (B's documents), durable acceptance of A's
 *  deposits (idempotent per digest), and one armed fault per cell at a time. */
function simCarrier(log: string[], violations: string[]) {
  const gens: Gen[] = []
  let current: Gen | null = null
  let online = true
  const mailbox: Mail[] = []
  /** durably accepted deposits: how often each digest was deposited after its acceptance */
  const accepted = new Set<string>()
  /** the order of calls into the carrier: a deposit's place, to tell a late effect from a bound one */
  let seq = 0
  const inflight: { o: Outbound; gen: Gen | null; at: number }[] = []
  let afterStep: (() => Promise<void> | void)[] = []
  /** effects that land right after the next start (a late stop) */
  let afterStart: (() => void)[] = []
  const armed = new Set<Cell>()
  const hit = (c: Cell) => {
    if (!armed.delete(c)) return false
    visited.add(c)
    log.push(`  ! ${c}`)
    return true
  }
  const older = () => [...gens].reverse().find((g) => g !== current) ?? null
  /** the holder recorded these accepted (last observation): never deposited again */
  const holderAccepted = new Set<string>()
  const ctx = { inUse: true, generation: 0, final: false }
  /** withdrawals the carrier refused, by digest, until one goes through */
  const withdrawRefused = new Set<string>()
  /** deposits begun by a submit that threw: held until the end */
  const slow = new Set<string>()
  /** deposits the carrier holds without taking them until the end, however often they come again */
  const slowDigests = new Set<string>()
  /** digests the carrier gives up (a valid failed report) while further deposits of them are pending */
  const failSoon = new Set<string>()
  /** digests the carrier reported failed to the generation in use */
  const carrierFailed = new Set<string>()
  /** the withdrawal a failure causes is answered synchronously: the carrier delivered the document after
   *  all; both state changes reach the holder, in turn */
  const answerInWithdrawal = new Set<string>()
  /** the carrier took these inside a withdrawal, in the generation in use: the holder records it */
  const mustAccept = new Set<string>()
  /** every deposit is held (not taken) while the cell answer/ended runs */
  const hold = { all: false }
  /** the envelopes A took, to deliver one again later */
  const takenEnv = new Map<string, unknown>()
  /** reported accepted, then delivered, to the generation in use: the holder must record delivered */
  const mustDeliver = new Set<string>()
  /** reported failed, then a late valid acknowledgement (delivered), to the generation in use: the
   *  holder must end at delivered (Delivery §6.1, TRANSPORT.md rule 6) */
  const mustDeliverLate = new Set<string>()
  /** the holder gave these up (last observation): no deposit of them may still complete */
  const holderGaveUp = new Set<string>()
  /** documents A took once and the carrier offers again (a duplicate), until A answers one taken */
  const redelivered = new Set<string>()
  /** duplicates A answered taken: each owes one answer, begun at the carrier (review 420 R23-2) */
  const answersOwed = new Set<string>()
  /** a duplicate's answer by digest: the carrier took it, or a closing opening withdrew it */
  const answerTaken = new Set<string>()
  const answerWithdrawnAtClose = new Set<string>()
  const isAnswer = (o: Outbound) => (o as { resend?: number }).resend !== undefined
  /** every duplicate's answer the carrier began, by its own deposit object (#426): it ends taken by the
   *  carrier or withdrawn by a closing opening, never withdrawn in use, never ended by another deposit
   *  of its digest (a regular one failed, withdrawn or given up) */
  const answers = new Map<Outbound, 'pending' | 'taken' | 'failed' | 'withdrawn-at-close'>()

  // connect: the carrier's status, with listeners that a stale notification still reaches
  const listeners: { fn: () => void; removed: boolean }[] = []
  let status: TransportStatus = { network: 'online', carrier: 'connected' }
  const notify = () => {
    const stale = hit('connect/stale')
    const times = hit('connect/double') ? 2 : 1
    for (let i = 0; i < times; i++)
      for (const l of [...listeners]) {
        if (l.removed && !stale) continue
        try {
          l.fn()
        } catch (e) {
          violations.push(`status listener threw: ${String(e)}`)
        }
      }
  }
  const statusStore = {
    get(): TransportStatus {
      if (hit('connect/throws')) throw Error('injected status failure')
      return status
    },
    subscribe(fn: () => void) {
      const l = { fn, removed: false }
      listeners.push(l)
      return () => {
        l.removed = true
      }
    },
  }
  const setOnline = (v: boolean) => {
    if (online === v) return
    online = v
    status = v ? { network: 'online', carrier: 'connected' } : { network: 'offline', carrier: 'unreachable' }
    if (hit('connect/late')) afterStep.push(notify)
    else notify()
  }

  const answer = (gen: Gen, staleAtCall: boolean, digest: string, a: string) => {
    log.push(`  envelope ${digest.slice(0, 8)} -> gen ${gen.id}${staleAtCall || gen.retired ? ' (retired)' : ''}: ${a}`)
    if (a === 'not-mine') violations.push(`envelope ${digest.slice(0, 10)} for A answered not-mine (gen ${gen.id})`)
    if (a !== 'later' && (staleAtCall || gen.retired)) violations.push(`final answer '${a}' from retired generation ${gen.id}`)
    if (a !== 'later' && !ctx.inUse) violations.push(`final answer '${a}' while no opening is in use`)
    if (a === 'taken') {
      const i = mailbox.findIndex((m) => m.digest === digest)
      if (i >= 0) takenEnv.set(digest, mailbox[i]!.env)
      if (i >= 0) mailbox.splice(i, 1)
      taken.add(digest)
      if (redelivered.delete(digest)) answersOwed.add(digest)
    }
  }
  const taken = new Set<string>()
  const deliver = async (gen: Gen, m: Mail) => {
    const staleAtCall = gen.retired
    // a receive that throws, or a transient answer of the library (rate-limited, RLTP-DEL-5820)
    if (hit('receive/throws')) lib.failReceive = 'throws'
    else if (hit('receive/rate-limited')) lib.failReceive = 'rate-limited'
    let a: string
    try {
      a = await gen.h.envelope(JSON.parse(JSON.stringify(m.env)) as unknown)
    } catch (e) {
      violations.push(`envelope handler threw: ${String(e)}`)
      return
    }
    answer(gen, staleAtCall, m.digest, a)
  }
  const report = (gen: Gen | null, r: DeliveryReport, deposit?: Outbound) => {
    if (!gen) return
    // a failure naming an answer ends that answer alone (rule 6)
    if (r.status === 'failed' && deposit && answers.get(deposit) === 'pending') answers.set(deposit, 'failed')
    try {
      gen.h.report(r, deposit)
    } catch (e) {
      violations.push(`report handler threw: ${String(e)}`)
    }
  }
  const send = (gen: Gen | null, r: DeliveryReport, deposit?: Outbound) => {
    if (hit('answer/throws')) lib.failReport = true
    if (hit('answer/stale')) {
      // a report computed for an earlier start: if it had an effect, the holder would give the document up
      report(older(), { digest: r.digest, status: 'failed', reason: STALE })
    }
    const double = hit('answer/double')
    const late = hit('answer/late')
    // twice: the same answer again, or the next state change (accepted, then delivered)
    const next: DeliveryReport | null = r.status === 'accepted' && hit('answer/next-state') ? { digest: r.digest, status: 'delivered', late: false } : null
    if (next && !late && gen && !gen.retired && !lib.failReport) mustDeliver.add(r.digest)
    const go = () => {
      report(gen, r, deposit)
      if (double) report(gen, r, deposit)
      if (next) report(gen, next, deposit)
    }
    if (late) afterStep.push(go)
    else queueMicrotask(go)
  }
  const accept = (o: Outbound, gen: Gen | null) => {
    accepted.add(o.digest)
    if (isAnswer(o)) answerTaken.add(o.digest)
    // the carrier takes a digest once: every answer of it ends, whichever deposit was taken (rule 6)
    for (const [x, st] of answers) if (st === 'pending' && x.digest === o.digest) answers.set(x, 'taken')
    send(gen, { digest: o.digest, status: 'accepted' }, o)
  }

  const carrier = {
    mustAccept,
    hold,
    takenEnv,
    /** delivers an envelope A took already once more (a duplicate after the ack retries ended) */
    redeliver(digest: string) {
      const env = takenEnv.get(digest)
      if (!env) return
      mailbox.push({ digest, env })
      redelivered.add(digest)
    },
    answersOwed,
    answers,
    /** the carrier gives one regular deposit of this digest up (a valid failure naming it), the others stay */
    failRegular(digest: string): boolean {
      const i = inflight.findIndex((x) => x.o.digest === digest && !isAnswer(x.o))
      if (i < 0 || !current?.live) return false
      const [x] = inflight.splice(i, 1)
      report(current, { digest, status: 'failed', reason: UNROUTABLE }, x!.o)
      return true
    },
    /** the duplicate's answers of this digest the carrier still holds */
    heldAnswers: (digest: string) => inflight.filter((x) => x.o.digest === digest && isAnswer(x.o)).length,
    /** the regular deposits of this digest the carrier still holds */
    heldRegular: (digest: string) => inflight.filter((x) => x.o.digest === digest && !isAnswer(x.o)).length,
    answerTaken,
    answerWithdrawnAtClose,
    carrierFailed,
    mustDeliver,
    mustDeliverLate,
    holderGaveUp,
    inflight,
    armed,
    accepted,
    taken,
    mailbox,
    holderAccepted,
    ctx,
    setOnline,
    isOnline: () => online,
    arm: (c: Cell) => armed.add(c),
    /** B's documents for A arrive at the carrier */
    post(o: Outbound) {
      if (!mailbox.some((m) => m.digest === o.digest) && !taken.has(o.digest)) mailbox.push({ digest: o.digest, env: JSON.parse(JSON.stringify(o.envelope)) as unknown })
    },
    /** a process ended: everything it started is retired */
    retireAll() {
      for (const g of gens) g.retired = true
    },
    /** one step of the carrier: what was late happens, in-flight deposits are taken, the mailbox is
     *  offered to the current start (or, by a fault, to another) */
    async pump() {
      const late = afterStep
      afterStep = []
      for (const f of late) await f()
      // a valid failure on one deposit while others of the digest are still pending at the carrier
      for (const d of [...failSoon]) {
        const pending = inflight.filter((x) => x.o.digest === d)
        if (pending.length < 2 || !current?.live) continue
        failSoon.delete(d)
        carrierFailed.add(d)
        visited.add('answer/failed-with-open-deposits')
        log.push(`  ! answer/failed-with-open-deposits ${d.slice(0, 8)} (${pending.length} pending)`)
        answerInWithdrawal.add(d)
        // the failure names its deposit: the other deposits of the digest stay pending (rule 6)
        report(current, { digest: d, status: 'failed', reason: UNROUTABLE }, pending[0]!.o)
      }
      // the carrier gives a deposit up, then its acknowledgement arrives after all: failed, then a late
      // delivered naming only the digest; the deposit has left the lease, its routing has not
      const g = current
      const gaveUp = online && g?.live && !g.retired && !hold.all ? inflight.find((x) => x.gen === g && !isAckType(x.o.type) && !withdrawRefused.has(x.o.digest) && !slowDigests.has(x.o.digest)) : undefined
      if (g && gaveUp && hit('report/late-delivered-after-failed')) {
        const d = gaveUp.o.digest
        // the failure names one deposit; the carrier delivers the document all the same, every deposit of it ends
        const rest = inflight.filter((x) => x.o.digest !== d)
        inflight.splice(0, inflight.length, ...rest)
        carrierFailed.add(d)
        accepted.add(d)
        report(g, { digest: d, status: 'failed', reason: UNROUTABLE }, gaveUp.o)
        afterStep.push(() => {
          if (current !== g || !g.live || g.retired || !ctx.inUse) return
          mustDeliverLate.add(d)
          report(g, { digest: d, status: 'delivered', late: true })
        })
      }
      if (online) {
        for (const x of inflight.splice(0)) {
          // a carrier whose withdrawal failed is unwell: it holds the deposit until the adapter tried again
          if (withdrawRefused.has(x.o.digest)) {
            if (!ctx.final) {
              inflight.push(x)
              continue
            }
            if (!slow.has(x.o.digest)) violations.push(`deposit ${x.o.digest.slice(0, 10)} completed although its withdrawal was refused and never tried again`)
          }
          if ((slowDigests.has(x.o.digest) || hold.all) && !ctx.final) {
            inflight.push(x)
            continue
          }
          if (holderGaveUp.has(x.o.digest)) violations.push(`the carrier took ${x.o.digest.slice(0, 10)}, which the holder gave up`)
          accept(x.o, x.gen)
        }
      }
      const work: Promise<void>[] = []
      if (online && mailbox.length > 0) {
        const m = mailbox[0]!
        let target = current?.live ? current : null
        if (hit('start/stale') || hit('receive/stale')) target = older() ?? target
        if (target) {
          if (hit('receive/late')) {
            const g = target
            afterStep.push(() => deliver(g, m))
          } else {
            const twice = hit('receive/double') || hit('start/double')
            work.push(deliver(target, m))
            if (twice) work.push(deliver(target, m))
          }
        }
        for (const rest of mailbox.slice(1)) if (target === current && target) work.push(deliver(target, rest))
      }
      await Promise.all(work)
    },
    /** delivers what waits through the given start, whatever its state (a carrier that is slow to stop) */
    async through(gen: Gen | null) {
      if (!gen) return
      await Promise.all(mailbox.map((m) => deliver(gen, m)))
    },
    current: () => current,
    endpoint(): Transport {
      const mine: Gen[] = []
      return {
        status: statusStore,
        start(h) {
          if (current) current.live = false
          for (const g of gens) if (g !== current) g.live = false
          const g: Gen = { id: ++ctx.generation, h, live: true, retired: false }
          for (const m of mine) m.retired = true
          gens.push(g)
          mine.push(g)
          current = g
          log.push(`  start gen ${g.id}`)
          const landing = afterStart
          afterStart = []
          for (const f of landing) f()
          if (hit('start/late')) {
            g.live = false
            afterStep.push(() => {
              if (current === g) g.live = true
            })
          }
          if (hit('start/throws')) throw Error('injected start failure')
        },
        stop(registration?: TransportHandlers) {
          // a bound stop names its registration; an unbound one ends whatever runs when it takes effect
          const callAt = ctx.generation
          const target = () => (registration ? (gens.find((x) => x.h === registration) ?? null) : current)
          const g = registration ? target() : (mine.at(-1) ?? null)
          if (!g) return
          g.retired = true
          log.push(`  stop gen ${g.id}`)
          const apply = (x: Gen | null) => {
            if (!x) return
            x.live = false
            if (current === x) current = null
          }
          if (hit('stop/late-effect')) {
            // the stop began, its confirmation is lost: it takes effect after the carrier's next start
            afterStart.push(() => {
              const x = target()
              if (x && x.id > callAt) violations.push(`a late stop ended generation ${x.id}, started after the stop was called`)
              apply(x)
            })
            throw Error('injected stop failure, stop begun')
          }
          if (hit('stop/throws')) throw Error('injected stop failure')
          if (hit('stop/stale')) {
            // the carrier applied the stop to an earlier start: this one keeps receiving until the next stop
            apply(older())
            return
          }
          if (hit('stop/late')) {
            afterStep.push(() => apply(g))
            return
          }
          apply(g)
          if (hit('stop/double')) apply(g)
        },
        submit(out) {
          for (const o of out) {
            log.push(`  deposit ${o.type.split('/').at(-1)} ${o.digest.slice(0, 8)}${online ? '' : ' (offline)'}`)
            if (!ctx.inUse) violations.push(`deposit ${o.digest.slice(0, 10)} while no opening is in use`)
            if (holderAccepted.has(o.digest)) violations.push(`deposit ${o.digest.slice(0, 10)} again after the holder recorded it accepted`)
          }
          const gen = hit('deposit/stale') ? older() : current
          const afterAcceptance = hit('deposit/throws-after-acceptance')
          const afterStart = !afterAcceptance && hit('deposit/throws-after-start')
          if (afterAcceptance || afterStart || hit('deposit/throws')) {
            // a deposit whose outcome is unknown: the carrier took the first document, or began it
            if (afterAcceptance && online && out[0]) accept(out[0], gen)
            if (afterStart)
              for (const o of out) {
                // begun and slow: the carrier completes it only at the end, unless it is withdrawn
                inflight.push({ o, gen, at: ++seq })
                withdrawRefused.add(o.digest)
                slow.add(o.digest)
              }
            throw Error('injected deposit failure')
          }
          if (!online) {
            for (const o of out) send(gen, { digest: o.digest, status: 'awaiting-transport', reason: 'offline' } as DeliveryReport)
            return
          }
          if (out.some((o) => !isAckType(o.type)) && hit('deposit/slow-across-due-times')) for (const o of out) slowDigests.add(o.digest)
          if (armed.has('answer/failed-with-open-deposits') && out.some((o) => !isAckType(o.type))) {
            armed.delete('answer/failed-with-open-deposits')
            for (const o of out) {
              slowDigests.add(o.digest)
              failSoon.add(o.digest)
            }
          }

          const late = hit('deposit/late')
          for (const o of out) if (isAnswer(o)) answers.set(o, 'pending')
          for (const o of out) {
            if (late) afterStep.push(() => void inflight.push({ o, gen, at: ++seq }))
            else inflight.push({ o, gen, at: ++seq })
            if (hit('deposit/double')) inflight.push({ o, gen, at: ++seq })
          }
        },
        withdraw(deposits) {
          // a bound withdrawal names its deposits; an unbound one (digests) drops whatever has the digest
          const items = deposits as readonly (Outbound | string)[]
          const matches = (x: { o: Outbound }) => items.some((d) => (typeof d === 'string' ? x.o.digest === d : x.o === d))
          const callAt = seq
          const drop = () => {
            for (const x of inflight) if (matches(x) && x.at > callAt) violations.push(`a late withdrawal dropped ${x.o.digest.slice(0, 10)}, deposited after the withdrawal was called`)
            const keep = inflight.filter((x) => !matches(x))
            inflight.splice(0, inflight.length, ...keep)
          }
          if (inflight.some(matches) && hit('deposit/withdraw-late-effect')) {
            // the withdrawal began, its confirmation is lost: it takes effect after the next step
            afterStep.push(drop)
            throw Error('injected withdraw failure, withdrawal begun')
          }
          if (inflight.some(matches) && hit('deposit/withdraw-throws')) {
            for (const x of inflight) if (matches(x)) withdrawRefused.add(x.o.digest)
            throw Error('injected withdraw failure')
          }
          for (const x of inflight) if (matches(x)) withdrawRefused.delete(x.o.digest)
          // a duplicate's answer whose entry ended by its own hand-over is never revoked (rule 6, R22-1)
          for (const x of inflight.filter(matches))
            if (isAnswer(x.o)) {
              if (ctx.inUse) violations.push(`the duplicate's answer ${x.o.digest.slice(0, 10)} was withdrawn while its opening was in use`)
              else {
                answerWithdrawnAtClose.add(x.o.digest)
                if (answers.get(x.o) === 'pending') answers.set(x.o, 'withdrawn-at-close')
              }
            }
          // the carrier answers inside the withdrawal: it took the deposit after all
          const took = inflight.find(matches)
          if (took?.gen && ctx.inUse && took.gen === current && hit('answer/during-withdraw')) {
            accepted.add(took.o.digest)
            mustAccept.add(took.o.digest)
            report(took.gen, { digest: took.o.digest, status: 'accepted' }, took.o)
          }
          for (const x of inflight.filter(matches)) {
            if (!answerInWithdrawal.delete(x.o.digest)) continue
            accepted.add(x.o.digest)
            report(x.gen, { digest: x.o.digest, status: 'delivered', late: true }, x.o)
          }
          drop()
        },
      }
    },
  }
  return carrier
}

interface CodecState {
  outbox: Record<string, { type: string; history: { status: string; reason?: string }[] }>
  effects: Record<string, { ack?: { digest: string; sent?: boolean } }>
}

export const RUNS = 15
/** the cells a seed arms for sure: together the runs hit every one */
export const forced = (seed: number) => CELLS.filter((_, i) => i % RUNS === (seed - 1) % RUNS)

type Op = 'redeliverOld' | 'redeliverEarly' | 'aScan' | 'aScanDue' | 'aScanExpire' | 'aScanLock' | 'bScan' | 'pump' | 'resume' | 'lock' | 'end' | 'offline' | 'online' | 'jump' | 'jumpDays' | 'jumpBack'
const OPS: readonly Op[] = ['aScan', 'bScan', 'pump', 'pump', 'resume', 'lock', 'end', 'offline', 'online', 'online', 'jump', 'jumpDays', 'jumpBack']
/** the operation that exercises a cell */
const OP_OF: Record<(typeof CALLBACKS)[number], Op[]> = {
  connect: ['offline', 'online'],
  start: ['lock'],
  stop: ['lock', 'end'],
  deposit: ['aScan'],
  receive: ['bScan'],
  answer: ['aScan'],
  close: ['lock'],
}

export async function run(seed: number) {
  const r = rng(seed * 7919 + 13)
  const log: string[] = []
  const violations: string[] = []
  lib.reset()
  lib.received.clear()
  // A opens first, B second: the library's faults are A's alone
  lib.created = 0
  lib.spare = 1
  const sim = simCarrier(log, violations)
  const vc = virtualClock(T0, 'UTC')
  let skew = 0
  const clockA: ClockPort = { now: () => vc.now() + skew, timeZone: () => 'UTC', setTimer: (at, cb) => vc.setTimer(at - skew, cb) }
  const idb = new IDBFactory()
  const keysA = { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) }
  const keysB = { rootIkm: new Uint8Array(64).fill(51), dek: new Uint8Array(32).fill(52) }
  const life = new Set<(s: 'active' | 'background') => void>()
  let ent = 900 + seed * 10
  const lifecycle = { onState(cb: (s: 'active' | 'background') => void) { life.add(cb); return () => void life.delete(cb) } }
  const makeA = () => rltpHolderHost({ idb, clock: clockA, entropy: fakeEntropy(ent++), transport: sim.endpoint(), writer: { acquire: async () => () => {} }, publish: () => {}, emit: () => {}, onCurrent: () => {}, lifecycle })
  const mc = memoryCarrier()
  const bT = mc.endpoint('B')
  // B's carrier hands every document of B to A's carrier
  const B = rltpHolderHost({ idb, clock: vc, entropy: fakeEntropy(ent++), transport: { ...bT, submit(out) { for (const o of out) sim.post(o); bT.submit(out) } }, writer: { acquire: async () => () => {} }, publish: () => {}, emit: () => {}, onCurrent: () => {}, lifecycle })
  let A = makeA()
  const a = await A.open('A', keysA), b = await B.open('B', keysB)
  if (a.kind !== 'ok' || b.kind !== 'ok') throw Error('open')
  let ah: HolderHandle = a.holder
  A.activate?.(ah)
  B.activate?.(b.holder)
  const sealer = await createSealer(keysA.dek)
  const store = idbHolderStore({ idb, name: holderDbName('A'), sealer, seal: { sealed: false }, uuid: () => crypto.randomUUID() })
  /** until rest (as pair.settle): no session work, no holder call, both revisions unchanged over two rounds */
  const settle = async () => {
    let last = ''
    let calm = 0
    for (let i = 0; i < 200; i++) {
      await mc.settled()
      await A.current()?.idle()
      await B.current()?.idle()
      await tick()
      const now = JSON.stringify([A.current()?.models()?.revision ?? null, B.current()?.models()?.revision ?? null])
      calm = now === last ? calm + 1 : 0
      last = now
      if (calm >= 2) return
    }
    throw Error(`settle: no rest after 200 rounds (seed ${seed})`)
  }
  const step = async () => {
    // a little time passes with every step: due timers run
    vc.advance(2_000)
    await settle()
    await sim.pump()
    await settle()
  }
  const shutdown = async () => {
    sim.ctx.inUse = false
    A.deactivate?.()
    await A.quiesce(ah)
    await A.seal(ah)
    await A.close(ah)
  }
  /** the host closes the opening in use directly, without a lock first */
  const closeOnly = async () => {
    sim.ctx.inUse = false
    await A.close(ah)
  }
  const reopen = async (fresh: boolean) => {
    if (fresh) {
      sim.retireAll()
      A = makeA()
    }
    for (let i = 0; ; i++) {
      const o = await A.open('A', keysA).catch((e: unknown) => ({ kind: `threw ${String(e)}` }))
      if (o.kind === 'ok' && 'holder' in o) {
        ah = o.holder
        break
      }
      // a failed close of the earlier opening is tried again by the next open; a third failure is red
      if (i >= 2) throw Error(`reopen: ${o.kind}`)
    }
    sim.ctx.inUse = true
    A.activate?.(ah)
    await settle()
  }
  /** every document A's holder owed so far, with its last status: custody independent of the holder's view */
  const ledger = new Map<string, string>()
  const TERMINAL = new Set(['accepted', 'delivered', 'failed'])
  /** A's holder state, read-only */
  const observe = async () => {
    const st = (await store.read()).state as unknown as CodecState
    for (const [d, s] of ledger) if (!(d in st.outbox) && !TERMINAL.has(s)) violations.push(`${d.slice(0, 10)} left the holder's custody while ${s}`)
    // a failure the carrier gave the generation in use reaches the holder, whatever followed (R21-1)
    for (const d of sim.carrierFailed) if (d in st.outbox && !st.outbox[d]!.history.some((h) => h.status === 'failed')) violations.push(`${d.slice(0, 10)}: the carrier's failed report never reached the holder`)
    for (const d of sim.mustAccept) {
      const last = st.outbox[d]?.history.at(-1)?.status
      if (last !== undefined && last === 'submitted') violations.push(`${d.slice(0, 10)}: the carrier took it inside a withdrawal, the holder never heard`)
    }
    sim.mustAccept.clear()
    for (const d of sim.mustDeliver) {
      const last = st.outbox[d]?.history.at(-1)?.status
      if (last !== undefined && last !== 'delivered' && last !== 'failed') violations.push(`${d.slice(0, 10)} reported delivered to its generation, the holder records ${last}`)
    }
    sim.mustDeliver.clear()
    for (const d of sim.mustDeliverLate) {
      const last = st.outbox[d]?.history.at(-1)?.status
      if (last !== undefined && last !== 'delivered') violations.push(`${d.slice(0, 10)}: a late delivered after failed reached its generation, the holder records ${last}`)
    }
    sim.mustDeliverLate.clear()
    for (const f of lib.fired.splice(0)) {
      const c: Cell = f === 'handOver' ? 'deposit/handOver-rejects' : 'deposit/pendingTransport-rejects'
      visited.add(c)
      log.push(`  ! ${c} (fired)`)
    }
    for (const [d, o] of Object.entries(st.outbox)) {
      const last = o.history.at(-1)
      if (last) ledger.set(d, last.status)
      if (last?.status === 'failed') sim.holderGaveUp.add(d)
      if (last?.status === 'accepted' || last?.status === 'delivered') {
        sim.holderAccepted.add(d)
        if (!sim.accepted.has(d)) violations.push(`holder records ${d.slice(0, 10)} ${last.status}, the carrier never took it`)
      }
      if (o.history.some((h) => h.status === 'failed' && h.reason === STALE)) violations.push(`a report to a retired generation gave up ${d.slice(0, 10)}`)
      if (last?.status === 'failed' && last.reason !== STALE && last.reason !== 'task-expired' && last.reason !== 'expired-by-adapter-policy' && !(last.reason === UNROUTABLE && sim.carrierFailed.has(d))) violations.push(`${d.slice(0, 10)} given up on a fault: ${last.reason}`)
    }
    for (const [d, e] of Object.entries(st.effects)) {
      if (e.ack?.sent && (e.ack as { sentBy?: string }).sentBy !== 'horizon' && !sim.accepted.has(e.ack.digest)) violations.push(`ack of ${d.slice(0, 10)} recorded sent, the carrier never took it`)
    }
    for (const d of sim.taken) if (!lib.received.has(d)) violations.push(`envelope ${d.slice(0, 10)} answered taken, the holder never answered it`)
    return st
  }
  /** the scanner confirms the shower's fresh card: the scanner's bundle goes to the shower */
  const scan = async (shower: typeof A, scanner: typeof A, k: number) => {
    const card = await shower.current()!.intent<{ qr: string }>('showCard', '', `show-${k}`, {}).done
    if (!card.ok) throw Error(`show ${JSON.stringify(card)}`)
    const done = await scanner.current()!.intent('confirmCard', '', `scan-${k}`, { card: decodeCardLink(card.value.qr), role: 'displayed' }).done
    if (!done.ok) throw Error(`scan ${JSON.stringify(done)}`)
  }
  let n = 0
  try {
    await scan(A, B, ++n)
    await step()
    await scan(B, A, ++n)
    await step()
    const plan = forced(seed)
    const at = new Map<number, Cell>()
    plan.forEach((c, i) => at.set(i * 3 + r.int(2), c))
    for (let i = 0; i < Math.max(9, plan.length * 3); i++) {
      const c = at.get(i)
      let op: Op = r.pick(OPS)
      if (c) {
        sim.arm(c)
        op = r.pick(OP_OF[c.split('/')[0] as (typeof CALLBACKS)[number]] ?? ['aScan'])
        if (c.startsWith('connect')) op = sim.isOnline() ? 'offline' : 'online'
        // a cell of the carrier's traffic needs the network
        if (/^(deposit|answer|receive|report)\//.test(c)) sim.setOnline(true)
        if (c === 'deposit/withdraw-throws' || c === 'deposit/withdraw-late-effect') op = 'aScanLock'
        if (c === 'deposit/throws-after-start' || c === 'deposit/slow-across-due-times') op = 'aScanExpire'
        if (c === 'answer/failed-with-open-deposits') op = 'aScanDue'
        if (c === 'answer/during-withdraw') op = 'aScanExpire'
        if (c === 'answer/ended') op = 'redeliverOld'
        if (c.startsWith('answer/begun-before-horizon')) op = 'redeliverEarly'
        if (c === 'report/late-delivered-after-failed') op = 'aScan'
        if (c === 'close/direct-during-receive') op = 'lock'
        if (c === 'deposit/handOver-rejects' || c === 'deposit/pendingTransport-rejects') {
          // the library's side of a hand-over: the next call rejects (the cell counts once it fired)
          sim.armed.delete(c)
          if (c === 'deposit/handOver-rejects') lib.failHandOver = true
          else lib.failPending = true
        }
      } else if (r.next() < 0.3) sim.arm(r.pick(CELLS))
      log.push(`${i}: ${op}${c ? ` [${c}]` : ''}`)
      switch (op) {
        case 'aScan':
          await scan(B, A, ++n).catch((e: unknown) => log.push(`  A scans: ${String(e)}`))
          break
        case 'redeliverOld': {
          // a document A took long ago comes again after its acknowledgement's retries ended: the
          // duplicate's answer goes out once and stays with the (slow) carrier; its entry ends (6330)
          const old = [...sim.takenEnv.keys()][0]
          if (!old) break
          sim.hold.all = true
          vc.advance(8 * DAY)
          for (const cb of life) cb('active')
          await settle()
          sim.redeliver(old)
          visited.add('answer/ended')
          sim.armed.delete('answer/ended')
          log.push(`  ! answer/ended ${old.slice(0, 8)}`)
          for (let k = 0; k < 4; k++) {
            await sim.pump()
            vc.advance(60_000)
            for (const cb of life) cb('active')
            await settle()
          }
          sim.hold.all = false
          break
        }
        case 'redeliverEarly': {
          // a document A takes now, its acknowledgement held by the (slow) carrier; one second before the
          // acknowledgement's retries end the document comes again: its answer begins while the regular
          // deposits are pending, and the regular retries end while the answer is in flight (#426)
          const cell = c ?? 'answer/begun-before-horizon'
          sim.armed.delete(cell)
          sim.setOnline(true)
          sim.hold.all = true
          const before = new Set(sim.takenEnv.keys())
          await scan(A, B, ++n).catch((e: unknown) => log.push(`  B scans: ${String(e)}`))
          await settle()
          for (let k = 0; k < 2 && [...sim.takenEnv.keys()].every((d) => before.has(d)); k++) {
            await sim.pump()
            await settle()
          }
          const fresh = [...sim.takenEnv.keys()].find((d) => !before.has(d))
          const ack = fresh ? (await observe()).effects[fresh]?.ack : undefined
          if (!fresh || !ack || ack.sent || sim.heldRegular(ack.digest) === 0) {
            log.push(`  (no pending acknowledgement to answer early)`)
            sim.hold.all = false
            break
          }
          const takenAt = vc.now()
          vc.advance(RETRY_HORIZON_MS - 30_000)
          for (const cb of life) cb('active')
          await settle()
          sim.redeliver(fresh)
          for (let k = 0; k < 2; k++) {
            await sim.pump()
            await settle()
          }
          if (sim.heldAnswers(ack.digest) === 0 || sim.heldRegular(ack.digest) === 0) {
            log.push(`  (the answer did not begin beside a pending regular deposit)`)
            sim.hold.all = false
            break
          }
          visited.add(cell)
          log.push(`  ! ${cell} ${fresh.slice(0, 8)} (ack ${ack.digest.slice(0, 8)}, taken at +${Math.round((takenAt - T0) / 1000)}s)`)
          if (cell === 'answer/begun-before-horizon-regular-failed') {
            // the failure names one regular deposit: the answer stays with the carrier (rule 6)
            sim.failRegular(ack.digest)
            await settle()
            if (sim.heldAnswers(ack.digest) === 0) violations.push(`a failed regular deposit of ${ack.digest.slice(0, 10)} ended the duplicate's begun answer`)
          }
          if (cell === 'answer/begun-before-horizon-shutdown') {
            // a lock with both pending: what the carrier has not taken is withdrawn, the answer too
            await shutdown().catch((e: unknown) => log.push(`  shutdown: ${String(e)}`))
            await reopen(false)
          }
          // the regular retries end: their deposits leave the carrier, the answer does not (#426)
          for (let k = 0; k < 3; k++) {
            vc.advance(60_000)
            for (const cb of life) cb('active')
            await settle()
          }
          if (cell !== 'answer/begun-before-horizon-shutdown' && sim.heldAnswers(ack.digest) === 0 && ![...sim.answers].some(([o, st]) => o.digest === ack.digest && st === 'taken'))
            violations.push(`the end of the regular retries of ${ack.digest.slice(0, 10)} ended the duplicate's begun answer`)
          sim.hold.all = false
          break
        }
        case 'aScanDue':
          // a hand-over, then due times: what got no answer goes over again, then the carrier gives up
          await scan(B, A, ++n).catch((e: unknown) => log.push(`  A scans: ${String(e)}`))
          await A.current()?.idle()
          for (let k = 0; k < 4; k++) {
            vc.advance(60_000)
            for (const cb of life) cb('active')
            await settle()
            await sim.pump()
          }
          break
        case 'aScanExpire':
          // a hand-over, then its deadline passes: the holder gives up what the carrier has not taken
          await scan(B, A, ++n).catch((e: unknown) => log.push(`  A scans: ${String(e)}`))
          await A.current()?.idle()
          // due times come and go: what got no answer is handed over again, more deposits of one digest
          for (let k = 0; k < 3; k++) {
            vc.advance(60_000)
            for (const cb of life) cb('active')
            await settle()
          }
          vc.advance(8 * DAY)
          for (const cb of life) cb('active')
          break
        case 'aScanLock':
          // a lock right after the hand-over, before the carrier took the deposit: the lease withdraws it
          sim.setOnline(true)
          await scan(B, A, ++n).catch((e: unknown) => log.push(`  A scans: ${String(e)}`))
          await A.current()?.idle()
          await shutdown().catch((e: unknown) => log.push(`  shutdown: ${String(e)}`))
          await reopen(false)
          break
        case 'bScan':
          await scan(A, B, ++n).catch((e: unknown) => log.push(`  B scans: ${String(e)}`))
          break
        case 'pump':
          break
        case 'resume':
          vc.advance(60_000)
          for (const cb of life) cb('active')
          break
        case 'lock': {
          // a lock while the carrier still delivers and the holder's close is slow or fails
          let release: () => void = () => {}
          if (sim.armed.has('close/late') || sim.armed.has('close/stale')) lib.closeHold = new Promise<void>((res) => (release = res))
          for (const [cell, f] of [['close/throws', 'after'], ['close/throws-holder-open', 'before']] as const) {
            if (!sim.armed.delete(cell)) continue
            visited.add(cell)
            log.push(`  ! ${cell}`)
            lib.failClose = f
          }
          const closing = sim.current()
          // a receive whose answer is computed while the opening closes without a lock first
          const during = sim.armed.delete('close/direct-during-receive')
          let answering: Promise<void> | null = null
          let releaseReceive: () => void = () => {}
          if (during) {
            visited.add('close/direct-during-receive')
            log.push('  ! close/direct-during-receive')
            await scan(A, B, ++n).catch(() => undefined)
            await settle()
            const computed = new Promise<void>((res) => (lib.computed = res))
            lib.receiveHold = new Promise<void>((res) => (releaseReceive = res))
            answering = sim.through(closing)
            // until the answer is computed, counted in turns (never wall time, so a seed replays alike under load)
            let isComputed = false
            void computed.then(() => (isComputed = true))
            for (let i = 0; i < 2000 && !isComputed; i++) await tick()
          }
          // a lock (deactivate, quiesce, seal, close) or a close without the lock first
          const direct = during || r.next() < 0.4
          if (direct) log.push('  (close without a lock first)')
          const first = (direct ? closeOnly() : shutdown()).catch((e: unknown) => log.push(`  shutdown: ${String(e)}`))
          const second = sim.armed.delete('close/double') ? (visited.add('close/double'), log.push('  ! close/double'), shutdown().catch(() => undefined)) : null
          if (lib.closeHold) {
            await tick()
            if (sim.armed.delete('close/late')) {
              visited.add('close/late')
              log.push('  ! close/late')
              await scan(A, B, ++n).catch(() => undefined)
              await sim.through(closing)
            }
            if (sim.armed.delete('close/stale')) {
              visited.add('close/stale')
              log.push('  ! close/stale')
              closing?.h.report({ digest: Object.keys((await observe()).outbox)[0] ?? 'none', status: 'failed', reason: STALE })
              await sim.through(closing)
            }
            lib.closeHold = null
            release()
          }
          if (answering) {
            await tick()
            lib.receiveHold = null
            lib.computed = null
            releaseReceive()
            await answering
          }
          await first
          await second
          await step()
          await reopen(false)
          break
        }
        case 'end':
          await shutdown().catch(() => undefined)
          log.push('  (process end)')
          await reopen(true)
          break
        case 'offline':
          sim.setOnline(false)
          break
        case 'online':
          sim.setOnline(true)
          break
        case 'jump':
          vc.advance((1 + r.int(30)) * 60_000)
          for (const cb of life) cb('active')
          break
        case 'jumpDays':
          vc.advance(8 * DAY)
          for (const cb of life) cb('active')
          break
        case 'jumpBack':
          skew -= (1 + r.int(60)) * 60_000
          for (const cb of life) cb('active')
          break
      }
      await step()
      await step()
      await observe()
      if (violations.length) break
    }
    log.push('end')
    // the end: online, no faults, time for the retries; the carrier took everything of A, A took everything
    sim.armed.clear()
    lib.reset()
    sim.setOnline(true)
    if (!violations.length) {
      for (let i = 0; i < 3; i++) {
        vc.advance(60_000)
        for (const cb of life) cb('active')
        await new Promise((res) => setTimeout(res, 0))
        await step()
      }
      // a retry the adapter scheduled on the wall clock (a failed start, stop or withdrawal) gets its second
      await new Promise((res) => setTimeout(res, 1100))
      sim.ctx.final = true
      for (let i = 0; i < 2; i++) {
        vc.advance(60_000)
        for (const cb of life) cb('active')
        await step()
      }
      const st = await observe()
      for (const [d, o] of Object.entries(st.outbox)) {
        const last = o.history.at(-1)?.status
        if (last !== 'accepted' && last !== 'delivered' && last !== 'failed') violations.push(`${d.slice(0, 10)} still ${last} at the end`)
      }
      for (const m of sim.mailbox) violations.push(`envelope ${m.digest.slice(0, 10)} still waits at the carrier at the end`)
      // every duplicate A answered taken owes its answer: the carrier took it, or a close withdrew it
      for (const d of sim.answersOwed) {
        const ack = st.effects[d]?.ack?.digest
        if (!ack || !(sim.answerTaken.has(ack) || sim.answerWithdrawnAtClose.has(ack))) violations.push(`the duplicate ${d.slice(0, 10)} was answered taken, its answer never reached the carrier`)
      }
      // every answer the carrier began ended by its own order: taken, or withdrawn by a closing opening (#426)
      for (const [o, st] of sim.answers) if (st === 'pending') violations.push(`the duplicate's answer ${o.digest.slice(0, 10)} began at the carrier and was lost without being taken or withdrawn at a close`)
      // every deposit the carrier still holds is one the holder still owes
      for (const x of sim.inflight) if (sim.holderGaveUp.has(x.o.digest) || !(x.o.digest in st.outbox || Object.values(st.effects).some((e) => e.ack?.digest === x.o.digest))) violations.push(`the carrier still holds ${x.o.digest.slice(0, 10)}, which the holder does not owe`)
    }
  } finally {
    sim.armed.clear()
    lib.reset()
    sim.ctx.inUse = false
    await shutdown().catch(() => undefined)
    await B.quiesce(b.holder)
    await B.seal(b.holder)
    await B.close(b.holder)
    store.close()
  }
  if (process.env.LOG) (await import('node:fs')).writeFileSync(process.env.LOG, log.join('\n'))
  expect(violations, `seed ${seed} (rerun: SEED=${seed})\n${log.join('\n')}`).toEqual([])
}

