// The transport contract (src/adapters/rltp/TRANSPORT.md, rules 1 to 6) against the real carrier: the VTI
// mediator (carrier-mediator.ts), the library's MediatorCarrierAdapter per relationship and the real
// wire (wire.ts), over the mediator double (the live double: real TSP and DIDComm crypto, the network
// below replaced). Two real holders A and B meet with delivery hints and write; a seeded generator runs
// sends both ways, locks, process ends, the network going away and time; each seed arms its cells of
// the matrix, every cell is armed by exactly one seed and must fire:
//   deposit: the wire throws (before the network, or after the frame went out), the answer comes late
//            (after the next step, or after a lock to the next generation), the mediator refuses the
//            routed form (routed-refused: the switch, and no return across openings)
//   auth:    the mediator does not authenticate; the token expired (renewal)
//   socket:  the socket drops (reconnect on the device clock); new sockets are refused for a while
//   network: the device is offline (no attempt, awaiting-transport offline)
//   frame:   a frame comes twice (absorbed)
//   receive: the holder answers rate-limited, or throws (the frame stays, comes again)
//   hint:    the counterpart's card has no hint, or one for another carrier (not carried: custody)
//   chained: a relationship is chained into another (its instance closes, its ack state goes)
//   deadline: a mediator that carries no routed frames, 72 h of quiet: the switch (RLTP-VTI-3130)
//   kill:    the process dies (no shutdown: its stores sealed, its network gone) right after the holder
//            committed an answer, right after a routed refusal, with a deposit in flight, or right after
//            a receive before its frame was concluded; then 72 h of quiet on a mediator that carries
//   renewal: a side that only receives, its token expired, its socket drops: it comes back; sockets
//            refused for ten minutes: the reconnects stay within the backoff (device clock)
//   race:    deactivate and activate right after a switch: the restore reads what the close wrote
//   renewal with refused sockets: the token is renewed, the sockets keep failing for five minutes in
//            steps of five seconds: one handshake, the reconnects back off
//   auth offline: the token expired, the device offline for ten minutes: no handshake at all; the
//            mediator refusing every handshake for ten minutes: the attempts back off
//   egress:  after the switch, the mediator refuses handshakes and sockets for ten minutes in steps of
//            five seconds while A writes: the egress identity's attempts back off as the connection
//            DID's do (one session lifecycle for both)
//   kill/switch-write-failed: the switch's write fails, nothing goes in egress-session, the process
//            dies, the restore is routed again
//   displayed (A shows a card, VTI 0.26 §1c, RLTP-VTI-1250 to 1270): the scanner's bundle arrives over
//            the mediator at the card's instance, A confirms, one scan; a frame of a foreign sender at the
//            card is dropped and acknowledged; a second scanner's bundle never makes a second contact;
//            the challenge ends and the instance closes; the process dies with the card on display, the
//            bundle waits at the mediator and the next process's card instance takes it
// Invariants after every step:
//   I1 a document never leaves A's custody while not final (accepted, delivered, failed);
//   I2 A's holder records accepted only for a document whose deposit the wire resolved, delivered only
//      for one B's holder answered;
//   I3 nothing is deposited while A has no opening in use;
//   I4 nothing is deposited again once A's holder recorded it accepted;
//   I5 a fault never gives a document up: failed only for a frame the mediator lost (deadline cell);
//   I6 after a switch to egress-session reached the store, nothing of that relationship goes routed
//      again, also after a lock, a process end or a kill;
//   I7 after a kill, a relationship whose documents were answered never switches (72 h of quiet);
//   I8 nothing goes in egress-session before the store holds that mode for the relationship.
// A killed process runs on as a zombie on the shared clock (its timers fire); its stores are sealed and
// its network is gone, so nothing of it is written or sent.
// At the end (no faults, online): every document of A to B is delivered or (lost) failed; documents to
// a relationship that is not carried stay in custody; no held answer is pending.
// Time is the device clock (#430); a seed replays alike in turns, never in wall time.
import { expect } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { WireError } from '@real-life/trust-protocol/adapters/vti-mediator'
import { mlib } from './transport-mediator.lib'
import { rltpHolderHost } from '../../src/adapters/rltp/host'
import { CARRIER_TICK_MS, mediatorTransport, type MediatorCarrier } from '../../src/adapters/rltp/carrier-mediator'
import { memoryCarrier } from '../../src/adapters/rltp/transport'
import { appDbName, holderDbName } from '../../src/adapters/rltp/session'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { idbAppDb } from '../../src/adapters/rltp/app-db'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'
import { KV } from '../../src/adapters/rltp/app-data'
import { deriveWireIdentities, peerKeys, type VtiWire } from '../../src/adapters/rltp/wire'
import { pack as tspPack } from '@openvtc/vti-tsp-js'
import type { HolderHandle } from '../../src/adapters/identity/host'
import { fakeEntropy, fakeNetwork, virtualClock } from '../../src/platform/fake'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

export const CELLS = [
  'deposit/throws',
  'deposit/throws-after-network',
  'deposit/late',
  'deposit/late-old-generation',
  'deposit/routed-refused',
  'auth/down',
  'auth/token-expired',
  'socket/drops',
  'socket/refused',
  'network/offline',
  'frame/double',
  'receive/rate-limited',
  'receive/throws',
  'hint/missing',
  'hint/unreadable',
  'relationship/chained',
  'routed/deadline-switch',
  'kill/after-answer',
  'kill/after-routed-refusal',
  'kill/deposit-in-flight',
  'kill/after-receive',
  'auth/expired-receive-only',
  'socket/reconnect-bounded',
  'ackstate/restore-race',
  'auth/sockets-refused-after-renewal',
  'kill/switch-write-failed',
  'auth/offline-expired',
  'auth/atm-refusing',
  'egress/mediator-unreachable',
  'displayed/bundle-arrives',
  'displayed/foreign-frame',
  'displayed/second-scan',
  'displayed/expired',
  'kill/displayed-pending',
] as const
export type Cell = (typeof CELLS)[number]
export const visited = new Set<Cell>()

/** the cells each seed arms; together every cell, each once. The deadline cell moves time by 72 h and
 *  runs in a seed of its own, beside cells that do not mind the long jump */
const PLANS: Readonly<Record<number, readonly Cell[]>> = {
  1: ['deposit/throws', 'deposit/late', 'socket/drops'],
  2: ['deposit/throws-after-network', 'deposit/late-old-generation', 'auth/token-expired', 'displayed/bundle-arrives'],
  3: ['deposit/routed-refused', 'network/offline', 'frame/double', 'kill/displayed-pending'],
  4: ['auth/down', 'receive/rate-limited', 'hint/missing'],
  5: ['socket/refused', 'receive/throws', 'hint/unreadable', 'relationship/chained'],
  6: ['routed/deadline-switch', 'displayed/expired', 'displayed/second-scan'],
  7: ['kill/after-answer', 'auth/expired-receive-only', 'displayed/foreign-frame'],
  8: ['kill/after-routed-refusal', 'socket/reconnect-bounded'],
  9: ['kill/deposit-in-flight', 'ackstate/restore-race'],
  10: ['kill/after-receive', 'auth/sockets-refused-after-renewal'],
  11: ['kill/switch-write-failed'],
  12: ['auth/offline-expired', 'auth/atm-refusing'],
  13: ['egress/mediator-unreachable'],
}
export const SEEDS_ALL = Object.keys(PLANS).map(Number)
export const forced = (seed: number): readonly Cell[] => PLANS[seed] ?? []
/** a seed replays alike in turns; this is the bound for a hang */
export const SEED_TIMEOUT_MS = 20_000

function rng(seed: number) {
  let a = seed >>> 0 || 1
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T }
}

const T0 = Date.parse('2026-10-20T10:00:00Z')
const HOUR = 3_600_000
const turn = () => new Promise<void>((r) => setTimeout(r, 0))
/** canonical JSON (sorted keys): the bytes a deposit carries are the JCS form of the envelope */
const canon = (v: unknown): string =>
  v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`

interface CodecState {
  commitSeq?: unknown
  outbox: Record<string, { type: string; envelope: unknown; recipient: { contactId: string }; history: { status: string; reason?: string }[] }>
}

type Op = 'aSend' | 'bSend' | 'lock' | 'end' | 'offline' | 'online' | 'jump' | 'tick'
const OPS: readonly Op[] = ['aSend', 'aSend', 'bSend', 'bSend', 'lock', 'end', 'offline', 'online', 'online', 'jump', 'tick']

export async function run(seed: number) {
  const r = rng(seed * 7919 + 17)
  const log: string[] = []
  const violations: string[] = []
  mlib.reset()
  mlib.chain = null
  mlib.received.clear()
  const vc = virtualClock(T0, 'UTC')
  const med = mediatorDouble(undefined, () => vc.now())
  const other = mediatorDouble('did:example:another-mediator', () => vc.now())
  const netA = fakeNetwork()
  const idb = new IDBFactory()
  const keysA = { rootIkm: new Uint8Array(64).fill(41), dek: new Uint8Array(32).fill(42) }
  const keysB = { rootIkm: new Uint8Array(64).fill(51), dek: new Uint8Array(32).fill(52) }
  const life = new Set<(s: 'active' | 'background') => void>()
  const lifecycle = { onState: (cb: (s: 'active' | 'background') => void) => (life.add(cb), () => void life.delete(cb)) }
  let ent = 1200 + seed * 10
  const host = (transport: Parameters<typeof rltpHolderHost>[0]['transport']) =>
    rltpHolderHost({ idb, clock: vc, entropy: fakeEntropy(ent++), transport, writer: { acquire: async () => () => {} }, publish: () => {}, emit: () => {}, onCurrent: () => {}, lifecycle })

  // ── the fault seam on A's wires ────────────────────────────────────────────────────────────────
  const ctx = { inUse: false }
  const armed = new Set<Cell>()
  /** a cell whose effect the step observed */
  const hit = (c: Cell, note = '') => {
    armed.delete(c)
    visited.add(c)
    log.push(`  ! ${c}${note}`)
  }
  const fire = (c: Cell) => {
    if (!armed.delete(c)) return false
    visited.add(c)
    log.push(`  ! ${c}`)
    return true
  }
  /** envelopes (canonical) whose deposit the wire resolved */
  const resolved = new Set<string>()
  /** envelopes the mediator took and lost (routed frames a mediator does not carry) */
  const lost = new Set<string>()
  /** A's last observed status per envelope */
  const statusOf = new Map<string, string>()
  /** relationships whose stored send state is egress-session (read from A's app-db each observation) */
  const switched = new Set<string>()
  const holds: { release: () => void; late: boolean }[] = []
  const deposits: { relId: string; mode: string }[] = []
  /** A's processes; a killed one runs no more code in reality: its deposits fail before the network */
  let proc = 0
  const dead = new Set<number>()
  const seamOf = (me: number) => (w: VtiWire, relId: string): VtiWire => ({
    ...w,
    deposit(t, bytes, egress, mode) {
      if (dead.has(me)) return Promise.reject(new WireError('unreachable', 'the process is dead'))
      let text = ''
      try {
        text = canon(JSON.parse(new TextDecoder().decode(bytes)))
      } catch {
        violations.push('I2: a deposit that is no envelope')
      }
      if (!ctx.inUse) violations.push(`I3: ${relId} deposited while A has no opening in use`)
      const st = statusOf.get(text)
      if (st === 'accepted' || st === 'delivered') violations.push(`I4: deposited again after A recorded it ${st}`)
      if (switched.has(relId) && mode === 'routed') violations.push(`I6: ${relId} went routed after its switch to egress-session`)
      if (mode === 'egress-session' && durableModes.get(relId) !== 'egress-session') violations.push(`I8: ${relId} deposited in egress-session before the store held that mode`)
      deposits.push({ relId, mode })
      if (fire('deposit/throws')) return Promise.reject(new WireError('unreachable', 'injected'))
      if (mode === 'routed' && (fire('deposit/routed-refused') || fire('kill/after-routed-refusal'))) {
        // the kill comes before the switch reaches the store: the process dies in this very turn
        if (killNow) killNow('after the routed refusal')
        return Promise.reject(new WireError('routed-refused', 'injected'))
      }
      const out = w.deposit(t, bytes, egress, mode).then(() => {
        if (med.faults.dropRouted && mode === 'routed') lost.add(text)
      })
      if (fire('deposit/throws-after-network')) return out.then(() => Promise.reject(new WireError('unreachable', 'injected after the frame went out')))
      if (fire('kill/deposit-in-flight')) {
        // the frame is on its way and its answer held; the process dies before the answer comes
        const flying = out.then(() => void resolved.add(text))
        // its outcome stays held until the release (handled meanwhile: the dead network may refuse it)
        flying.catch(() => undefined)
        if (killNow) killNow('with a deposit in flight')
        return new Promise<void>((res, rej) => holds.push({ late: true, release: () => void flying.then(res, rej) }))
      }
      const late = fire('deposit/late-old-generation') ? true : fire('deposit/late') ? false : null
      const done = out.then(() => void resolved.add(text))
      if (late === null) return done
      return new Promise<void>((res, rej) => holds.push({ late, release: () => void done.then(res, rej) }))
    },
  })

  // ── the devices ────────────────────────────────────────────────────────────────────────────────
  /** the network of A's process: a kill takes it away with the process */
  let netOfA = phoneNet(med.net)
  /** the sending mode each relationship's stored ack state holds (the writes that landed) */
  const durableModes = new Map<string, string>()
  /** the next ack state writes fail (the switch's write) */
  let failAckWrites = false
  const ackSeam = (st: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> }) => ({
    get: (k: string) => st.get(k),
    put: async (k: string, v: unknown) => {
      if (failAckWrites) throw new Error('injected ack state write failure')
      await st.put(k, v)
      const mode = (v as { send?: { mode?: string } } | null)?.send?.mode
      if (mode) durableModes.set(k, mode)
      else if (v === null) durableModes.delete(k)
    },
  })
  const carrierOf = (): MediatorCarrier => mediatorTransport({ did: med.did, clock: vc, network: netA, net: netOfA.net, seam: seamOf(++proc), ackSeam })
  /** set while a kill may come from inside a call (the seam, the holder's receive) */
  let killNow: ((why: string) => void) | null = null
  let A = host(carrierOf())
  const B = host(mediatorTransport({ did: med.did, clock: vc, net: med.net }))
  // E shows cards without a hint (a carrier that takes documents); D shows a hint for another carrier
  const E = host(memoryCarrier(vc).endpoint('E'))
  const D = host(mediatorTransport({ did: other.did, clock: vc, net: other.net }))
  // F meets A over the same carrier: its relationship is the one the chained cell folds into B's
  const F = host(mediatorTransport({ did: med.did, clock: vc, net: med.net }))
  // G, H and J scan cards A displays (the displayed cells): each meets A once
  const G = host(mediatorTransport({ did: med.did, clock: vc, net: med.net }))
  const H = host(mediatorTransport({ did: med.did, clock: vc, net: med.net }))
  const J = host(mediatorTransport({ did: med.did, clock: vc, net: med.net }))
  const open = async (h: typeof A, ns: string, keys: { rootIkm: Uint8Array; dek: Uint8Array }) => {
    mlib.tag = ns
    const o = await h.open(ns, keys)
    if (o.kind !== 'ok') throw Error(`open ${ns}`)
    h.activate?.(o.holder)
    return o.holder
  }
  let ah: HolderHandle = await open(A, 'A', keysA)
  ctx.inUse = true
  const bh = await open(B, 'B', keysB)
  // each seed opens only the other devices its cells meet: a seed's file stays within its bound in the
  // parallel run of the whole suite (the opening and the carrier of a device cost real crypto)
  const plan0 = forced(seed)
  const meets = (...cs: Cell[]) => cs.some((c) => plan0.includes(c))
  const others: [typeof A, HolderHandle][] = []
  const openIf = async (on: boolean, h: typeof A, ns: string, fill: number) => {
    if (!on) return
    others.push([h, await open(h, ns, { rootIkm: new Uint8Array(64).fill(fill), dek: new Uint8Array(32).fill(fill + 1) })])
  }
  await openIf(meets('hint/missing'), E, 'E', 61)
  await openIf(meets('hint/unreadable'), D, 'D', 71)
  await openIf(meets('relationship/chained'), F, 'F', 81)
  await openIf(meets('displayed/bundle-arrives', 'displayed/second-scan'), G, 'G', 91)
  await openIf(meets('displayed/second-scan'), H, 'H', 101)
  await openIf(meets('kill/displayed-pending'), J, 'J', 121)
  const sealer = await createSealer(keysA.dek)
  const store = idbHolderStore({ idb, name: holderDbName('A'), sealer, seal: { sealed: false }, uuid: () => crypto.randomUUID() })
  const appA = idbAppDb({ idb, name: appDbName('A'), sealer, seal: { sealed: false } })

  /** until rest: the double's turns done, sessions idle, no carrier work in flight, revisions unchanged */
  const settle = async () => {
    let last = ''
    let calm = 0
    for (let i = 0; i < 600; i++) {
      await med.settled()
      await A.current()?.idle()
      await B.current()?.idle()
      await turn()
      const busy = (A.current()?.transportBusy() ?? 0) + (B.current()?.transportBusy() ?? 0)
      const now = JSON.stringify([A.current()?.models()?.revision ?? null, B.current()?.models()?.revision ?? null])
      calm = busy === 0 && now === last ? calm + 1 : 0
      last = now
      if (calm >= 2) return
    }
    // a held answer keeps the carrier busy on purpose: rest is reached when only holds remain
    if (holds.length === 0) throw Error(`settle: no rest after 600 rounds (seed ${seed})`)
  }
  const step = async () => {
    vc.advance(CARRIER_TICK_MS)
    for (const cb of life) cb('active')
    await settle()
  }
  const shutdown = async () => {
    ctx.inUse = false
    A.deactivate?.()
    await A.quiesce(ah)
    await A.seal(ah)
    await A.close(ah)
  }
  /** the process dies: no quiesce, no close; its stores are sealed (nothing more is written), its
   *  network is gone (its sockets close, nothing more is sent); the holder's databases stay */
  let killed: string | null = null
  const kill = (why: string) => {
    killed = why
    void A.seal(ah)
    dead.add(proc)
    netOfA.setOnline(false)
    ctx.inUse = false
    log.push(`  (killed ${why})`)
  }
  const afterKill = async () => {
    killed = null
    killNow = null
    mlib.afterReceive = null
    netOfA = phoneNet(med.net)
    A = host(carrierOf())
    ah = await open(A, 'A', keysA)
    ctx.inUse = true
    await settle()
  }
  /** I7: 72 h of quiet on a mediator that carries routed frames; a relationship whose documents were
   *  answered stays routed unless its stored send state switched */
  const quiet72 = async () => {
    for (let j = 0; j < 3; j++) await step()
    // the stored send states as they stand now (observe reads them)
    const st = await observe()
    const durable = switched.size > 0
    const unanswered = Object.values(st.outbox).some((o) => o.recipient.contactId === aId && o.history.at(-1)?.status === 'accepted')
    for (let j = 0; j < 4; j++) {
      vc.advance(19 * HOUR)
      for (const cb of life) cb('active')
      await settle()
      await step()
    }
    await observe()
    if ((await carriageOf(A))[aId] === 'egress-session' && !durable && !unanswered) violations.push('I7: the relationship switched after the kill though its documents were answered')
  }
  const reopen = async (fresh: boolean) => {
    if (fresh) A = host(carrierOf())
    ah = await open(A, 'A', keysA)
    ctx.inUse = true
    await settle()
  }

  const ledger = new Map<string, string>()
  const FINAL = new Set(['accepted', 'delivered', 'failed'])
  const observe = async (): Promise<CodecState> => {
    const st = (await store.read()).state as unknown as CodecState
    for (const [d, s] of ledger) if (!(d in st.outbox) && !FINAL.has(s)) violations.push(`I1: ${d.slice(0, 10)} left A's custody while ${s}`)
    for (const [d, o] of Object.entries(st.outbox)) {
      const text = canon(o.envelope)
      const last = o.history.at(-1)
      if (!last) continue
      ledger.set(d, last.status)
      statusOf.set(text, last.status)
      // accepted is the carrier's report on a deposit it took; delivered is B's acknowledgement, which
      // A's holder verifies itself (a deposit that threw may still have reached B, rule 5)
      if (o.history.some((h) => h.status === 'accepted') && !resolved.has(text)) violations.push(`I2: A records ${d.slice(0, 10)} accepted, no deposit of it resolved`)
      if (last.status === 'delivered' && !mlib.received.has(d)) violations.push(`I2: A records ${d.slice(0, 10)} delivered, its counterpart never answered it`)
      if (last.status === 'failed' && !lost.has(text)) violations.push(`I5: ${d.slice(0, 10)} given up on a fault: ${last.reason}`)
    }
    for (const f of mlib.fired.splice(0)) if (armed.has(f as Cell)) hit(f as Cell, ' (fired)')
    for (const [k, v] of (await appA.readAll()).kv) if (k.startsWith(KV.acks) && (v as { send?: { mode?: string } } | null)?.send?.mode === 'egress-session') switched.add(k.slice(KV.acks.length))
    return st
  }

  // ── the people ─────────────────────────────────────────────────────────────────────────────────
  type Host = typeof A
  const contacts = (h: Host) => h.current()?.models()?.contacts ?? []
  let k = 0
  /** `shower` shows a card, A scans it; returns A's new contact */
  const aScans = async (shower: Host) => {
    const before = new Set(contacts(A).map((c) => c.id))
    const card = await shower.current()!.intent<{ qr: string }>('showCard', '', `show-${++k}`, {}).done
    if (!card.ok) throw Error(`show ${JSON.stringify(card)}`)
    const done = await A.current()!.intent('confirmCard', '', `scan-${k}`, { card: decodeCardLink(card.value.qr), role: 'displayed' }).done
    if (!done.ok) throw Error(`scan ${JSON.stringify(done)}`)
    await settle()
    return contacts(A).find((c) => !before.has(c.id))?.id ?? ''
  }
  /** A shows a card: its challenge, the card, and the connection DID of its instance (from the N the
   *  show act journaled into the displayed cards) */
  const aShows = async () => {
    const shown = await A.current()!.intent<{ qr: string }>('showCard', '', `show-a-${++k}`, {}).done
    if (!shown.ok) throw Error(`A show ${JSON.stringify(shown)}`)
    const card = decodeCardLink(shown.value.qr) as { challenge: { value: string } }
    const displayed = (await appA.get<Record<string, { nonce: string }>>('kv', KV.displayed)) ?? {}
    const n = displayed[card.challenge.value]?.nonce
    if (!n) throw Error('A show: no displayed card journaled')
    const nonce = Uint8Array.from(atob(n.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (n.length % 4)) % 4)), (c) => c.charCodeAt(0))
    const conn = (await deriveWireIdentities(keysA.rootIkm, med.did, nonce)).conn.did
    return { card, conn }
  }
  /** `scanner` scans a card A shows: its bundle goes over the mediator */
  const scansA = async (scanner: Host, card: unknown) => {
    const done = await scanner.current()!.intent('confirmCard', '', `scan-a-${++k}`, { card, role: 'displayed' }).done
    if (!done.ok) throw Error(`scan of A's card ${JSON.stringify(done)}`)
  }
  /** A confirms the contact its card's bundle made (the counter-step) */
  const aConfirms = async (id: string) => {
    const ok = await A.current()!.intent('counterVerify', `c:${id}`, `counter-${id}`, { contactId: id }).done
    if (!ok.ok) throw Error(`A counter ${JSON.stringify(ok)}`)
  }
  let sent = 0
  const send = async (from: Host, to: string) => {
    const n = ++sent
    await from
      .current()
      ?.intent('send', `c:${to}`, `send|m-${n}`, { contactId: to, text: `m-${n}`, draftKey: `m-${n}` })
      .done.catch((e: unknown) => log.push(`  send: ${String(e)}`))
  }

  let aId = ''
  let bId = ''
  /** contacts never carried (no readable hint): their documents stay in custody */
  const uncarried = new Set<string>()
  /** contacts whose relationship was folded into another: what went before is accepted or delivered
   *  (F answers through its displayed card's instance), what came after stays in custody */
  const folded = new Set<string>()
  try {
    // the encounter with hints, one scan: B shows, A scans, A's bundle reaches B's card instance over the
    // mediator, B confirms (VTI 0.26 §1c)
    aId = await aScans(B)
    for (let i = 0; i < 4 && contacts(B).length === 0; i++) await step()
    bId = contacts(B)[0]?.id ?? ''
    if (!bId) throw Error('setup: the bundle never reached B')
    const ok = await B.current()!.intent('counterVerify', `c:${bId}`, `counter-${bId}`, { contactId: bId }).done
    if (!ok.ok) throw Error('counter')
    for (let i = 0; i < 3; i++) await step()
    if (contacts(A)[0]?.verification !== 'mutual') throw Error(`setup: not mutual (${contacts(A)[0]?.verification})`)

    const plan = forced(seed)
    const at = new Map<number, Cell>()
    plan.forEach((c, i) => at.set(i * 3 + r.int(2), c))
    for (let i = 0; i < Math.max(8, plan.length * 3 + 2); i++) {
      const c = at.get(i)
      let op: Op = r.pick(OPS)
      if (c) {
        armed.add(c)
        netA.set('online')
        op = 'aSend'
      }
      log.push(`${i}: ${op}${c ? ` [${c}]` : ''}`)
      switch (c) {
        case 'deposit/late-old-generation': {
          await send(A, aId)
          await settle()
          if (holds.length === 0) break
          await shutdown()
          await reopen(false)
          for (const h of holds.splice(0)) h.release()
          await settle()
          continue
        }
        case 'deposit/routed-refused': {
          // the refusal switches at once; the send state goes into the app-db and the next process
          // restores it: nothing of the relationship goes routed again (I6)
          await send(A, aId)
          await step()
          await step()
          if ((await carriageOf(A))[aId] !== 'egress-session') violations.push(`routed-refused: carriage ${String((await carriageOf(A))[aId])}`)
          await shutdown()
          log.push('  (process end)')
          await reopen(true)
          await send(A, aId)
          await step()
          if ((await carriageOf(A))[aId] !== 'egress-session') violations.push(`routed-refused: back to ${String((await carriageOf(A))[aId])} after a process end`)
          continue
        }
        case 'auth/down': {
          med.faults.authDown = true
          await shutdown()
          await reopen(false)
          await send(A, aId)
          await step()
          if (med.counts.authRefused > 0) hit(c)
          med.faults.authDown = false
          await step()
          continue
        }
        case 'auth/token-expired': {
          const auths = [...med.counts.auths.values()].reduce((a, b) => a + b, 0)
          vc.advance(601_000)
          await send(A, aId)
          await step()
          if ([...med.counts.auths.values()].reduce((a, b) => a + b, 0) > auths) hit(c)
          continue
        }
        case 'socket/drops': {
          const before = med.opened.length
          med.dropAll()
          await settle()
          await send(A, aId)
          await step()
          if (med.opened.length > before) hit(c)
          continue
        }
        case 'socket/refused': {
          med.faults.refuseSockets = true
          med.dropAll()
          await send(A, aId)
          await step()
          await step()
          if (med.counts.socketsRefused > 0) hit(c)
          med.faults.refuseSockets = false
          await step()
          await step()
          continue
        }
        case 'network/offline': {
          netA.set('offline')
          await send(A, aId)
          await step()
          const st = await observe()
          if (Object.values(st.outbox).some((o) => o.history.some((h) => h.status === 'awaiting-transport' && h.reason === 'offline'))) hit(c)
          netA.set('online')
          await step()
          continue
        }
        case 'frame/double': {
          await send(B, bId)
          await step()
          // the last frame of every open socket comes once more: A's and B's instances absorb it
          if ([...med.sockets.keys()].map((did) => med.again(did)).some(Boolean)) hit(c)
          await step()
          continue
        }
        case 'receive/rate-limited':
        case 'receive/throws': {
          mlib.failReceive = c === 'receive/rate-limited' ? 'rate-limited' : 'throws'
          await send(B, bId)
          await step()
          await step()
          continue
        }
        case 'hint/missing':
        case 'hint/unreadable': {
          const id = await aScans(c === 'hint/missing' ? E : D)
          uncarried.add(id)
          await step()
          const st = await observe()
          const bundle = Object.values(st.outbox).find((o) => o.recipient.contactId === id)
          const carriage = A.current() ? (await carriageOf(A))[id] : undefined
          if (carriage === (c === 'hint/missing' ? 'no-hint' : 'hint-unreadable') && bundle && bundle.history.at(-1)?.status === 'awaiting-transport') hit(c)
          else violations.push(`${c}: carriage ${String(carriage)}, bundle ${JSON.stringify(bundle?.history.at(-1))}`)
          continue
        }
        case 'relationship/chained': {
          // a relationship of A's own, carried: F's. The library's flows chain nothing before continuity,
          // so the view folds it into B's relationship (RLTP-VTI-1230): its instance closes for good
          const fId = await aScans(F)
          folded.add(fId)
          await step()
          const before = [...(await appA.readAll()).kv.keys()].filter((x) => x.startsWith(KV.acks))
          if ((await carriageOf(A))[fId] !== 'routed' || before.length !== 2) violations.push(`chained: F not carried before (${JSON.stringify(await carriageOf(A))}, ${before.length} ack states)`)
          mlib.chain = { into: aId, from: fId }
          await send(A, aId)
          await step()
          const after = [...(await appA.readAll()).kv.keys()].filter((x) => x.startsWith(KV.acks))
          const gone = before.filter((x) => !after.includes(x)).map((x) => x.slice(KV.acks.length))
          if (gone.length === 1) hit(c, ` ${gone[0]?.slice(0, 10)}`)
          else violations.push(`chained: ack states before ${before.length}, after ${after.length}`)
          const n = deposits.length
          await send(A, aId)
          await send(A, fId)
          await step()
          if (deposits.slice(n).some((d) => gone.includes(d.relId))) violations.push('chained: the closed instance deposited again')
          if ((await carriageOf(A))[aId] === undefined) violations.push('chained: the chain is no longer carried')
          continue
        }
        case 'kill/after-answer': {
          // the holder commits B's acknowledgement of A's document; the process dies before the
          // carrier writes that the deposit was answered
          killNow = kill
          mlib.afterReceive = (r) => {
            if (killed || !r.events?.some((e) => e.type === 'delivery.status' && e.status === 'delivered')) return
            mlib.afterReceive = null
            hit(c)
            kill('after the holder committed an answer')
          }
          await send(A, aId)
          for (let j = 0; j < 4 && !killed; j++) await step()
          if (!killed) violations.push('kill/after-answer: no answer came')
          await afterKill()
          await quiet72()
          continue
        }
        case 'kill/after-routed-refusal':
        case 'kill/deposit-in-flight': {
          killNow = kill
          await send(A, aId)
          for (let j = 0; j < 4 && !killed; j++) await step()
          if (!killed) violations.push(`${c}: the deposit never came`)
          await afterKill()
          for (const h of holds.splice(0)) h.release()
          await quiet72()
          continue
        }
        case 'kill/after-receive': {
          // A's holder takes B's message; the process dies before the frame was concluded and acked:
          // the mediator offers it again, the holder absorbs it, it shows once
          killNow = kill
          mlib.afterReceive = (r) => {
            if (killed || r.disposition !== 'unique' || !r.events?.some((e) => e.type === 'message.received')) return
            mlib.afterReceive = null
            hit(c)
            kill('after a receive, before its conclusion')
          }
          await send(B, bId)
          for (let j = 0; j < 4 && !killed; j++) await step()
          if (!killed) violations.push('kill/after-receive: no message came')
          await afterKill()
          for (let j = 0; j < 3; j++) await step()
          const texts = (A.current()?.models()?.conversations.get(`c:${aId}`)?.items ?? []).filter((x) => x.kind === 'message').map((x) => (x as { text: string }).text)
          if (new Set(texts).size !== texts.length) violations.push(`kill/after-receive: a message shows twice (${texts.length})`)
          await quiet72()
          continue
        }
        case 'auth/expired-receive-only': {
          // nothing of A to send; its token expires and its socket drops: B's message still arrives
          for (let j = 0; j < 2; j++) await step()
          vc.advance(601_000)
          med.dropAll()
          await settle()
          const before = sent
          await send(B, bId)
          for (let j = 0; j < 4; j++) await step()
          const texts = (A.current()?.models()?.conversations.get(`c:${aId}`)?.items ?? []).filter((x) => x.kind === 'message').map((x) => (x as { text: string }).text)
          if (texts.includes(`m-${before + 1}`)) hit(c)
          else violations.push(`auth/expired-receive-only: B's message never reached A (${med.counts.expiredRefused} upgrades with an expired token)`)
          if (med.counts.expiredRefused > 0) violations.push(`auth/expired-receive-only: ${med.counts.expiredRefused} upgrades tried with an expired token`)
          continue
        }
        case 'socket/reconnect-bounded': {
          // ten minutes without sockets, in steps of device time: the reconnects follow the backoff
          med.faults.refuseSockets = true
          med.dropAll()
          const tries = med.counts.socketsRefused
          for (let j = 0; j < 20; j++) {
            vc.advance(30_000)
            await settle()
          }
          const made = med.counts.socketsRefused - tries
          // two sides; per side from 50 ms doubling to 30 s, then one per 30 s: about 10 + 20, plus the
          // carrier's renewals; the bound is twice that
          if (made === 0 || made > 2 * 2 * 30) violations.push(`socket/reconnect-bounded: ${made} socket attempts in 10 min`)
          else hit(c, ` ${made} attempts`)
          med.faults.refuseSockets = false
          for (let j = 0; j < 3; j++) await step()
          await send(A, aId)
          for (let j = 0; j < 3; j++) await step()
          continue
        }
        case 'ackstate/restore-race': {
          // the switch, then at once a new generation of the same opening: its restore reads what the
          // close of the old one wrote, never an older state
          armed.add('deposit/routed-refused')
          await send(A, aId)
          await settle()
          armed.delete('deposit/routed-refused')
          A.deactivate?.()
          A.activate?.(ah)
          await settle()
          await step()
          if ((await carriageOf(A))[aId] === 'egress-session') hit(c)
          else violations.push(`restore-race: carriage ${String((await carriageOf(A))[aId])} after the new generation`)
          continue
        }
        case 'auth/sockets-refused-after-renewal': {
          // the token expires and every socket is refused: the renewal succeeds once, the sockets back
          // off; five minutes in steps of five seconds (the carrier's tick) show every handshake
          for (let j = 0; j < 2; j++) await step()
          vc.advance(601_000)
          med.faults.refuseSockets = true
          med.dropAll()
          await settle()
          const auths = () => [...med.counts.auths.values()].reduce((a, b) => a + b, 0)
          const before = auths()
          for (let j = 0; j < 60; j++) {
            vc.advance(5000)
            await settle()
          }
          const made = auths() - before
          // A and B, one renewal each, a second one at most where a renewal raced the drop
          if (made > 4) violations.push(`renewal with refused sockets: ${made} handshakes in 5 min`)
          else hit(c, ` ${made} handshakes`)
          med.faults.refuseSockets = false
          for (let j = 0; j < 8; j++) await step()
          const n = sent
          await send(B, bId)
          for (let j = 0; j < 4; j++) await step()
          const texts = (A.current()?.models()?.conversations.get(`c:${aId}`)?.items ?? []).filter((x) => x.kind === 'message').map((x) => (x as { text: string }).text)
          if (!texts.includes(`m-${n + 1}`)) violations.push('renewal with refused sockets: B\'s message never reached A after the sockets came back')
          continue
        }
        case 'kill/switch-write-failed': {
          // the mediator refuses the routed form, the switch's write fails: nothing goes in
          // egress-session (I8); the process dies; the restore is routed and carries again
          failAckWrites = true
          armed.add('deposit/routed-refused')
          await send(A, aId)
          for (let j = 0; j < 3; j++) await step()
          armed.delete('deposit/routed-refused')
          if ((await carriageOf(A))[aId] === 'egress-session') hit(c)
          else violations.push(`kill/switch-write-failed: carriage ${String((await carriageOf(A))[aId])} after the refusal`)
          kill('with the switch not stored')
          failAckWrites = false
          await afterKill()
          if ((await carriageOf(A))[aId] !== 'routed') violations.push(`kill/switch-write-failed: restored ${String((await carriageOf(A))[aId])}`)
          await quiet72()
          continue
        }
        case 'auth/offline-expired':
        case 'auth/atm-refusing': {
          // ten minutes in steps of five seconds (the carrier's tick): offline no handshake; refused,
          // the handshakes back off on the device clock (from 50 ms doubling to 30 s per wire)
          for (let j = 0; j < 2; j++) await step()
          vc.advance(601_000)
          if (c === 'auth/offline-expired') netA.set('offline')
          else med.faults.authDown = true
          netOfA.drop()
          await settle()
          // A's HTTP requests (each handshake is two: challenge and answer)
          const a0 = netOfA.requests()
          for (let j = 0; j < 120; j++) {
            vc.advance(5000)
            await settle()
          }
          const made = netOfA.requests() - a0
          netA.set('online')
          med.faults.authDown = false
          // offline: none; refused: within the backoff (from 50 ms doubling to 30 s: about 10 + 20 tries
          // in 10 min, each up to two requests)
          const bound = c === 'auth/offline-expired' ? 0 : 2 * (10 + 20)
          if (made > bound) violations.push(`${c}: ${made} requests of A in 10 min`)
          else hit(c, ` ${made} requests`)
          for (let j = 0; j < 8; j++) await step()
          const n = sent
          await send(B, bId)
          for (let j = 0; j < 4; j++) await step()
          const texts = (A.current()?.models()?.conversations.get(`c:${aId}`)?.items ?? []).filter((x) => x.kind === 'message').map((x) => (x as { text: string }).text)
          if (!texts.includes(`m-${n + 1}`)) violations.push(`${c}: B's message never reached A afterwards`)
          continue
        }
        case 'egress/mediator-unreachable': {
          // the switch first (a refusal of the routed form), then the mediator goes away for the egress
          // identity's handshakes and sockets
          armed.add('deposit/routed-refused')
          await send(A, aId)
          for (let j = 0; j < 3; j++) await step()
          armed.delete('deposit/routed-refused')
          if ((await carriageOf(A))[aId] !== 'egress-session') violations.push(`egress: carriage ${String((await carriageOf(A))[aId])} after the refusal`)
          // fresh tokens for both identities first (a renewal while the mediator answers)
          vc.advance(601_000)
          await send(A, aId)
          for (let j = 0; j < 3; j++) await step()
          // then the mediator refuses handshakes and sockets for five minutes (inside the tokens'
          // lifetime): the identities wait in the backoff, they do not authenticate per tick
          med.faults.authDown = true
          med.faults.refuseSockets = true
          netOfA.drop()
          await settle()
          const r0 = netOfA.requests()
          const s0 = med.counts.socketsRefused
          for (let j = 0; j < 60; j++) {
            if (j % 12 === 0) await send(A, aId)
            vc.advance(5000)
            await settle()
          }
          const made = netOfA.requests() - r0
          const sockets = med.counts.socketsRefused - s0
          med.faults.authDown = false
          med.faults.refuseSockets = false
          // no handshake (the tokens stand); sockets of A's and B's identities within the backoff
          if (made > 0 || sockets > 3 * 25) violations.push(`egress: ${made} requests of A, ${sockets} sockets in 5 min`)
          else hit(c, ` ${made} requests, ${sockets} sockets`)
          for (let j = 0; j < 10; j++) await step()
          await quiet72()
          continue
        }
        case 'displayed/bundle-arrives': {
          // one scan: A shows, G scans; G's bundle reaches A's card instance, A confirms, G is mutual and
          // A's documents to G are carried by the instance the card became
          const before = new Set(contacts(A).map((x) => x.id))
          const { card } = await aShows()
          await scansA(G, card)
          for (let j = 0; j < 4 && contacts(A).every((x) => before.has(x.id)); j++) await step()
          const gId = contacts(A).find((x) => !before.has(x.id))?.id
          if (!gId) {
            violations.push('displayed/bundle-arrives: no contact at A after the scan')
            continue
          }
          await aConfirms(gId)
          for (let j = 0; j < 3; j++) await step()
          const g = contacts(G)[0]
          if (g?.verification === 'mutual' && (await carriageOf(A))[gId] === 'routed') hit(c)
          else violations.push(`displayed/bundle-arrives: G ${g?.verification}, carriage ${String((await carriageOf(A))[gId])}`)
          await send(A, gId)
          continue
        }
        case 'displayed/foreign-frame': {
          // a stranger writes to the card's connection DID: dropped before the holder, acknowledged
          const { conn } = await aShows()
          await step()
          const X = await deriveWireIdentities(new Uint8Array(64).fill(111), med.did, new Uint8Array(32).fill(112))
          const f = await tspPack(new TextEncoder().encode('{"rkid":"x"}'), X.egress.did, conn, { senderSigningKey: X.egress.edSecret, receiverEncryptionKey: peerKeys(conn).encPub })
          const before = contacts(A).length
          const text = med.deliver(conn, f.bytes)
          await step()
          const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
          if ((await med.ackedBy(conn)).includes(id) && contacts(A).length === before) hit(c)
          else violations.push('displayed/foreign-frame: not acknowledged, or it made a contact')
          continue
        }
        case 'displayed/second-scan': {
          // two scanners of one card: one contact at A, both frames leave the mediator
          const before = new Set(contacts(A).map((x) => x.id))
          const { card, conn } = await aShows()
          await scansA(G, card)
          await scansA(H, card)
          for (let j = 0; j < 4; j++) await step()
          const made = contacts(A).filter((x) => !before.has(x.id))
          if (made.length === 1 && med.held(conn) === (await med.ackedBy(conn)).length) hit(c)
          else violations.push(`displayed/second-scan: ${made.length} contacts, ${med.held(conn)} held, ${(await med.ackedBy(conn)).length} acked`)
          for (const x of made) await aConfirms(x.id)
          await step()
          continue
        }
        case 'displayed/expired': {
          // the challenge ends unbound: its instance closes on the device clock (RLTP-VTI-1270)
          const { conn } = await aShows()
          await step()
          const open = med.openSockets(conn)
          vc.advance(300_000)
          await settle()
          await step()
          if (open === 1 && med.openSockets(conn) === 0) hit(c)
          else violations.push(`displayed/expired: sockets ${open} then ${med.openSockets(conn)}`)
          continue
        }
        case 'kill/displayed-pending': {
          // the process dies with the card on display; the bundle waits at the mediator; the next
          // process opens the card's instance again from the displayed cards and takes it
          const before = new Set(contacts(A).map((x) => x.id))
          const { card } = await aShows()
          await step()
          kill('with a card on display')
          await scansA(J, card)
          await step()
          await afterKill()
          for (let j = 0; j < 4 && contacts(A).every((x) => before.has(x.id)); j++) await step()
          const made = contacts(A).filter((x) => !before.has(x.id))
          if (made.length === 1) hit(c)
          else violations.push(`kill/displayed-pending: ${made.length} contacts after the restart`)
          for (const x of made) await aConfirms(x.id)
          for (let j = 0; j < 3; j++) await step()
          if (made[0] && (await carriageOf(A))[made[0].id] !== 'routed') violations.push(`kill/displayed-pending: carriage ${String((await carriageOf(A))[made[0].id])}`)
          continue
        }
        case 'routed/deadline-switch': {
          med.faults.dropRouted = true
          await send(A, aId)
          await step()
          // 72 h of quiet in four jumps: the instance concludes empty collections, its queue is empty
          for (let j = 0; j < 4; j++) {
            vc.advance(19 * HOUR)
            for (const cb of life) cb('active')
            await settle()
            await step()
          }
          med.faults.dropRouted = false
          const mode = (await carriageOf(A))[aId]
          if (mode === 'egress-session') {
            hit(c)
          } else violations.push(`deadline: carriage ${String(mode)} after 76 h`)
          await send(A, aId)
          await step()
          continue
        }
        default:
          break
      }
      switch (op) {
        case 'aSend':
          await send(A, aId)
          break
        case 'bSend':
          await send(B, bId)
          break
        case 'lock':
          await shutdown()
          await reopen(false)
          break
        case 'end':
          await shutdown()
          log.push('  (process end)')
          await reopen(true)
          break
        case 'offline':
          netA.set('offline')
          break
        case 'online':
          netA.set('online')
          break
        case 'jump':
          vc.advance((1 + r.int(30)) * 60_000)
          for (const cb of life) cb('active')
          break
        case 'tick':
          break
      }
      await step()
      // a late answer comes after the next step (rule 3: it belongs to the generation it began in)
      for (const h of holds.splice(0)) h.release()
      await step()
      await observe()
      if (violations.length) break
    }
    log.push('end')
    armed.clear()
    mlib.reset()
    netA.set('online')
    for (const h of holds.splice(0)) h.release()
    if (!violations.length) {
      for (let i = 0; i < 6; i++) await step()
      const st = await observe()
      for (const [d, o] of Object.entries(st.outbox)) {
        const last = o.history.at(-1)?.status
        const text = canon(o.envelope)
        if (uncarried.has(o.recipient.contactId)) {
          if (last !== 'submitted' && last !== 'awaiting-transport') violations.push(`${d.slice(0, 10)} to a relationship not carried is ${last}`)
        } else if (folded.has(o.recipient.contactId)) {
          if (last !== 'submitted' && last !== 'awaiting-transport' && last !== 'accepted' && last !== 'delivered') violations.push(`${d.slice(0, 10)} to a folded relationship is ${last}`)
        } else if (last !== 'delivered' && !(last === 'failed' && lost.has(text)) && !(lost.has(text) && last === 'accepted')) violations.push(`${d.slice(0, 10)} still ${last} at the end`)
      }
      if (holds.length) violations.push('a held answer is still pending')
    }
  } finally {
    armed.clear()
    mlib.reset()
    mlib.chain = null
    ctx.inUse = false
    for (const h of holds.splice(0)) h.release()
    await shutdown().catch(() => undefined)
    for (const [h, x] of [[B, bh] as [typeof A, HolderHandle], ...others]) {
      await h.quiesce(x).catch(() => undefined)
      await h.seal(x).catch(() => undefined)
      await h.close(x).catch(() => undefined)
    }
    store.close()
    appA.close()
  }
  if (process.env.LOG) (await import('node:fs')).writeFileSync(process.env.LOG, log.join('\n'))
  expect(violations, `seed ${seed} (rerun: SEED=${seed})\n${log.join('\n')}`).toEqual([])
}

/** A's carriage per contact, as the port shows it */
async function carriageOf(h: { current(): { carriage: { get(): { contacts: Readonly<Record<string, string>> } } } | null }) {
  return h.current()?.carriage.get().contacts ?? {}
}
