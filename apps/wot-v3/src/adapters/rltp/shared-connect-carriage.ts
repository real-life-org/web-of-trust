// The carriage of the shared-connect enactments of one opening (shared-connect 0.1; lib 0.16.0
// `shared-connect-holder`). The holder runs the ceremony: its flow machines hold every enactment,
// its commits name the documents to send (`sharedconnect.send`) and its view names them again after
// a restart (`outbox`). This module only keeps a wire per enactment (shared-connect-wire.ts) and
// moves documents between that wire and the holder. It holds no state of an enactment that the
// holder's view does not give back.
//
//  - Which enactments have a wire is read from the view, never from an event alone: an open
//    enactment (an inviter's without a counterpart only while its link is live, with the ceremony's
//    clock tolerance), and a closed one for SC_LINGER_MS after it closed, so the last documents leave
//    and a counterpart that sends its own again is answered again by the holder.
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

export type SharedConnectDiagnostic = 'wire-frame-refused' | 'shared-connect-refused' | 'shared-connect-wire'

export interface SharedConnectCarriageDeps {
  /** a wire at the build's carrier (the custody lease's `sharedConnect`); rejects while it cannot open */
  readonly open: (cfg: SharedConnectWireOpening) => Promise<SharedConnectWire>
  readonly keys: KeyProvider
  /** the holder's view (`holder.sharedConnect()`) */
  readonly views: () => Promise<SharedConnectView[]>
  /** a document for the holder with its verified sender (`holder.sharedConnectReceive`) */
  readonly receive: (doc: unknown, sender: string) => Promise<ActResult>
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
  /** the whole outbox of the view goes out at the next flush */
  resync: boolean
  /** the time the view no longer wants this wire, with the timer that looks again then */
  until: { at: number; cancel: () => void } | null
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

/** until when the view wants a wire for this enactment (device time); null: no wire */
function wantedUntil(v: SharedConnectView, now: number): number | null {
  if (v.status === 'open') {
    // nobody answered the inviter's link: it listens while the link is live
    if (v.role === 'inviter' && v.theirDid === null) {
      const end = (v.link.exp + sc.CLOCK_TOLERANCE_S) * 1000
      return now < end ? end : null
    }
    return Infinity
  }
  const end = (v.closedAt ?? 0) + SC_LINGER_MS
  return now < end ? end : null
}

export function createSharedConnectCarriage(deps: SharedConnectCarriageDeps): SharedConnectCarriage {
  const runs = new Map<string, Run>()
  /** documents of commits not sent yet, by enactment, in commit order */
  const owed = new Map<string, { to: string; docs: readonly unknown[] }[]>()
  let stopped = false
  let resyncAll = false
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

  const receive = async (doc: unknown, sender: string): Promise<void> => {
    if (stopped) return
    try {
      // a decision of the person may commit between the machine's step and its commit: the step is taken again
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await deps.receive(doc, sender)
        if (r.ok) return
        if (r.code !== 'concurrent') return void deps.diagnose?.('shared-connect-refused', r.code)
      }
      deps.diagnose?.('shared-connect-refused', 'concurrent')
    } catch {
      // storage or a closed gate: the counterpart's document comes again when it sends its outbox again
      deps.diagnose?.('shared-connect-refused', 'not-received')
    }
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
              // what went to the socket that closed may be lost: the outbox again
              r.resync = true
              reconcile()
            }
            r.connected = true
          },
          report: (x) => deps.diagnose?.(x.code === 'wire-frame-refused' ? 'wire-frame-refused' : 'shared-connect-wire', x.detail),
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
    const now = deps.now()
    const wanted = new Map<string, { v: SharedConnectView; until: number }>()
    for (const v of views) {
      const until = wantedUntil(v, now)
      if (until !== null) wanted.set(v.id, { v, until })
    }
    for (const r of [...runs.values()]) if (!wanted.has(r.id)) closeRun(r)
    // documents of an enactment the view gives no wire leave with it
    for (const id of [...owed.keys()]) if (!wanted.has(id)) owed.delete(id)
    for (const { v, until } of wanted.values()) {
      let r = runs.get(v.id)
      if (!r) {
        r = { id: v.id, wire: null, opening: false, dead: false, tries: 0, retry: null, connected: false, resync: resyncAll, until: null }
        runs.set(v.id, r)
      }
      if (r.until?.at !== until) {
        r.until?.cancel()
        r.until = Number.isFinite(until) ? { at: until, cancel: deps.setTimer(until, () => reconcile()) } : null
      }
      if (!r.wire && !r.opening && !r.dead && !r.retry) openRun(r, v)
      await flush(r, v, covered.get(v.id) ?? 0)
      if (stopped) return
    }
    resyncAll = false
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
      for (const r of [...runs.values()]) closeRun(r)
      resyncAll = true
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
