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
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import type { HolderHandle } from '../../src/adapters/identity/host'
import type { ClockPort } from '../../src/platform/ports'

type Outbound = Parameters<Transport['submit']>[0][number]
type DeliveryReport = Parameters<TransportHandlers['report']>[0]
/** the reason a stale report carries: the carrier sends it never else, so a holder that records it obeyed a retired generation */
const STALE = 'unroutable'

const CALLBACKS = ['connect', 'start', 'stop', 'deposit', 'receive', 'answer', 'close'] as const
const BEHAVIOURS = ['throws', 'late', 'stale', 'double'] as const
/** the further forms of a callback's fault, each a cell of its own */
const FORMS = [
  'deposit/throws-after-acceptance',
  'deposit/withdraw-throws',
  'deposit/handOver-rejects',
  'deposit/pendingTransport-rejects',
  'receive/rate-limited',
  'answer/next-state',
  'close/throws-holder-open',
  'close/direct-during-receive',
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
  const inflight: { o: Outbound; gen: Gen | null }[] = []
  let afterStep: (() => Promise<void> | void)[] = []
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
  /** reported accepted, then delivered, to the generation in use: the holder must record delivered */
  const mustDeliver = new Set<string>()

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
      if (i >= 0) mailbox.splice(i, 1)
      taken.add(digest)
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
  const report = (gen: Gen | null, r: DeliveryReport) => {
    if (!gen) return
    try {
      gen.h.report(r)
    } catch (e) {
      violations.push(`report handler threw: ${String(e)}`)
    }
  }
  const send = (gen: Gen | null, r: DeliveryReport) => {
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
      report(gen, r)
      if (double) report(gen, r)
      if (next) report(gen, next)
    }
    if (late) afterStep.push(go)
    else queueMicrotask(go)
  }
  const accept = (o: Outbound, gen: Gen | null) => {
    accepted.add(o.digest)
    send(gen, { digest: o.digest, status: 'accepted' })
  }

  const carrier = {
    mustDeliver,
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
      if (online) {
        for (const x of inflight.splice(0)) {
          // a carrier whose withdrawal failed is unwell: it holds the deposit until the adapter tried again
          if (withdrawRefused.has(x.o.digest)) {
            if (!ctx.final) {
              inflight.push(x)
              continue
            }
            violations.push(`deposit ${x.o.digest.slice(0, 10)} completed although its withdrawal was refused and never tried again`)
          }
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
          if (hit('start/late')) {
            g.live = false
            afterStep.push(() => {
              if (current === g) g.live = true
            })
          }
          if (hit('start/throws')) throw Error('injected start failure')
        },
        stop() {
          const g = mine.at(-1)
          if (!g) return
          g.retired = true
          log.push(`  stop gen ${g.id}`)
          if (hit('stop/throws')) throw Error('injected stop failure')
          const apply = (x: Gen | null) => {
            if (!x) return
            x.live = false
            if (current === x) current = null
          }
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
          if (afterAcceptance || hit('deposit/throws')) {
            // a deposit whose outcome is unknown: the carrier may have taken the first document
            if (afterAcceptance && online && out[0]) accept(out[0], gen)
            throw Error('injected deposit failure')
          }
          if (!online) {
            for (const o of out) send(gen, { digest: o.digest, status: 'awaiting-transport', reason: 'offline' } as DeliveryReport)
            return
          }
          const late = hit('deposit/late')
          for (const o of out) {
            if (late) afterStep.push(() => void inflight.push({ o, gen }))
            else inflight.push({ o, gen })
            if (hit('deposit/double')) inflight.push({ o, gen })
          }
        },
        withdraw(digests) {
          if (digests.some((d) => inflight.some((x) => x.o.digest === d)) && hit('deposit/withdraw-throws')) {
            for (const d of digests) if (inflight.some((x) => x.o.digest === d)) withdrawRefused.add(d)
            throw Error('injected withdraw failure')
          }
          for (const d of digests) withdrawRefused.delete(d)
          const drop = new Set(digests)
          const keep = inflight.filter((x) => !drop.has(x.o.digest))
          inflight.splice(0, inflight.length, ...keep)
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

export const RUNS = 12
/** the cells a seed arms for sure: together the runs hit every one */
export const forced = (seed: number) => CELLS.filter((_, i) => i % RUNS === (seed - 1) % RUNS)

type Op = 'aScan' | 'aScanLock' | 'bScan' | 'pump' | 'resume' | 'lock' | 'end' | 'offline' | 'online' | 'jump' | 'jumpDays' | 'jumpBack'
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
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await mc.settled()
      await A.current()?.idle()
      await B.current()?.idle()
      await tick()
    }
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
    for (const d of sim.mustDeliver) {
      const last = st.outbox[d]?.history.at(-1)?.status
      if (last !== undefined && last !== 'delivered' && last !== 'failed') violations.push(`${d.slice(0, 10)} reported delivered to its generation, the holder records ${last}`)
    }
    sim.mustDeliver.clear()
    for (const [d, o] of Object.entries(st.outbox)) {
      const last = o.history.at(-1)
      if (last) ledger.set(d, last.status)
      if (last?.status === 'accepted' || last?.status === 'delivered') {
        sim.holderAccepted.add(d)
        if (!sim.accepted.has(d)) violations.push(`holder records ${d.slice(0, 10)} ${last.status}, the carrier never took it`)
      }
      if (o.history.some((h) => h.status === 'failed' && h.reason === STALE)) violations.push(`a report to a retired generation gave up ${d.slice(0, 10)}`)
      if (last?.status === 'failed' && last.reason !== STALE && last.reason !== 'task-expired' && last.reason !== 'expired-by-adapter-policy') violations.push(`${d.slice(0, 10)} given up on a fault: ${last.reason}`)
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
    for (let i = 0; i < 9; i++) {
      const c = at.get(i)
      let op: Op = r.pick(OPS)
      if (c) {
        sim.arm(c)
        op = r.pick(OP_OF[c.split('/')[0] as (typeof CALLBACKS)[number]])
        if (c.startsWith('connect')) op = sim.isOnline() ? 'offline' : 'online'
        // a cell of the carrier's traffic needs the network
        if (/^(deposit|answer|receive)\//.test(c)) sim.setOnline(true)
        if (c === 'deposit/withdraw-throws') op = 'aScanLock'
        if (c === 'close/direct-during-receive') op = 'lock'
        if (c === 'deposit/handOver-rejects' || c === 'deposit/pendingTransport-rejects') {
          // the library's side of a hand-over: the next call rejects
          sim.armed.delete(c)
          visited.add(c)
          log.push(`  ! ${c}`)
          if (c === 'deposit/handOver-rejects') lib.failHandOver = true
          else lib.failPending = true
        }
      } else if (r.next() < 0.3) sim.arm(r.pick(CELLS))
      log.push(`${i}: ${op}${c ? ` [${c}]` : ''}`)
      switch (op) {
        case 'aScan':
          await scan(B, A, ++n).catch((e: unknown) => log.push(`  A scans: ${String(e)}`))
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
            await Promise.race([computed, new Promise((res) => setTimeout(res, 500))])
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

