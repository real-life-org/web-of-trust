// The VTI mediator as the device's carrier (TRANSPORT.md "The VTI mediator"; VTI Mediator Adapter
// Profile 0.25; lib 0.8.0 `./adapters/vti-mediator`). One custody lease per holder opening; while the
// opening is in use, one MediatorCarrierAdapter of the library per carried relationship, each over a
// wire of its own (one session per relationship and side, `wire.ts`).
//
//  - Carried is a relationship with this side's carrier nonce N and exactly one readable delivery hint
//    of the counterpart for C (readDeliveryHints, RLTP-VTI-1225, 1227). Without one it is not carried
//    (RLTP-VTI-1235): its documents stay in the holder's custody, reported awaiting-transport.
//  - A relationship chained into another (its id in another one's `chainedFrom`) closes its instance
//    and gets no successor; its ack state is dropped (§6, RLTP-VTI-1230).
//  - reconcile(view) hands each instance the entries of its contact; the instance hands each one over
//    through the holder (lib reconcile with the holder as the gate) and withdraws what the view no
//    longer names. Reports are read from the instance and passed to the holder when they change, in
//    order per submission.
//  - Frames the wire hands an instance are collected, received by the holder one by one and concluded,
//    except those the holder answered `later` (a transient refusal): they stay unacknowledged.
//  - The ack state (with the send state) is persisted per relationship in the opening's app-db after
//    every change and when an instance closes, and restored into the next instance; a snapshot the
//    library refuses (fail-closed) leaves the relationship not carried in this opening.
//  - Time is the opening's holder time on the device clock (#430); the carrier's own tick (advance:
//    attempts, acknowledgements, the switch check) runs every CARRIER_TICK_MS of device time.

import type { ContactView, DeliveryReport, RelationshipView, TransportView } from '@real-life/trust-protocol'
import { deliveryHint, MediatorCarrierAdapter, readDeliveryHint, readDeliveryHints, type AckState, type MediatorWire } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { ReadStore } from '../../port'
import { writableStore } from '../../port'
import type { NetworkPort } from '../../platform/ports'
import type { Carriage, CarrierOpening, ContactCarriage, CustodyLease, DeviceTimers, TransportHandlers, TransportStatus } from './transport'
import { createVtiWire, type VtiWire, type WireConfig } from './wire'

/** how often (device time) the carrier advances its instances while the opening is in use */
export const CARRIER_TICK_MS = 5000

export interface MediatorCarrierConfig {
  /** C, the mediator's DID, exactly as configured for this build */
  readonly did: string
  readonly clock: DeviceTimers
  readonly network?: NetworkPort
  /** the network below the wire (tests, harness: the mediator double) */
  readonly net?: WireConfig['net']
  /** tests and the harness: a wire as the adapter instance of a relationship sees it (fault injection) */
  readonly seam?: (wire: VtiWire, relId: string) => VtiWire
}

export interface MediatorCarrier {
  readonly kind: 'mediator'
  readonly carrier: string
  readonly status: ReadStore<TransportStatus>
  lease(): CustodyLease
}

const unb64u = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const td = new TextDecoder()

interface Instance {
  readonly relId: string
  readonly adapter: MediatorCarrierAdapter
  readonly wire: VtiWire
  /** the submissions filed by reconcile, with the last report passed to the holder */
  readonly refs: Map<string, { readonly digest: string; sent: string | null }>
  closed: boolean
  /** the ack state last written */
  persisted: string | null
  collecting: Promise<void> | null
  collectAgain: boolean
  offState: () => void
}

export function mediatorTransport(cfg: MediatorCarrierConfig): MediatorCarrier {
  const { clock } = cfg
  const C = cfg.did
  const network = () => cfg.network?.current() ?? 'unknown'
  const status = writableStore<TransportStatus>({ network: network(), carrier: 'idle' })
  /** the lease whose opening is in use; only it runs instances */
  let inUse: { refresh(): void } | null = null
  cfg.network?.subscribe(() => inUse?.refresh())

  const lease = (): CustodyLease => {
    let h: TransportHandlers | null = null
    let opening: CarrierOpening | null = null
    let wanted = false
    let stopped = false
    /** one generation per activation: an instance, a build or an answer of an earlier one acts no more */
    let gen = 0
    const instances = new Map<string, Instance>()
    const building = new Set<string>()
    /** relationships found not carried in this generation (no hint, an unreadable one, a refused ack
     *  snapshot), and why */
    const uncarried = new Set<string>()
    /** relationships chained into another: closed for good in this opening */
    const chained = new Set<string>()
    let contacts: readonly ContactView[] = []
    /** digests of entries not carried, reported awaiting-transport once per generation */
    const held = new Set<string>()
    let lastReceiveAt: number | null = null
    const carriage = writableStore<Carriage>({ contacts: {}, open: 0, lastReceiveAt: null })
    let tick: (() => void) | null = null
    const persisting = new Set<Promise<void>>()
    /** work of this lease in flight: turns it scheduled, builds, collections, wire calls (tests, harness) */
    let inFlight = 0
    const track = <T>(p: Promise<T>): Promise<T> => {
      inFlight++
      return p.finally(() => inFlight--)
    }

    const live = () => !stopped && wanted && h !== null && opening !== null && inUse === self
    const now = () => opening?.when() ?? clock.now()

    /** the relationship that carries a contact's documents: the first of its relationships (in the
     *  view's order) with this side's N that is neither chained nor found not carried. Every carried
     *  relationship of a contact reaches the same counterpart; one of them sends, so a document is
     *  never deposited on two routes. The others still receive. */
    const routes = (): Map<string, string> => {
      const out = new Map<string, string>()
      for (const c of contacts) {
        const r = c.relationships.find((x) => x.carrierNonce && !chained.has(x.id) && !uncarried.has(x.id))
        if (r) for (const id of [c.id, ...c.aliases]) out.set(id, r.id)
      }
      return out
    }
    const publish = () => {
      const byContact: Record<string, ContactCarriage> = {}
      const route = routes()
      for (const c of contacts) {
        if (!c.relationships.some((r) => r.carrierNonce)) continue
        const rel = route.get(c.id)
        const s = rel ? stateOf(rel) : 'not-carried'
        for (const id of [c.id, ...c.aliases]) byContact[id] = s
      }
      let open = 0
      for (const i of instances.values()) open += i.adapter.ackState().send?.open.length ?? 0
      carriage.set({ contacts: byContact, open, lastReceiveAt })
      if (inUse === self) {
        const states = [...instances.values()].map((i) => i.wire.state())
        const carrier: TransportStatus['carrier'] =
          states.length === 0 ? 'idle' : states.includes('unreachable') ? 'unreachable' : states.includes('connecting') ? 'connecting' : 'connected'
        status.set({ network: network(), carrier })
      }
    }
    const stateOf = (relId: string): ContactCarriage => {
      const i = instances.get(relId)
      if (i) return i.adapter.closed ? 'not-carried' : i.adapter.sendMode
      if (building.has(relId)) return 'starting'
      return 'not-carried'
    }

    const persist = (i: Instance, state: AckState | null = i.adapter.ackState()) => {
      const o = opening
      if (!o) return
      const json = JSON.stringify(state)
      if (json === i.persisted) return
      i.persisted = json
      const p = o.acks.put(i.relId, state).catch(() => {
        // the next change writes again; a sealed store (lock) is the end of this opening
        i.persisted = null
        o.diagnose('carrier-ack-state-unsaved')
      })
      persisting.add(p)
      void p.finally(() => persisting.delete(p))
    }

    const close = (i: Instance, forget: boolean) => {
      if (i.closed) return
      i.closed = true
      i.offState()
      // retired: late wire outcomes change nothing, its ack state stays readable for the persist (§6)
      i.adapter.close()
      i.wire.close()
      instances.delete(i.relId)
      persist(i, forget ? null : i.adapter.ackState())
    }
    const closeAll = () => {
      for (const i of [...instances.values()]) close(i, false)
      building.clear()
      uncarried.clear()
      held.clear()
      tick?.()
      tick = null
      publish()
    }

    /** the instances this generation should run: build what is missing, close what was chained */
    const plan = () => {
      if (!live()) return
      chained.clear()
      for (const c of contacts) for (const r of c.relationships) for (const id of r.chainedFrom) chained.add(id)
      const present = new Map<string, RelationshipView>()
      for (const c of contacts) for (const r of c.relationships) if (r.carrierNonce) present.set(r.id, r)
      for (const i of [...instances.values()]) {
        // chained into another relationship (§6, RLTP-VTI-1230): closed, no successor
        if (chained.has(i.relId)) close(i, true)
        else if (!present.has(i.relId)) close(i, false)
      }
      for (const [relId, rel] of present) {
        if (chained.has(relId) || instances.has(relId) || building.has(relId) || uncarried.has(relId)) continue
        void track(build(rel))
      }
      schedule()
      publish()
    }

    const build = async (rel: RelationshipView) => {
      const o = opening
      const g = gen
      if (!o || !rel.carrierNonce) return
      building.add(rel.id)
      publish()
      let made: { adapter: MediatorCarrierAdapter; wire: VtiWire } | null = null
      try {
        const nonce = unb64u(rel.carrierNonce.nonce)
        const own = readDeliveryHint(await deliveryHint(o.rootIkm, C, nonce), C)
        const peer = own ? readDeliveryHints(rel.counterpartDeliveryHints ?? [], C, { connection: own.connectionDid, egress: own.egressDid }) : null
        if (!peer) {
          // no readable hint of the counterpart for C: not carried (RLTP-VTI-1235)
          uncarried.add(rel.id)
          return
        }
        const stored = (await o.acks.get(rel.id)) as AckState | undefined
        const made0 = await createVtiWire({
          rootIkm: o.rootIkm,
          mediatorDid: C,
          nonce,
          peerDid: peer.connectionDid,
          peerEgressDid: peer.egressDid,
          clock,
          network,
          report: (r) => o.diagnose(r.code, r.detail),
          ...(cfg.net ? { net: cfg.net } : {}),
        })
        const wire = cfg.seam ? cfg.seam(made0, rel.id) : made0
        const at = now()
        let adapter: MediatorCarrierAdapter
        try {
          adapter = await MediatorCarrierAdapter.create(o.rootIkm, C, nonce, watched(wire, rel.id), stored, stored === undefined ? undefined : at)
        } catch {
          // a snapshot the library refuses is never replaced by a fresh one (fail-closed, profile §4)
          wire.close()
          uncarried.add(rel.id)
          o.diagnose('carrier-ack-state-refused')
          return
        }
        made = { adapter, wire }
      } catch {
        // a derivation or the store failed: the next plan of this generation tries again
        return
      } finally {
        building.delete(rel.id)
        if (!made) publish()
      }
      if (g !== gen || !live() || chained.has(rel.id)) {
        made.adapter.close()
        made.wire.close()
        publish()
        return
      }
      const i: Instance = {
        relId: rel.id,
        adapter: made.adapter,
        wire: made.wire,
        refs: new Map(),
        closed: false,
        persisted: null,
        collecting: null,
        collectAgain: false,
        offState: made.wire.onState(() => {
          publish()
          // back on the socket: what waited goes now
          if (made.wire.state() === 'connected') advance(i)
        }),
      }
      instances.set(rel.id, i)
      // the transport admission: authentication and the pickup socket (binding README fact 3)
      i.adapter.register([], now())
      persist(i)
      publish()
      schedule()
      // a fresh custody view for the new instance (RLTP-VTI-6110: only through the holder's view)
      o.offer()
    }

    /** the wire as the instance sees it: a frame it took, or a deposit that ended, wakes the carrier */
    const watched = (wire: VtiWire, relId: string): MediatorWire => ({
      authChallenge: (did) => wire.authChallenge(did),
      authenticate: (a) => track(wire.authenticate(a)),
      refresh: (t) => track(wire.refresh(t)),
      keylistUpdate: (t, r) => wire.keylistUpdate(t, r),
      deposit: (t, b, e, m) => {
        const p = track(wire.deposit(t, b, e, m))
        const wake = () => soon(() => pump(instances.get(relId)))
        p.then(wake, wake)
        return p
      },
      ackReceived: (t, q) => track(wire.ackReceived(t, q)),
      onDeliver: (cb) =>
        wire.onDeliver(async (bytes) => {
          const took = await cb(bytes)
          if (took) soon(() => collect(instances.get(relId)))
          return took
        }),
      offline: () => wire.offline(),
      queueEmpty: () => wire.queueEmpty(),
    })
    /** a turn of the event loop later (never time): the adapter applies an outcome after its wire call */
    const soon = (fn: () => void) => void track(new Promise<void>((r) => setTimeout(r, 0)).then(fn))

    /** the instance's reports to the holder, each submission's changes in order (TRANSPORT.md rule 6) */
    const pump = (i: Instance | undefined) => {
      if (!i || i.closed || !live() || !h) return
      for (const [id, ref] of [...i.refs]) {
        let r: DeliveryReport | null
        try {
          if (!i.adapter.has(id)) {
            i.refs.delete(id)
            continue
          }
          r = i.adapter.report(id)
        } catch {
          continue
        }
        if (r === null) continue
        const key = JSON.stringify(r)
        if (key === ref.sent) continue
        ref.sent = key
        h.report(r)
        if (r.status === 'delivered' || r.status === 'failed') i.refs.delete(id)
      }
      try {
        i.adapter.drainTransitions()
      } catch {
        // retired meanwhile
      }
      persist(i)
      publish()
    }

    /** frames the wire handed the instance: received by the holder, then concluded but for `later` */
    const collect = (i: Instance | undefined): Promise<void> | void => {
      if (!i || i.closed || !live()) return
      if (i.collecting) {
        i.collectAgain = true
        return i.collecting
      }
      const handlers = h
      const g = gen
      i.collecting = track((async () => {
        do {
          i.collectAgain = false
          const c = i.adapter.collect(now())
          const keep: string[] = []
          let took = false
          for (const item of c.items) {
            let env: unknown
            try {
              env = JSON.parse(td.decode(item.bytes))
            } catch {
              // not an envelope: concluded, the holder can take nothing from it
              continue
            }
            const a = handlers && g === gen ? await handlers.envelope(env).catch(() => 'later' as const) : 'later'
            if (a === 'later') keep.push(item.queueId)
            else took = true
          }
          // an answer computed for an ended generation concludes nothing: the frames stay unacknowledged
          if (i.closed || g !== gen) return
          // the reports the collection carried (answered) are applied before its conclude (lib 0.7.0)
          i.adapter.conclude(c, now(), { keep })
          if (took) lastReceiveAt = now()
          persist(i)
        } while (i.collectAgain && !i.closed && g === gen)
      })())
        .catch(() => undefined)
        .finally(() => {
          i.collecting = null
          publish()
        })
      return i.collecting
    }

    const advance = (i: Instance) => {
      if (i.closed || !live()) return
      try {
        i.adapter.advance(now())
      } catch {
        return
      }
      soon(() => pump(i))
      void collect(i)
    }
    const schedule = () => {
      if (tick || !live() || instances.size === 0) return
      tick = clock.setTimer(clock.now() + CARRIER_TICK_MS, () => {
        tick = null
        for (const i of [...instances.values()]) advance(i)
        schedule()
      })
    }


    const self: CustodyLease & { refresh(): void } = {
      kind: 'custody',
      carrier: C,
      status,
      carriage,
      start(handlers, o) {
        h = handlers
        opening = o
        if (wanted) self.activate()
      },
      activate() {
        wanted = true
        if (!h || stopped) return
        if (inUse !== self) {
          gen++
          inUse = self
        }
        plan()
      },
      deactivate() {
        wanted = false
        gen++
        closeAll()
        if (inUse === self) {
          inUse = null
          status.set({ network: network(), carrier: 'idle' })
        }
      },
      async stop() {
        self.deactivate()
        stopped = true
        h = null
        // the last ack states reach the store before the opening's app-db closes (TRANSPORT.md rule 4)
        await Promise.all([...persisting])
      },
      reconcile(view: TransportView) {
        if (!live() || !opening || !h) return
        const o = opening
        const handlers = h
        const route = routes()
        for (const i of instances.values()) {
          if (i.closed) continue
          const entries = view.entries.filter((e) => route.get(e.recipient.contactId) === i.relId)
          let refs
          try {
            refs = i.adapter.reconcile({ ...view, entries }, o.gate, now())
          } catch {
            continue
          }
          for (const r of refs) i.refs.set(r.submissionId, { digest: r.digest, sent: null })
          soon(() => pump(i))
        }
        for (const e of view.entries) {
          const k = e.resend === undefined ? e.digest : `${e.digest}#${e.resend}`
          const rel = route.get(e.recipient.contactId)
          // carried, or its instance is being built (it asks for a fresh view when it runs)
          if ((rel && (instances.has(rel) || building.has(rel))) || held.has(k)) continue
          // not carried (RLTP-VTI-1235): the holder keeps it; awaiting-transport says why it waits
          held.add(k)
          handlers.report({ digest: e.digest, status: 'awaiting-transport', reason: 'transport-unreachable' })
        }
      },
      carry(next) {
        contacts = next
        plan()
        publish()
      },
      answered(digests) {
        const at = now()
        for (const i of instances.values()) {
          for (const d of digests) {
            try {
              i.adapter.answered(d, at)
            } catch {
              // retired
            }
            for (const [id, ref] of [...i.refs]) if (ref.digest === d) i.refs.delete(id)
          }
          persist(i)
        }
        publish()
      },
      busy: () => inFlight + [...instances.values()].reduce((n, i) => n + i.wire.busy(), 0),
      refresh() {
        publish()
        if (network() === 'online') for (const i of [...instances.values()]) advance(i)
      },
    }
    return self
  }

  return { kind: 'mediator', carrier: C, status, lease }
}
