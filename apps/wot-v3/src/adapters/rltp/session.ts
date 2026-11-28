// One opening of a holder (architecture §3.1, §2.1 rules 7 and 9): holder store and app-db of a
// namespace, the write gate of its generation, the serial sync (ingest + fence + publish), timers,
// transport, and the command service with the intent journal (§3.4). The host (host.ts) creates one
// per HolderHost.open and drives its shutdown phases.

import { cardOk, CHALLENGE_MAX_AGE, createHolder, CryptoUnavailableError, InfraError, sharedConnect as sc } from '@real-life/trust-protocol'
import type { ActResult, ContactView, DeliveryItemView, DeliveryReport, GroupView, PendingJoinView, Holder, HolderEvent, ProfileView, PromptView, ReceiveResult, RetryPolicy, SharedConnectView } from '@real-life/trust-protocol'
import { concludable } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { ActId, AppError, AppEvent, BackRead, CardPreview, ConnectionId, ContactId, DecisionResolution, EncounterOutcome, IntentHandle, LoginOutcome, MessageId, Result } from '../../port'
import { revision, writableStore, type ReadStore } from '../../port'
import type { DiagnosticEntry } from '../../port/diagnostics'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import { ACTS, ownMessageLine, type ActContext, type ActOutcome, type ActSpec } from './acts'
import { carrierOffer, journaledOffer } from './carrier-offer'
import { compareOrder, EMPTY_ENCOUNTERS, EMPTY_LEDGER, KV, orderKey, type DisplayedCards, type EncounterCache, type Ledger, type LogLine, type MessageLine, type ReadMarks } from './app-data'
import { idbAppDb, type AppDb, type AppWrite } from './app-db'
import { decodeCardLink } from './card-link'
import { mapActError, TRANSIENT_REFUSALS } from './errors'
import { createGate, GateClosedError, type Gate } from './gate'
import { applyEncounterEvents, connectedContact, ingest, statusFinal } from './ingest'
import { DONE_RETENTION_MS, isOpen, RETRY_HORIZON_MS, type IntentRecord } from './journal'
import { project, relayCache, type ReadModels } from './projection'
import { createSealer } from './sealed'
import { createSharedConnectCarriage, type SharedConnectCarriage } from './shared-connect-carriage'
import { keysFromRootIkm } from './keys'
import { answerLogin, type LoginKeys } from './login'
import { idbHolderStore, type HolderStore } from './store-idb'
import { createContactTurn } from './contact-turn'
import { entryDedupe, entryIds, entryInput, entryKey, type Entries } from './entries'
import { challengeEnd, challengeOpen, depositKey, DRAIN_LIMIT_MS, type AnyLease, type Carriage, type CarrierOpening, type DisplayedCard } from './transport'

export const holderDbName = (ns: string) => `wot-v3-holder-${ns}`
export const appDbName = (ns: string) => `wot-v3-app-${ns}`

export interface SessionDeps {
  readonly ns: string
  readonly generation: number
  readonly idb: IDBFactory
  readonly rootIkm: Uint8Array
  readonly dek: Uint8Array
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  /** this opening's lease of the device transport (TRANSPORT.md): it never throws */
  readonly transport: AnyLease
  readonly anchorShort: string
  readonly retry?: Partial<RetryPolicy>
  readonly subtle?: SubtleCrypto
  /** fault switches of tests and the harness (architecture §3.2 FaultSwitches.killAt) */
  readonly faults?: RltpFaults
  /** the ceremony a shown code starts (RltpPortDeps.ceremony); 'shared-connect' when absent */
  readonly ceremony?: 'shared-connect' | 'card'
  /** what the adapter met, codes only (architecture §2.6); the host records it while the opening is
   *  in use */
  readonly diagnose?: (entry: Omit<DiagnosticEntry, 'id'>) => void
  /** the app comes back to the foreground: due work and open replays run again (§3.4) */
  readonly lifecycle?: { onState(cb: (s: 'active' | 'background') => void): () => void; current?(): 'active' | 'background' }
  /** 'dereg-only': opened by a delete only to deregister (§2.1 rule 9 S3, architecture §4.2): no
   *  transport, no timers, no intent recovery, nothing submitted (review 420 R5-2) */
  readonly mode?: 'normal' | 'dereg-only'
  publish(models: ReadModels): void
  emit(e: AppEvent): void
}

/** 'after-journal': the process dies after the intent is journaled as running, before the act */
export interface RltpFaults {
  /** after-journal: the process dies after an intent is journaled as running, before its act;
   *  before-take: after inbox messages are written to the history, before takeMessages */
  killAt: 'after-journal' | 'before-take' | null
  /** a hold point of the contact order's dedupe read (CONTACT-ORDER.md; the interleaving tests) */
  probe?: ((point: 'dedupe:before' | 'dedupe:after', actId: string) => Promise<void> | void) | null
  /** hold points of the re-meeting tests: an unordered gesture before its journal is read and written
   *  (`journal:before`), and any act after its journal, right before its library effect (`act:before`) */
  hold?: ((point: 'journal:before' | 'act:before', actId: string) => Promise<void> | void) | null
}

export interface Session {
  readonly ns: string
  readonly generation: number
  /** the last published models (null before the first bundle) */
  models(): ReadModels | null
  intent<T>(command: keyof typeof ACTS & string, target: string, dedupe: string, input: Readonly<Record<string, unknown>>, preview?: CardPreview): IntentHandle<T>
  confirmIntent<T>(actId: ActId): IntentHandle<T>
  /** intent recovery (N11): the same act, actId and inputs again, for a replay intent whose outcome is unknown */
  retryIntent<T>(actId: ActId): IntentHandle<T>
  discardIntent(actId: ActId): Promise<Result>
  previewCard(raw: string): Promise<Result<CardPreview>>
  /** the entry a contact id stands for now (entries.ts): itself, or the entry it was joined into */
  entryOf(contactId: string): string
  /** the inviter's camera read a back-code (shared-connect without a carrier, lib 0.22.0): the proposal of
   *  the own shown code it answers, as if a carrier had brought it; the confirmation opens */
  readBackCode(raw: string): Promise<Result<BackRead>>
  /** EXPERIMENTAL: answer a login request of a web app (login.ts) with the identity toward it */
  answerLogin(raw: string, opts: { name?: string | null; picture?: string | null }): Promise<Result<LoginOutcome>>
  /** read boundary of a conversation: the item `upTo` and everything before it count as read */
  markRead(key: string, upTo: string): void
  /** entries in the library's inbox not yet taken over (tests) */
  inboxSize(): Promise<number>
  /** the sent card of the scanner toward this contact, as QR text, until mutual */
  sentCard(contactId: string): Promise<string | null>
  setProfile(input: { name: string; image?: string }, actId: string): Promise<void>
  /** resolves when nothing is queued (tests, harness) */
  idle(): Promise<void>
  /** the carrier's work in flight for this opening (tests, harness; 0 for a carrier that takes documents) */
  transportBusy(): number
  /** timer and journal work in flight that nobody awaits (tests, harness: rest means 0) */
  timerBusy(): number
  /** the opening became the one in use: hand over what the holder keeps for transport */
  offer(): void
  /** own documents in the holder's custody, not yet taken by a carrier (the last custody view) */
  readonly queued: ReadStore<number>
  /** how the carrier carries the relationships (a custody carrier; none for one that takes documents) */
  readonly carriage: ReadStore<Carriage>
  quiesce(): Promise<void>
  seal(): void
  /** ends the opening: resolves once the holder's running operation finished and the stores are closed */
  close(): Promise<void>
}

const bigger = (a: string, b: string) => BigInt(a) > BigInt(b)

function toAppError(e: unknown): AppError {
  if (e instanceof GateClosedError) return { kind: 'locked' }
  if (e instanceof InfraError) {
    if (e.code === 'unknown-commit-outcome') return { kind: 'infra', code: 'unknown-outcome', retryable: true }
    if (e.code === 'commit-conflict') return { kind: 'infra', code: 'conflict', retryable: true }
    if (e.code === 'key-provider') return { kind: 'infra', code: 'key-provider', retryable: true }
    return { kind: 'infra', code: 'storage', retryable: true }
  }
  if (e instanceof CryptoUnavailableError) return { kind: 'infra', code: 'crypto-unavailable', retryable: false }
  if (e instanceof Error && e.name === 'StoreSealedError') return { kind: 'locked' }
  return { kind: 'infra', code: 'storage', retryable: true }
}

/** The holder's transient answer to a receive, the library's `concludable` (lib 0.8.0): nothing
 *  committed, the carrier keeps the document. Delivery 0.83 names `failed(rate-limited)` the one
 *  failure that is transient (RLTP-DEL-5820, 6280); every other failure of stages 1 to 8, also
 *  `gate-future` and `consumed-challenge`, is terminal and concluded. */
const transient = (r: ReceiveResult): boolean => !concludable(r)

/** A failed opening whose holder did not close: the store stays open, the namespace taken, and
 *  `closeAgain` is tried until it went through (TRANSPORT.md rule 4, LIFECYCLE.md) */
export class UnclosedOpeningError extends Error {
  constructor(
    readonly reason: unknown,
    readonly closeAgain: () => Promise<void>,
  ) {
    super('opening failed and its holder did not close')
    this.name = 'UnclosedOpeningError'
  }
}

/** How long one attempt to close a holder may take (device time) before the opening counts as not
 *  closed (§2.1 rule 9: S2 goes on after 2 s; the same bound for S5, so a hanging host never holds a
 *  lock, a switch or the next unlock). */
export const CLOSE_LIMIT_MS = 2000
/** S2: the running holder calls get this long (device time) before the shutdown goes on */
export { DRAIN_LIMIT_MS } from './transport'

/** A holder close that did not return within CLOSE_LIMIT_MS: the opening stays registered as closing */
export class HolderCloseTimeout extends Error {
  constructor() {
    super('holder close did not return in time')
    this.name = 'HolderCloseTimeout'
  }
}

export async function openSession(deps: SessionDeps): Promise<Session> {
  const sealer = await createSealer(deps.dek, deps.subtle ? { subtle: deps.subtle } : {})
  const seal = { sealed: false }
  const store: HolderStore = idbHolderStore({ idb: deps.idb, name: holderDbName(deps.ns), sealer, uuid: () => deps.entropy.uuid(), seal })
  const app: AppDb = idbAppDb({ idb: deps.idb, name: appDbName(deps.ns), sealer, seal })
  // from the first store on, a failed opening leaves nothing open (review 420 R1-3, R2 R1-3): every
  // later step registers its own undo, run in reverse when the opening fails
  const undo: (() => void | Promise<void>)[] = [
    () => {
      seal.sealed = true
      store.close()
      app.close()
    },
  ]
  const r = { store, app, seal, unclosed: null as null | (() => Promise<void>) }
  try {
    return await build(deps, r, undo)
  } catch (e) {
    const steps = undo.reverse()
    // the stores close only after the holder did
    const stores = steps.pop()
    for (const u of steps) {
      try {
        await u()
      } catch {
        // keep undoing
      }
    }
    const closeAgain = r.unclosed
    if (!closeAgain) {
      stores?.()
      throw e
    }
    throw new UnclosedOpeningError(e, async () => {
      await closeAgain()
      await stores?.()
    })
  }
}

async function build(deps: SessionDeps, r: { store: HolderStore; app: AppDb; seal: { sealed: boolean }; unclosed: null | (() => Promise<void>) }, undo: (() => void | Promise<void>)[]): Promise<Session> {
  const { ns, clock, entropy } = deps
  const { store, app, seal } = r
  const holder: Holder = await createHolder({ store, keys: keysFromRootIkm(deps.rootIkm), ...(deps.retry ? { retry: deps.retry } : {}) })
  const gate: Gate<Holder> = createGate(holder, deps.generation)
  /** the holder's joining work and the ordered attempts, never interleaved (contact-turn.ts) */
  const contactTurn = createContactTurn()
  let holderClosed: Promise<void> | null = null
  /** the holder's own close, kept across attempts: a close that outlived the limit is awaited again,
   *  never started twice; a rejected one is forgotten, so the next attempt calls close() again */
  let holderClose: Promise<void> | null = null
  /** holder.close() once, each attempt bounded by CLOSE_LIMIT_MS of device time (§2.1 rule 9 S2, S5): a
   *  host that hangs leaves the opening `closing` (registered, retried by the next close or open of the
   *  namespace, which then fails instead of waiting for ever); the lock never waits on it */
  const closeHolder = (): Promise<void> => {
    holderClosed ??= (async () => {
      holderClose ??= holder.close().catch((e: unknown) => {
        holderClose = null
        throw e
      })
      let cancel: () => void = () => undefined
      const limit = new Promise<'late'>((r) => {
        cancel = clock.setTimer(clock.now() + CLOSE_LIMIT_MS, () => r('late'))
      })
      try {
        if ((await Promise.race([holderClose.then(() => 'closed' as const), limit])) === 'late') throw new HolderCloseTimeout()
      } finally {
        cancel()
      }
    })().catch((e: unknown) => {
      // a failure of the host is tried again by the next call; a timeout stands for the rest of this
      // shutdown (quiesce and close share one 2 s window), `retryClose` opens the next window
      if (!(e instanceof HolderCloseTimeout)) holderClosed = null
      throw e
    })
    return holderClosed
  }
  /** a new attempt after a failed or timed-out one (the register's retry, the next open) */
  const retryClose = (): Promise<void> => {
    holderClosed = null
    return closeHolder()
  }
  undo.push(async () => {
    gate.close()
    try {
      await closeHolder()
    } catch (e) {
      r.unclosed = retryClose
      throw e
    }
  })

  const deregOnly = deps.mode === 'dereg-only'
  // The personal community (Identity §2, §5.4): founded at the first opening that lacks it, so a holder
  // created before lib 0.11.0 gets its community anchor too. One act under one actId per namespace:
  // a crash between commit and this check replays it; a second founding is refused (already-founded).
  // Not on a sealed store (a delete past its seal) and not in a dereg-only opening: nothing is written
  // there any more. After the undo list holds the holder's close, so a failure here closes it.
  if (!seal.sealed && !deregOnly && (await holder.profile()).community === undefined) {
    const r = await holder.foundPersonalCommunity({ name: 'personal' }, { when: clock.now(), actId: `community:${ns}` })
    if (!r.ok && r.code !== 'already-founded') deps.diagnose?.({ at: clock.now(), code: 'community-not-founded', detail: r.code })
  }
  let stopped = deregOnly
  /** Every clock timer of this opening is a resource of the opening (LIFECYCLE.md, resource register;
   *  CONTACT-ORDER.md "Timers", #428): it is held here with its cancel, the end of the opening and a
   *  failed opening cancel all and drop the references, and a timer of an ended opening that fires
   *  anyway does nothing. Nothing of the opening stays reachable from the clock after its end. */
  const timers = new Set<() => void>()
  /** work a timer or an event started and nobody awaits (the due time, the journal's expiry and
   *  replay): counted, so a caller waiting for rest sees it while it runs, also when a holder call in
   *  it takes longer than idle's bounded drain (review 468 #6, like the carrier's busy() in #461) */
  let background = 0
  const track = <T>(p: Promise<T>): Promise<T> => {
    background++
    void p.then(
      () => void background--,
      () => void background--,
    )
    return p
  }
  const setTimer = (at: number, cb: () => void): (() => void) => {
    let done = false
    const own = () => {
      if (done) return
      done = true
      timers.delete(own)
      cancel()
    }
    const cancel = clock.setTimer(at, () => {
      if (done) return
      done = true
      timers.delete(own)
      if (!stopped) cb()
    })
    if (!done) timers.add(own)
    return own
  }
  const cancelTimers = () => {
    for (const c of [...timers]) c()
  }
  undo.push(() => cancelTimers())
  let models: ReadModels | null = null
  let appSeq = 0
  /** the one reading of a contact id (entries.ts), from the last bundle's contacts */
  let entries: Entries = entryIds([])
  let lastViews: { commitSeq: string; contacts: ContactView[]; prompts: PromptView[]; profile: ProfileView; connections: SharedConnectView[]; relayed: Record<string, boolean | null>; groups: GroupView[]; pendingJoins: PendingJoinView[]; provenance: Record<string, Record<string, string[]>> } | null = null
  /** whether a messaging identity names a relay, by DID: the library's full resolution, a known answer kept */
  const relayedOf = relayCache()
  /** events announced but not yet taken over, and the ids already taken (dedupe of act results) */
  let pending: HolderEvent[] = []
  const seen = new Set<string>()
  // effectiveNow (§3.4 N11): never behind a time this device already used, across restarts; the high
  // mark is kept in app-db and raised with every journal write and every sync
  // a failed read aborts the opening: never a smaller substitute for an unknown high mark (R2 R1-9)
  let highWhen = (await app.get<{ high: number }>('kv', KV.clock))?.high ?? 0
  const now = () => clock.now()
  const when = () => (highWhen = Math.max(highWhen, now()))
  const clockWrite = (): AppWrite => ({ store: 'kv', key: KV.clock, value: { high: when() } })
  // the library's act journal holds an act for its retention, max(P90D, retry horizon), after the
  // commit (lib 0.6.1 replay): an open record is settled through holder.replay until one day before
  // that, never by running its act blind (review 421 R10-1)
  const horizonMs = deps.retry?.horizonMs ?? RETRY_HORIZON_MS
  const manualLimitMs = Math.max(90 * 86_400_000, horizonMs) - 86_400_000
  /** when an open record expires: one day before the library may forget its actId */
  const expiresAt = (r: IntentRecord) => r.createdAt + manualLimitMs

  // ── serial queue: every app-db write of lib-derived data and every publish goes through it ────
  let chain: Promise<unknown> = Promise.resolve()
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn)
    chain = p.catch(() => undefined)
    return p
  }

  const publishFromDb = async (): Promise<void> => {
    if (stopped || !lastViews) return
    const snap = await app.readAll()
    const lines = [...snap.log.values()] as LogLine[]
    const intents = [...snap.intents.values()] as IntentRecord[]
    const encounters = (snap.kv.get(KV.encounters) as EncounterCache | undefined) ?? EMPTY_ENCOUNTERS
    const reads = (snap.kv.get(KV.reads) as ReadMarks | undefined) ?? {}
    const ledger = (snap.kv.get(KV.ledger) as Ledger | undefined) ?? EMPTY_LEDGER
    appSeq++
    const next = project({
      revision: revision(deps.generation, Number(lastViews.commitSeq), appSeq),
      now: now(),
      timeZone: clock.timeZone(),
      anchorShort: deps.anchorShort,
      contacts: lastViews.contacts,
      prompts: lastViews.prompts,
      profile: lastViews.profile,
      connections: lastViews.connections,
      relayed: lastViews.relayed,
      groups: lastViews.groups,
      pendingJoins: lastViews.pendingJoins,
      provenance: lastViews.provenance,
      encounters,
      displayed: (snap.kv.get(KV.displayed) as DisplayedCards | undefined) ?? {},
      lines,
      intents,
      reads,
      shown: ledger.contacts,
    })
    if (stopped) return
    models = next
    deps.publish(next)
  }

  /** Ingest and publish one consistent bundle (§3.1 steps 1 to 6). */
  const syncOnce = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (stopped) return
      // own messages whose sender status can still change (read before the fence: only this queue writes them)
      const pendingOut = ([...(await app.readAll()).log.values()] as LogLine[]).filter(
        (l): l is MessageLine => l.kind === 'message' && l.dir === 'out' && l.digest !== null && !statusFinal(l.status),
      )
      const a = (await gate.run((h) => h.profile())).commitSeq
      const [rawContacts, prompts, inbox, statusViews, connections, groups, pendingJoins] = await gate.run((h) =>
        Promise.all([h.contacts(), h.prompts(), h.inbox(), Promise.all(pendingOut.map((l) => h.deliveryStatus(l.digest ?? ''))), h.sharedConnect(), h.groups(), h.pendingJoins()]),
      )
      // whether each ceremony's link names a relay, from the stored link (also after a restart)
      const relayed = Object.fromEntries(await Promise.all(connections.map(async (v) => [v.id, await relayedOf(v.role === 'responder' ? v.link.from : v.did)] as const)))
      // who invited whom, per group this device holds the log of (Membership RLTP-MT-3400)
      const provenance: Record<string, Record<string, string[]>> = {}
      await gate.run(async (h) => {
        for (const g of groups) {
          const p = await h.groupProvenance(g.id)
          if (p) provenance[g.id] = p
        }
      })
      // one reading of "verified" for ingest, projection and the flows (connectedContact)
      const contacts = rawContacts.map(connectedContact)
      const profile = await gate.run((h) => h.profile())
      if (profile.commitSeq !== a) {
        // a commit landed while reading: the next attempt waits for the burst to come to rest
        await quiet()
        continue
      }
      const take = pending.filter((e) => !bigger(e.commitSeq, a))
      const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
      const ledger = (await app.get<Ledger>('kv', KV.ledger)) ?? EMPTY_LEDGER
      const statuses = pendingOut.map((line, i) => ({ line, items: (statusViews[i]?.items ?? []) as DeliveryItemView[] }))
      const out = ingest({ commitSeq: a, now: now(), events: take, contacts, prompts, encounters, ledger, inbox, statuses })
      const writes: AppWrite[] = [
        { store: 'kv', key: KV.encounters, value: out.encounters },
        { store: 'kv', key: KV.ledger, value: out.ledger },
        { store: 'kv', key: KV.applied, value: { commitSeq: a } },
        clockWrite(),
        ...out.lines.map((l) => ({ store: 'log' as const, key: l.id, value: l })),
      ]
      // the history is durable first; only then the library may drop the inbox entries (N4)
      await app.write(writes)
      // events count as taken over only once their derivation is durable (review 420 R1-1)
      pending = pending.filter((e) => !take.includes(e))
      lastViews = { commitSeq: a, contacts, prompts, profile, connections, relayed, groups, pendingJoins, provenance }
      entries = entryIds(contacts)
      // which relationships a custody carrier carries, and which instance closes at a chaining
      if (deps.transport.kind === 'custody' && !deregOnly) deps.transport.carry(contacts)
      await publishFromDb()
      if (out.take.length > 0) {
        if (deps.faults?.killAt === 'before-take') {
          deps.faults.killAt = null
          stopped = true
          return
        }
        await gate.run((h) => h.takeMessages([...out.take], { when: when() }))
      }
      sendHeld(contacts)
      return
    }
    // five attempts without a stable fence: the last consistent bundle stays; a timer retries
    retrySoon()
  }
  /** a sync whose failure is the caller's (opening) */
  const syncStrict = () => queue(syncOnce)
  /** until no holder call runs, bounded in macrotask turns like idle (never wall time, #429): a held
   *  call (tests) delays a build, never blocks it; an ended opening stops waiting at once, so no turn
   *  of the event loop keeps it reachable (#428) */
  const quiet = () =>
    stopped
      ? Promise.resolve()
      : gate.drain(30, async (turns) => {
          for (let i = 0; i < turns && !stopped; i++) await new Promise((r) => setTimeout(r, 0))
        })
  /** the sync queued and not started yet: every caller until it starts joins it, so a burst of commits
   *  is built into the model once, plus one follow-up for what came while that build ran */
  let nextSync: Promise<void> | null = null
  /** Every publication goes through the collector (fence, take-over, app read): app data never
   *  shows beside views of another state (review 420 R2-1). A failed sync keeps the last consistent
   *  bundle and tries again after a second. */
  const sync = (): Promise<void> => {
    if (nextSync) return nextSync
    const p = queue(async () => {
      // the build starts when the holder calls of the burst returned: the fence below then holds at
      // the first attempt instead of failing on every commit of the burst; commits until then still
      // join this run
      await quiet()
      // from here on the reads run: a later commit needs a run of its own (the follow-up)
      nextSync = null
      await syncOnce()
    }).catch((e: unknown) => {
      retrySoon()
      throw e
    })
    nextSync = p
    return p
  }
  let retryTimer: (() => void) | null = null
  const retrySoon = () => {
    if (stopped || retryTimer) return
    retryTimer = setTimer(now() + 1000, () => {
      retryTimer = null
      void sync().catch(() => undefined)
    })
  }

  // ── timers, transport ───────────────────────────────────────────────────────────────────────
  let timer: { at: number; cancel: () => void } | null = null
  const schedule = (at: number | undefined) => {
    if (at === undefined || stopped) return
    if (timer && timer.at <= at) return
    try {
      timer?.cancel()
      timer = { at, cancel: setTimer(at, () => void track(due())) }
    } catch {
      timer = null
    }
  }

  // ── transport: the holder's custody (Delivery 0.83 RLTP-DEL-6120 to 6135, lib 0.6.0) ──────────
  // The holder keeps every outbound document, regular or acknowledgement, until a service took it or
  // the holder gave it up, across a lock and the end of a process. This opening keeps no store of its
  // own: it hands over what holder.pendingTransport names (only after a completed resume of this
  // opening), each through holder.handOver, the check and the start of the send in one step of the
  // holder's queue. What it handed over lives only in this opening's transport lease; the lease
  // withdraws it when the opening stops, and the next opening hands it over again from the holder.
  /** handed over by this opening and still named by the holder, by deposit identity (`depositKey`):
   *  the digest for a regular hand-over, `digest#n` for a duplicate's answer. It decides the end of each
   *  identity at the lease (withdraw or end) and is never cleared by a report (review 426 R1-1) */
  const handed = new Set<string>()
  /** own documents in custody at the last view */
  const queued = writableStore(0)
  /** the identities not to hand over again in this pass: handed over and not answered `later` */
  const filed = new Set<string>()
  /** reported awaiting-transport: the carrier keeps no copy; handed over again when the network comes
   *  back, at the holder's next due time or at activation, never in the same pass (no report loop) */
  const parked = new Set<string>()
  /** set at a due time: what was handed over and not answered goes over again (a lost or late report
   *  is `later`, TRANSPORT.md rule 1; the carrier takes a digest once) */
  let resend = false
  const offerOnce = async (): Promise<void> => {
    const again = resend
    resend = false
    const view = await gate.run((h) => h.pendingTransport(when()))
    if (!view.ok || stopped) return
    // the holder's time never runs back, and the app's neither (review 421 R9-1)
    highWhen = Math.max(highWhen, view.at)
    queued.set(view.entries.filter((e) => e.kind === 'document' && e.resend === undefined).length)
    // a custody carrier hands each document over through the holder itself (lib reconcile)
    if (deps.transport.kind === 'custody') return deps.transport.reconcile(view)
    const transport = deps.transport
    const named = new Set(view.entries.map(depositKey))
    const digests = new Set(view.entries.map((e) => e.digest))
    // every identity is decided on its own, regular hand-over and each duplicate's answer apart, up to
    // the lease (TRANSPORT.md rule 6, #426): a regular hand-over the holder no longer names is not to be
    // sent (RLTP-DEL-6135), its copy leaves the device unless the carrier took it already; a
    // duplicate's answer whose hand-over began left the view by it (Delivery 6330), that is its end, an
    // event of its own (R22-1), never a revocation, also when the regular retries of its digest end
    const gone: string[] = []
    const ended: string[] = []
    for (const k of handed) {
      if (named.has(k)) continue
      handed.delete(k)
      filed.delete(k)
      if (k.includes('#')) ended.push(k)
      else gone.push(k)
    }
    for (const d of parked) if (!digests.has(d)) parked.delete(d)
    if (ended.length > 0) transport.end(ended)
    if (gone.length > 0) transport.withdraw(gone)
    for (const entry of view.entries) {
      const k = depositKey(entry)
      if ((filed.has(k) && !again) || parked.has(entry.digest) || stopped) continue
      // runs inside the holder's queue, right after its check: no lock, no other step in between
      const start = () => {
        if (stopped || !transport.ready()) return false
        // a duplicate's answer ends with its begun hand-over: it starts only when the carrier can take it
        if (entry.resend !== undefined && transport.status.get().network !== 'online') return false
        // the deadline at the start itself, not at the call: time passes while the holder reads (6135)
        if (when() >= entry.notAfter) return false
        // filed before the deposit: a report the transport gives synchronously finds it (review 420 R12-4)
        filed.add(k)
        if (transport.submit([entry])) {
          handed.add(k)
          return true
        }
        filed.delete(k)
        // `later`: the timer offers again, no user action needed
        schedule(now() + 1000)
        return false
      }
      await gate.run((h) => h.handOver(entry, when(), start)).catch(() => false)
    }
  }
  // one pass at a time; a request meanwhile runs one more pass after it
  let offering: Promise<void> | null = null
  let offerAgain = false
  const offer = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (offering) {
      offerAgain = true
      return offering
    }
    offering = (async () => {
      do {
        offerAgain = false
        await offerOnce().catch(() => undefined)
      } while (offerAgain && !stopped)
    })().finally(() => {
      offering = null
    })
    return offering
  }
  /** The members of the own groups are still to be asked for what their logs hold beyond this device's
   *  (Access stage 1: the log travels between members, nobody keeps it for the group). Due once per
   *  opening and again at every return to the foreground; it stays due until a request went through,
   *  so a failure is tried again by the timer and a resume that failed first does not skip it (#534).
   *  A deregistration-only opening asks nobody. */
  let groupsDue = !deregOnly
  const GROUPS_RETRY_MS = [1000, 5000, 30_000, 120_000] as const
  let groupsFailures = 0
  /** Runs after a completed resume. The requests leave from the holder's custody like every document;
   *  one that reaches nobody is given up by the holder. A device in no group asks nobody. */
  const catchUpGroups = async (): Promise<void> => {
    if (stopped || !groupsDue) return
    try {
      const r = await gate.run((h) => h.syncGroups({ when: when() }))
      groupsDue = false
      groupsFailures = 0
      if (r.ok && r.outbound.length > 0) await offer()
    } catch {
      // the gate closed or the storage failed: still due, the timer comes back with a growing pause
      schedule(now() + GROUPS_RETRY_MS[Math.min(groupsFailures, GROUPS_RETRY_MS.length - 1)]!)
      groupsFailures++
    }
  }
  /** a resume of this opening completed: the holder's time is reconciled, open records may be settled
   *  (review 421 R10-1) */
  let resumed = false
  const due = async () => {
    timer = null
    try {
      const t = await contactTurn.joining(() => gate.run((h) => h.tick(when())))
      if (t.ok) schedule(t.nextDueAt)
      const r = await contactTurn.joining(() => gate.run((h) => h.resume(when())))
      schedule(r.nextDueAt)
      resumed = true
    } catch {
      // gate closed or storage failure: nothing is handed over until a resume of this opening
      // completes (the holder refuses pendingTransport meanwhile); the next timer tries again. The
      // journal's own retention holds anyway (R12-4)
      schedule(now() + 1000)
      if (!deregOnly) await expireOpen(true).catch(() => undefined)
      return
    }
    parked.clear()
    resend = true
    await offer()
    if (deregOnly) return
    await catchUpGroups()
    // a failed expiry or replay is tried again shortly, without activation or network (R10-3)
    await expireOpen().catch(() => schedule(now() + 1000))
    await replayOpen().catch(() => schedule(now() + 1000))
  }

  undo.push(() => {
    stopped = true
  })
  // ── shared-connect (shared-connect-carriage.ts): a wire per enactment at the build's carrier ──
  // The holder runs the ceremony; the carriage moves its documents. Only with a carrier that has such
  // wires (the VTI mediator) and never in a dereg-only opening.
  const keys = keysFromRootIkm(deps.rootIkm)
  const lease = deps.transport
  const sharedConnect: SharedConnectCarriage | null =
    lease.kind === 'custody' && !deregOnly
      ? createSharedConnectCarriage({
          open: (cfg) => lease.sharedConnect(cfg),
          keys,
          views: () => gate.run((h) => h.sharedConnect()),
          receive: async (doc, sender) => {
            const r = await contactTurn.joining(() => gate.run((h) => h.sharedConnectReceive(doc, sender, when())))
            if (r.ok) schedule(r.nextDueAt)
            return r
          },
          attempts: {
            read: async () => (await app.get<Record<string, number>>('kv', KV.connectAttempts)) ?? {},
            write: (next: Readonly<Record<string, number>>) => queue(() => app.write([{ store: 'kv', key: KV.connectAttempts, value: next }])),
          },
          now,
          setTimer,
          diagnose: (code, detail) => deps.diagnose?.({ at: now(), code, ...(detail !== undefined ? { detail } : {}) }),
        })
      : null
  undo.push(() => sharedConnect?.stop())
  const unsubscribe = holder.subscribe(({ events }) => {
    if (stopped) return
    // every commit's events, also those of a document the carriage itself handed to the holder
    sharedConnect?.events(events)
    for (const e of events) {
      if (seen.has(e.eventId)) continue
      seen.add(e.eventId)
      pending.push(e)
      const app = toAppEvent(e)
      if (app) deps.emit(app)
    }
    void sync().catch(() => undefined)
    // every commit may change what the holder keeps for transport (an act, a resume, a report, a
    // receipt and its acknowledgement or a duplicate's answer): the view decides, never a result's copy
    if (!deregOnly) void offer()
  })

  undo.push(() => unsubscribe())
  undo.push(() => deps.transport.stop())
  /** the holder's receive of an envelope a carrier delivered, and its answer to the carrier: a failure
   *  (storage, a closed gate) throws and is `later` in the lease (TRANSPORT.md) */
  const receive = async (env: unknown) => {
    const r = await contactTurn.joining(() => gate.run((h) => h.receive(env, when())))
    // validated answers for own documents (an acknowledgement, a refusal): a custody carrier's open
    // deposits are answered before the collection that carried them is concluded (lib 0.7.0)
    if (r.disposition === 'unique' && deps.transport.kind === 'custody') {
      const answered = r.events.filter((e) => e.type === 'delivery.status' && (e.status === 'delivered' || e.status === 'failed')).map((e) => (e as { digest: string }).digest)
      if (answered.length > 0) deps.transport.answered(answered)
    }
    if (r.disposition === 'failed' && r.key === 'unknown') return { r, answer: 'not-mine' as const }
    // transient: nothing committed, the carrier keeps the document and the holder judges it afresh
    // when it comes again (RLTP-DEL-5820, 6280; RLTP-VTI-1265: only a concludable refusal is
    // acknowledged)
    if (transient(r)) return { r, answer: 'later' as const }
    if (r.disposition === 'unique') schedule(r.nextDueAt)
    return { r, answer: 'taken' as const }
  }
  /** an envelope at a displayed card's instance (TRANSPORT.md "The displayed card's instance",
   *  RLTP-VTI-1255): the holder judges it; when it takes it (`unique` or `duplicate-known`), the record
   *  of the card's challenge is the relationship holding the card's N */
  const receiveAtCard = async (env: unknown, card: DisplayedCard) => {
    const { r, answer } = await receive(env)
    if (r.disposition !== 'unique' && r.disposition !== 'duplicate-known') return { answer, recorded: null }
    const contacts = await gate.run((h) => h.contacts())
    const recorded = contacts.flatMap((c) => c.relationships).find((x) => x.carrierNonce?.nonce === card.nonce) ?? null
    return { answer, recorded }
  }
  /** what a custody carrier needs of this opening (TRANSPORT.md "The VTI mediator") */
  const carrierOpening: CarrierOpening = {
    rootIkm: deps.rootIkm,
    // one object for the opening: the library binds an adapter instance to the gate of its first reconcile
    gate: {
      handOver: (entry, at, start) => gate.run((h) => h.handOver(entry, at, start)),
      get closed() {
        return stopped || !gate.isOpen()
      },
    },
    acks: {
      get: (relId) => app.get('kv', `${KV.acks}${relId}`),
      put: (relId, state) => app.write([{ store: 'kv', key: `${KV.acks}${relId}`, value: state }]),
    },
    when,
    offer: () => void offer(),
    answered: async (digests) => {
      const out: string[] = []
      for (const d of digests) {
        const v = await gate.run((h) => h.deliveryStatus(d))
        if (v.items.some((x) => x.digest === d && (x.status === 'delivered' || (x.status === 'failed' && x.reason === 'rejected-by-receiver') || (x.status === 'accepted' && x.held === true)))) out.push(d)
      }
      return out
    },
    record: async (r) => {
      // a storage failure or a closed gate throws: the carrier keeps the answer unacknowledged. `ok: false`
      // is only `unknown-digest`, a document the holder has no entry for: nothing to record, so the
      // answer is concluded and acknowledged like one that binds nothing (RLTP-VTI-5080)
      const x = await gate.run((h) => h.report(r, when()))
      if (x.ok) schedule(x.nextDueAt)
    },
    receiveAtCard,
    diagnose: (code, detail) => deps.diagnose?.({ at: now(), code, ...(detail !== undefined ? { detail } : {}) }),
  }
  if (!deregOnly) deps.transport.start({
    // the holder's own answer only
    envelope: async (env) => (await receive(env)).answer,
    report: (r: DeliveryReport) => {
      // the carrier keeps no copy of what waits: the holder does, and it goes over again later. Only the
      // re-offer lock is lifted: other deposits of the digest stay handed, their end is decided as before
      if (r.status === 'awaiting-transport') {
        parked.add(r.digest)
        for (const k of [...filed]) if (k.split('#')[0] === r.digest) filed.delete(k)
      }
      void gate
        .run((h) => h.report(r, when()))
        .then((x) => {
          if (x.ok) schedule(x.nextDueAt)
        })
        // a report the holder could not record is `later`: the next due time hands the document over again
        .catch(() => schedule(now() + 1000))
    },
  }, carrierOpening)

  // ── command service (§3.4) ──────────────────────────────────────────────────────────────────
  const inflight = new Map<string, IntentHandle<unknown>>()
  /** the inputs of the gesture a key runs for (intent only) */
  const inflightInput = new Map<string, Readonly<Record<string, unknown>>>()
  /** where the key of a command holds its contact id (`acts.ts` `keyContact`): the command is the key's
   *  first part */
  const keyContactOf = (dedupe: string): number | undefined => ACTS[dedupe.slice(0, Math.max(0, dedupe.indexOf('|'))) as keyof typeof ACTS]?.keyContact
  /** a gesture's key as the entries stand now (entries.ts): the key of a record or a running gesture taken
   *  under an id that became an alias since is read so, never rewritten */
  const keyNow = (dedupe: string, input: Readonly<Record<string, unknown>> | null | undefined) => entryDedupe(entries, dedupe, input?.contactId, keyContactOf(dedupe))
  /** the running gesture of a key, also one taken under an id of the person that became an alias since */
  const runningUnder = (dedupe: string): string | undefined => (inflight.has(dedupe) ? dedupe : [...inflight.keys()].find((k) => keyNow(k, inflightInput.get(k)) === dedupe))

  const putIntent = (r: IntentRecord) => app.write([{ store: 'intents', key: r.actId, value: r }, clockWrite()])

  // ── contact order (CONTACT-ORDER.md, issue #425) ───────────────────────────────────────────
  // Block and unblock of one contact: each gesture (dedupe, journal with the older open record
  // superseded, the library parts, `done`) and each recovery of such a record runs in the contact's
  // serial section, entered synchronously when the gesture is taken. The last gesture taken sets the
  // target state; a record left open is completed in the same order, also after the deadline.
  const sections = new Map<string, Promise<unknown>>()
  const section = <T>(target: string, fn: () => Promise<T>): Promise<T> => {
    const p = (sections.get(target) ?? Promise.resolve()).then(fn)
    const tail = p.catch(() => undefined)
    sections.set(target, tail)
    void tail.then(() => {
      if (sections.get(target) === tail) sections.delete(target)
    })
    return p
  }
  /** the person of an ordered gesture as it stands when the gesture is taken: the contacts joined into its
   *  entry so far (journal.ts `aliases`; nothing where there are none) */
  const known = (input: Readonly<Record<string, unknown>>): { aliases?: readonly string[] } => {
    const aliases = typeof input.contactId === 'string' ? entries.aliasesOf(input.contactId) : []
    return aliases.length > 0 ? { aliases: [...aliases] } : {}
  }
  /** the last gesture taken per contact while it runs: the same gesture again joins it */
  const lastTaken = new Map<string, { readonly dedupe: string; readonly input: Readonly<Record<string, unknown>>; readonly handle: IntentHandle<unknown> }>()
  /** contacts whose recovery waits for their section: one at a time per contact */
  const recovering = new Set<string>()
  /** contacts whose next recovery is planned on the clock, with the timer's cancel */
  const planned = new Map<string, () => void>()
  const ORDER_RETRY = [2000, 10_000, 60_000]
  const LOCKED: Result<never> = { ok: false, error: { kind: 'locked' } }
  const UNKNOWN: Result<never> = { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
  const ordered = (r: IntentRecord) => ACTS[r.command as keyof typeof ACTS]?.ordered === true
  /** the lanes of an ordered record (acts.ts `lanes`): the parts of the contact's state it sets */
  const lanesOf = (r: IntentRecord): readonly string[] => ACTS[r.command as keyof typeof ACTS]?.lanes?.(r.input ?? {}) ?? [r.command]
  /** a gesture covers an older record when it sets every part the older one sets: only then the
   *  older one's target state is replaced whole, and only then it is superseded (CONTACT-ORDER.md
   *  "Queue", review 483 round 3) */
  const covers = (lanes: readonly string[], older: IntentRecord) => lanesOf(older).every((l) => lanes.includes(l))
  /** a record's place in its contact's queue; a record written before 3.0.4 has no seq and comes first */
  const place = (r: IntentRecord) => r.seq ?? 0
  /** the open ordered records of a contact, in queue order */
  /** the open ordered records of a contact, in queue order */
  const openOrdered = (all: Iterable<unknown>, target: string): IntentRecord[] =>
    ([...all] as IntentRecord[]).filter((r) => r.target === target && ordered(r) && isOpen(r)).sort((a, b) => place(a) - place(b))
  /** the open records whose order cannot be told: the same place (two without a seq, or a seq written twice) */
  const undecidable = (open: readonly IntentRecord[]): IntentRecord[] => open.filter((r) => open.some((o) => o !== r && place(o) === place(r)))
  /** A journal with open ordered records of one contact whose order cannot be told was not written
   *  under the contract. The records are dropped as invalid and a diagnostic entry without content
   *  records it (CONTACT-ORDER.md "Invalid journal"). */
  const INVALID_JOURNAL = 'contact-order-invalid-journal'
  const dropInvalid = async (records: readonly IntentRecord[]): Promise<void> => {
    await app.write([...records.map((r): AppWrite => ({ store: 'intents', key: r.actId, value: null })), clockWrite()])
    deps.diagnose?.({ at: now(), code: INVALID_JOURNAL, ref: 'CONTACT-ORDER.md' })
  }
  /** at opening, before any recovery: every contact's open ordered records of undecidable order */
  const dropInvalidJournal = async (): Promise<void> => {
    const byTarget = new Map<string, IntentRecord[]>()
    for (const v of (await app.readAll()).intents.values()) {
      const r = v as IntentRecord
      if (!ordered(r) || !isOpen(r)) continue
      byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r])
    }
    const invalid = [...byTarget.values()].flatMap(undecidable)
    if (invalid.length > 0) await dropInvalid(invalid)
  }
  /** the end of an older gesture's record, written with the newer one's journal */
  const supersededWrite = (r: IntentRecord): AppWrite => ({
    store: 'intents',
    key: r.actId,
    value: { ...r, state: 'done', input: null, outcome: { ok: false, error: { kind: 'refused', code: 'superseded' } }, finishedAt: now() } satisfies IntentRecord,
  })

  /** an open record is never left without a planned completion: after every attempt that did not
   *  finish it, the next one is on the clock (the last wait repeats) */
  /** failed attempts per contact in this opening since its last finished record: the backoff grows
   *  also where the failure could not be written (review 422 R7-1) */
  const tries = new Map<string, number>()
  const planOrdered = (target: string) => {
    if (stopped || planned.has(target)) return
    const n = (tries.get(target) ?? 0) + 1
    tries.set(target, n)
    const wait = ORDER_RETRY[Math.min(n, ORDER_RETRY.length) - 1]!
    const cancel = setTimer(now() + wait, () => {
      planned.delete(target)
      if (!stopped) void recoverOrdered(target)
    })
    planned.set(target, cancel)
  }
  const markOpen = async (rec: IntentRecord): Promise<void> => {
    const again: IntentRecord = { ...rec, state: 'outcome-unknown', attempts: rec.attempts + 1 }
    await putIntent(again).catch(() => undefined)
    void sync().catch(() => undefined)
    planOrdered(rec.target)
  }
  /** one attempt's answer: the result for the handle, and whether the record is finished (`done`)
   *  or still open, when the queue behind it waits */
  interface Attempt<T> {
    readonly result: Result<T>
    readonly settled: boolean
  }
  const stillOpen = <T>(result: Result<T>): Attempt<T> => ({ result, settled: false })
  /** One attempt at an ordered record, inside its contact's section: the parts (each answered from the
   *  library's act journal, or run), then `done` with the outcome in one write. A storage failure and a
   *  transient refusal keep the record open with its recovery planned; a final refusal finishes it. */
  const runOrdered = async <T>(rec: IntentRecord, spec: ActSpec): Promise<Attempt<T>> => {
    if (stopped || !gate.isOpen()) return stillOpen(LOCKED)
    if (deps.faults?.killAt === 'after-journal') {
      // the process dies here: the record stays journaled, the next opening completes it
      deps.faults.killAt = null
      return stillOpen(UNKNOWN)
    }
    await deps.faults?.hold?.('act:before', rec.actId)
    return attemptOrdered<T>(rec, spec, null)
  }
  /** The attempt itself. `entry` is the entry whose turn the attempt runs in: null for the record's own
   *  contact, else the entry that contact was joined into since the gesture was taken (CONTACT-ORDER.md
   *  "A contact joined meanwhile"); `inside`: the entries whose sections this attempt already holds. What the
   *  contact stands for is read at the holder in the same turn as the act (contact-turn.ts): a join the
   *  attempt does not run under yet sends it to that entry's section, behind everything open there. Where
   *  a contact was joined into the person since the gesture was taken (the record's own into an entry, or
   *  another into it), a record that restricts runs, on a joined entry as an act of its own; one that lifts
   *  or grants runs nothing: it answers from the library's journal where it committed whole, else it ends
   *  as superseded. */
  const attemptOrdered = async <T>(rec: IntentRecord, spec: ActSpec, entry: string | null, inside: readonly string[] = []): Promise<Attempt<T>> => {
    if (stopped || !gate.isOpen()) return stillOpen(LOCKED)
    const input = rec.input ?? {}
    let r: ActOutcome | { readonly turnOf: string | null } | { readonly joined: true }
    try {
      // reading and act in one turn: no joining work of the holder runs between them (contact-turn.ts)
      r = await contactTurn.attempt(() =>
        gate.run(async (h) => {
          const id = input.contactId
          const person = typeof id === 'string' ? (await h.contacts()).find((c) => c.id === id || c.aliases.includes(id)) : undefined
          const into = person && person.id !== id ? person.id : null
          if (into !== entry) return { turnOf: into }
          const joined = into !== null || (person?.aliases ?? []).some((a) => !(rec.aliases ?? []).includes(a))
          if (joined && !spec.restricts?.(input)) {
            // the gesture was for the person as it stood then: nothing of it runs now
            const events: HolderEvent[] = []
            for (const part of spec.partIds?.(rec.actId) ?? [rec.actId]) {
              const rp = await h.replay(part, rec.when)
              if (!rp.ok) return { joined: true as const }
              events.push(...rp.result.events)
            }
            return { ok: true as const, outbound: [], events }
          }
          // on a joined entry the restriction is an act of its own: what it committed for the fresh contact
          // before the join is that contact's, not the person's
          return spec.run(h, input, { when: rec.when, actId: into === null ? rec.actId : `${rec.actId}@${into}` }, actContext)
        }),
      )
    } catch (e) {
      const error = toAppError(e)
      // locked: the opening ended, the next one completes the record (replayOpen)
      if (error.kind === 'locked') return stillOpen(LOCKED)
      await markOpen(rec)
      return stillOpen(UNKNOWN)
    }
    if ('turnOf' in r) {
      const into = r.turnOf
      if (into === null) return attemptOrdered<T>(rec, spec, null, inside)
      // an entry whose section this attempt holds already (joined, split off, joined again): not from
      // inside it; the record stays open, its recovery starts over
      if (inside.includes(into)) {
        planOrdered(rec.target)
        return stillOpen(UNKNOWN)
      }
      const target = `c:${into}`
      return section(target, async (): Promise<Attempt<T>> => {
        let ahead: IntentRecord[]
        try {
          ahead = openOrdered((await app.readAll()).intents.values(), target)
        } catch (e) {
          if (toAppError(e).kind === 'locked') return stillOpen(LOCKED)
          planOrdered(rec.target)
          return stillOpen(UNKNOWN)
        }
        const { last: held } = await runQueue(ahead)
        // a record of the entry stays open: this one waits behind it, its own recovery planned
        if (held && !held.settled) {
          planOrdered(rec.target)
          return stillOpen(!held.result.ok && held.result.error.kind === 'locked' ? LOCKED : UNKNOWN)
        }
        return attemptOrdered<T>(rec, spec, into, [...inside, into])
      })
    }
    const done: ActOutcome | null = 'joined' in r ? null : r
    if (done?.ok && done.nextDueAt !== undefined) schedule(done.nextDueAt)
    // "not now", or a later part refused after a committed one (the state is partial): the record
    // stays open, its completion planned (CONTACT-ORDER.md "Failures")
    // (#485: the handle says open, like every other open path, not refused)
    if (done && !done.ok && ('partial' in done || TRANSIENT_REFUSALS.has(done.code))) {
      await markOpen(rec)
      return stillOpen(UNKNOWN)
    }
    const value = done?.ok ? spec.outcome(done.events, input) : undefined
    const outcome: { ok: true; value: unknown } | { ok: false; error: AppError } =
      done === null ? { ok: false, error: { kind: 'refused', code: 'superseded' } } : done.ok ? { ok: true, value } : { ok: false, error: mapActError(done.code) }
    if (done?.ok) {
      for (const e of done.events) {
        if (seen.has(e.eventId)) continue
        seen.add(e.eventId)
        pending.push(e)
      }
    }
    try {
      await putIntent({ ...rec, state: 'done', input: null, attempts: rec.attempts + 1, outcome, finishedAt: now() })
      // a finished record resets the contact's backoff and its planned recovery (review 422 R8-2)
      tries.delete(rec.target)
      planned.get(rec.target)?.()
      planned.delete(rec.target)
    } catch (e) {
      // the library's state stands; the next attempt finds the act in its journal and finishes
      if (toAppError(e).kind === 'locked') return stillOpen(LOCKED)
      planOrdered(rec.target)
      return stillOpen(UNKNOWN)
    }
    await sync().catch(() => undefined)
    return { result: outcome.ok ? { ok: true, value: value as T } : outcome, settled: true }
  }
  /** a queue's run, oldest first: each record gets its attempt; one that stays open holds the rest,
   *  their recovery is planned with it. `last` is the attempt the run ended with, `of` every record's */
  interface QueueRun {
    readonly last: Attempt<unknown> | null
    readonly of: ReadonlyMap<ActId, Attempt<unknown>>
  }
  const runQueue = async (recs: readonly IntentRecord[]): Promise<QueueRun> => {
    let last: Attempt<unknown> | null = null
    const of = new Map<ActId, Attempt<unknown>>()
    for (const rec of recs) {
      const spec = ACTS[rec.command as keyof typeof ACTS]
      if (!spec) continue
      last = await runOrdered(rec, spec)
      of.set(rec.actId, last)
      if (!last.settled) break
    }
    return { last, of }
  }
  /** A gesture of the contact order, in its section: journal (every older open record it covers
   *  superseded in the same write), taken; then the queue ahead of it, oldest first, then its own
   *  attempt. A record ahead that stays open keeps this one waiting: taken, open, recovery planned. */
  const orderedGesture = async <T>(spec: ActSpec, command: string, target: string, dedupe: string, input: Readonly<Record<string, unknown>>, actId: ActId, taken: () => void): Promise<Result<T>> => {
    if (stopped || !gate.isOpen()) return LOCKED
    let rec: IntentRecord
    let ahead: IntentRecord[]
    try {
      await deps.faults?.probe?.('dedupe:before', actId)
      const open = openOrdered((await app.readAll()).intents.values(), target)
      await deps.faults?.probe?.('dedupe:after', actId)
      const lanes = spec.lanes?.(input) ?? [command]
      // the same gesture at the end of the queue (a failure, a restart): that record and its actId;
      // its act answers from the library's journal, never a second act (§3.4 step 1)
      const last = open.at(-1)
      const same = last && last.dedupe === dedupe && sameInput(last.input, input) ? last : null
      rec = same ?? { actId, command: command as IntentRecord['command'], target, policy: spec.policyFor?.(input) ?? spec.policy, state: 'journaled', dedupe, input: structuredClone(input), when: when(), createdAt: now(), seq: (last ? place(last) : 0) + 1, attempts: 0, ...known(input) }
      // replaced whole: every older record this gesture covers; the rest stays ahead in the queue
      const superseded = open.filter((r) => r !== same && covers(lanes, r))
      ahead = open.filter((r) => r !== same && !superseded.includes(r))
      // journal before the first effect (§3.4 step 2): this gesture and the end of every record it
      // covers, one write
      if (!same || superseded.length > 0) {
        await app.write([
          ...superseded.map(supersededWrite),
          ...(same ? [] : [{ store: 'intents' as const, key: rec.actId, value: rec }]),
          clockWrite(),
        ])
      }
      taken()
    } catch (e) {
      return { ok: false, error: toAppError(e) }
    }
    void sync().catch(() => undefined)
    const { last: held } = await runQueue(ahead)
    // a record ahead stays open: this gesture is taken and waits behind it, with the planned recovery
    if (held && !held.settled) return !held.result.ok && held.result.error.kind === 'locked' ? LOCKED : UNKNOWN
    return (await runOrdered<T>(rec, spec)).result
  }
  const orderedIntent = <T>(spec: ActSpec, command: string, target: string, dedupe: string, input: Readonly<Record<string, unknown>>): IntentHandle<T> => {
    const last = lastTaken.get(target)
    if (last?.dedupe === dedupe) {
      // the same gesture again with nothing between: it joins; other inputs under the key are refused (R9-3)
      if (!sameInput(last.input, input)) return { actId: last.handle.actId, done: Promise.resolve({ ok: false, error: { kind: 'refused', code: 'superseded' } }), journaled: Promise.resolve(false) }
      return last.handle as IntentHandle<T>
    }
    const actId = entropy.uuid() as ActId
    if (stopped || !gate.isOpen()) return { actId, done: Promise.resolve(LOCKED), journaled: Promise.resolve(false) }
    let taken: (v: boolean) => void = () => undefined
    const journaled = new Promise<boolean>((r) => (taken = r))
    // entered now, synchronously: the order of the sections is the order of the gestures
    const done = section(target, () => orderedGesture<T>(spec, command, target, dedupe, input, actId, () => taken(true)))
      .catch((e: unknown): Result<T> => ({ ok: false, error: toAppError(e) }))
      .finally(() => {
        taken(false)
        if (lastTaken.get(target)?.handle === handle) lastTaken.delete(target)
      })
    const handle: IntentHandle<T> = { actId, done, journaled }
    lastTaken.set(target, { dedupe, input: structuredClone(input), handle: handle as IntentHandle<unknown> })
    return handle
  }
  /** Recovery of a contact's queue, in its section (timer, activation, reopening, retryIntent): every
   *  open record gets its attempt, oldest first; one that stays open holds the rest (no deadline).
   *  Asked for one record (`retryIntent`, #484), the answer is that record's: its attempt's result,
   *  `unknown-outcome` while it waits behind one that stayed open, `superseded` once it is no longer
   *  open (a newer gesture replaced it meanwhile). */
  const recoverOrdered = (target: string, asked?: ActId): Promise<Result<unknown>> => {
    if (recovering.has(target)) return Promise.resolve({ ok: false, error: { kind: 'unavailable', reason: 'in-flight' } })
    recovering.add(target)
    return section(target, async (): Promise<Result<unknown>> => {
      recovering.delete(target)
      if (stopped || !gate.isOpen()) return LOCKED
      let recs: IntentRecord[]
      try {
        const open = openOrdered((await app.readAll()).intents.values(), target)
        const invalid = undecidable(open)
        // never under the contract; dropped like at opening, nothing of them runs
        if (invalid.length > 0) await dropInvalid(invalid)
        recs = open.filter((r) => !invalid.includes(r))
      } catch (e) {
        if (toAppError(e).kind === 'locked') return LOCKED
        planOrdered(target)
        return UNKNOWN
      }
      const run = await runQueue(recs)
      if (asked) {
        const own = run.of.get(asked)
        if (own) return own.result
        return recs.some((r) => r.actId === asked) ? UNKNOWN : { ok: false, error: { kind: 'refused', code: 'superseded' } }
      }
      return run.last?.result ?? { ok: false, error: { kind: 'refused', code: 'superseded' } }
    }).catch((e: unknown): Result<unknown> => ({ ok: false, error: toAppError(e) }))
  }

  /** An intent whose outcome is unknown (§3.4 step 4): an encounter act waits for the human again
   *  (N3), a lost showCard is dropped, a replay act is repeated with backoff within the horizon. */
  const unknownOutcome = async (rec: IntentRecord): Promise<void> => {
    const state = rec.policy === 'confirm-again' ? 'needs-confirmation' : rec.policy === 'discard' ? 'expired' : 'outcome-unknown'
    await putIntent({ ...rec, state, ...(state === 'expired' ? { input: null } : {}) }).catch(() => undefined)
    void sync().catch(() => undefined)
    if (state === 'outcome-unknown') scheduleReplay({ ...rec, state })
  }

  /** the act of this attempt did not start: the record keeps what it knew before (a record that may
   *  have committed stays so, never back to 'journaled', review 421 R11-2) */
  const notStarted = async (rec: IntentRecord): Promise<void> => {
    const again: IntentRecord = { ...rec, attempts: rec.attempts + 1 }
    await putIntent(again).catch(() => undefined)
    void sync().catch(() => undefined)
    if (rec.policy === 'replay') scheduleReplay(again)
    planJournal()
  }

  const BACKOFF = [2000, 10_000, 60_000]
  /** open with an unknown outcome; a record left 'journaled' or 'running' by a failed write counts too
   *  (nothing in flight holds it: callers check inflight first, review 421 R3-5, R5-3) */
  const replayable = (r: IntentRecord) => !executing.has(r.actId) && !knownAnswer.has(r.actId) && (r.state === 'outcome-unknown' || r.state === 'journaled' || r.state === 'running')
  const scheduleReplay = (rec: IntentRecord) => {
    const wait = BACKOFF[rec.attempts - 1]
    if (wait === undefined || stopped || expiresAt(rec) < when()) return
    setTimer(now() + wait, () => {
      if (stopped) return
      void findIntent(rec.actId).then((cur) => {
        const spec = cur ? ACTS[cur.command as keyof typeof ACTS] : undefined
        if (cur && spec && replayable(cur) && expiresAt(cur) >= when()) settle(cur, spec)
      })
    })
  }
  /** An open record settled by the command service on its own: under the gesture's key, with its
   *  inputs and as taken, like the gesture itself (a changed text under the key is refused, R10-2) */
  const settle = (rec: IntentRecord, spec: ActSpec) => {
    if (!resumed) return
    const key = rec.dedupe !== undefined ? keyNow(rec.dedupe, rec.input) : `retry|${rec.actId}`
    if (runningUnder(key) !== undefined) return
    const h: IntentHandle<unknown> = {
      actId: rec.actId,
      journaled: Promise.resolve(true),
      done: execute(rec, spec).finally(() => {
        if (inflight.get(key) !== h) return
        inflight.delete(key)
        inflightInput.delete(key)
      }),
    }
    inflight.set(key, h)
    if (rec.input) inflightInput.set(key, structuredClone(rec.input))
  }

  /** What the finished act leaves behind beside its outcome (§3.4 step 4, N4), all in the
   *  transaction that marks the intent done: the encounter cache from its own events, the resolution
   *  of a decision it decided. */
  const finishWrites = async (rec: IntentRecord, value: unknown, events: readonly HolderEvent[]): Promise<AppWrite[]> => {
    const input = rec.input ?? {}
    const card = input.card as { anchor?: unknown } | undefined
    const captured = rec.command === 'confirmCard' && input.role === 'sent' && typeof card?.anchor === 'string' ? { anchor: card.anchor } : undefined
    const cache = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
    const { own, sent, met, capturedBy } = applyEncounterEvents(cache, events, rec.when, captured)
    const writes: AppWrite[] = [{ store: 'kv', key: KV.encounters, value: { ...cache, own, sent, met, capturedBy } satisfies EncounterCache }]
    // a card shown with a carrier offer: its N moves from the act input (dropped with `done`) to the
    // displayed cards, in this transaction (TRANSPORT.md "The displayed card's instance")
    const offer = input.carrier as { c?: unknown; nonce?: unknown } | undefined
    const shown = events.find((e) => e.type === 'encounter.shown')
    if (rec.command === 'showCard' && shown?.type === 'encounter.shown' && typeof offer?.c === 'string' && typeof offer.nonce === 'string') {
      const card = shown.card as { keyAgreement?: unknown; challenge?: { issuedAt?: unknown } }
      const issuedAt = typeof card.challenge?.issuedAt === 'string' ? Date.parse(card.challenge.issuedAt) : rec.when
      const t = when()
      const kept = Object.entries((await app.get<DisplayedCards>('kv', KV.displayed)) ?? {}).filter(([, v]) => challengeOpen(v, t))
      const entry = { c: offer.c, nonce: offer.nonce, rkid: String(card.keyAgreement), issuedAt }
      writes.push({ store: 'kv', key: KV.displayed, value: Object.fromEntries([...kept, [shown.challenge, entry]]) satisfies DisplayedCards })
    }
    const decided = (value as { decided?: { prompt: string; choice: 'accept' | 'decline' } } | null)?.decided
    if (decided) {
      const id = `dec:${decided.prompt}`
      const line = await app.get<LogLine>('log', id)
      const resolution: DecisionResolution = { choice: decided.choice, by: 'this-device', at: when(), basis: 'own-act' }
      const contactId = typeof input.contactId === 'string' ? input.contactId : null
      if (line?.kind === 'decision') writes.push({ store: 'log', key: id, value: { ...line, resolution } })
      else if (contactId) writes.push({ store: 'log', key: id, value: { kind: 'decision', id, key: `c:${contactId}`, at: rec.when, decision: decided.prompt, resolution } satisfies LogLine })
    }
    return writes
  }

  /** The cards on display with an offer for this opening's custody carrier, while the holder resolves
   *  their challenge `open`, to the lease: each gets an instance of its own (TRANSPORT.md "The
   *  displayed card's instance"); at the opening also those still open from before a restart. A card
   *  whose challenge resolves `unknown` leaves `displayed` here, at the timer of its end (an opening
   *  timer, LIFECYCLE.md) or at the next opening. */
  let displayedTimer: (() => void) | null = null
  const announceDisplayed = async (): Promise<void> => {
    const lease = deps.transport
    if (lease.kind !== 'custody' || deregOnly || stopped) return
    const t = when()
    const all = (await app.get<DisplayedCards>('kv', KV.displayed)) ?? {}
    if (stopped) return
    const open = Object.entries(all).filter(([, v]) => challengeOpen(v, t))
    if (open.length !== Object.keys(all).length) {
      await queue(async () => {
        const cur = (await app.get<DisplayedCards>('kv', KV.displayed)) ?? {}
        await app.write([{ store: 'kv', key: KV.displayed, value: Object.fromEntries(Object.entries(cur).filter(([, v]) => challengeOpen(v, when()))) satisfies DisplayedCards }])
      }).catch(() => undefined)
    }
    lease.display(open.filter(([, v]) => v.c === lease.carrier).map(([challenge, v]) => ({ challenge, nonce: v.nonce, rkid: v.rkid, issuedAt: v.issuedAt })))
    displayedTimer?.()
    displayedTimer = null
    if (open.length === 0) return
    const end = Math.min(...open.map(([, v]) => challengeEnd(v)))
    displayedTimer = setTimer(now() + Math.max(0, end - t), () => {
      displayedTimer = null
      void announceDisplayed().catch(() => undefined)
    })
  }

  /** A repeated optical capture reports no contact (N9); the cache of own captures maps the card back. */
  const enrich = async (rec: IntentRecord, value: unknown, skipped?: string): Promise<unknown> => {
    const o = value as EncounterOutcome | null
    // a back-code lives as long as the link it answers (the core shows none past it); an act that ran nothing
    // says why with the reason the act itself found, never one read again now
    if (rec.command === 'showBackCode') {
      if (skipped !== undefined) return { kind: 'not-shown', why: skipped }
      const v = (await gate.run((h) => h.sharedConnect())).find((x) => x.id === rec.input?.connection)
      if (typeof (value as { qr?: unknown } | null)?.qr === 'string') return { kind: 'shown', qr: (value as { qr: string }).qr, validUntil: (v?.link.exp ?? 0) * 1000 }
      // committed without a code (an act the journal settles): the ceremony's state tells the flow the rest
      return { kind: 'not-shown', why: 'closed' }
    }
    if (rec.command !== 'confirmCard' || o?.kind !== 'already-captured' || o.contactId !== null) return value
    const anchor = (rec.input?.card as { anchor?: unknown } | undefined)?.anchor
    const cache = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
    const contactId = typeof anchor === 'string' ? cache.capturedBy?.[anchor] : undefined
    return contactId ? { kind: 'already-captured', contactId } : value
  }

  /** Runs the act of a journaled record (state running); finishes the record by its outcome. */
  /** the records an execution runs for right now, whatever key started it: a replay never runs beside
   *  them (a record left 'running' by a failed write is replayable, review 421 R5-3) */
  const executions = new Map<string, Promise<Result<unknown>>>()
  /** records whose answer is known (a refusal) and not yet written: recovery leaves them alone */
  const knownAnswer = new Set<string>()
  const executing = { has: (actId: string) => executions.has(actId) }
  /** One execution per actId, whatever path asks (a gesture, retryIntent, confirmIntent, recovery):
   *  a second caller joins it (review 421 R11-3). An open record from before runs only after a
   *  completed resume of this opening (R10-1, R11-2); a fresh gesture runs at once. */
  const execute = <T>(rec: IntentRecord, spec: ActSpec, fresh = false): Promise<Result<T>> => {
    const running = executions.get(rec.actId)
    if (running) return running as Promise<Result<T>>
    // a known answer not yet written belongs to its writer alone (R12-2, R13-4)
    if (knownAnswer.has(rec.actId)) return Promise.resolve({ ok: false, error: { kind: 'unavailable', reason: 'in-flight' } })
    if (!fresh && !resumed) return Promise.resolve({ ok: false, error: { kind: 'unavailable', reason: 'later' } })
    const p = executeOnce<T>(rec, spec).finally(() => {
      executions.delete(rec.actId)
      // every record's own deadline (expiry, retention) is planned, also without other holder work (R11-4)
      planJournal()
    })
    executions.set(rec.actId, p as Promise<Result<unknown>>)
    return p
  }
  const planJournal = () => {
    if (!stopped && !deregOnly) void track(expireOpen()).catch(() => schedule(now() + 1000))
  }
  /** a write whose content is known, tried again shortly until it holds (no user action needed) */
  const persistLater = (write: () => Promise<void>) => {
    if (stopped) return
    setTimer(now() + 1000, () => {
      if (!stopped) void write().catch(() => persistLater(write))
    })
  }
  /** An open record at its limit: the library's journal is asked first (a committed act's result is
   *  taken over, R12-1); only an act it does not know expires; a failed read leaves the record open
   *  and is tried again (R13-1). The caller holds the record in `executions`. */
  const settleAtLimit = async <T>(rec: IntentRecord, spec: ActSpec): Promise<Result<T>> => {
    if (rec.state === 'journaled') return expire(rec)
    let known: Awaited<ReturnType<Holder['replay']>>
    try {
      known = await gate.run((h) => h.replay(rec.actId, when()))
    } catch {
      schedule(now() + 1000)
      return { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
    if (known.ok) return finishOk<T>(rec, { ...rec, state: 'running' }, spec, known.result.events)
    return expire(rec)
  }
  /** An open record that cannot settle (past its limit, or unknown to the library's journal): the text
   *  stays in the conversation as expired, "send as a new message"; a failed write is tried again
   *  shortly (R10-3) */
  const expire = async <T>(rec: IntentRecord): Promise<Result<T>> => {
    try {
      await queue(async () => {
        // the record as it is now: one that settled meanwhile is not expired over (R13-3)
        const cur = await app.get<IntentRecord>('intents', rec.actId)
        if (cur && !isOpen(cur)) return
        await app.write(expireWrites(cur ?? rec, (await app.readAll()).log))
      })
      await sync().catch(() => undefined)
    } catch {
      schedule(now() + 1000)
    }
    return { ok: false, error: { kind: 'unavailable', reason: 'later' } }
  }
  const executeOnce = async <T>(rec: IntentRecord, spec: ActSpec): Promise<Result<T>> => {
    const input = rec.input ?? {}
    const running: IntentRecord = { ...rec, state: 'running', attempts: rec.attempts + 1 }
    try {
      await putIntent(running)
    } catch (e) {
      const error = toAppError(e)
      // the record is journaled already: its inputs belong to the command service now, the outcome is
      // open (never "not taken": a caller would hand the text back and send another, review 421 R2-1);
      // the record keeps the state it had before this attempt (R11-2), recovery settles it
      if (error.kind !== 'locked') await notStarted(rec)
      return { ok: false, error: error.kind === 'locked' ? error : { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
    void sync().catch(() => undefined)
    await deps.faults?.hold?.('act:before', rec.actId)
    if (deps.faults?.killAt === 'after-journal') {
      // the process dies here: nothing after this point runs, the record stays `running`
      deps.faults.killAt = null
      return { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
    // the limit holds at the act itself, whatever waited before (review 421 R8-1): past it the
    // library's act journal may have forgotten this actId
    if (expiresAt(rec) < when()) return settleAtLimit<T>(running, spec)
    const act = async (): Promise<ActOutcome | 'unknown'> => {
      if (rec.state === 'journaled' || rec.policy !== 'replay') {
        // the act never started, or the human confirms it again (confirm-again, N3): it runs, the same
        // actId (a committed act answers its journaled result)
        return gate.run((h) => spec.run(h, input, { when: rec.when, actId: rec.actId }, actContext))
      }
      // the act may have committed: the library's journal says, nothing runs blind (R10-1)
      const rp = await gate.run((h) => h.replay(rec.actId, when()))
      return rp.ok ? ({ ok: true, events: rp.result.events } as ActResult) : 'unknown'
    }
    let r: ActOutcome
    try {
      const step = await act()
      if (step === 'unknown') return expire(running)
      r = step
    } catch (e) {
      const error = toAppError(e)
      if (error.kind !== 'locked') await unknownOutcome(running)
      return { ok: false, error: error.kind === 'locked' ? error : { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
    if (!r.ok) {
      const error = mapActError(r.code)
      const code = r.code
      // the refusal is the library's answer and known here: its record is written until it holds; a
      // refusal commits nothing, so the library's journal could not tell it later (review 421 R4-2).
      // Written only while the record is still this attempt, never over a newer state: a line that went
      // out meanwhile stays (R11-1)
      const finish = async () => {
        await queue(async () => {
          const cur = await app.get<IntentRecord>('intents', rec.actId)
          if (cur && (cur.state !== 'running' || cur.attempts !== running.attempts)) return
          const lines: LogLine[] = []
          for (const l of spec.lines?.({ ok: false, code }, input, rec.when) ?? []) {
            const old = await app.get<LogLine>('log', l.id)
            if (!(old?.kind === 'message' && old.digest !== null)) lines.push(l)
          }
          await app.write([
            { store: 'intents', key: rec.actId, value: { ...running, state: 'done', input: null, outcome: { ok: false, error }, finishedAt: now() } },
            clockWrite(),
            ...lines.map((l) => ({ store: 'log' as const, key: l.id, value: l })),
          ])
        })
      }
      // persistence is retried, publication is not part of it (a failed sync never repeats the write);
      // until it holds, the known answer is this record's alone: no recovery reads or expires it (R12-2)
      const written = () => {
        knownAnswer.delete(rec.actId)
        planJournal()
        return sync().catch(() => undefined)
      }
      await finish().then(written, () => {
        knownAnswer.add(rec.actId)
        persistLater(() => finish().then(written))
      })
      return { ok: false, error }
    }
    if (r.nextDueAt !== undefined) schedule(r.nextDueAt)
    return finishOk<T>(rec, running, spec, r.events, 'skipped' in r ? r.skipped : undefined)
  }
  /** a committed act's result: its projections and `done` in one transaction */
  const finishOk = async <T>(rec: IntentRecord, running: IntentRecord, spec: ActSpec, events: readonly HolderEvent[], skipped?: string): Promise<Result<T>> => {
    const input = rec.input ?? {}
    for (const e of events) {
      if (seen.has(e.eventId)) continue
      seen.add(e.eventId)
      pending.push(e)
    }
    try {
      const value = (await enrich(rec, spec.outcome(events, input), skipped)) as T
      // the act's own projections and `done` in one transaction (§3.4 step 4, N4, review 420 R1-1)
      await queue(async () => {
        const writes = await finishWrites(rec, value, events)
        const lines = spec.lines?.({ ok: true, events }, input, rec.when) ?? []
        await app.write([
          ...writes,
          ...lines.map((l) => ({ store: 'log' as const, key: l.id, value: l })),
          { store: 'intents', key: rec.actId, value: { ...running, state: 'done', input: null, outcome: { ok: true, value }, finishedAt: now() } },
          clockWrite(),
        ])
      })
      // reports and acks that came in before the act's lines existed: the next sync reads them
      await sync().catch(() => undefined)
      // a card on display listens at the carrier from now on
      if (rec.command === 'showCard') await announceDisplayed().catch(() => undefined)
      return { ok: true, value }
    } catch {
      // committed in the library, not finished here: a repeat with the same actId returns the result
      await unknownOutcome(running)
      return { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
  }

  /** the inputs as the journal compares them (canonical JSON of plain values) */
  /** an encounter act opens a relationship: with a custody carrier its card carries the delivery hint
   *  for C under a fresh N, drawn here and journaled with the act (carrier-offer.ts) */
  const withCarrier = (command: string, input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
    // also for a connection ceremony (shared-connect): its acts take the offer as show and scan do
    deps.transport.kind === 'custody' && (command === 'showCard' || (command === 'confirmCard' && input.role === 'displayed'))
      ? { ...input, carrier: journaledOffer(deps.transport.carrier, entropy.bytes(32)) }
      : input
  /** the app in front, as the lifecycle says; without one (tests, the harness) always */
  let foreground = deps.lifecycle?.current?.() !== 'background'
  const offFront = (deregOnly ? undefined : deps.lifecycle)?.onState((st) => {
    foreground = st === 'active'
  }) ?? (() => {})
  undo.push(() => offFront())
  const actContext: ActContext = {
    offer: (raw) => carrierOffer(deps.rootIkm, raw),
    // the documents of a connection ceremony travel over the carrier's address, where the carrier has
    // wires for them (the VTI mediator): configuration, known also while the device is offline
    relays: sharedConnect && lease.kind === 'custody' ? [{ kind: 'tsp-mediator', address: lease.carrier }] : null,
    legacyCard: deps.ceremony === 'card',
    foreground: () => foreground,
    now,
  }
  /** the gesture of an input: the journaled carrier offer (N) is the act's, never the gesture's */
  const gesture = (i: Readonly<Record<string, unknown>> | null) => {
    if (i === null) return null
    const { carrier: _offer, ...rest } = i
    void _offer
    return rest
  }
  const sameInput = (a: Readonly<Record<string, unknown>> | null, b: Readonly<Record<string, unknown>>) => JSON.stringify(gesture(a)) === JSON.stringify(gesture(structuredClone(b)))

  const intent = <T>(
    command: keyof typeof ACTS & string,
    given: string,
    givenDedupe: string,
    givenInput: Readonly<Record<string, unknown>>,
    preview?: CardPreview,
    opts: { auto?: boolean } = {},
  ): IntentHandle<T> => {
    // every contact id of the command read as its entry (entries.ts), before the queue, the dedupe key,
    // the actId and the journal see it: a command on an alias is one on the person it stands for
    const target = entryKey(entries, given)
    const dedupe = entryDedupe(entries, givenDedupe, givenInput.contactId, ACTS[command as keyof typeof ACTS]?.keyContact)
    const input = entryInput(entries, givenInput)
    const spec = ACTS[command as keyof typeof ACTS]
    if (spec?.ordered) return orderedIntent<T>(spec, command, target, dedupe, input)
    const runningKey = runningUnder(dedupe)
    const running = runningKey === undefined ? undefined : inflight.get(runningKey)
    if (runningKey !== undefined && running) {
      // the same gesture joins; other inputs under the same key are refused, never taken (R9-3)
      // the stored inputs read as the entries stand now: a send taken under an id that became an alias since
      if (inflightInput.has(runningKey) && !sameInput(entryInput(entries, inflightInput.get(runningKey) ?? {}), input)) {
        return { actId: running.actId, done: Promise.resolve({ ok: false, error: { kind: 'refused', code: 'superseded' } }), journaled: Promise.resolve(false) }
      }
      return running as IntentHandle<T>
    }
    const actId = entropy.uuid() as ActId
    if (!spec || stopped || !gate.isOpen()) {
      return {
        actId,
        done: Promise.resolve({ ok: false, error: stopped || !gate.isOpen() ? { kind: 'locked' } : { kind: 'unavailable', reason: 'not-supported' } }),
        journaled: Promise.resolve(false),
      }
    }
    // whether the command service holds the gesture durably: the composer empties only then (20.10.)
    let taken: (v: boolean) => void = () => undefined
    const journaled = new Promise<boolean>((r) => (taken = r))
    let settleAfter: (() => void) | null = null
    const rec: IntentRecord = {
      actId,
      command: command as IntentRecord['command'],
      target,
      policy: spec.policyFor?.(input) ?? spec.policy,
      state: 'journaled',
      dedupe,
      input: structuredClone(withCarrier(command, input)),
      when: when(),
      createdAt: now(),
      attempts: 0,
      ...(preview ? { preview } : {}),
    }
    const done = (async (): Promise<Result<T>> => {
      try {
        // the same gesture while its record is still open (after a restart, or a held draft released
        // while its earlier act is being replayed): that record, its actId, never a second act
        await deps.faults?.hold?.('journal:before', actId)
        const same = ([...(await app.readAll()).intents.values()] as IntentRecord[]).filter((r) => r.dedupe !== undefined && keyNow(r.dedupe, r.input) === dedupe)
        // a message whose record expired with an unknown outcome is spent: sending again is a new act
        // under a new draft key, never this one (review 421 R3-2); other gestures (a new card) are
        // new acts under their fixed key (R4-1)
        if (command === 'send' && same.some((r) => r.state === 'expired')) return { ok: false, error: { kind: 'refused', code: 'superseded' } }
        const open = same.find((r) => isOpen(r))
        if (open) {
          const openSpec = ACTS[open.command as keyof typeof ACTS]
          // the gesture with other inputs under the same key is refused, never the old inputs sent
          if (!sameInput(entryInput(entries, open.input ?? {}), input)) return { ok: false, error: { kind: 'refused', code: 'superseded' } }
          // the same gesture is held by its open record
          taken(true)
          // an automatic release (a held draft) never runs an open record: the command service settles it
          // once this gesture let go of its key (it held the key meanwhile, R10-1)
          if (opts.auto || open.policy !== 'replay' || !openSpec) {
            if (open.policy === 'replay' && openSpec) settleAfter = () => settle(open, openSpec)
            return { ok: false, error: { kind: 'unavailable', reason: 'in-flight' } }
          }
          // the human again: the manual limit holds (§3.4 "Retry-Frist", review 421 R2-2)
          if (open.createdAt + manualLimitMs < when()) return { ok: false, error: { kind: 'unavailable', reason: 'later' } }
          return execute<T>(open, openSpec)
        }
        // a draft that went out already is not sent twice (the same draft key after its intent ended)
        if (command === 'send') {
          const line = await app.get<LogLine>('log', `msg:out:${String(input.draftKey)}`)
          // only the same text to the same contact: other inputs under a used key are refused (R8-3)
          if (line?.kind === 'message' && line.digest !== null && (line.text !== String(input.text) || entries(line.contactId) !== entries(String(input.contactId)))) {
            return { ok: false, error: { kind: 'refused', code: 'superseded' } }
          }
          if (line?.kind === 'message' && line.digest !== null) {
            taken(true)
            return { ok: true, value: spec.outcome([], input) as T }
          }
          // its record expired and left the journal, the line says "expired": sending it again is a new
          // message under a new draft key, never this one (R3-2)
          if (line?.kind === 'message' && line.status?.phase === 'expired') return { ok: false, error: { kind: 'refused', code: 'superseded' } }
        }
        // journal before the first effect (§3.4 step 2)
        await putIntent(rec)
        taken(true)
      } catch (e) {
        return { ok: false, error: toAppError(e) }
      }
      return execute<T>(rec, spec, true)
    })().finally(() => {
      // a newer gesture under the same key may hold it by now (R3-1)
      if (inflight.get(dedupe) === handle) {
        inflight.delete(dedupe)
        inflightInput.delete(dedupe)
      }
      // every refusal before the journal: not taken (a resolved promise keeps its first answer)
      taken(false)
      settleAfter?.()
    })
    const handle: IntentHandle<T> = { actId, done, journaled }
    inflight.set(dedupe, handle as IntentHandle<unknown>)
    inflightInput.set(dedupe, structuredClone(input))
    return handle
  }

  const findIntent = async (actId: ActId) => app.get<IntentRecord>('intents', actId)

  const confirmIntent = <T>(actId: ActId): IntentHandle<T> => {
    const key = `confirm|${actId}`
    const running = inflight.get(key)
    if (running) return running as IntentHandle<T>
    const done = (async (): Promise<Result<T>> => {
      const rec = await findIntent(actId)
      const spec = rec ? ACTS[rec.command as keyof typeof ACTS] : undefined
      if (!rec || !spec || rec.state !== 'needs-confirmation') return { ok: false, error: { kind: 'refused', code: 'decision-gone' } }
      if (rec.createdAt + manualLimitMs < when()) {
        const log = (await app.readAll()).log
        await app.write(expireWrites(rec, log))
        await sync().catch(() => undefined)
        return { ok: false, error: { kind: 'unavailable', reason: 'later' } }
      }
      return execute<T>(rec, spec)
    })().finally(() => inflight.delete(key))
    const handle = { actId, done }
    inflight.set(key, handle as IntentHandle<unknown>)
    return handle
  }

  const retryIntent = <T>(actId: ActId): IntentHandle<T> => {
    const key = `retry|${actId}`
    const running = inflight.get(key)
    if (running) return running as IntentHandle<T>
    const done = (async (): Promise<Result<T>> => {
      const rec = await findIntent(actId)
      const spec = rec ? ACTS[rec.command as keyof typeof ACTS] : undefined
      // the contact's queue is run; the answer is this record's (#484); a record a newer gesture
      // superseded stays as it is
      if (rec && spec?.ordered) return (isOpen(rec) ? recoverOrdered(rec.target, actId) : Promise.resolve({ ok: false, error: { kind: 'refused', code: 'superseded' } })) as Promise<Result<T>>
      // a replay of the same record already runs: join it
      const joinedKey = rec?.dedupe ? runningUnder(keyNow(rec.dedupe, rec.input)) : undefined
      const joined = joinedKey === undefined ? undefined : inflight.get(joinedKey)
      if (joined) return joined.done as Promise<Result<T>>
      if (!rec || !spec || rec.policy !== 'replay' || (rec.state !== 'outcome-unknown' && rec.state !== 'partial')) return { ok: false, error: { kind: 'refused', code: 'superseded' } }
      if (rec.createdAt + manualLimitMs < when()) {
        const log = (await app.readAll()).log
        await app.write(expireWrites(rec, log))
        await sync().catch(() => undefined)
        return { ok: false, error: { kind: 'unavailable', reason: 'later' } }
      }
      return execute<T>(rec, spec)
    })().finally(() => inflight.delete(key))
    const handle = { actId, done }
    inflight.set(key, handle as IntentHandle<unknown>)
    return handle
  }

  const discardIntent = async (actId: ActId): Promise<Result> => {
    const rec = await findIntent(actId)
    if (!rec || !isOpen(rec)) return { ok: false, error: { kind: 'refused', code: 'decision-gone' } }
    // a record of the contact order is completed, never dropped: a partial state would stay (CONTACT-ORDER.md)
    if (ordered(rec)) return { ok: false, error: { kind: 'unavailable', reason: 'not-supported' } }
    await queue(() => putIntent({ ...rec, state: 'expired', input: null, finishedAt: now() }))
    await sync().catch(() => undefined)
    return { ok: true, value: undefined }
  }

  /** After unlocking (§3.4 "Wiederanlauf"): never runs an encounter act without the human (N3). */
  /** An open intent past the manual limit is never run again. An own message keeps its text in the
   *  conversation as expired, with "send as a new message" (review 421 R2-3, 20.10.); its inputs leave
   *  the journal. */
  const expireWrites = (r: IntentRecord, log: ReadonlyMap<string, unknown>): AppWrite[] => {
    const writes: AppWrite[] = [{ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null, finishedAt: when() } }]
    if (r.command === 'send' && r.input) {
      const id = `msg:out:${String(r.input.draftKey)}`
      const line = log.get(id) as LogLine | undefined
      if (!(line?.kind === 'message' && line.digest !== null)) {
        writes.push({ store: 'log', key: id, value: ownMessageLine(r.input, Math.floor(r.when / 1000) * 1000, { status: { phase: 'expired' } }) })
      }
    }
    return writes
  }

  /** What passed its limit while the session ran expires here too, not only at opening (R8-4); the
   *  timer comes back at the next limit of an open record, without activation or network (R9-4). */
  const expireOpen = async (purgeOnly = false) => {
    if (stopped) return
    const before = await app.readAll()
    const all = [...before.intents.values()] as IntentRecord[]
    // records of the contact order never expire: their recovery completes them (CONTACT-ORDER.md)
    const open = all.filter((r) => isOpen(r) && !ordered(r) && !executing.has(r.actId) && !knownAnswer.has(r.actId))
    const due = purgeOnly ? [] : open.filter((r) => expiresAt(r) < when())
    // every record at its limit is settled through the journal lookup, claimed before it starts (R13-3)
    for (const r of due) {
      const spec = ACTS[r.command as keyof typeof ACTS]
      if (!spec || executing.has(r.actId)) continue
      const p = settleAtLimit(r, spec).finally(() => executions.delete(r.actId))
      executions.set(r.actId, p)
      await p
    }
    // finished records leave the journal at their retention, also while the session runs
    const doneUntil = (r: IntentRecord) => (r.finishedAt ?? r.createdAt) + DONE_RETENTION_MS
    const finished = all.filter((r) => !isOpen(r))
    const purge = finished.filter((r) => doneUntil(r) < when())
    if (purge.length > 0) {
      await queue(async () => app.write(purge.map((r) => ({ store: 'intents' as const, key: r.actId, value: null }))))
      await sync().catch(() => undefined)
    }
    const next = Math.min(...open.filter((r) => !due.includes(r)).map((r) => expiresAt(r) + 1), ...finished.filter((r) => !purge.includes(r)).map((r) => doneUntil(r) + 1))
    if (Number.isFinite(next)) schedule(next)
  }


  const recover = async () => {
    const snap = await app.readAll()
    const writes: AppWrite[] = []
    for (const v of snap.intents.values()) {
      const r = v as IntentRecord
      const t = when()
      if (!isOpen(r)) {
        if ((r.finishedAt ?? r.createdAt) + DONE_RETENTION_MS < t) writes.push({ store: 'intents', key: r.actId, value: null })
        continue
      }
      // a record being settled right now (a lookup since the resume) is that settlement's
      if (executing.has(r.actId)) continue
      // a record at its limit is settled after the resume, through the journal lookup (R13-2)
      if (expiresAt(r) < t) continue
      if (r.policy === 'discard') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null, finishedAt: t } })
      else if (r.policy === 'confirm-again') {
        if (r.state !== 'needs-confirmation') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'needs-confirmation' } })
      }
      // a replay record waits for the first completed resume of this opening (due → replayOpen, R10-1)
    }
    if (writes.length) await app.write(writes)
  }

  /** Messages the app held unsent because the relationship was not ready (Message Tasks 5.1) go
   *  out once the contact view says canMessage; the same draft key, a new act. */
  const sendHeld = (contacts: readonly ContactView[]) => {
    if (stopped) return
    const ready = new Set(contacts.filter((c) => c.canMessage && !c.blocked).map((c) => c.id))
    const entry = entryIds(contacts)
    void app.readAll().then((snap) => {
      for (const v of snap.log.values()) {
        const l = v as LogLine
        // held under an id that is an alias now: the entry it joined decides
        if (l.kind !== 'message' || l.dir !== 'out' || l.held !== 'not-ready' || !ready.has(entry(l.contactId)) || l.draftKey === null) continue
        intent('send', l.key, `send|${l.draftKey}`, { contactId: l.contactId, text: l.text, draftKey: l.draftKey, ...(l.replyTo ? { replyTo: l.replyTo } : {}) }, undefined, { auto: true })
      }
    })
  }

  const markRead = (key: string, upTo: string) => {
    void queue(async () => {
      if (stopped) return false
      // the line of the item, so the mark uses the conversation's own order (R1-4)
      // the conversation of an alias is its entry's (entries.ts): the mark is the entry's
      const own = entryKey(entries, key)
      const line = await app.get<LogLine>('log', upTo)
      if (!line || entryKey(entries, line.key) !== own) return false
      const mark = orderKey(line)
      const reads = (await app.get<ReadMarks>('kv', KV.reads)) ?? {}
      const cur = reads[own]
      if (cur && compareOrder(cur, mark) >= 0) return false
      await app.write([{ store: 'kv', key: KV.reads, value: { ...reads, [own]: mark } }])
      return true
    })
      .then((changed) => (changed ? sync() : undefined))
      .catch(() => undefined)
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────
  /** The trigger link of a connection ceremony (shared-connect 0.1): read without the network; the name
   *  is the link's `_label`, unverified. An own link is this device's code. */
  const previewLink = async (raw: string): Promise<Result<CardPreview>> => {
    // a back-code answers one of this device's own shown codes: the name its proposal states (unverified)
    const back = await backCodeOf(raw).catch((e: unknown) => ({ error: toAppError(e) }))
    if (back && 'error' in back) return { ok: false, error: back.error }
    if (back) return { ok: true, value: { role: 'back', name: typeof back.propose.payload?.reason === 'string' ? back.propose.payload.reason : null, knownContact: null, self: false } }
    const read = await sc.readSharedConnectLink(raw.trim(), Math.floor(now() / 1000)).catch(() => null)
    if (!read?.ok) return { ok: false, error: { kind: 'refused', code: read?.reason === 'expired' ? 'code-expired' : 'card-invalid' } }
    let mine: SharedConnectView | undefined
    try {
      mine = (await gate.run((h) => h.sharedConnect())).find((v) => v.id === read.link.id)
    } catch (e) {
      return { ok: false, error: toAppError(e) }
    }
    const value = { role: 'displayed' as const, name: read.link.label ?? null, knownContact: null, self: mine?.role === 'inviter' }
    // the very link this device's camera answered, its ceremony open: resumed from the stored ceremony (the
    // name, the other side, the end are its own; the core gives the same back-code and opens nothing twice).
    // A link under the same handle with other data is not that link
    if (mine?.role === 'responder' && mine.status === 'open' && mine.channel === 'scan') {
      const same = sc.sameVid(mine.link.from, read.link.from.did) && mine.link.exp === read.link.exp && (mine.link.label ?? null) === (read.link.label ?? null)
      if (!same) return { ok: false, error: { kind: 'refused', code: 'card-invalid' } }
      return { ok: true, value: { ...value, name: mine.name, answered: mine.id as ConnectionId } }
    }
    // any other link this device answered before is spent (one code, one ceremony)
    if (mine?.role === 'responder') return { ok: false, error: { kind: 'refused', code: 'code-used' } }
    return { ok: true, value }
  }

  /** A back-code (shared-connect without a carrier, lib 0.22.0) and the own open shown code it answers: the
   *  responder's card in it is made for that one code (`backCardChallenge`), so it names the enactment;
   *  null for anything else, also a back-code for no code of this device or one without a card */
  const backCodeOf = async (raw: string): Promise<{ id: string; propose: { issuer?: unknown; payload?: { reason?: unknown } } } | null> => {
    const code = raw.trim()
    if (!code.includes(sc.BACK_PATH)) return null
    const open = (await gate.run((h) => h.sharedConnect())).filter((v) => v.role === 'inviter' && v.status === 'open')
    for (const v of open) {
      const read = await sc.readBackCode(code, { did: v.did, id: v.id }).catch(() => null)
      if (read?.card) return { id: v.id, propose: read.propose }
    }
    return null
  }
  /** the inviter's camera read a back-code. The kind is the one write's own result (`sharedConnectReadBack`),
   *  never a view read before or after it: a code past its link's end is expired before anything is
   *  written; the write's `sharedconnect.pending` is `taken`, its `sharedconnect.refused` is `refused`; a
   *  write that reports neither took nothing new (the core absorbed the very proposal it holds, or the
   *  ceremony had ended): `again`, and what the ceremony stands at is its state in the next bundle */
  const readBackCode = async (raw: string): Promise<Result<BackRead>> => {
    try {
      const back = await backCodeOf(raw)
      if (!back || typeof back.propose.issuer !== 'string') return { ok: true, value: { kind: 'no-match' } }
      const connection = back.id as ConnectionId
      const before = (await gate.run((h) => h.sharedConnect())).find((x) => x.id === back.id)
      if (!before) return { ok: true, value: { kind: 'no-match' } }
      if (now() > (before.link.exp + sc.CLOCK_TOLERANCE_S) * 1000) return { ok: true, value: { kind: 'expired', connection } }
      const r = await gate.run((h) => h.sharedConnectReadBack(back.id, raw.trim(), when()))
      if (!r.ok) return { ok: false, error: mapActError(r.code) }
      schedule(r.nextDueAt)
      const no = r.events.find((e): e is Extract<HolderEvent, { type: 'sharedconnect.refused' }> => e.type === 'sharedconnect.refused')
      const taken = r.events.some((e) => e.type === 'sharedconnect.pending' && e.id === back.id)
      // published before the answer: the flow judges the ceremony's newest state
      await sync()
      if (no) return { ok: true, value: { kind: 'refused', connection, reason: no.reason } }
      return { ok: true, value: { kind: taken ? 'taken' : 'again', connection } }
    } catch (e) {
      return { ok: false, error: toAppError(e) }
    }
  }

  const previewCard = async (raw: string): Promise<Result<CardPreview>> => {
    const card = decodeCardLink(raw)
    if (!card) return previewLink(raw)
    if ((await cardOk(card)) !== null) return { ok: false, error: { kind: 'refused', code: 'card-invalid' } }
    const sent = typeof card.sentTo === 'string'
    const challenge = (card.challenge ?? null) as { value?: unknown; issuedAt?: unknown } | null
    const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
    const self = !sent && typeof challenge?.value === 'string' && Object.hasOwn(encounters.own, challenge.value)
    if (!sent && !self && typeof challenge?.issuedAt === 'string' && Date.parse(challenge.issuedAt) + CHALLENGE_MAX_AGE < now()) {
      return { ok: false, error: { kind: 'refused', code: 'code-expired' } }
    }
    return { ok: true, value: { role: sent ? 'sent' : 'displayed', name: typeof card.name === 'string' ? card.name : null, knownContact: null, self } }
  }

  /** After the backoff is spent, open replay intents are tried again whenever the network comes back
   *  (§3.4 "dann bei jedem active und jeder Netzrückkehr", R2 R1-10); same intents, same actIds. */
  /** confirm-again records already looked up in the library's journal by this opening */
  const lookedUp = new Set<string>()
  /** A confirm-again record whose act may have committed: a known result is taken over, an unknown one
   *  waits for the human's confirmation (architecture §3.4, review 421 R11-5) */
  const lookUp = async (rec: IntentRecord, spec: ActSpec) => {
    if (lookedUp.has(rec.actId) || executing.has(rec.actId)) return
    lookedUp.add(rec.actId)
    // the whole lookup holds the record: nothing else (recovery, a confirmation) touches it meanwhile
    const p = (async (): Promise<Result<unknown>> => {
      const rp = await gate.run((h) => h.replay(rec.actId, when()))
      if (!rp.ok) return { ok: false, error: { kind: 'unavailable', reason: 'later' } }
      const done = await finishOk(rec, { ...rec, state: 'running' }, spec, rp.result.events)
      // a result not yet written is looked up again at the next activation (R12-3)
      if (!done.ok) lookedUp.delete(rec.actId)
      return done
    })().finally(() => executions.delete(rec.actId))
    executions.set(rec.actId, p)
    await p
  }
  const replayOpen = async () => {
    if (stopped || !resumed) return
    await expireOpen()
    const snap = await app.readAll()
    for (const v of snap.intents.values()) {
      const r = v as IntentRecord
      const spec = ACTS[r.command as keyof typeof ACTS]
      // the contact order completes its open records in their section, whatever their age (CONTACT-ORDER.md)
      if (spec?.ordered) {
        if (isOpen(r)) void recoverOrdered(r.target)
        continue
      }
      if (!spec || expiresAt(r) < when()) continue
      if (r.policy === 'replay' && replayable(r)) settle(r, spec)
      else if (r.policy === 'confirm-again' && (r.state === 'needs-confirmation' || r.state === 'running' || r.state === 'outcome-unknown')) void lookUp(r, spec).catch(() => lookedUp.delete(r.actId))
    }
  }
  let wasOnline = deps.transport.status.get().network === 'online'
  const offStatus = deregOnly
    ? () => undefined
    : deps.transport.status.subscribe(() => {
        const online = deps.transport.status.get().network === 'online'
        if (online && !wasOnline) {
          void track(replayOpen()).catch(() => undefined)
          sharedConnect?.poke()
          // what waited for the network goes over again from the holder
          parked.clear()
          void offer()
        }
        wasOnline = online
      })
  undo.push(() => offStatus())
  const offLifecycle =
    (deregOnly ? undefined : deps.lifecycle)?.onState((st) => {
      if (st !== 'active' || stopped) return
      // coming back: the groups' members are asked again (due runs the request)
      groupsDue = true
      void track(due())
      sharedConnect?.poke()
      void track(replayOpen()).catch(() => undefined)
    }) ?? (() => undefined)
  undo.push(() => offLifecycle())

  // ── first bundle, recovery, catch-up ────────────────────────────────────────────────────────
  undo.push(() => (timer as { cancel(): void } | null)?.cancel())
  await syncStrict()
  if (!deregOnly) {
    // the deadlines first (tick; resume gives up what expired while closed), then the hand-over from
    // the holder's custody: nothing goes out before a resume of this opening completed (RLTP-DEL-6130);
    // the holder's time raises the app's high mark before any replay is weighed against a limit (R9-1)
    // an invalid journal goes before anything recovers from it
    await dropInvalidJournal()
    await due()
    await recover()
    await sync()
    // a card displayed before a restart and still valid gets its instance again
    await announceDisplayed()
  }

  /** The end of the opening up to the holder's close (TRANSPORT.md rule 4): new work is blocked, the
   *  running hand-overs end within a deadline, reception closes. */
  let ending: Promise<void> | null = null
  const end = () =>
    (ending ??= (async () => {
      stopped = true
      gate.close()
      sharedConnect?.stop()
      // the generation ends at once: an answer computed from now on is `later` (rule 3)
      deps.transport.deactivate()
      offStatus()
      offLifecycle()
      offFront()
      retryTimer?.()
      timer?.cancel()
      timer = null
      // every timer of the opening, also the planned recoveries per contact (#428)
      cancelTimers()
      planned.clear()
      unsubscribe()
      // S2 within a deadline on the device clock (#430); the timer is cancelled when the calls ended first
      let cancelDrain: () => void = () => undefined
      await gate.drain(DRAIN_LIMIT_MS, (ms) => new Promise<void>((r) => (cancelDrain = clock.setTimer(clock.now() + ms, r))))
      cancelDrain()
      await deps.transport.stop()
    })())

  const session: Session = {
    ns,
    generation: deps.generation,
    models: () => models,
    intent,
    confirmIntent,
    retryIntent,
    discardIntent,
    previewCard,
    entryOf: (contactId: string) => entries(contactId),
    readBackCode,
    answerLogin: (raw, opts) => answerLogin(keys as LoginKeys, raw, { ...opts, now: when() }),
    markRead,
    async inboxSize() {
      return (await gate.run((h) => h.inbox())).length
    },
    async sentCard(contactId) {
      const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
      // kept under the entry (ingest moves a joined contact's card there): any of its ids reads it
      return encounters.sent[entries(contactId)]?.qr ?? null
    },
    async setProfile(input, actId) {
      const r = await gate.run((h) => h.setProfile(input.image === undefined ? { name: input.name } : { name: input.name, image: input.image }, { when: when(), actId }))
      if (r.ok) schedule(r.nextDueAt)
      await sync()
    },
    async idle() {
      for (let i = 0; i < 3; i++) await queue(async () => undefined)
      await Promise.all([...sections.values()])
      await offering
      // and the holder calls running now get a moment to finish (a receive, a report, a due time); a call
      // held on purpose (tests) never blocks for long: callers that wait for rest loop (pair.settle).
      // The moment is counted in macrotask turns, never in wall time, so a seeded run replays alike on
      // a fast machine and under load (#429)
      await gate.drain(30, async (turns) => {
        for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0))
      })
    },
    transportBusy: () => (deps.transport.kind === 'custody' ? deps.transport.busy() : 0) + (sharedConnect?.busy() ?? 0),
    timerBusy: () => background,
    offer() {
      if (deregOnly) return
      parked.clear()
      void offer()
      // the wires of the open shared-connect enactments, from the holder's view
      sharedConnect?.resume()
    },
    queued,
    carriage: deps.transport.kind === 'custody' ? deps.transport.carriage : writableStore<Carriage>({ contacts: {}, open: 0, lastReceiveAt: null }),
    async quiesce() {
      await end()
      // a failed close is tried again by close()
      await closeHolder().catch(() => undefined)
    },
    seal() {
      seal.sealed = true
    },
    async close() {
      models = null
      await end()
      // the store closes, and the writer lock or the next opening may follow, only once the holder's
      // running operation finished (lib 0.6.0 close: until then it may still commit); a failed close
      // rejects, keeps the stores open and is tried again by the next close; a timeout of quiesce's
      // attempt counts for this close too (one 2 s window per shutdown), the next close opens a new one
      try {
        await closeHolder()
      } catch (e) {
        if (e instanceof HolderCloseTimeout) holderClosed = null
        throw e
      }
      store.close()
      app.close()
    },
  }
  return session
}

/** Ephemeral app events (§2.5) from library events; what stays comes through the bundle. */
function toAppEvent(e: HolderEvent): AppEvent | null {
  const base = { eventId: e.eventId, ...(e.actId ? { actId: e.actId as ActId } : {}) }
  switch (e.type) {
    case 'encounter.accepted':
      return e.mutual ? { ...base, type: 'encounter.mutual', contactId: e.contactId as ContactId, isNew: true } : null
    case 'prompt.opened':
      if (e.kind === 'shared-connect-confirm') return { ...base, type: 'decision.opened', decision: e.promptId as never, kind: 'connect-confirm' }
      return e.kind === 'encounter-confirm' ? { ...base, type: 'decision.opened', decision: e.promptId as never, kind: 'encounter-confirm' } : null
    case 'trust.received':
      return { ...base, type: 'trust.received', contactId: e.contactId as ContactId }
    case 'message.received':
      return { ...base, type: 'message.received', key: `c:${e.contactId}`, messageId: `msg:in:${e.inboxId}` as MessageId }
    default:
      return null
  }
}
