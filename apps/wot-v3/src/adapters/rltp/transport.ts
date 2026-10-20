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
  /** the carrier's report on a document this device submitted (Delivery §6.1) */
  report(r: DeliveryReport): void
}

/** The carrier (TRANSPORT.md): any call may throw, any answer may come late, twice or through the
 *  handlers of an earlier start. Only the adapter (`shareTransport`) calls it. */
export interface Transport {
  readonly status: ReadStore<TransportStatus>
  start(h: TransportHandlers): void
  /** the deposit of each document starts now: a carrier that cannot deposit now reports
   *  awaiting-transport and keeps no copy (Delivery RLTP-DEL-6120 to 6135) */
  submit(out: readonly Outbound[]): void
  /** stops sending and receiving; nothing of this endpoint reaches the session afterwards */
  stop(): void
  /** drops submissions still waiting on this device: their opening was shut down, or the holder no
   *  longer names them (Delivery RLTP-DEL-6135) */
  withdraw?(digests: readonly string[]): void
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
      later(async () => h.report({ digest: o.digest, status: 'accepted' }))
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
            if (h) for (const o of out) later(async () => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'offline' }))
            return
          }
          e.outbox.push(...out)
          flushOutbox(e)
        },
        stop() {
          e.handlers = null
        },
        withdraw(digests) {
          const drop = new Set(digests)
          const keep = e.outbox.filter((o) => !drop.has(o.digest))
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
      for (const o of out) queueMicrotask(() => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'transport-unreachable' }))
    },
    stop() {
      handlers = null
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
  /** an opening's lease: what it deposited and the carrier has not taken (withdrawable) */
  type Mine = { h: TransportHandlers | null; unsent: Set<string> }
  type Gen = { readonly lease: Mine }
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
  /** a stop the carrier refused: tried again until it went through */
  let stopOwed = false
  let retry: ReturnType<typeof setTimeout> | null = null
  const again = () => {
    retry ??= setTimeout(() => {
      retry = null
      sync()
    }, 1000)
  }
  const live = (g: Gen) => current === g
  /** withdrawals the carrier has not confirmed: kept and tried again until it did (rule 1) */
  const owed = new Set<string>()
  /** the lease that deposited a digest last: its reports go there, until it stops; only it may withdraw */
  const depositor = new Map<string, Mine>()
  /** the lease gives up a deposit the carrier has not taken: withdrawn unless another lease deposited it since */
  const release = (mine: Mine, d: string) => {
    if (!mine.unsent.delete(d) || depositor.get(d) !== mine) return
    owed.add(d)
  }
  const withdrawOwed = () => {
    if (owed.size === 0 || !t.withdraw) return
    const ds = [...owed]
    if (call('withdraw', () => t.withdraw?.(ds))) for (const d of ds) owed.delete(d)
    else again()
  }
  /** the device transport follows the opening in use: one generation per start, ended at every change */
  const sync = () => {
    withdrawOwed()
    const want = inUse?.h ? inUse : null
    if (current && current.lease !== want) {
      current = null
      stopOwed = true
    }
    if (stopOwed && call('stop', () => t.stop())) stopOwed = false
    if (stopOwed) {
      // the carrier still delivers to the ended generation: its answers are `later`, the stop is tried again
      again()
      return
    }
    if (!current && want) {
      const g: Gen = { lease: want }
      current = g
      const started = call('start', () =>
        t.start({
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
          report: (r) => {
            // every report of a digest this lease deposited, one state change after another
            if (!live(g) || depositor.get(r.digest) !== g.lease) return
            if (r.status !== 'awaiting-transport') g.lease.unsent.delete(r.digest)
            g.lease.h?.report(r)
          },
        }),
      )
      if (!started) {
        // whatever the carrier registered belongs to an ended generation; tried again shortly
        current = null
        stopOwed = true
        again()
      }
    }
  }

  return {
    faults: () => [...log],
    lease() {
      const mine: Mine = { h: null, unsent: new Set() }
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
          for (const o of out) {
            // the same bytes deposited again are owed to the carrier, not to be withdrawn
            owed.delete(o.digest)
            mine.unsent.add(o.digest)
            depositor.set(o.digest, mine)
          }
          if (call('deposit', () => t.submit(out))) return true
          // a deposit that threw may have begun: withdrawn, the hand-over comes again (rule 1)
          for (const o of out) release(mine, o.digest)
          withdrawOwed()
          return false
        },
        withdraw(digests) {
          for (const d of digests) release(mine, d)
          withdrawOwed()
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
          // what the carrier has not taken never leaves the device after this opening's shutdown
          for (const d of [...mine.unsent]) release(mine, d)
          for (const [d, m] of depositor) if (m === mine) depositor.delete(d)
          mine.h = null
          if (inUse === mine) inUse = null
          wanted = false
          sync()
        },
      }
    },
  }
}
