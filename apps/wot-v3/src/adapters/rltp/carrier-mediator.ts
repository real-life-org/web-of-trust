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
//  - A card this device displays with an offer for C has an instance of its own while its challenge
//    runs (TRANSPORT.md "The displayed card's instance", VTI 0.26 §1c, RLTP-VTI-1250 to 1270): an
//    adapter and a wire under the card's connection DID that knows no counterpart. Before its binding
//    a frame reaches the holder only as an envelope sealed to the card's key; once the challenge is
//    recorded (a bundle the holder judged unique or duplicate-known, or the optical capture), the
//    instance binds to the identities the sent card's hint names and becomes the instance of the new
//    relationship. It closes when the challenge ends unbound, or when the sent card names no
//    readable hint for C.

import type { ContactView, DeliveryReport, RelationshipView, TransportView } from '@real-life/trust-protocol'
import { deliveryHint, MediatorCarrierAdapter, readDeliveryHint, readDeliveryHints, WireError, type AckState, type MediatorWire, type SendMode } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { ReadStore } from '../../port'
import { writableStore } from '../../port'
import type { NetworkPort } from '../../platform/ports'
import { challengeEnd, challengeOpen, DRAIN_LIMIT_MS, type AckStore, type Carriage, type CarrierOpening, type ContactCarriage, type CustodyLease, type DeviceTimers, type DisplayedCard, type TransportHandlers, type TransportStatus } from './transport'
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
  /** tests and the harness: a wire as the adapter instance of a relationship sees it (fault injection);
   *  `key` is the relationship id, or `card:<challenge>` for a displayed card's instance (the key it
   *  was built under, also after its binding) */
  readonly seam?: (wire: VtiWire, key: string) => VtiWire
  /** tests and the harness: the ack store as the carrier sees it (fault injection) */
  readonly ackSeam?: (store: AckStore) => AckStore
}

export interface MediatorCarrier {
  readonly kind: 'mediator'
  readonly carrier: string
  readonly status: ReadStore<TransportStatus>
  lease(): CustodyLease
}

/** a sender for the diagnostics: the method, the first and the last four characters of a did:key
 *  (`did:key:z6Mk…xxxx`), enough to tell senders apart, never the key */
export const shortDid = (did: string): string => {
  const m = /^(did:[a-z0-9]+:)(.+)$/.exec(did)
  if (!m || (m[2] ?? '').length <= 8) return 'did:…'
  const id = m[2] as string
  return `${m[1] as string}${id.slice(0, 4)}…${id.slice(-4)}`
}

const unb64u = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const td = new TextDecoder()

interface Instance {
  /** the relationship it carries; null while it is a displayed card's instance not bound yet */
  relId: string | null
  /** the displayed card it was opened for, also after its binding; null for one built for a
   *  relationship */
  readonly card: DisplayedCard | null
  /** a card instance whose sent card named no readable hint for C: it closes once the collection
   *  that found it is concluded and its acknowledgement is under way */
  closeAfter: boolean
  /** the contact view named its relationship since it carries it (a card instance bound by its own
   *  bundle is ahead of the view until the next `carry`) */
  viewed: boolean
  readonly adapter: MediatorCarrierAdapter
  readonly wire: VtiWire
  /** the submissions filed by reconcile, with the last report passed to the holder */
  readonly refs: Map<string, { readonly digest: string; sent: string | null }>
  closed: boolean
  /** the ack state last handed to the store, and the write that carries it */
  persisted: string | null
  written: Promise<void>
  /** the sending mode the store holds: a deposit in another mode waits until it holds that one */
  durableMode: SendMode
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
    /** relationships found not carried in this generation, and why */
    const uncarried = new Map<string, Exclude<ContactCarriage, 'routed' | 'egress-session' | 'starting'>>()
    /** chained relationships whose ack state this opening deleted */
    const forgotten = new Set<string>()
    /** a build that failed for a transient reason is planned again on the device clock */
    let rebuild: (() => void) | null = null
    /** relationships chained into another: closed for good in this opening */
    const chained = new Set<string>()
    let contacts: readonly ContactView[] = []
    /** the cards this device displays with an offer for C (the session's list) */
    let displayed: readonly DisplayedCard[] = []
    /** displayed cards' instances not bound yet, by the card's N */
    const cards = new Map<string, Instance>()
    const buildingCards = new Set<string>()
    /** the end of the earliest running challenge: its instance closes then (RLTP-VTI-1270) */
    let cardTimer: (() => void) | null = null
    /** the drain waits of card instances closing after their last collection (cancelled at the end of
     *  the generation) */
    const drains = new Set<() => void>()
    /** digests of entries not carried, reported awaiting-transport once per generation */
    const held = new Set<string>()
    let lastReceiveAt: number | null = null
    const carriage = writableStore<Carriage>({ contacts: {}, open: 0, lastReceiveAt: null })
    let tick: (() => void) | null = null
    const persisting = new Set<Promise<unknown>>()
    /** work of this lease in flight: turns it scheduled, builds, collections, wire calls (tests, harness) */
    let inFlight = 0
    const track = <T>(p: Promise<T>): Promise<T> => {
      inFlight++
      return p.finally(() => inFlight--)
    }

    const live = () => !stopped && wanted && h !== null && opening !== null && inUse === self
    const acksOf = (o: CarrierOpening): AckStore => (cfg.ackSeam ? cfg.ackSeam(o.acks) : o.acks)
    /** per running build, the answers the holder committed meanwhile: applied when its instance is in
     *  place, before its first advance (two builds of one relationship overlap after a deactivate and
     *  activate: each has its own) */
    const answeredWhileBuilding = new Set<Set<string>>()
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
        // a contact met without a carrier offer has no N: its card named no hint for this carrier
        if (!c.relationships.some((r) => r.carrierNonce)) {
          for (const id of [c.id, ...c.aliases]) byContact[id] = 'no-hint'
          continue
        }
        // the route's state, or why the contact's own relationship is not carried
        const rel = route.get(c.id) ?? c.relationships.find((r) => r.carrierNonce && !chained.has(r.id))?.id
        const s = rel ? stateOf(rel) : 'not-carried'
        for (const id of [c.id, ...c.aliases]) byContact[id] = s
      }
      let open = 0
      for (const i of instances.values()) open += i.adapter.ackState().send?.open.length ?? 0
      carriage.set({ contacts: byContact, open, lastReceiveAt })
      if (inUse === self) {
        const states = [...instances.values(), ...cards.values()].map((i) => i.wire.state())
        const carrier: TransportStatus['carrier'] =
          states.length === 0 ? 'idle' : states.includes('unreachable') ? 'unreachable' : states.includes('connecting') ? 'connecting' : 'connected'
        status.set({ network: network(), carrier })
      }
    }
    /** a displayed card's instance with this relationship's N is running or being built: it becomes
     *  the relationship's instance at its binding */
    const cardPending = (relId: string): boolean => {
      for (const c of contacts) {
        const n = c.relationships.find((r) => r.id === relId)?.carrierNonce?.nonce
        if (n !== undefined) return cards.has(n) || buildingCards.has(n)
      }
      return false
    }
    const stateOf = (relId: string): ContactCarriage => {
      const i = instances.get(relId)
      if (i) return i.adapter.closed ? 'not-carried' : i.adapter.sendMode
      if (building.has(relId) || cardPending(relId)) return 'starting'
      const why = uncarried.get(relId)
      if (why) return why
      return rebuild ? 'starting' : 'not-carried'
    }

    /** the ack store, one relationship's reads and writes in the order they were asked for: a read
     *  after a write sees it (a restore never reads behind a close's write, review 435 R1-5) */
    const chains = new Map<string, Promise<unknown>>()
    const inOrder = <T>(relId: string, fn: () => Promise<T>): Promise<T> => {
      const p = (chains.get(relId) ?? Promise.resolve()).then(fn, fn)
      const tail = p.catch(() => undefined)
      chains.set(relId, tail)
      persisting.add(tail)
      void tail.finally(() => {
        persisting.delete(tail)
        if (chains.get(relId) === tail) chains.delete(relId)
      })
      return p
    }
    const persist = (i: Instance, state: AckState | null = i.adapter.ackState()): Promise<void> => {
      const o = opening
      // a card instance before its binding keeps nothing: its frames are offered again by the mediator
      // until acknowledged, and the holder's receive is idempotent over the digest
      const relId = i.relId
      if (!o || relId === null) return i.written
      const json = JSON.stringify(state)
      if (json === i.persisted) return i.written
      i.persisted = json
      const mode = state?.send?.mode
      i.written = inOrder(relId, () => acksOf(o).put(relId, state)).then(
        () => {
          if (mode) i.durableMode = mode
        },
        () => {
          // the next change writes again; a sealed store (lock) is the end of this opening
          i.persisted = null
          o.diagnose('carrier-ack-state-unsaved')
        },
      )
      return i.written
    }

    const close = (i: Instance, forget: boolean) => {
      if (i.closed) return
      i.closed = true
      i.offState()
      // retired: late wire outcomes change nothing, its ack state stays readable for the persist (§6)
      i.adapter.close()
      i.wire.close()
      if (i.relId === null) {
        if (i.card && cards.get(i.card.nonce) === i) cards.delete(i.card.nonce)
        return
      }
      instances.delete(i.relId)
      persist(i, forget ? null : i.adapter.ackState())
    }
    const closeAll = () => {
      for (const i of [...instances.values(), ...cards.values()]) close(i, false)
      building.clear()
      buildingCards.clear()
      cardTimer?.()
      cardTimer = null
      for (const d of [...drains]) d()
      uncarried.clear()
      held.clear()
      tick?.()
      tick = null
      rebuild?.()
      rebuild = null
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
        const relId = i.relId ?? ''
        if (chained.has(relId)) close(i, true)
        else if (present.has(relId)) i.viewed = true
        // a card instance its own bundle bound waits for the view that names its relationship, while
        // the challenge is open; otherwise a relationship the view no longer names closes
        else if (i.viewed || !i.card || !challengeOpen(i.card, now())) close(i, false)
      }
      // a chained relationship's ack state goes, whether an instance of it ran in this opening or not
      for (const id of chained) {
        if (forgotten.has(id) || !opening) continue
        forgotten.add(id)
        const o = opening
        void inOrder(id, () => acksOf(o).put(id, null)).catch(() => {
          forgotten.delete(id)
          o.diagnose('carrier-ack-state-unsaved')
        })
      }
      // displayed cards (RLTP-VTI-1250 to 1270): a recorded challenge binds its instance, an ended or no
      // longer displayed one closes it, a running one without an instance gets one
      const byNonce = new Map<string, RelationshipView>()
      for (const rel of present.values()) if (rel.carrierNonce) byNonce.set(rel.carrierNonce.nonce, rel)
      const t = now()
      for (const ci of [...cards.values()]) {
        const card = ci.card as DisplayedCard
        const rel = byNonce.get(card.nonce)
        // recorded, by a bundle at this instance, through another carrier or optically: it binds now,
        // also while a collection of it runs (its later frames then meet the bound counterpart)
        if (rel) bindTo(ci, rel)
        // the holder resolves the challenge `unknown` (1270), or the card is no longer displayed
        else if (!challengeOpen(card, t) || !displayed.some((d) => d.nonce === card.nonce)) close(ci, false)
      }
      // the cards whose instance is bound already (its relationship maybe not in the view yet)
      const bound = new Set([...instances.values()].map((i) => i.card?.nonce).filter((n): n is string => n !== undefined))
      for (const card of displayed) {
        if (!challengeOpen(card, t) || byNonce.has(card.nonce) || bound.has(card.nonce) || cards.has(card.nonce) || buildingCards.has(card.nonce)) continue
        void track(buildCard(card))
      }
      for (const [relId, rel] of present) {
        if (chained.has(relId) || instances.has(relId) || building.has(relId) || uncarried.has(relId)) continue
        // the instance of a displayed card with this N becomes the relationship's (it binds above, or
        // once its collection or its build ended)
        const n = rel.carrierNonce?.nonce ?? ''
        if (cards.has(n) || buildingCards.has(n)) continue
        void track(build(rel))
      }
      planCardEnd()
      schedule()
      publish()
    }

    /** one timer (device clock) to the first instant the library resolves the earliest open challenge
     *  of a card instance `unknown`; then `plan` asks the library's predicate (1270). An instance that
     *  closes after its running collection (`closeAfter`) is not waited for here: its collection ends
     *  it, once, after the drain (no timer at once, again and again) */
    const planCardEnd = () => {
      cardTimer?.()
      cardTimer = null
      const waiting = [...cards.values()].filter((i) => !i.closeAfter)
      if (!live() || waiting.length === 0) return
      const t = now()
      const end = Math.min(...waiting.map((i) => challengeEnd(i.card as DisplayedCard)))
      cardTimer = clock.setTimer(clock.now() + Math.max(0, end - t), () => {
        cardTimer = null
        plan()
      })
    }

    /** The displayed card's challenge is recorded (RLTP-VTI-1260): its instance binds to the identities
     *  the sent card's hint names, never to a frame's sender, and becomes the instance of the new
     *  relationship. Without a readable hint for C the instance closes and the relationship is not
     *  carried (RLTP-VTI-1235). */
    const bindTo = (i: Instance, rel: RelationshipView) => {
      if (i.closed || i.relId !== null) return
      const hints = rel.counterpartDeliveryHints ?? []
      const peer = readDeliveryHints(hints, C, { connection: i.wire.connectionDid, egress: i.wire.egressDid })
      if (!peer || instances.has(rel.id)) {
        if (!peer) uncarried.set(rel.id, hints.length === 0 ? 'no-hint' : 'hint-unreadable')
        if (i.collecting) i.closeAfter = true
        else close(i, false)
        return
      }
      try {
        i.wire.bind({ connectionDid: peer.connectionDid, egressDid: peer.egressDid })
      } catch {
        close(i, false)
        return
      }
      cards.delete((i.card as DisplayedCard).nonce)
      i.relId = rel.id
      instances.set(rel.id, i)
      persist(i)
      publish()
      schedule()
      // a fresh custody view: the new relationship's documents (the bundle's acknowledgement) go now
      opening?.offer()
    }

    /** the wire of an instance: toward the counterpart the hint names, or (null) a displayed card's,
     *  bound later; a card's refusals name their sender to the diagnostics, which redact it */
    const wireOf = async (o: CarrierOpening, nonce: Uint8Array, peer: { connectionDid: string; egressDid: string } | null, key: string): Promise<VtiWire> => {
      const made = await createVtiWire({
        rootIkm: o.rootIkm,
        mediatorDid: C,
        nonce,
        ...(peer ? { peerDid: peer.connectionDid, peerEgressDid: peer.egressDid } : {}),
        clock,
        network,
        report: (r) => o.diagnose(r.code, !peer && r.sender !== undefined ? `${r.detail} sender ${shortDid(r.sender)}` : r.detail),
        ...(cfg.net ? { net: cfg.net } : {}),
      })
      return cfg.seam ? cfg.seam(made, key) : made
    }

    /** an instance in place: its state watcher, its admission at the mediator (binding README fact 3) */
    const install = (ref: { i?: Instance }, made: { adapter: MediatorCarrierAdapter; wire: VtiWire }, relId: string | null, card: DisplayedCard | null): Instance => {
      const i: Instance = {
        relId,
        card,
        closeAfter: false,
        viewed: relId !== null,
        adapter: made.adapter,
        wire: made.wire,
        refs: new Map(),
        closed: false,
        persisted: null,
        written: Promise.resolve(),
        durableMode: made.adapter.sendMode,
        collecting: null,
        collectAgain: false,
        offState: made.wire.onState(() => {
          publish()
          // back on the socket: what waited goes now; down with an expired token: the instance renews it
          if (made.wire.state() === 'connected') advance(i)
          else renew(i)
        }),
      }
      ref.i = i
      if (relId !== null) instances.set(relId, i)
      else if (card) cards.set(card.nonce, i)
      i.adapter.register([], now())
      persist(i)
      publish()
      schedule()
      return i
    }

    /** a displayed card's instance (RLTP-VTI-1250): the trio of the card's N, a wire without a
     *  counterpart, no restored state */
    const buildCard = async (card: DisplayedCard) => {
      const o = opening
      const g = gen
      if (!o) return
      buildingCards.add(card.nonce)
      const ref: { i?: Instance } = {}
      let made: { adapter: MediatorCarrierAdapter; wire: VtiWire } | null = null
      let wire: VtiWire | null = null
      try {
        const nonce = unb64u(card.nonce)
        wire = await wireOf(o, nonce, null, `card:${card.challenge}`)
        made = { adapter: await MediatorCarrierAdapter.create(o.rootIkm, C, nonce, watched(wire, ref)), wire }
      } catch {
        wire?.close()
        if (g === gen && live()) {
          rebuild ??= clock.setTimer(clock.now() + CARRIER_TICK_MS, () => {
            rebuild = null
            plan()
          })
        }
        return
      } finally {
        buildingCards.delete(card.nonce)
      }
      if (g !== gen || !live() || !challengeOpen(card, now())) {
        made.adapter.close()
        made.wire.close()
        publish()
        return
      }
      install(ref, made, null, card)
      // recorded meanwhile (an optical capture): it binds now
      plan()
    }

    const build = async (rel: RelationshipView) => {
      const o = opening
      const g = gen
      if (!o || !rel.carrierNonce) return
      const ref: { i?: Instance } = {}
      building.add(rel.id)
      const late = new Set<string>()
      answeredWhileBuilding.add(late)
      publish()
      let made: { adapter: MediatorCarrierAdapter; wire: VtiWire } | null = null
      /** what this build made so far: closed again if the build fails */
      let partial: { adapter?: MediatorCarrierAdapter; wire?: VtiWire } = {}
      try {
        const nonce = unb64u(rel.carrierNonce.nonce)
        const own = readDeliveryHint(await deliveryHint(o.rootIkm, C, nonce), C)
        const peer = own ? readDeliveryHints(rel.counterpartDeliveryHints ?? [], C, { connection: own.connectionDid, egress: own.egressDid }) : null
        if (!peer) {
          // no readable hint of the counterpart for C: not carried (RLTP-VTI-1235)
          uncarried.set(rel.id, (rel.counterpartDeliveryHints ?? []).length === 0 ? 'no-hint' : 'hint-unreadable')
          return
        }
        const stored = (await inOrder(rel.id, () => acksOf(o).get(rel.id))) as AckState | undefined
        const wire = await wireOf(o, nonce, { connectionDid: peer.connectionDid, egressDid: peer.egressDid }, rel.id)
        partial = { wire }
        const at = now()
        let adapter: MediatorCarrierAdapter
        try {
          adapter = await MediatorCarrierAdapter.create(o.rootIkm, C, nonce, watched(wire, ref), stored, stored === undefined ? undefined : at)
        } catch {
          // a snapshot the library refuses is never replaced by a fresh one (fail-closed, profile §4)
          wire.close()
          uncarried.set(rel.id, 'ack-state-refused')
          o.diagnose('carrier-ack-state-refused')
          return
        }
        partial = { wire, adapter }
        // the holder is the truth for answers: every open deposit it answered already (a commit whose
        // ack state write a crash cut off) is answered before the instance's first advance (lib README:
        // answers for documents an earlier adapter deposited, through answered, before the next advance)
        const open = adapter.ackState().send?.open.map((x) => x.digest) ?? []
        if (open.length > 0) for (const d of await o.answered(open)) adapter.answered(d, at)
        made = { adapter, wire }
      } catch {
        partial.adapter?.close()
        partial.wire?.close()
        // a derivation or the store failed: tried again on the device clock, only while this generation
        // runs (nothing of an ended opening stays reachable from the clock, LIFECYCLE.md #428)
        if (g === gen && live()) {
          rebuild ??= clock.setTimer(clock.now() + CARRIER_TICK_MS, () => {
            rebuild = null
            plan()
          })
        }
        return
      } finally {
        building.delete(rel.id)
        if (!made) {
          answeredWhileBuilding.delete(late)
          publish()
        }
      }
      // the answers committed while it was built (lease.answered reached no instance of it yet)
      answeredWhileBuilding.delete(late)
      for (const d of late) made.adapter.answered(d, now())
      if (g !== gen || !live() || chained.has(rel.id)) {
        made.adapter.close()
        made.wire.close()
        publish()
        return
      }
      install(ref, made, rel.id, null)
      // a fresh custody view for the new instance (RLTP-VTI-6110: only through the holder's view)
      o.offer()
    }

    /** the wire as the instance sees it: a frame it took, or a deposit that ended, wakes the carrier.
     *  `ref` names the instance once it is in place (a card instance keeps it across its binding) */
    const watched = (wire: VtiWire, ref: { i?: Instance }): MediatorWire => ({
      authChallenge: (did) => wire.authChallenge(did),
      authenticate: (a) => track(wire.authenticate(a)),
      refresh: (t) => track(wire.refresh(t)),
      keylistUpdate: (t, r) => wire.keylistUpdate(t, r),
      deposit: (t, b, e, m) => {
        // a deposit in a mode the store does not hold yet waits for the write: after a crash the
        // relationship never returns to a mode it already left (RLTP-VTI-3130)
        const i = ref.i
        const p = track(
          i && i.durableMode !== m
            ? persist(i).then(() => {
                // the write did not hold the mode: no deposit in it, `later` (rule 1); the next attempt
                // writes again
                if (i.durableMode !== m) throw new WireError('unreachable', 'the send state is not stored')
                return wire.deposit(t, b, e, m)
              })
            : wire.deposit(t, b, e, m),
        )
        const wake = () => soon(() => pump(ref.i))
        p.then(wake, wake)
        return p
      },
      ackReceived: (t, q) => track(wire.ackReceived(t, q)),
      onDeliver: (cb) =>
        wire.onDeliver(async (bytes) => {
          const took = await cb(bytes)
          if (took) soon(() => collect(ref.i))
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
              if (i.card) refuseAtCard(i, item.queueId, 'not an envelope')
              continue
            }
            if (i.card) {
              const a = await atCard(i, item.queueId, env, g)
              if (a === 'later') keep.push(item.queueId)
              else if (a === 'taken') took = true
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
          if (i.closeAfter) {
            // the acknowledgement of what it concluded goes out (within the drain limit of device
            // time), then the card's instance closes; the end of the generation cancels the wait
            // (nothing of an ended opening stays reachable from the clock, LIFECYCLE.md #428)
            let cancel: () => void = () => undefined
            try {
              i.adapter.advance(now())
              await Promise.race([
                i.adapter.settle(),
                new Promise<void>((r) => {
                  const stop = clock.setTimer(clock.now() + DRAIN_LIMIT_MS, r)
                  cancel = () => {
                    stop()
                    drains.delete(cancel)
                    r()
                  }
                  drains.add(cancel)
                }),
              ])
            } catch {
              // retired meanwhile
            }
            cancel()
            close(i, false)
            return
          }
        } while (i.collectAgain && !i.closed && g === gen)
      })())
        .catch(() => undefined)
        .finally(() => {
          i.collecting = null
          publish()
        })
      return i.collecting
    }

    /** a frame at a card instance dropped: concluded (acknowledged), logged with its sender, shortened
     *  (RLTP-VTI-1265) */
    const refuseAtCard = (i: Instance, queueId: string, why: string) => {
      const from = i.wire.senderOf(queueId)
      opening?.diagnose('carrier-card-frame-refused', `${why} sender ${from === null ? 'unknown' : shortDid(from)}`)
    }
    /** One frame at a displayed card's instance (RLTP-VTI-1255 to 1265). Before the binding only an
     *  envelope sealed to the card's key reaches the holder; when the holder judged it `unique` or
     *  `duplicate-known` and the challenge is recorded, the instance binds. After the binding a frame
     *  from another sender than the counterpart's egress identity (one that came before the binding)
     *  is dropped; the wire refuses the later ones itself (RLTP-VTI-7140). */
    const atCard = async (i: Instance, queueId: string, env: unknown, g: number): Promise<'taken' | 'later' | 'dropped'> => {
      const o = opening
      const card = i.card as DisplayedCard
      const from = i.wire.senderOf(queueId)
      const bound = i.wire.peer()
      if (bound) {
        if (from !== null && from !== bound.egressDid) {
          refuseAtCard(i, queueId, 'not the counterpart')
          return 'dropped'
        }
        const a = h && g === gen ? await h.envelope(env).catch(() => 'later' as const) : 'later'
        return a === 'later' ? 'later' : 'taken'
      }
      if ((env as { rkid?: unknown } | null)?.rkid !== card.rkid) {
        refuseAtCard(i, queueId, 'not sealed to the card')
        return 'dropped'
      }
      if (!o || !h || g !== gen) return 'later'
      const r = await o.receiveAtCard(env, card).catch(() => ({ answer: 'later' as const, recorded: null }))
      // a transient answer (`concludable` false: rate-limited): the frame stays (1265)
      if (r.answer === 'later') return 'later'
      if (g !== gen || i.closed) return 'taken'
      if (!r.recorded) {
        refuseAtCard(i, queueId, 'not the bundle of the card')
        return 'taken'
      }
      bindTo(i, r.recorded)
      // the frame's sender against the hint: a diagnosis only, never a refusal (1255)
      const peer = i.wire.peer()
      if (from !== null && peer && from !== peer.egressDid) o.diagnose('carrier-hint-mismatch', `sender ${shortDid(from)}`)
      return 'taken'
    }

    /** a socket down with an expired token: the instance authenticates again through its wire
     *  (`register`, the library's keylist intent; its advance retries it until it lands) */
    const renew = (i: Instance) => {
      if (i.closed || !live() || network() === 'offline' || !i.wire.needsAuth()) return
      try {
        i.adapter.register([], now())
      } catch {
        // retired meanwhile
      }
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
      if (tick || !live() || instances.size + cards.size === 0) return
      tick = clock.setTimer(clock.now() + CARRIER_TICK_MS, () => {
        tick = null
        for (const i of [...instances.values(), ...cards.values()]) {
          renew(i)
          advance(i)
        }
        plan()
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
        // the last ack states reach the store before the opening's app-db closes, within the bound of
        // rule 4 (device time); a write that did not land is a loss the holder's state answers again
        let cancel: () => void = () => undefined
        await Promise.race([Promise.all([...persisting]), new Promise<void>((r) => (cancel = clock.setTimer(clock.now() + DRAIN_LIMIT_MS, r)))])
        cancel()
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
          if ((rel && (instances.has(rel) || building.has(rel) || cardPending(rel))) || held.has(k)) continue
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
      display(next) {
        displayed = next
        plan()
      },
      answered(digests) {
        const at = now()
        for (const pending of answeredWhileBuilding) for (const d of digests) pending.add(d)
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
      busy: () => inFlight + [...instances.values(), ...cards.values()].reduce((n, i) => n + i.wire.busy(), 0),
      refresh() {
        publish()
        if (network() !== 'online') return
        for (const i of [...instances.values(), ...cards.values()]) {
          i.wire.resume()
          renew(i)
          advance(i)
        }
        plan()
      },
    }
    return self
  }

  return { kind: 'mediator', carrier: C, status, lease }
}
