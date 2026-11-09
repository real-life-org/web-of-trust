// The carriage of the shared-connect enactments of one opening (shared-connect 0.1; lib 0.16.0
// `shared-connect-holder`). The holder runs the ceremony: its flow machines hold every enactment,
// its commits name the documents to send (`sharedconnect.send`) and its view names them again after
// a restart (`outbox`). This module only keeps a wire per enactment (shared-connect-wire.ts) and
// moves documents between that wire and the holder. It holds no state of an enactment that the
// holder's view does not give back, except one mark per closed enactment: that its last documents
// were handed to the carrier.
//
//  - Which enactments have a wire is read from the view, never from an event alone (`wantedUntil`):
//    an open one that nobody answered or decided only around its link's life; a decided one until
//    it closes; a closed one until its last documents were handed to the carrier and a moment more.
//    Closed on this side is not delivered on the other, and a frame on the socket is not one the
//    mediator carries: the hand-over counts once the mediator kept the frame for SC_LINGER_MS
//    without refusing it (its problem report) over a socket that stayed open, and is marked durably
//    then (`deps.sent`); without the mark the wire is wanted again after every restart.
//  - A document reaches the mediator's acknowledgement only after the holder took it: one it could
//    not take now stays there and comes again at the next connect.
//  - The messaging keys come from the KeyProvider under the nonce this side minted: the inviter's
//    handle (the enactment id), the responder's own challenge (the id of its propose, which its later
//    documents name as `threadId` and its credential as `taskContext`). The wire checks the keys
//    against the enactment's did:peer:2, so a wrong nonce opens nothing.
//  - Documents of a commit go out in order once the wire is open. A send that did not reach the
//    socket, a reconnect and a restart are answered alike: the view's whole outbox goes out again
//    (the counterpart's machine answers a duplicate, it never acts twice).
//  - A wire that does not open is tried again on the device clock while the view still wants it.
//
// Nothing here survives the opening: `stop()` closes every wire, the next opening starts from the
// holder's view (`resume()`).

import { fromB64u, sharedConnect as sc } from '@real-life/trust-protocol'
import type { ActResult, HolderEvent, KeyProvider, SharedConnectView } from '@real-life/trust-protocol'
import { sharedConnectKeys, type SharedConnectKeys, type SharedConnectWire, type SharedConnectWireOpening } from './shared-connect-wire'

/** how long (device time) a closed enactment keeps its wire: its last documents leave, a
 *  counterpart's repeated document is answered again */
export const SC_LINGER_MS = 120_000
/** the waits (device time) between attempts to open a wire that did not open; the last one repeats */
export const SC_OPEN_RETRY_MS = [1000, 5000, 30_000] as const

export type SharedConnectDiagnostic = 'wire-frame-refused' | 'wire-deposit-refused' | 'shared-connect-refused' | 'shared-connect-wire'

export interface SharedConnectCarriageDeps {
  /** a wire at the build's carrier (the custody lease's `sharedConnect`); rejects while it cannot open */
  readonly open: (cfg: SharedConnectWireOpening) => Promise<SharedConnectWire>
  readonly keys: KeyProvider
  /** the holder's view (`holder.sharedConnect()`) */
  readonly views: () => Promise<SharedConnectView[]>
  /** a document for the holder with its verified sender (`holder.sharedConnectReceive`) */
  readonly receive: (doc: unknown, sender: string) => Promise<ActResult>
  /** when the last documents of a closed enactment were handed to the carrier, by enactment id: kept
   *  by the opening (app-db), so a restart knows what is still owed. `write` replaces the whole map. */
  readonly sent: { read(): Promise<Readonly<Record<string, number>>>; write(next: Readonly<Record<string, number>>): Promise<void> }
  readonly now: () => number
  readonly setTimer: (at: number, cb: () => void) => () => void
  /** codes only: a refusal's code, never a document, a name or an identifier */
  readonly diagnose?: (code: SharedConnectDiagnostic, detail?: string) => void
}

export interface SharedConnectCarriage {
  /** the events of a commit: documents to send, enactments opened or closed */
  events(events: readonly HolderEvent[]): void
  /** the opening became the one in use: every wire is opened anew from the holder's view and the
   *  outbox of each enactment goes out again */
  resume(): void
  /** the network came back or the app is active again: what waits is tried now */
  poke(): void
  /** ends the carriage: every wire closes, nothing is planned */
  stop(): void
  /** work in flight (tests, harness) */
  busy(): number
}

interface Run {
  readonly id: string
  wire: SharedConnectWire | null
  opening: boolean
  /** the keys do not fit the enactment's identity: nothing to try again */
  dead: boolean
  tries: number
  retry: (() => void) | null
  /** the socket was open once: a later `connected` is a reconnect */
  connected: boolean
  /** the whole outbox of the view goes out at the next flush: at a run's start (a fresh enactment's is
   *  what its first commit named, a restarted one's what the counterpart may miss) and after a reconnect */
  resync: boolean
  /** the time the view no longer wants this wire, with the timer that looks again then */
  until: { at: number; cancel: () => void } | null
  /** a closed enactment's last documents went to the socket then; the hand-over counts once the
   *  socket stayed open SC_LINGER_MS without the mediator refusing it (null: not handed, or marked) */
  handedAt: number | null
  confirm: (() => void) | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** the nonces the messaging identity of an enactment may derive from, most direct first */
function nonceCandidates(v: SharedConnectView): string[] {
  if (v.role === 'inviter') return [v.id]
  const docs = v.outbox as readonly { type?: unknown; id?: unknown; threadId?: unknown }[]
  const own = [
    ...docs.filter((d) => d.type === sc.TASK_PROPOSE).map((d) => str(d.id)),
    ...docs.map((d) => str(d.threadId)),
    str((v.myCredential as { taskContext?: unknown } | null)?.taskContext),
  ]
  return [...new Set(own.filter((c): c is string => c !== null && sc.canonicalChallenge(c)))]
}

/** how long (device time) an enactment that closed with documents still owed to the counterpart is
 *  tried: the library keeps a declined or failed enactment that long (its RETENTION), a counterpart
 *  that has not come back by then has dropped its own */
export const SC_OWED_MS = 30 * 24 * 3_600_000
/** the longest wait a timer of the carriage is set for; a later end is looked at again at the next
 *  event, resume or poke (a browser timer overflows past 24.8 days) */
const TIMER_MAX_MS = 24 * 3_600_000

/** The last documents of an enactment that closed on this side are owed to the counterpart: the
 *  receipt of a complete one, the inviter's decline. Closed here says nothing about there: the
 *  counterpart completes only when it has them. */
const owes = (v: SharedConnectView): boolean => v.outbox.length > 0 && (v.status === 'complete' || (v.status === 'declined' && v.role === 'inviter'))

/** Until when the view wants a wire for this enactment (device time); null: no wire.
 *  - Open, nobody answered the inviter's link: while the link is live. Open, a proposal nobody
 *    decided: it is asked only while the code is valid, so both sides wait that long and a moment more.
 *  - Open and decided (the acceptance is out or in): until it closes. The documents that complete it
 *    may wait at the carrier while either app is away; the library ends an enactment that never
 *    completes at its own retention.
 *  - Closed with documents owed: until the carrier kept them (`sentAt`: on the socket, not refused
 *    by the mediator within SC_LINGER_MS, the socket open that long; kept across restarts) and
 *    SC_LINGER_MS more, in which a counterpart that sends its own again is answered again; never
 *    handed over, SC_OWED_MS after it closed.
 *  - Closed otherwise: SC_LINGER_MS. */
function wantedUntil(v: SharedConnectView, now: number, sentAt: number | undefined): number | null {
  if (v.status === 'open') {
    const live = (v.link.exp + sc.CLOCK_TOLERANCE_S) * 1000
    const answered = v.theirDid !== null
    const decided = v.role === 'inviter' ? answered && v.promptId === null : v.theirPair !== null
    if (decided) return Infinity
    const end = live + (answered ? SC_LINGER_MS : 0)
    return now < end ? end : null
  }
  const closedAt = v.closedAt ?? 0
  const end = owes(v) ? (sentAt === undefined ? closedAt + SC_OWED_MS : sentAt + SC_LINGER_MS) : closedAt + SC_LINGER_MS
  return now < end ? end : null
}

export function createSharedConnectCarriage(deps: SharedConnectCarriageDeps): SharedConnectCarriage {
  const runs = new Map<string, Run>()
  /** documents of commits not sent yet, by enactment, in commit order */
  const owed = new Map<string, { to: string; docs: readonly unknown[] }[]>()
  let stopped = false
  /** the hand-over marks (deps.sent), read once per carriage; null until then */
  let sent: Record<string, number> | null = null
  let inFlight = 0
  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight++
    return p.finally(() => void inFlight--)
  }

  const closeRun = (r: Run) => {
    runs.delete(r.id)
    owed.delete(r.id)
    r.retry?.()
    r.retry = null
    r.until?.cancel()
    r.until = null
    r.confirm?.()
    r.confirm = null
    const w = r.wire
    r.wire = null
    try {
      w?.close()
    } catch {
      // already closed
    }
  }

  /** Resolves once the holder took the document or refused it for good; rejects when it could not take
   *  it now (storage, a closed gate, a step that kept losing against a commit): the wire then leaves the
   *  frame unacknowledged and the mediator delivers it again at the next connect. */
  const receive = async (doc: unknown, sender: string): Promise<void> => {
    if (stopped) throw new Error('shared-connect: the carriage stopped')
    let r: ActResult
    try {
      r = await deps.receive(doc, sender)
      // a decision of the person may commit between the machine's step and its commit: the step is taken again
      for (let attempt = 0; attempt < 2 && !r.ok && r.code === 'concurrent'; attempt++) r = await deps.receive(doc, sender)
    } catch (e) {
      deps.diagnose?.('shared-connect-refused', 'not-received')
      throw e
    }
    if (r.ok) return
    deps.diagnose?.('shared-connect-refused', r.code)
    if (r.code === 'concurrent') throw new Error('shared-connect: the document was not taken')
  }

  const keysOf = async (v: SharedConnectView): Promise<SharedConnectKeys | null> => {
    for (const c of nonceCandidates(v)) {
      try {
        return await sharedConnectKeys(deps.keys, fromB64u(c), v.did)
      } catch {
        // the next candidate
      }
    }
    return null
  }

  const openRun = (r: Run, v: SharedConnectView) => {
    r.opening = true
    void track(
      (async () => {
        const keys = await keysOf(v)
        if (!keys) {
          r.dead = true
          deps.diagnose?.('shared-connect-wire', 'keys')
          return
        }
        // the counterpart once known is the only sender heard (the enactment belongs to the first issuer)
        const peerDid = v.theirDid
        const wire = await deps.open({
          did: v.did,
          keys,
          exp: v.link.exp,
          ...(peerDid !== null ? { peerDid } : {}),
          onDocument: (doc, sender) => track(receive(doc, sender)),
          onState: (s) => {
            if (s !== 'connected' || stopped || runs.get(r.id) !== r) return
            if (r.connected) {
              // what went to the socket that closed may be lost: the outbox again, the hand-over unconfirmed
              r.resync = true
              r.handedAt = null
              reconcile()
            }
            r.connected = true
          },
          onRefused: () => {
            // the mediator took a frame from the socket and refused it: nothing of this pass counts as
            // handed over; the outbox goes again (a sticky refusal is bounded by SC_OWED_MS)
            if (stopped || runs.get(r.id) !== r) return
            r.resync = true
            r.handedAt = null
            reconcile()
          },
          report: (x) => deps.diagnose?.(x.code, x.detail),
        })
        if (stopped || runs.get(r.id) !== r) {
          wire.close()
          return
        }
        r.wire = wire
        r.tries = 0
      })()
        .catch(() => {
          if (stopped || runs.get(r.id) !== r) return
          const wait = SC_OPEN_RETRY_MS[Math.min(r.tries, SC_OPEN_RETRY_MS.length - 1)] as number
          r.tries++
          r.retry = deps.setTimer(deps.now() + wait, () => {
            r.retry = null
            reconcile()
          })
        })
        .finally(() => {
          r.opening = false
          if (!stopped && runs.get(r.id) === r && r.wire) reconcile()
        }),
    )
  }

  /** the durable mark: the enactment's last documents were with the carrier from `at` on */
  const mark = async (id: string, at: number): Promise<void> => {
    if (!sent || stopped) return
    const next = { ...sent, [id]: at }
    try {
      await deps.sent.write(next)
    } catch {
      return
    }
    sent = next
    // the wire's end follows the mark
    reconcile()
  }

  /** `covered`: how many of the owed commits the view was read after (its outbox holds their documents) */
  const flush = async (r: Run, v: SharedConnectView, covered: number): Promise<void> => {
    const wire = r.wire
    if (!wire?.isOpen()) return
    const list = owed.get(r.id) ?? []
    let handed = list.length > 0
    if (r.resync) {
      handed = true
      if (v.theirDid !== null && v.outbox.length > 0) {
        try {
          await wire.send(v.theirDid, v.outbox)
        } catch {
          // the socket went down: its reconnect sends again
          return
        }
      }
      // the outbox is every own document of the enactment up to the view: what those commits named is in it
      r.resync = false
      list.splice(0, covered)
    }
    while (list.length > 0) {
      const next = list[0] as { to: string; docs: readonly unknown[] }
      try {
        await wire.send(next.to, next.docs)
      } catch {
        r.resync = true
        return
      }
      list.shift()
    }
    // everything this side owes of a closed enactment is on the socket now; it counts as handed over
    // once the mediator kept it for SC_LINGER_MS without refusing it (the confirm in reconcile)
    if (owes(v) && sent?.[v.id] === undefined && (handed || r.handedAt === null)) r.handedAt = deps.now()
  }

  const reconcileOnce = async (): Promise<void> => {
    if (stopped) return
    // commits named before the view is read are in its outbox
    const covered = new Map([...owed].map(([id, list]) => [id, list.length]))
    let views: SharedConnectView[]
    try {
      views = await deps.views()
    } catch {
      // a closed gate ends with the opening; a storage failure is read again at the next event
      return
    }
    if (stopped) return
    if (!sent) {
      try {
        sent = { ...(await deps.sent.read()) }
      } catch {
        return
      }
      if (stopped) return
    }
    // marks of enactments the holder no longer keeps leave with them
    const gone = Object.keys(sent).filter((id) => !views.some((v) => v.id === id))
    if (gone.length > 0) {
      const next = Object.fromEntries(Object.entries(sent).filter(([id]) => !gone.includes(id)))
      await deps.sent.write(next).then(
        () => (sent = next),
        () => undefined,
      )
    }
    const now = deps.now()
    const wanted = new Map<string, { v: SharedConnectView; until: number }>()
    for (const v of views) {
      const until = wantedUntil(v, now, sent[v.id])
      if (until !== null) wanted.set(v.id, { v, until })
    }
    for (const r of [...runs.values()]) if (!wanted.has(r.id)) closeRun(r)
    // documents of an enactment the view gives no wire leave with it
    for (const id of [...owed.keys()]) if (!wanted.has(id)) owed.delete(id)
    for (const { v, until } of wanted.values()) {
      let r = runs.get(v.id)
      if (!r) {
        r = { id: v.id, wire: null, opening: false, dead: false, tries: 0, retry: null, connected: false, resync: true, until: null, handedAt: null, confirm: null }
        runs.set(v.id, r)
      }
      if (r.until?.at !== until) {
        r.until?.cancel()
        // a far end is looked at again by then anyway: a timer only for one within a day
        r.until = until - now <= TIMER_MAX_MS ? { at: until, cancel: deps.setTimer(until, () => reconcile()) } : null
      }
      if (!r.wire && !r.opening && !r.dead && !r.retry) openRun(r, v)
      await flush(r, v, covered.get(v.id) ?? 0)
      if (stopped) return
      // the hand-over of a closed enactment: on the socket, kept SC_LINGER_MS, not refused, the socket
      // still open; then the mark, and the wire ends (its end is the hand-over's time plus the linger)
      if (r.handedAt !== null && sent[v.id] === undefined) {
        if (!r.wire?.isOpen()) r.handedAt = null
        else if (deps.now() >= r.handedAt + SC_LINGER_MS) {
          const at = r.handedAt
          r.handedAt = null
          await mark(v.id, at)
        } else if (!r.confirm) {
          r.confirm = deps.setTimer(r.handedAt + SC_LINGER_MS, () => {
            r.confirm = null
            reconcile()
          })
        }
      }
    }
  }
  // one pass at a time; a request meanwhile runs one more pass after it
  let running: Promise<void> | null = null
  let again = false
  const reconcile = (): void => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = track(
      (async () => {
        do {
          again = false
          await reconcileOnce().catch(() => undefined)
        } while (again && !stopped)
      })().finally(() => {
        running = null
      }),
    )
  }

  return {
    events(events) {
      if (stopped) return
      let mine = false
      for (const e of events) {
        if (!e.type.startsWith('sharedconnect.')) continue
        mine = true
        if (e.type === 'sharedconnect.send' && e.to !== '' && e.docs.length > 0) owed.set(e.id, [...(owed.get(e.id) ?? []), { to: e.to, docs: e.docs }])
      }
      if (mine) reconcile()
    },
    resume() {
      if (stopped) return
      // every run is made anew, and a new run sends its view's outbox
      for (const r of [...runs.values()]) closeRun(r)
      reconcile()
    },
    poke() {
      if (stopped) return
      // a planned attempt runs now
      for (const r of runs.values()) {
        r.retry?.()
        r.retry = null
      }
      reconcile()
    },
    stop() {
      stopped = true
      for (const r of [...runs.values()]) closeRun(r)
      owed.clear()
    },
    busy: () => inFlight + [...runs.values()].reduce((n, r) => n + (r.wire?.busy() ?? 0), 0),
  }
}
