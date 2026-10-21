// Transport of the adapter (architecture §3.1 `transport/`, contract in TRANSPORT.md): the carrier
// interface (`Transport`), two carriers (an in-memory one for loopback, tests and harness, §3.3; the
// unconfigured transport of store builds until the TSP Rev 3 package exists, step 8 of the handover)
// and the adapter between the device's carrier and the holder openings (`shareTransport`, one lease
// per opening). The TSP transport joins with that package.

import type { DeliveryReport, Outbound } from '@real-life/trust-protocol'
import type { ReadStore } from '../../port'
import { writableStore } from '../../port'

export interface TransportStatus {
  readonly network: 'online' | 'offline' | 'unknown'
  readonly carrier: 'connected' | 'connecting' | 'unreachable' | 'not-configured'
}

export interface TransportHandlers {
  /** an envelope for this device: 'not-mine' when no relationship of this holder opens it, 'later'
   *  when the receiver refused it for now (a transient refusal): the carrier keeps it and delivers
   *  it again */
  envelope(env: unknown): Promise<'taken' | 'not-mine' | 'later'>
  /** the carrier's report on a document this device submitted (Delivery §6.1), naming the deposit
   *  (the object given to `submit`) where the carrier knows it */
  report(r: DeliveryReport, deposit?: Outbound): void
}

/** The carrier (TRANSPORT.md): any call may throw, any answer may come late, twice or through the
 *  handlers of an earlier start. Only the adapter (`shareTransport`) calls it. */
export interface Transport {
  readonly status: ReadStore<TransportStatus>
  start(h: TransportHandlers): void
  /** the deposit of each document starts now: a carrier that cannot deposit now reports
   *  awaiting-transport and keeps no copy (Delivery RLTP-DEL-6120 to 6135) */
  submit(out: readonly Outbound[]): void
  /** ends the registration that `start` made with these handlers, and only it: a stop that takes effect
   *  late never ends a later registration (TRANSPORT.md, bound calls) */
  stop(registration: TransportHandlers): void
  /** drops these deposits (the objects given to `submit`), and only them, while still waiting on this
   *  device: their opening was shut down, or the holder no longer names them (Delivery RLTP-DEL-6135);
   *  a withdrawal that takes effect late never drops a later deposit of the same document */
  withdraw?(deposits: readonly Outbound[]): void
}

// ── In-memory carrier (loopback) ──────────────────────────────────────────────

interface Endpoint {
  readonly id: string
  online: boolean
  handlers: TransportHandlers | null
  /** documents the carrier holds for this endpoint until it is online and started */
  readonly mailbox: { env: unknown }[]
  /** own submissions being deposited (flushed at once: an offline endpoint keeps none) */
  readonly outbox: Outbound[]
  readonly status: ReturnType<typeof writableStore<TransportStatus>>
}

export interface MemoryCarrier {
  /** a new endpoint (one device) on this carrier */
  endpoint(id: string): Transport
  setOnline(id: string, online: boolean): void
  isOnline(id: string): boolean
  /** resolves when no document is in flight and no handler runs */
  settled(): Promise<void>
}

/** A carrier that delivers every document to every other endpoint (the one whose relationship opens
 *  it takes it; the others answer 'not-mine'). An endpoint that is offline sends nothing and receives
 *  nothing; the carrier keeps documents for it, like a mediator mailbox. */
/** how long the in-memory carrier waits before it offers a transiently refused document again */
export const REDELIVER_MS = 1000

export function memoryCarrier(): MemoryCarrier {
  const endpoints = new Map<string, Endpoint>()
  let busy = 0
  let waiters: (() => void)[] = []
  const settle = () => {
    if (busy > 0) return
    const w = waiters
    waiters = []
    for (const r of w) r()
  }
  const later = (fn: () => Promise<void>) => {
    busy++
    void Promise.resolve()
      .then(fn)
      .catch(() => undefined)
      .finally(() => {
        busy--
        settle()
      })
  }
  const statusOf = (e: Endpoint): TransportStatus => (e.online ? { network: 'online', carrier: 'connected' } : { network: 'offline', carrier: 'unreachable' })

  const drainMailbox = (e: Endpoint) => {
    if (!e.online || !e.handlers) return
    const h = e.handlers
    later(async () => {
      const keep: { env: unknown }[] = []
      while (e.online && e.handlers === h && e.mailbox.length > 0) {
        const next = e.mailbox.shift()
        if (!next) continue
        // a transient refusal: the carrier keeps the document and tries again a little later
        if ((await h.envelope(next.env)) === 'later') keep.push(next)
      }
      if (keep.length > 0) {
        e.mailbox.unshift(...keep)
        setTimeout(() => drainMailbox(e), REDELIVER_MS)
      }
    })
  }
  const flushOutbox = (e: Endpoint) => {
    if (!e.online || !e.handlers) return
    const h = e.handlers
    const docs = e.outbox.splice(0)
    for (const o of docs) {
      for (const other of endpoints.values()) {
        if (other === e) continue
        // what travels is bytes: a copy, like a real carrier (no shared object between devices)
        other.mailbox.push({ env: JSON.parse(JSON.stringify(o.envelope)) as unknown })
        drainMailbox(other)
      }
      later(async () => h.report({ digest: o.digest, status: 'accepted' }, o))
    }
  }

  return {
    endpoint(id) {
      const e: Endpoint = { id, online: true, handlers: null, mailbox: [], outbox: [], status: writableStore<TransportStatus>({ network: 'online', carrier: 'connected' }) }
      endpoints.set(id, e)
      return {
        status: e.status,
        start(h) {
          e.handlers = h
          flushOutbox(e)
          drainMailbox(e)
        },
        submit(out) {
          // offline: no deposit starts, and no copy waits on the device for the network to come back
          if (!e.online || !e.handlers) {
            const h = e.handlers
            if (h) for (const o of out) later(async () => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'offline' }, o))
            return
          }
          e.outbox.push(...out)
          flushOutbox(e)
        },
        stop(registration) {
          if (e.handlers === registration) e.handlers = null
        },
        withdraw(deposits) {
          const drop = new Set(deposits)
          const keep = e.outbox.filter((o) => !drop.has(o))
          e.outbox.splice(0, e.outbox.length, ...keep)
        },
      }
    },
    setOnline(id, online) {
      const e = endpoints.get(id)
      if (!e || e.online === online) return
      e.online = online
      e.status.set(statusOf(e))
      if (online) {
        flushOutbox(e)
        drainMailbox(e)
      }
    },
    isOnline: (id) => endpoints.get(id)?.online ?? false,
    async settled() {
      for (;;) {
        if (busy === 0) {
          await new Promise((r) => setTimeout(r, 0))
          if (busy === 0) return
        }
        await new Promise<void>((r) => waiters.push(r))
      }
    },
  }
}

// ── Unconfigured (store builds until the TSP package) ─────────────────────────

/** Holds every document before the trias: the carrier is not configured yet. */
export function unconfiguredTransport(): Transport {
  const status = writableStore<TransportStatus>({ network: 'unknown', carrier: 'not-configured' })
  let handlers: TransportHandlers | null = null
  return {
    status,
    start(h) {
      handlers = h
    },
    submit(out) {
      const h = handlers
      if (!h) return
      for (const o of out) queueMicrotask(() => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'transport-unreachable' }, o))
    },
    stop(registration) {
      if (handlers === registration) handlers = null
    },
  }
}

// ── The adapter: one device transport, one lease per holder opening (TRANSPORT.md) ──────────────

/** What one opening sees of the carrier. It never throws (TRANSPORT.md rule 1). */
export interface Lease {
  /** the carrier's status; `unknown` when the carrier cannot say */
  readonly status: ReadStore<TransportStatus>
  /** this opening's receive and report; they act only in a generation of this lease (rule 3) */
  start(h: TransportHandlers): void
  /** the deposit of each document starts now (inside holder.handOver): false is `later` */
  submit(out: readonly Outbound[]): boolean
  /** drops deposits the carrier has not taken: the holder no longer names them (RLTP-DEL-6135) */
  withdraw(digests: readonly string[]): void
  /** a duplicate's answer left the holder's view by its own begun hand-over (Delivery 6330): its
   *  deposits are kept with the carrier until taken or until this opening stops, never withdrawn */
  end(digests: readonly string[]): void
  /** whether a deposit now reaches the carrier: this opening is in use and its generation runs */
  ready(): boolean
  /** the opening becomes the one in use (host) */
  activate(): void
  /** the opening is no longer in use (host, synchronously at lock and boot) */
  deactivate(): void
  /** reception closes; what the carrier has not taken is withdrawn */
  stop(): void
}

export interface SharedTransport {
  lease(): Lease
  /** the last faults the adapter mapped to `later` (diagnostics), newest last */
  faults(): readonly { readonly callback: string; readonly reason: string }[]
}

const UNKNOWN: TransportStatus = { network: 'unknown', carrier: 'unreachable' }

/** During a restore the old and the staged holder are open side by side (architecture §4.2). Both
 *  share the device's transport, neither may stop or redirect the other: the device transport runs
 *  only while an opening is in use, one generation per start for that opening (TRANSPORT.md). */
export function shareTransport(t: Transport): SharedTransport {
  /** one deposit: the very object given to the carrier, and where it stands in its own order of events
   *  (TRANSPORT.md rule 6). `kept`: a duplicate's answer whose holder entry ended by its own begun
   *  hand-over, it stays with the carrier until taken or until its opening stops */
  type DepositState = 'open' | 'kept' | 'taken' | 'failed' | 'withdrawing' | 'withdrawn'
  type Deposit = { readonly o: Outbound; readonly lease: Mine; state: DepositState }
  /** an opening's lease: its handlers and its deposits by digest */
  type Mine = { h: TransportHandlers | null; deposits: Map<string, Deposit[]> }
  /** one start: the opening it serves and the registration it made at the carrier */
  type Gen = { readonly lease: Mine; registration: TransportHandlers | null }
  const log: { callback: string; reason: string }[] = []
  /** every call into the carrier: a throw is `later` with its reason in the diagnostics (rule 1) */
  const note = (callback: string, e: unknown) => {
    log.push({ callback, reason: e instanceof Error ? e.message : String(e) })
    if (log.length > 20) log.shift()
  }
  const call = (callback: string, fn: () => void): boolean => {
    try {
      fn()
      return true
    } catch (e) {
      note(callback, e)
      return false
    }
  }
  const status: ReadStore<TransportStatus> = {
    get() {
      let s = UNKNOWN
      call('connect', () => (s = t.status.get()))
      return s
    },
    subscribe(onChange) {
      let off: () => void = () => undefined
      call('connect', () => (off = t.status.subscribe(onChange)))
      return () => void call('connect', off)
    },
  }

  /** the opening in use */
  let inUse: Mine | null = null
  /** the generation running at the carrier, null when none */
  let current: Gen | null = null
  /** registrations of ended generations the carrier has not confirmed stopped: tried again until it did */
  const unstopped = new Set<TransportHandlers>()
  let retry: ReturnType<typeof setTimeout> | null = null
  const again = () => {
    retry ??= setTimeout(() => {
      retry = null
      sync()
    }, 1000)
  }
  /** a generation acts only while it is current and its opening is in use (rule 3, review 420 R19-2) */
  const live = (g: Gen) => current === g && inUse === g.lease

  // ── Rule 6: one order of events per deposit ────────────────────────────────────────────────────
  // Reports, withdrawals and the end of a duplicate's answer are events of one queue, handled one after
  // another in the order they arrived; what the carrier calls back while an event is handled (a report
  // inside a withdrawal) is queued behind it and never overtakes it.
  type Event =
    | { readonly kind: 'report'; readonly g: Gen; readonly r: DeliveryReport; readonly deposit?: Outbound }
    | { readonly kind: 'withdraw'; readonly ds: readonly Deposit[] }
    | { readonly kind: 'end'; readonly ds: readonly Deposit[] }
  const events: Event[] = []
  let draining = false
  const post = (e: Event) => {
    events.push(e)
    if (draining) return
    draining = true
    try {
      for (let next = events.shift(); next; next = events.shift()) handle(next)
    } finally {
      draining = false
    }
  }
  /** the lease that deposited a digest last: every report on it goes there, until that lease stops */
  const depositor = new Map<string, Mine>()
  /** withdrawals the carrier has not confirmed: tried again (next sync, timer) until it did */
  const owed = new Set<Deposit>()
  const handle = (e: Event) => {
    if (e.kind === 'report') {
      // computed for this generation only; reaches only the lease that deposited
      if (!live(e.g) || depositor.get(e.r.digest) !== e.g.lease) return
      const of = e.g.lease.deposits.get(e.r.digest) ?? []
      // taken: the carrier takes a digest once, every deposit of it is done; failed: only the deposit
      // the carrier names, the others stay pending (withdrawn when the holder lets the document go).
      // A deposit whose order ended leaves the lease and the owed withdrawals: later reports need only
      // the digest's depositor, never the envelope (review 420 R23-1)
      if (e.r.status === 'accepted' || e.r.status === 'delivered') for (const d of of) settle(d, 'taken')
      else if (e.r.status === 'failed' && e.deposit) for (const d of of) if (d.o === e.deposit) settle(d, 'failed')
      e.g.lease.h?.report(e.r)
      return
    }
    if (e.kind === 'end') {
      for (const d of e.ds) if (d.state === 'open') d.state = 'kept'
      return
    }
    // withdraw: only what is still pending; a carrier without withdraw keeps no copy (R22-2)
    for (const d of e.ds) if (!isPending(d)) owed.delete(d)
    const ds = e.ds.filter(isPending)
    if (ds.length === 0) return
    if (!t.withdraw) {
      for (const d of ds) settleWithdrawn(d)
      return
    }
    for (const d of ds) d.state = 'withdrawing'
    if (call('withdraw', () => t.withdraw?.(ds.map((d) => d.o)))) for (const d of ds) settleWithdrawn(d)
    else {
      for (const d of ds) owed.add(d)
      again()
    }
  }
  const isPending = (d: Deposit) => d.state === 'open' || d.state === 'kept' || d.state === 'withdrawing'
  /** a deposit's order ends: it leaves its lease and the owed withdrawals, whatever ended it */
  const settle = (d: Deposit, state: 'taken' | 'failed' | 'withdrawn') => {
    owed.delete(d)
    if (isPending(d)) d.state = state
    forget(d)
  }
  const settleWithdrawn = (d: Deposit) => settle(d, 'withdrawn')
  /** a deposit whose order ended leaves the lease */
  const forget = (d: Deposit) => {
    const of = d.lease.deposits.get(d.o.digest)
    if (!of) return
    const rest = of.filter((x) => x !== d)
    if (rest.length > 0) d.lease.deposits.set(d.o.digest, rest)
    else d.lease.deposits.delete(d.o.digest)
  }
  const pending = (mine: Mine, digests: Iterable<string>) => [...digests].flatMap((d) => (mine.deposits.get(d) ?? []).filter((x) => x.state === 'open' || x.state === 'kept'))

  /** the device transport follows the opening in use: one generation per start, ended at every change */
  const sync = () => {
    const want = inUse?.h ? inUse : null
    // the generation ends first: whatever the carrier calls back during the stops and withdrawals below
    // reaches no lease (review 420 R19-2)
    if (current && current.lease !== want) {
      if (current.registration) unstopped.add(current.registration)
      current = null
    }
    if (owed.size > 0) post({ kind: 'withdraw', ds: [...owed] })
    // each stop names its own registration: one that takes effect late never ends a later one
    for (const r of [...unstopped]) if (call('stop', () => t.stop(r))) unstopped.delete(r)
    // the carrier may still deliver to an ended generation: its answers are `later`, the stop is tried again
    if (unstopped.size > 0) again()
    if (!current && want) {
      const g: Gen = { lease: want, registration: null }
      current = g
      const registration: TransportHandlers = {
        envelope: async (env) => {
          const h = g.lease.h
          if (!live(g) || !h) return 'later'
          // a receive that failed proves nothing: the carrier keeps the document (rules 1, 2)
          const a = await h.envelope(env).catch((e: unknown) => {
            note('receive', e)
            return 'later' as const
          })
          // computed for this generation only: one that ended meanwhile answers `later` (rule 3)
          return live(g) ? a : 'later'
        },
        report: (r, deposit) => {
          if (live(g)) post({ kind: 'report', g, r, ...(deposit ? { deposit } : {}) })
        },
      }
      g.registration = registration
      if (!call('start', () => t.start(registration))) {
        // whatever the carrier registered belongs to an ended generation; tried again shortly
        current = null
        unstopped.add(registration)
        again()
      }
    }
  }

  return {
    faults: () => [...log],
    lease() {
      const mine: Mine = { h: null, deposits: new Map() }
      let wanted = false
      return {
        status,
        start(h) {
          mine.h = h
          if (wanted) inUse = mine
          sync()
        },
        ready() {
          if (inUse !== mine) return false
          sync()
          return current?.lease === mine
        },
        submit(out) {
          if (out.length === 0 || current?.lease !== mine) return false
          // recorded before the deposit: a report the carrier gives synchronously finds it
          const ds = out.map((o) => {
            const d: Deposit = { o, lease: mine, state: 'open' }
            mine.deposits.set(o.digest, [...(mine.deposits.get(o.digest) ?? []), d])
            depositor.set(o.digest, mine)
            return d
          })
          if (call('deposit', () => t.submit(out))) return true
          // a deposit that threw may have begun: withdrawn, the hand-over comes again (rule 1)
          post({ kind: 'withdraw', ds })
          return false
        },
        withdraw(digests) {
          post({ kind: 'withdraw', ds: pending(mine, digests) })
        },
        end(digests) {
          post({ kind: 'end', ds: pending(mine, digests) })
        },
        activate() {
          wanted = true
          if (mine.h) inUse = mine
          sync()
        },
        deactivate() {
          wanted = false
          if (inUse === mine) inUse = null
          sync()
        },
        stop() {
          if (inUse === mine) inUse = null
          wanted = false
          // the generation ends before anything else: nothing below reaches this lease (rule 3)
          sync()
          // what the carrier has not taken never leaves the device after this opening's shutdown
          post({ kind: 'withdraw', ds: pending(mine, mine.deposits.keys()) })
          for (const [d, m] of depositor) if (m === mine) depositor.delete(d)
          mine.h = null
          sync()
        },
      }
    },
  }
}
