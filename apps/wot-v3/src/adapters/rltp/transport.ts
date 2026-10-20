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
  /** an envelope for this device: 'not-mine' when no relationship of this holder opens it */
  envelope(env: unknown): Promise<'taken' | 'not-mine'>
  /** the carrier's report on a document this device submitted (Delivery §6.1) */
  report(r: DeliveryReport): void
}

export interface Transport {
  readonly status: ReadStore<TransportStatus>
  start(h: TransportHandlers): void
  submit(out: readonly Outbound[]): void
  /** stops sending and receiving; nothing of this endpoint reaches the session afterwards */
  stop(): void
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
  /** resolves when no document is in flight and no handler runs */
  settled(): Promise<void>
}

/** A carrier that delivers every document to every other endpoint (the one whose relationship opens
 *  it takes it; the others answer 'not-mine'). An endpoint that is offline sends nothing and receives
 *  nothing; the carrier keeps documents for it, like a mediator mailbox. */
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
      while (e.online && e.handlers === h && e.mailbox.length > 0) {
        const next = e.mailbox.shift()
        if (next) await h.envelope(next.env)
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

// ── One device transport, one lease per holder opening ───────────────────────────────────────

export interface SharedTransport {
  /** a view of the transport for one opening: its stop() withdraws only its own handlers */
  lease(): Transport
}

/** During a restore the old and the staged holder are open side by side (architecture §4.2). Both
 *  share the device's transport, but neither may stop or redirect the other (review 420 R1-5):
 *  envelopes go to the oldest started lease (the identity in use until the switch closes it, R2-2),
 *  reports to the lease that submitted the digest. */
export function shareTransport(t: Transport): SharedTransport {
  const started: { h: TransportHandlers }[] = []
  const owner = new Map<string, { h: TransportHandlers }>()
  let running = false
  const active = () => started[0] ?? null
  const ensure = () => {
    if (running) return
    running = true
    t.start({
      envelope: async (env) => (active() ? active()!.h.envelope(env) : 'not-mine'),
      report: (r) => {
        const o = owner.get(r.digest)
        const to = o && started.includes(o) ? o : active()
        to?.h.report(r)
      },
    })
  }
  return {
    lease() {
      let mine: { h: TransportHandlers } | null = null
      return {
        status: t.status,
        start(h) {
          if (mine) started.splice(started.indexOf(mine), 1)
          mine = { h }
          started.push(mine)
          ensure()
        },
        submit(out) {
          if (!mine) return
          for (const o of out) owner.set(o.digest, mine)
          t.submit(out)
        },
        stop() {
          if (!mine) return
          const i = started.indexOf(mine)
          if (i >= 0) started.splice(i, 1)
          for (const [d, o] of owner) if (o === mine) owner.delete(d)
          mine = null
          if (started.length === 0 && running) {
            running = false
            t.stop()
          }
        },
      }
    },
  }
}
