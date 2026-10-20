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
  /** the deposit of each document starts now (holder.handOver's `start`): a transport that cannot
   *  deposit now reports awaiting-transport and keeps no copy; the holder keeps custody and the
   *  session hands the document over again (Delivery RLTP-DEL-6120 to 6135) */
  submit(out: readonly Outbound[]): void
  /** stops sending and receiving; nothing of this endpoint reaches the session afterwards */
  stop(): void
  /** drops submissions still waiting on this device: their opening was shut down, or the holder no
   *  longer names them (Delivery RLTP-DEL-6135) */
  withdraw?(digests: readonly string[]): void
  /** whether a submission now reaches the device (a lease: only while its opening is the one in use) */
  ready?(): boolean
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
  /** a view of the transport for one opening: its stop() withdraws only its own handlers and copies */
  lease(): Transport & { activate(): void; deactivate(): void; withdraw(digests: readonly string[]): void; ready(): boolean }
}

/** During a restore the old and the staged holder are open side by side (architecture §4.2). Both
 *  share the device's transport, but neither may stop or redirect the other (review 420 R1-5):
 *  envelopes go to the active lease (the identity in use; the host activates it with the opening),
 *  reports to the lease that submitted the digest.
 *  A lease is one opening's transport adapter: it takes submissions only while it is active (the
 *  session hands over from the holder's custody, holder.handOver, and offers again at activation)
 *  and keeps no store of its own. When it stops, what the carrier has not taken is withdrawn from the
 *  device: the holder keeps every document until a service took it, and the next opening hands it
 *  over again (Delivery 0.83 RLTP-DEL-6120 to 6135). */
export function shareTransport(t: Transport): SharedTransport {
  type Mine = { h: TransportHandlers }
  const started: Mine[] = []
  const owner = new Map<string, Mine>()
  /** handed to the device, not yet taken by the carrier, per lease */
  const unsent = new Map<Mine, Set<string>>()
  let running = false
  let chosen: Mine | null = null
  const active = () => (chosen && started.includes(chosen) ? chosen : null)
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
  }
  return {
    lease() {
      let mine: Mine | null = null
      let wanted = false
      const isActive = () => mine !== null && chosen === mine
      return {
        status: t.status,
        ready: isActive,
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
          mine = { h }
          started.push(mine)
          if (wanted) chosen = mine
          sync()
        },
        submit(out) {
          const m = mine
          // only the opening in use hands documents to the device; the caller offers again at activation
          if (!m || !isActive() || out.length === 0) throw new Error('lease not active')
          const own = unsent.get(m) ?? new Set<string>()
          unsent.set(m, own)
          for (const o of out) {
            owner.set(o.digest, m)
            own.add(o.digest)
          }
          t.submit(out)
        },
        withdraw(digests) {
          const own = mine ? unsent.get(mine) : undefined
          const taken = digests.filter((d) => own?.delete(d))
          for (const d of taken) owner.delete(d)
          if (taken.length > 0) t.withdraw?.(taken)
        },
        stop() {
          if (!mine) return
          const m = mine
          const i = started.indexOf(m)
          if (i >= 0) started.splice(i, 1)
          for (const [d, o] of owner) if (o === m) owner.delete(d)
          // what the carrier has not taken never leaves the device after this opening's shutdown
          const own = unsent.get(m)
          unsent.delete(m)
          if (own && own.size > 0) {
            try {
              t.withdraw?.([...own])
            } catch {
              // nothing more to do: the device keeps no handlers for it
            }
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
