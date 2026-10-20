// Transport interface of the adapter (architecture §3.1 `transport/`): the session hands sealed
// documents to a carrier and receives envelopes and delivery reports from it. Two implementations
// here: an in-memory carrier for loopback (tests, harness; §3.3) and the unconfigured transport of
// store builds until the TSP Rev 3 package exists (step 8 of the handover). The TSP transport joins
// with that package.

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

export interface Transport {
  readonly status: ReadStore<TransportStatus>
  start(h: TransportHandlers): void
  submit(out: readonly Outbound[]): void
  /** stops sending and receiving; nothing of this endpoint reaches the session afterwards */
  stop(): void
  /** drops submissions still waiting on this device: their opening was shut down; a later legitimate
   *  session re-emits its own from the library outbox on resume (review 420 R5-3) */
  withdraw?(digests: readonly string[]): void
}

// ── In-memory carrier (loopback) ──────────────────────────────────────────────

interface Endpoint {
  readonly id: string
  online: boolean
  handlers: TransportHandlers | null
  /** documents the carrier holds for this endpoint until it is online and started */
  readonly mailbox: { env: unknown }[]
  /** own submissions waiting for the network */
  readonly outbox: Outbound[]
  readonly status: ReturnType<typeof writableStore<TransportStatus>>
}

export interface MemoryCarrier {
  /** a new endpoint (one device) on this carrier */
  endpoint(id: string): Transport
  setOnline(id: string, online: boolean): void
  isOnline(id: string): boolean
  /** the carrier loses what it holds for and from this endpoint (fault switch) */
  drop(id: string): void
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
          e.outbox.push(...out)
          if (!e.online && e.handlers) {
            const h = e.handlers
            for (const o of out) later(async () => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'offline' }))
          }
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
    drop(id) {
      const e = endpoints.get(id)
      if (!e) return
      e.outbox.splice(0)
      e.mailbox.splice(0)
    },
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

// ── One device transport, one lease per holder opening ───────────────────────────────────────

export interface SharedTransport {
  /** a view of the transport for one opening of ns: its stop() withdraws only its own handlers */
  lease(ns: string): Transport & { activate(): void; deactivate(): void }
  /** ns was wiped: what was parked for it is dropped for good */
  forget(ns: string): void
}

/** During a restore the old and the staged holder are open side by side (architecture §4.2). Both
 *  share the device's transport, but neither may stop or redirect the other (review 420 R1-5):
 *  envelopes go to the active lease (the identity in use; the host activates it with the opening,
 *  R3 R2-2), reports to the lease that submitted the digest.
 *  What an opening submitted and the carrier has not taken yet is parked under its namespace when the
 *  opening stops: a later opening of the same namespace hands it on when it becomes active, an
 *  opening of another namespace never sends it, a wipe drops it (review 420 R5-3, R6-1). The library
 *  does not re-emit documents it was told are awaiting the transport. */
export function shareTransport(t: Transport): SharedTransport {
  type Mine = { h: TransportHandlers; ns: string }
  const started: Mine[] = []
  const owner = new Map<string, Mine>()
  /** submitted, not yet taken by the carrier: digest → document, per lease */
  const unsent = new Map<Mine, Map<string, Outbound>>()
  const parked = new Map<string, Map<string, Outbound>>()
  let running = false
  let chosen: Mine | null = null
  const active = () => (chosen && started.includes(chosen) ? chosen : null)
  const handOn = (m: Mine) => {
    const p = parked.get(m.ns)
    if (!p || p.size === 0) return
    parked.delete(m.ns)
    const out = [...p.values()]
    const own = unsent.get(m) ?? new Map<string, Outbound>()
    unsent.set(m, own)
    for (const o of out) {
      owner.set(o.digest, m)
      own.set(o.digest, o)
    }
    t.submit(out)
  }
  // The device's transport runs only while an opening is active: before that (unlocking, a staged
  // restore) the carrier keeps what arrives instead of hearing "not mine" (review 420 R4-1)
  const sync = () => {
    const a = active()
    if (a && !running) {
      running = true
      t.start({
        envelope: async (env) => {
          const to = active()
          return to ? to.h.envelope(env) : 'not-mine'
        },
        report: (r) => {
          const o = owner.get(r.digest)
          if (o && r.status !== 'awaiting-transport') unsent.get(o)?.delete(r.digest)
          const to = o && started.includes(o) ? o : active()
          to?.h.report(r)
        },
      })
    } else if (!a && running) {
      running = false
      t.stop()
    }
    if (a) handOn(a)
  }
  return {
    forget(ns) {
      parked.delete(ns)
    },
    lease(ns) {
      let mine: Mine | null = null
      let wanted = false
      return {
        status: t.status,
        activate() {
          wanted = true
          if (mine) chosen = mine
          sync()
        },
        deactivate() {
          wanted = false
          if (mine && chosen === mine) chosen = null
          sync()
        },
        start(h) {
          if (mine) started.splice(started.indexOf(mine), 1)
          mine = { h, ns }
          started.push(mine)
          if (wanted) chosen = mine
          sync()
        },
        submit(out) {
          if (!mine) return
          const own = unsent.get(mine) ?? new Map<string, Outbound>()
          unsent.set(mine, own)
          for (const o of out) {
            owner.set(o.digest, mine)
            own.set(o.digest, o)
          }
          t.submit(out)
        },
        stop() {
          if (!mine) return
          const m = mine
          const i = started.indexOf(m)
          if (i >= 0) started.splice(i, 1)
          for (const [d, o] of owner) if (o === m) owner.delete(d)
          // what the carrier has not taken leaves the device only for this namespace again
          const own = unsent.get(m)
          unsent.delete(m)
          if (own && own.size > 0) {
            t.withdraw?.([...own.keys()])
            const p = parked.get(ns) ?? new Map<string, Outbound>()
            for (const [d, o] of own) p.set(d, o)
            parked.set(ns, p)
          }
          if (chosen === m) chosen = null
          mine = null
          wanted = false
          sync()
        },
      }
    },
  }
}
