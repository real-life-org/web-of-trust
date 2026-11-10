// The carriage of the shared-connect enactments of one opening (shared-connect 0.1; lib 0.16.0
// `shared-connect-holder`). The holder runs the ceremony: its flow machines hold every enactment,
// its commits name the documents to send (`sharedconnect.send`) and its view names them again after
// a restart (`outbox`). This module only keeps a wire per enactment (shared-connect-wire.ts) and
// moves documents between that wire and the holder. It holds no state of an enactment that the
// holder's view does not give back, except the time of the last attempt to deliver the last
// documents of a closed enactment.
//
//  - Which enactments have a wire is read from the view, never from an event alone (`wantedUntil`):
//    an open one that nobody answered or decided only around its link's life; a decided one until
//    it closes; a closed one until its last documents were handed to the carrier and a moment more.
//  - The responder's wire is at the inviter's relay (the link's `_from` names it) and sends routed
//    through it; the inviter's is at this build's carrier: each side collects where its own
//    identifier says, so a counterpart on another mediator (Keyring on mediator.ic3.dev) is reached.
//    Three decisions stay apart: the holder decides that an enactment is complete; a timeout decides
//    that a socket closes (a resource); nothing but delivery evidence or the explicit rule of
//    SC_OWED_MS ends the retries. Closed on this side is not delivered on the other, and a frame on
//    the socket is not one the mediator confirmed, so a closed enactment with documents owed is
//    tried again at every resume and poke within SC_OWED_MS (each attempt a wire for SC_LINGER_MS,
//    not more often than SC_RETRY_MIN_MS); the time of the last attempt is kept by the opening
//    (`deps.attempts`), and it says when, never that the counterpart has them.
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

export type SharedConnectDiagnostic = 'wire-frame-refused' | 'wire-deposit-refused' | 'shared-connect-refused' | 'shared-connect-wire' | 'shared-connect-failed' | 'shared-connect-step-refused'

export interface SharedConnectCarriageDeps {
  /** a wire at the build's carrier (the custody lease's `sharedConnect`); rejects while it cannot open */
  readonly open: (cfg: SharedConnectWireOpening) => Promise<SharedConnectWire>
  readonly keys: KeyProvider
  /** the holder's view (`holder.sharedConnect()`) */
  readonly views: () => Promise<SharedConnectView[]>
  /** a document for the holder with its verified sender (`holder.sharedConnectReceive`) */
  readonly receive: (doc: unknown, sender: string) => Promise<ActResult>
  /** when the last documents of a closed enactment last went to a socket, by enactment id: kept by
   *  the opening (app-db) to pace the attempts across restarts; it is no evidence of delivery.
   *  `write` replaces the whole map. */
  readonly attempts: { read(): Promise<Readonly<Record<string, number>>>; write(next: Readonly<Record<string, number>>): Promise<void> }
  readonly now: () => number
  readonly setTimer: (at: number, cb: () => void) => () => void
  /** codes only: a refusal's code, never a document, a name or an identifier */
  readonly diagnose?: (code: SharedConnectDiagnostic, detail?: string) => void
}

export interface SharedConnectCarriage {
  /** the events of a commit: documents to send, enactments opened or closed */
  events(events: readonly HolderEvent[]): void
  /** the opening became the one in use: every wire is opened anew from the holder's view and the
   *  outbox of each enactment goes out again; a closed enactment with documents owed gets its attempt */
  resume(): void
  /** the network came back or the app is active again: what waits is tried now, a closed enactment
   *  with documents owed included */
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
  /** an attempt at a closed enactment's owed documents: its wire opened then (device time) */
  readonly startedAt: number
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** the class of a failed wire opening, from the error's message: an HTTP status of the relay's
 *  handshake (`http-403`), a socket that did not open, a relay that could not be resolved, else `other` */
export function openFailure(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const status = /\b([45]\d\d)\b/.exec(m)
  if (status) return `http-${status[1]}`
  if (/resolv/i.test(m)) return 'resolve'
  if (/socket|websocket|network|fetch/i.test(m)) return 'socket'
  if (/no socket endpoint/i.test(m)) return 'no-endpoint'
  return 'other'
}

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

/** The explicit end of the retries for the last documents of a closed enactment (device time after
 *  the close): the library keeps a declined or failed enactment that long (its RETENTION), so a
 *  counterpart that has not completed by then has dropped its own. Until then every resume and poke
 *  may try again. */
export const SC_OWED_MS = 30 * 24 * 3_600_000
/** the least time between two attempts at the same closed enactment (the attempt itself lasts
 *  SC_LINGER_MS); later attempts are paced by the obligation's age: a pace, not a limit of the retries */
export const SC_RETRY_MIN_MS = 10 * 60_000
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
 *  - Closed with documents owed: an attempt (`attempt`: the wire of a run, SC_LINGER_MS from its
 *    start, in which the documents go out and a counterpart that sends its own again is answered)
 *    whenever the last attempt lies far enough back (SC_RETRY_MIN_MS at least, then as long as the
 *    obligation was old at that attempt) or never happened, until SC_OWED_MS after the close. The
 *    socket's end is a timeout; the retries end with the rule.
 *  - Closed otherwise: SC_LINGER_MS. */
function wantedUntil(v: SharedConnectView, now: number, lastAttempt: number | undefined, attempt: Run | undefined): number | null {
  if (v.status === 'open') {
    const live = (v.link.exp + sc.CLOCK_TOLERANCE_S) * 1000
    const answered = v.theirDid !== null
    const decided = v.role === 'inviter' ? answered && v.promptId === null : v.theirPair !== null
    if (decided) return Infinity
    const end = live + (answered ? SC_LINGER_MS : 0)
    return now < end ? end : null
  }
  const closedAt = v.closedAt ?? 0
  if (!owes(v)) {
    const end = closedAt + SC_LINGER_MS
    return now < end ? end : null
  }
  if (now >= closedAt + SC_OWED_MS) return null
  // a run that was open long before the close: its attempt at the owed documents starts at the close
  if (attempt) {
    const end = Math.max(attempt.startedAt, closedAt) + SC_LINGER_MS
    return end > now ? end : null
  }
  // the pace grows with the age of the obligation: the gap to the next attempt is at least the time
  // from the close to the last one (a day after a day, a week after a week), never under SC_RETRY_MIN_MS
  if (lastAttempt === undefined) return now + SC_LINGER_MS
  return now - lastAttempt >= Math.max(SC_RETRY_MIN_MS, lastAttempt - closedAt) ? now + SC_LINGER_MS : null
}

export function createSharedConnectCarriage(deps: SharedConnectCarriageDeps): SharedConnectCarriage {
  const runs = new Map<string, Run>()
  /** documents of commits not sent yet, by enactment, in commit order */
  const owed = new Map<string, { to: string; docs: readonly unknown[] }[]>()
  let stopped = false
  /** the last attempts (deps.attempts), read once per carriage; null until then */
  let attempts: Record<string, number> | null = null
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
        // the responder listens and sends where the inviter's identifier says (its relay), as the inviter
        // listens at the carrier it put into its link; a link naming no mediator relay falls back to ours
        const relay = v.role === 'responder' ? (await sc.parsePeer(v.link.from))?.relays.find((x) => x.kind === 'tsp-mediator')?.address : undefined
        deps.diagnose?.('shared-connect-wire', `${v.role}/${relay ? 'their-relay' : 'our-relay'}/opening`)
        const wire = await deps.open({
          did: v.did,
          keys,
          exp: v.link.exp,
          // at the inviter's relay every frame goes routed through it (the relay admits no direct frame
          // between strangers); at our own carrier direct, as before
          ...(relay ? { mediatorDid: relay, routed: true } : {}),
          ...(peerDid !== null ? { peerDid } : {}),
          onDocument: (doc, sender) => track(receive(doc, sender)),
          onState: (s) => {
            if (s !== 'connected' || stopped || runs.get(r.id) !== r) return
            if (r.connected) {
              // what went to the socket that closed may be lost: the outbox again
              r.resync = true
              reconcile()
            }
            r.connected = true
          },
          onRefused: () => {
            // the mediator took a frame from the socket and refused it: the outbox goes again, and the
            // attempt does not count as one (a sticky refusal is bounded by SC_OWED_MS)
            if (stopped || runs.get(r.id) !== r) return
            r.resync = true
            if (attempts && attempts[r.id] !== undefined) void record(r.id, undefined)
            reconcile()
          },
          report: (x) => deps.diagnose?.(x.code, x.detail),
          // the wire's steps, with the enactment's role and the relay class (ours or the counterpart's)
          trace: (step) => deps.diagnose?.('shared-connect-wire', `${v.role}/${relay ? 'their-relay' : 'our-relay'}/${step}`),
        })
        if (stopped || runs.get(r.id) !== r) {
          wire.close()
          return
        }
        r.wire = wire
        r.tries = 0
      })()
        .catch((e: unknown) => {
          if (stopped || runs.get(r.id) !== r) return
          // why the wire did not open, as a class (the relay refused the login, the network, the
          // relay's own answer), never an address: the first failure and every fourth after it
          if (r.tries % 4 === 0) deps.diagnose?.('shared-connect-wire', `open-failed/${openFailure(e)}`)
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

  /** the time of the last attempt at a closed enactment's owed documents (undefined: none counts); a
   *  failed write leaves the pace at the earlier value, nothing else depends on it */
  const record = async (id: string, at: number | undefined): Promise<void> => {
    if (!attempts || stopped) return
    const next = { ...attempts }
    if (at === undefined) delete next[id]
    else next[id] = at
    try {
      await deps.attempts.write(next)
    } catch {
      return
    }
    attempts = next
  }

  /** `covered`: how many of the owed commits the view was read after (its outbox holds their documents) */
  const flush = async (r: Run, v: SharedConnectView, covered: number): Promise<void> => {
    const wire = r.wire
    if (!wire?.isOpen()) return
    const list = owed.get(r.id) ?? []
    if (r.resync) {
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
    // the owed documents of a closed enactment went to the socket: that is the attempt's time, not a
    // delivery; the next attempt comes SC_RETRY_MIN_MS later at the earliest, until SC_OWED_MS
    const at = Math.max(r.startedAt, v.closedAt ?? 0)
    if (owes(v) && attempts?.[v.id] !== at) await record(v.id, at)
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
    if (!attempts) {
      try {
        attempts = { ...(await deps.attempts.read()) }
      } catch {
        return
      }
      if (stopped) return
    }
    // attempts of enactments the holder no longer keeps leave with them
    const gone = Object.keys(attempts).filter((id) => !views.some((v) => v.id === id))
    if (gone.length > 0) {
      const next = Object.fromEntries(Object.entries(attempts).filter(([id]) => !gone.includes(id)))
      await deps.attempts.write(next).then(
        () => (attempts = next),
        () => undefined,
      )
    }
    const now = deps.now()
    const wanted = new Map<string, { v: SharedConnectView; until: number }>()
    for (const v of views) {
      const until = wantedUntil(v, now, attempts[v.id], runs.get(v.id))
      if (until !== null) wanted.set(v.id, { v, until })
    }
    for (const r of [...runs.values()]) if (!wanted.has(r.id)) closeRun(r)
    // documents of an enactment the view gives no wire leave with it
    for (const id of [...owed.keys()]) if (!wanted.has(id)) owed.delete(id)
    for (const { v, until } of wanted.values()) {
      let r = runs.get(v.id)
      if (!r) {
        r = { id: v.id, wire: null, opening: false, dead: false, tries: 0, retry: null, connected: false, resync: true, until: null, startedAt: now }
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
        // how an enactment went wrong, for the diagnostics: codes and step names, never a document
        if (e.type === 'sharedconnect.failed') deps.diagnose?.('shared-connect-failed', e.code.slice(0, 120))
        if (e.type === 'sharedconnect.refused') deps.diagnose?.('shared-connect-step-refused', `${e.docType.split('/').slice(-2).join('/').slice(0, 60)}/${e.reason.slice(0, 40)}`)
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
