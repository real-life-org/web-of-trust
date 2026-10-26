// Transport of the adapter (architecture §3.1 `transport/`, contract in TRANSPORT.md): the carrier
// interface (`Transport`), two device carriers (an in-memory one for loopback, tests and harness, §3.3;
// the unconfigured transport) with the adapter between such a carrier and the holder openings
// (`shareTransport`, one deposit lease per opening), and the lease kinds the session sees. The VTI
// mediator is a carrier of its own kind (`carrier-mediator.ts`): its leases take the holder's custody
// view (lib `reconcile`) instead of single documents.

import type { ContactView, DeliveryReport, Outbound, RelationshipView, TransportView } from '@real-life/trust-protocol'
import { challengeAged, CHALLENGE_MAX_AGE, SKEW_TOLERANCE } from '@real-life/trust-protocol'
import type { TransportGate } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { ReadStore } from '../../port'
import type { DiagnosticCode } from '../../port/diagnostics'
import { writableStore } from '../../port'
import { redact } from '../../lib/error-filter'
import type { ClockPort } from '../../platform/ports'

/** The device clock as far as the transport needs it (#430): every delay of the adapter is a timer on
 *  it, never a wall-clock `setTimeout`, so a harness advances the clock instead of waiting real time. */
export type DeviceTimers = Pick<ClockPort, 'now' | 'setTimer'>

export interface TransportStatus {
  readonly network: 'online' | 'offline' | 'unknown'
  /** `idle`: configured, and no relationship to carry yet */
  readonly carrier: 'connected' | 'connecting' | 'unreachable' | 'idle' | 'not-configured'
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
  /** the planned redelivery of refused documents (device clock), null when none is planned */
  redeliver: (() => void) | null
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

/** how long the in-memory carrier waits (device time) before it offers a transiently refused document again */
export const REDELIVER_MS = 1000

/** A carrier that delivers every document to every other endpoint (the one whose relationship opens
 *  it takes it; the others answer 'not-mine'). An endpoint that is offline sends nothing and receives
 *  nothing; the carrier keeps documents for it, like a mediator mailbox. A transiently refused document
 *  is offered again REDELIVER_MS later on `clock` (#430); without a clock, at the next start, the
 *  endpoint coming online or the next document for it. */
export function memoryCarrier(clock?: DeviceTimers): MemoryCarrier {
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
        if (clock && !e.redeliver) {
          e.redeliver = clock.setTimer(clock.now() + REDELIVER_MS, () => {
            e.redeliver = null
            drainMailbox(e)
          })
        }
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
      const e: Endpoint = { id, online: true, handlers: null, mailbox: [], outbox: [], redeliver: null, status: writableStore<TransportStatus>({ network: 'online', carrier: 'connected' }) }
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
      for (const o of out) queueMicrotask(() => h.report({ digest: o.digest, status: 'awaiting-transport', reason: 'transport-unreachable' }, o))
    },
    stop(registration) {
      if (handlers === registration) handlers = null
    },
  }
}

// ── The adapter: one device transport, one lease per holder opening (TRANSPORT.md) ──────────────

/** A deposit's identity in its lease (TRANSPORT.md rule 6): the digest for a regular hand-over,
 *  `digest#n` for the answer to a duplicate (its number, holder.pendingTransport `resend`). A document
 *  given up, a withdrawal and the end of a duplicate's answer each name identities, never a bare
 *  digest: the end of the regular retries never reaches a begun answer of the same digest (#426). */
export const depositKey = (o: { readonly digest: string; readonly resend?: number }): string => (o.resend === undefined ? o.digest : `${o.digest}#${o.resend}`)

/** What a lease needs of its opening (the custody lease; the deposit lease takes nothing of it). */
export interface CarrierOpening {
  /** the 64-byte root IKM: the carrier derives its wire identities from it (Identity §7a) */
  readonly rootIkm: Uint8Array
  /** the holder as the gate of every hand-over (lib TransportGate), through the opening's write gate */
  readonly gate: TransportGate
  /** the adapter's ack state per relationship, persisted in the opening's app-db (sealed) */
  readonly acks: AckStore
  /** holder time of the opening: never behind a time this device used */
  when(): number
  /** asks the opening for a fresh custody view (a new carried relationship) */
  offer(): void
  /** of these own documents, the ones the holder recorded answered (delivered, or refused by the
   *  receiver): the holder is the truth for answers */
  answered(digests: readonly string[]): Promise<string[]>
  /** an envelope at a displayed card's instance, from a sender not bound yet (TRANSPORT.md "The
   *  displayed card's instance", RLTP-VTI-1255): the holder's receive, answered like
   *  `TransportHandlers.envelope`; when the holder takes it (`unique` or `duplicate-known`), the
   *  relationship whose carrier nonce is the card's N (the challenge recorded); null otherwise */
  receiveAtCard(env: unknown, card: DisplayedCard): Promise<{ readonly answer: 'taken' | 'not-mine' | 'later'; readonly recorded: RelationshipView | null }>
  diagnose(code: DiagnosticCode, detail?: string): void
}

/** A card this device displays with a carrier offer for the custody carrier (TRANSPORT.md "The
 *  displayed card's instance"): its challenge, the carrier nonce N it was shown under (base64url, from
 *  the act input), the key its bundle is sealed to (the card's `keyAgreement`, the envelope's `rkid`),
 *  and when its challenge was issued (the card's `challenge.issuedAt`, holder time). */
export interface DisplayedCard {
  readonly challenge: string
  readonly nonce: string
  readonly rkid: string
  readonly issuedAt: number
}

/** the library's age bound of a challenge (tests and the harness read it here) */
export { CHALLENGE_MAX_AGE }

/** Whether the holder still resolves the card's challenge `open` at `now` (holder time): the library's
 *  own age bound (Encounter 5190, `challengeAged`), never a number of the app (RLTP-VTI-1250, 1270). */
export const challengeOpen = (card: { readonly issuedAt: number }, now: number): boolean => !challengeAged(card.issuedAt, now)

/** The first instant the library resolves the challenge `unknown`: whole seconds past
 *  issuedAt + CHALLENGE_MAX_AGE + SKEW_TOLERANCE (the library's constants). The holder's lib names no
 *  such time in a view; a timer runs to it and `challengeOpen` decides. */
export const challengeEnd = (card: { readonly issuedAt: number }): number => (Math.floor(card.issuedAt / 1000) + (CHALLENGE_MAX_AGE + SKEW_TOLERANCE) / 1000 + 1) * 1000

export interface AckStore {
  get(relId: string): Promise<unknown>
  /** null deletes */
  put(relId: string, state: unknown): Promise<void>
}

/** What one opening sees of the carrier. It never throws (TRANSPORT.md rule 1). */
interface LeaseBase {
  /** the carrier's status; `unknown` when the carrier cannot say */
  readonly status: ReadStore<TransportStatus>
  /** the opening becomes the one in use (host) */
  activate(): void
  /** the opening is no longer in use (host, synchronously at lock and boot) */
  deactivate(): void
  /** reception closes; what the carrier has not taken is withdrawn; resolves when the carrier's state of
   *  this opening is put away (the custody lease persists its ack states) */
  stop(): void | Promise<void>
}

/** A lease of a device carrier that takes single documents (`shareTransport`): the session hands each
 *  document over through holder.handOver and deposits it inside that step. */
export interface Lease extends LeaseBase {
  readonly kind: 'deposit'
  /** this opening's receive and report; they act only in a generation of this lease (rule 3). The
   *  opening is not needed: the session hands each document over itself */
  start(h: TransportHandlers, opening?: CarrierOpening): void
  /** the deposit of each document starts now (inside holder.handOver): false is `later` */
  submit(out: readonly Outbound[]): boolean
  /** drops the deposits of these identities (`depositKey`) the carrier has not taken: the holder no
   *  longer names them (RLTP-DEL-6135); other identities of the same digest stay as they are */
  withdraw(keys: readonly string[]): void
  /** a duplicate's answer left the holder's view by its own begun hand-over (Delivery 6330): the
   *  deposits of these identities (`depositKey`, `digest#n`) are kept with the carrier until taken
   *  or until this opening stops, never withdrawn */
  end(keys: readonly string[]): void
  /** whether a deposit now reaches the carrier: this opening is in use and its generation runs */
  ready(): boolean
}

/** How one contact's relationship is carried (TRANSPORT.md "The VTI mediator"), or why it is not: the
 *  card of the encounter had no hint, its hints named no readable one for C, the stored ack state was
 *  refused, the carrier refused direct delivery in the fallback form (RLTP-VTI-3120); `not-carried` without a
 *  known reason. */
export type ContactCarriage = 'routed' | 'egress-session' | 'starting' | 'no-hint' | 'hint-unreadable' | 'ack-state-refused' | 'direct-refused' | 'not-carried'

/** What the custody lease tells the app beside its status. */
export interface Carriage {
  /** by contact id (and its aliases); a contact without an entry has no relationship at this carrier */
  readonly contacts: Readonly<Record<string, ContactCarriage>>
  /** own documents accepted in routed and not answered yet (the send states' open deposits) */
  readonly open: number
  /** the last time a document of a counterpart reached the holder through this carrier */
  readonly lastReceiveAt: number | null
}

/** A lease of a carrier that takes the holder's custody view itself (the VTI mediator adapter of the
 *  library, `reconcile(view, holder, now)`): the carrier hands each document over through the holder. */
export interface CustodyLease extends LeaseBase {
  readonly kind: 'custody'
  /** this opening's receive and report, and what the carrier needs of the opening (rule 3) */
  start(h: TransportHandlers, opening: CarrierOpening): void
  /** reception closes; resolves when the ack states are written, at most DRAIN_LIMIT_MS later */
  stop(): Promise<void>
  /** C, the carrier the cards' delivery hints name */
  readonly carrier: string
  readonly carriage: ReadStore<Carriage>
  /** the holder's custody view after a completed resume of this opening (pendingTransport) */
  reconcile(view: TransportView): void
  /** the holder's contacts: which relationships are carried, which instance closes (chaining) */
  carry(contacts: readonly ContactView[]): void
  /** the cards this device displays with an offer for this carrier: each valid one gets an instance
   *  of its own until its challenge ends (TRANSPORT.md "The displayed card's instance") */
  display(cards: readonly DisplayedCard[]): void
  /** the holder validated answers for these own documents (an acknowledgement, a refusal) */
  answered(digests: readonly string[]): void
  /** work of the carrier in flight for this opening (tests and the harness wait for none) */
  busy(): number
}

export type AnyLease = Lease | CustodyLease

export interface SharedTransport {
  lease(): Lease
  /** the last faults the adapter mapped to `later` (diagnostics), newest last */
  faults(): readonly { readonly callback: string; readonly reason: string }[]
}

const UNKNOWN: TransportStatus = { network: 'unknown', carrier: 'unreachable' }

/** S2 and the ack state writes of a custody lease's stop: how long (device time) the shutdown waits for
 *  them before it goes on (TRANSPORT.md rule 4) */
export const DRAIN_LIMIT_MS = 2000

/** how long (device time) the adapter waits before it tries a refused start, stop or withdrawal again */
export const TRANSPORT_RETRY_MS = 1000

/** During a restore the old and the staged holder are open side by side (architecture §4.2). Both
 *  share the device's transport, neither may stop or redirect the other: the device transport runs
 *  only while an opening is in use, one generation per start for that opening (TRANSPORT.md). */
export function shareTransport(t: Transport, clock: DeviceTimers): SharedTransport {
  /** one deposit: the very object given to the carrier, and where it stands in its own order of events
   *  (TRANSPORT.md rule 6). `kept`: a duplicate's answer whose holder entry ended by its own begun
   *  hand-over, it stays with the carrier until taken or until its opening stops */
  type DepositState = 'open' | 'kept' | 'taken' | 'failed' | 'refused' | 'withdrawing' | 'withdrawn'
  type Deposit = { readonly o: Outbound; readonly lease: Mine; state: DepositState }
  /** an opening's lease: its handlers and its deposits by digest */
  type Mine = { h: TransportHandlers | null; deposits: Map<string, Deposit[]> }
  /** one start: the opening it serves and the registration it made at the carrier */
  type Gen = { readonly lease: Mine; registration: TransportHandlers | null }
  const log: { callback: string; reason: string }[] = []
  /** every call into the carrier: a throw is `later` with its reason in the diagnostics (rule 1) */
  const note = (callback: string, e: unknown) => {
    // redacted on the way in: the reason is read back through faults() (architecture §5)
    log.push({ callback, reason: redact(e) })
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
  // one retry for the device transport, on the device clock (#430): it outlives openings because the
  // shared transport does; what it retries (stops, starts, withdrawals) names its own objects
  let retry: (() => void) | null = null
  const again = () => {
    retry ??= clock.setTimer(clock.now() + TRANSPORT_RETRY_MS, () => {
      retry = null
      sync()
    })
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
  /** the lease that deposited a digest last: every report on it goes there, until `delivered` or until
   *  that lease stops (rule 6); kept apart from the deposits, which end at `accepted` or `failed` */
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
      else if (e.deposit && (e.r.status === 'failed' || e.r.status === 'awaiting-transport')) {
        // awaiting-transport: the carrier keeps no copy of the deposit it names; it ends like a named
        // failure, the others of the digest stay pending (review 426 R1-2)
        const ended = e.r.status === 'failed' ? 'failed' : 'refused'
        for (const d of of) if (d.o === e.deposit) settle(d, ended)
      }
      e.g.lease.h?.report(e.r)
      // the routing outlives the deposit: after `accepted` a `delivered` is owed, after `failed` a late
      // valid acknowledgement still turns it `delivered` (Delivery §6.1). `delivered` is final: the
      // routing ends there, or when the lease stops
      if (e.r.status === 'delivered') depositor.delete(e.r.digest)
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
  const settle = (d: Deposit, state: 'taken' | 'failed' | 'refused' | 'withdrawn') => {
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
  /** the deposits of these identities still pending in the lease (`depositKey`): a regular hand-over
   *  and each duplicate's answer of one digest are told apart until their order ends (#426) */
  const pending = (mine: Mine, keys: Iterable<string>) => {
    const want = new Set(keys)
    const digests = new Set([...want].map((k) => k.split('#')[0]!))
    return [...digests].flatMap((d) => (mine.deposits.get(d) ?? []).filter((x) => (x.state === 'open' || x.state === 'kept') && want.has(depositKey(x.o))))
  }
  /** every deposit still pending in the lease, whatever its identity (the opening stops) */
  const all = (mine: Mine) => [...mine.deposits.values()].flat().filter((x) => x.state === 'open' || x.state === 'kept')

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
        kind: 'deposit',
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
        withdraw(keys) {
          post({ kind: 'withdraw', ds: pending(mine, keys) })
        },
        end(keys) {
          post({ kind: 'end', ds: pending(mine, keys) })
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
          post({ kind: 'withdraw', ds: all(mine) })
          for (const [d, m] of depositor) if (m === mine) depositor.delete(d)
          mine.h = null
          sync()
        },
      }
    },
  }
}
