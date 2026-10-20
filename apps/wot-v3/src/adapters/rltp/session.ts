// One opening of a holder (architecture §3.1, §2.1 rules 7 and 9): holder store and app-db of a
// namespace, the write gate of its generation, the serial sync (ingest + fence + publish), timers,
// transport, and the command service with the intent journal (§3.4). The host (host.ts) creates one
// per HolderHost.open and drives its shutdown phases.

import { cardOk, CHALLENGE_MAX_AGE, createHolder, CryptoUnavailableError, InfraError } from '@real-life/trust-protocol'
import type { ActResult, ContactView, DeliveryReport, Holder, HolderEvent, ProfileView, PromptView, RetryPolicy } from '@real-life/trust-protocol'
import type { ActId, AppError, AppEvent, CardPreview, ContactId, DecisionResolution, EncounterOutcome, IntentHandle, Result } from '../../port'
import { revision } from '../../port'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import { ACTS, type ActSpec } from './acts'
import { EMPTY_ENCOUNTERS, EMPTY_LEDGER, KV, type EncounterCache, type Ledger, type LogLine } from './app-data'
import { idbAppDb, type AppDb, type AppWrite } from './app-db'
import { decodeCardLink } from './card-link'
import { mapActError } from './errors'
import { createGate, GateClosedError, type Gate } from './gate'
import { applyEncounterEvents, ingest } from './ingest'
import { DONE_RETENTION_MS, isOpen, RETRY_HORIZON_MS, type IntentRecord } from './journal'
import { project, type ReadModels } from './projection'
import { createSealer } from './sealed'
import { keysFromRootIkm } from './keys'
import { idbHolderStore, type HolderStore } from './store-idb'
import type { Lease } from './transport'

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
  readonly transport: Lease
  readonly anchorShort: string
  readonly retry?: Partial<RetryPolicy>
  readonly subtle?: SubtleCrypto
  /** fault switches of tests and the harness (architecture §3.2 FaultSwitches.killAt) */
  readonly faults?: RltpFaults
  /** the app comes back to the foreground: due work and open replays run again (§3.4) */
  readonly lifecycle?: { onState(cb: (s: 'active' | 'background') => void): () => void }
  /** 'dereg-only': opened by a delete only to deregister (§2.1 rule 9 S3, architecture §4.2): no
   *  transport, no timers, no intent recovery, nothing submitted (review 420 R5-2) */
  readonly mode?: 'normal' | 'dereg-only'
  publish(models: ReadModels): void
  emit(e: AppEvent): void
}

/** 'after-journal': the process dies after the intent is journaled as running, before the act */
export interface RltpFaults {
  killAt: 'after-journal' | null
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
  /** the sent card of the scanner toward this contact, as QR text, until mutual */
  sentCard(contactId: string): Promise<string | null>
  setProfile(input: { name: string; image?: string }, actId: string): Promise<void>
  /** resolves when nothing is queued (tests, harness) */
  idle(): Promise<void>
  /** the opening became the one in use: hand over what the holder keeps for transport */
  offer(): void
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
  let holderClosed: Promise<void> | null = null
  /** holder.close() once; a rejected attempt is forgotten, so the next close tries again */
  const closeHolder = (): Promise<void> => {
    holderClosed ??= holder.close().catch((e: unknown) => {
      holderClosed = null
      throw e
    })
    return holderClosed
  }
  undo.push(async () => {
    gate.close()
    try {
      await closeHolder()
    } catch (e) {
      r.unclosed = closeHolder
      throw e
    }
  })

  const deregOnly = deps.mode === 'dereg-only'
  let stopped = deregOnly
  let models: ReadModels | null = null
  let appSeq = 0
  let lastViews: { commitSeq: string; contacts: ContactView[]; prompts: PromptView[]; profile: ProfileView } | null = null
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
  // the library's retry horizon decides both limits (§3.4 "Retry-Frist"): automatic repeats until
  // createdAt + horizon, manual ones until createdAt + retention − 1 day, retention = max(P90D, horizon)
  const horizonMs = deps.retry?.horizonMs ?? RETRY_HORIZON_MS
  const manualLimitMs = Math.max(90 * 86_400_000, horizonMs) - 86_400_000

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
    appSeq++
    const next = project({
      revision: revision(deps.generation, Number(lastViews.commitSeq), appSeq),
      now: now(),
      timeZone: clock.timeZone(),
      anchorShort: deps.anchorShort,
      contacts: lastViews.contacts,
      prompts: lastViews.prompts,
      profile: lastViews.profile,
      encounters,
      lines,
      intents,
    })
    if (stopped) return
    models = next
    deps.publish(next)
  }

  /** Ingest and publish one consistent bundle (§3.1 steps 1 to 6). */
  const syncOnce = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (stopped) return
      const a = (await gate.run((h) => h.profile())).commitSeq
      const [contacts, prompts] = await gate.run((h) => Promise.all([h.contacts(), h.prompts()]))
      const profile = await gate.run((h) => h.profile())
      if (profile.commitSeq !== a) continue
      const take = pending.filter((e) => !bigger(e.commitSeq, a))
      const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
      const ledger = (await app.get<Ledger>('kv', KV.ledger)) ?? EMPTY_LEDGER
      const out = ingest({ commitSeq: a, now: now(), events: take, contacts, prompts, encounters, ledger })
      const writes: AppWrite[] = [
        { store: 'kv', key: KV.encounters, value: out.encounters },
        { store: 'kv', key: KV.ledger, value: out.ledger },
        { store: 'kv', key: KV.applied, value: { commitSeq: a } },
        clockWrite(),
        ...out.lines.map((l) => ({ store: 'log' as const, key: l.id, value: l })),
      ]
      await app.write(writes)
      // events count as taken over only once their derivation is durable (review 420 R1-1)
      pending = pending.filter((e) => !take.includes(e))
      lastViews = { commitSeq: a, contacts, prompts, profile }
      await publishFromDb()
      return
    }
    // five attempts without a stable fence: the last consistent bundle stays; a timer retries
    retrySoon()
  }
  /** a sync whose failure is the caller's (opening) */
  const syncStrict = () => queue(syncOnce)
  /** Every publication goes through the collector (fence, take-over, app read): app data never
   *  shows beside views of another state (review 420 R2-1). A failed sync keeps the last consistent
   *  bundle and tries again after a second. */
  const sync = () =>
    queue(syncOnce).catch((e: unknown) => {
      retrySoon()
      throw e
    })
  let retryTimer: (() => void) | null = null
  const retrySoon = () => {
    if (stopped || retryTimer) return
    retryTimer = clock.setTimer(now() + 1000, () => {
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
      timer = { at, cancel: clock.setTimer(at, () => void due()) }
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
  /** handed over by this opening and still named by the holder: the digest, a duplicate's answer by its number */
  const filed = new Set<string>()
  /** reported awaiting-transport: the carrier keeps no copy; handed over again when the network comes
   *  back, at the holder's next due time or at activation, never in the same pass (no report loop) */
  const parked = new Set<string>()
  const keyOf = (e: { readonly digest: string; readonly resend?: number }) => (e.resend === undefined ? e.digest : `${e.digest}#${e.resend}`)
  /** set at a due time: what was handed over and not answered goes over again (a lost or late report
   *  is `later`, TRANSPORT.md rule 1; the carrier takes a digest once) */
  let resend = false
  const offerOnce = async (): Promise<void> => {
    const again = resend
    resend = false
    const view = await gate.run((h) => h.pendingTransport(when()))
    if (!view.ok || stopped) return
    const named = new Set(view.entries.map(keyOf))
    const digests = new Set(view.entries.map((e) => e.digest))
    // a document the holder no longer names is not to be sent (RLTP-DEL-6135): its copy leaves the
    // device unless the carrier took it already; a duplicate's answer whose hand-over began is ended
    const gone = new Set<string>()
    for (const k of filed) {
      if (named.has(k)) continue
      filed.delete(k)
      const d = k.split('#')[0]!
      if (!digests.has(d)) gone.add(d)
    }
    for (const d of parked) if (!digests.has(d)) parked.delete(d)
    if (gone.size > 0) deps.transport.withdraw([...gone])
    for (const entry of view.entries) {
      const k = keyOf(entry)
      if ((filed.has(k) && !again) || parked.has(entry.digest) || stopped) continue
      // runs inside the holder's queue, right after its check: no lock, no other step in between
      const start = () => {
        if (stopped || !deps.transport.ready()) return false
        // a duplicate's answer ends with its begun hand-over: it starts only when the carrier can take it
        if (entry.resend !== undefined && deps.transport.status.get().network !== 'online') return false
        // the deadline at the start itself, not at the call: time passes while the holder reads (6135)
        if (when() >= entry.notAfter) return false
        // filed before the deposit: a report the transport gives synchronously finds it (review 420 R12-4)
        filed.add(k)
        if (deps.transport.submit([entry])) return true
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
  const due = async () => {
    timer = null
    try {
      const t = await gate.run((h) => h.tick(when()))
      if (t.ok) schedule(t.nextDueAt)
      const r = await gate.run((h) => h.resume(when()))
      schedule(r.nextDueAt)
    } catch {
      // gate closed or storage failure: nothing is handed over until a resume of this opening
      // completes (the holder refuses pendingTransport meanwhile); the next timer tries again
      schedule(now() + 1000)
      return
    }
    parked.clear()
    resend = true
    await offer()
  }

  undo.push(() => {
    stopped = true
  })
  const unsubscribe = holder.subscribe(({ events }) => {
    if (stopped) return
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
  if (!deregOnly) deps.transport.start({
    // the holder's own answer only: a failure (storage, a closed gate) is `later` in the lease (TRANSPORT.md)
    envelope: async (env) => {
      const r = await gate.run((h) => h.receive(env, when()))
      if (r.disposition === 'failed' && r.key === 'unknown') return 'not-mine'
      // transient by the library's own answer: nothing committed, the carrier offers it again (RLTP-DEL-5820)
      if (r.disposition === 'failed' && r.reason === 'rate-limited') return 'later'
      if (r.disposition === 'unique') schedule(r.nextDueAt)
      return 'taken'
    },
    report: (r: DeliveryReport) => {
      // the carrier keeps no copy of what waits: the holder does, and it goes over again later
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
  })

  // ── command service (§3.4) ──────────────────────────────────────────────────────────────────
  const inflight = new Map<string, IntentHandle<unknown>>()

  const putIntent = (r: IntentRecord) => app.write([{ store: 'intents', key: r.actId, value: r }, clockWrite()])

  /** An intent whose outcome is unknown (§3.4 step 4): an encounter act waits for the human again
   *  (N3), a lost showCard is dropped, a replay act is repeated with backoff within the horizon. */
  const unknownOutcome = async (rec: IntentRecord): Promise<void> => {
    const state = rec.policy === 'confirm-again' ? 'needs-confirmation' : rec.policy === 'discard' ? 'expired' : 'outcome-unknown'
    await putIntent({ ...rec, state, ...(state === 'expired' ? { input: null } : {}) }).catch(() => undefined)
    void sync().catch(() => undefined)
    if (state === 'outcome-unknown') scheduleReplay({ ...rec, state })
  }

  const BACKOFF = [2000, 10_000, 60_000]
  const scheduleReplay = (rec: IntentRecord) => {
    const wait = BACKOFF[rec.attempts - 1]
    if (wait === undefined || stopped || rec.createdAt + horizonMs < when()) return
    clock.setTimer(now() + wait, () => {
      if (stopped) return
      void findIntent(rec.actId).then((cur) => {
        const spec = cur ? ACTS[cur.command as keyof typeof ACTS] : undefined
        if (cur && spec && cur.state === 'outcome-unknown' && cur.createdAt + horizonMs >= when()) void execute(cur, spec)
      })
    })
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
    const writes: AppWrite[] = [{ store: 'kv', key: KV.encounters, value: { own, sent, met, capturedBy } }]
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

  /** A repeated optical capture reports no contact (N9); the cache of own captures maps the card back. */
  const enrich = async (rec: IntentRecord, value: unknown): Promise<unknown> => {
    const o = value as EncounterOutcome | null
    if (rec.command !== 'confirmCard' || o?.kind !== 'already-captured' || o.contactId !== null) return value
    const anchor = (rec.input?.card as { anchor?: unknown } | undefined)?.anchor
    const cache = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
    const contactId = typeof anchor === 'string' ? cache.capturedBy?.[anchor] : undefined
    return contactId ? { kind: 'already-captured', contactId } : value
  }

  /** Runs the act of a journaled record (state running); finishes the record by its outcome. */
  const execute = async <T>(rec: IntentRecord, spec: ActSpec): Promise<Result<T>> => {
    const input = rec.input ?? {}
    const running: IntentRecord = { ...rec, state: 'running', attempts: rec.attempts + 1 }
    try {
      await putIntent(running)
    } catch (e) {
      return { ok: false, error: toAppError(e) }
    }
    void sync().catch(() => undefined)
    if (deps.faults?.killAt === 'after-journal') {
      // the process dies here: nothing after this point runs, the record stays `running`
      deps.faults.killAt = null
      return { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
    let r: ActResult
    try {
      r = await gate.run((h) => spec.run(h, input, { when: rec.when, actId: rec.actId }))
    } catch (e) {
      const error = toAppError(e)
      if (error.kind !== 'locked') await unknownOutcome(running)
      return { ok: false, error: error.kind === 'locked' ? error : { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
    if (!r.ok) {
      const error = mapActError(r.code)
      try {
        await queue(() => app.write([{ store: 'intents', key: rec.actId, value: { ...running, state: 'done', input: null, outcome: { ok: false, error }, finishedAt: now() } }, clockWrite()]))
        await sync()
      } catch {
        // the refusal is the library's answer; a repeat with the same actId gets it again
      }
      return { ok: false, error }
    }
    for (const e of r.events) {
      if (seen.has(e.eventId)) continue
      seen.add(e.eventId)
      pending.push(e)
    }
    schedule(r.nextDueAt)
    const events = r.events
    try {
      const value = (await enrich(rec, spec.outcome(events, input))) as T
      // the act's own projections and `done` in one transaction (§3.4 step 4, N4, review 420 R1-1)
      await queue(async () => {
        const writes = await finishWrites(rec, value, events)
        await app.write([...writes, { store: 'intents', key: rec.actId, value: { ...running, state: 'done', input: null, outcome: { ok: true, value }, finishedAt: now() } }, clockWrite()])
      })
      await sync().catch(() => undefined)
      return { ok: true, value }
    } catch {
      // committed in the library, not finished here: a repeat with the same actId returns the result
      await unknownOutcome(running)
      return { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
  }

  const intent = <T>(command: keyof typeof ACTS & string, target: string, dedupe: string, input: Readonly<Record<string, unknown>>, preview?: CardPreview): IntentHandle<T> => {
    const running = inflight.get(dedupe)
    if (running) return running as IntentHandle<T>
    const spec = ACTS[command as keyof typeof ACTS]
    const actId = entropy.uuid() as ActId
    if (!spec || stopped || !gate.isOpen()) {
      return { actId, done: Promise.resolve({ ok: false, error: stopped || !gate.isOpen() ? { kind: 'locked' } : { kind: 'unavailable', reason: 'not-supported' } }) }
    }
    const rec: IntentRecord = {
      actId,
      command: command as IntentRecord['command'],
      target,
      policy: spec.policy,
      state: 'journaled',
      input: structuredClone(input),
      when: when(),
      createdAt: now(),
      attempts: 0,
      ...(preview ? { preview } : {}),
    }
    const done = (async (): Promise<Result<T>> => {
      try {
        // journal before the first effect (§3.4 step 2)
        await putIntent(rec)
      } catch (e) {
        return { ok: false, error: toAppError(e) }
      }
      return execute<T>(rec, spec)
    })().finally(() => inflight.delete(dedupe))
    const handle: IntentHandle<T> = { actId, done }
    inflight.set(dedupe, handle as IntentHandle<unknown>)
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
        await putIntent({ ...rec, state: 'expired', input: null })
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
      if (!rec || !spec || rec.policy !== 'replay' || (rec.state !== 'outcome-unknown' && rec.state !== 'partial')) return { ok: false, error: { kind: 'refused', code: 'superseded' } }
      if (rec.createdAt + manualLimitMs < when()) {
        await putIntent({ ...rec, state: 'expired', input: null })
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
    await queue(() => putIntent({ ...rec, state: 'expired', input: null, finishedAt: now() }))
    await sync().catch(() => undefined)
    return { ok: true, value: undefined }
  }

  /** After unlocking (§3.4 "Wiederanlauf"): never runs an encounter act without the human (N3). */
  const recover = async () => {
    const snap = await app.readAll()
    const writes: AppWrite[] = []
    const replays: IntentRecord[] = []
    for (const v of snap.intents.values()) {
      const r = v as IntentRecord
      const t = when()
      if (!isOpen(r)) {
        if ((r.finishedAt ?? r.createdAt) + DONE_RETENTION_MS < t) writes.push({ store: 'intents', key: r.actId, value: null })
        continue
      }
      if (r.createdAt + manualLimitMs < t) {
        writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null } })
        continue
      }
      if (r.policy === 'discard') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null, finishedAt: t } })
      else if (r.policy === 'confirm-again') {
        if (r.state !== 'needs-confirmation') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'needs-confirmation' } })
      } else if (r.createdAt + horizonMs >= t) replays.push(r)
      // past the automatic horizon a replay waits for the human (retryIntent) until the manual limit
      else if (r.state !== 'outcome-unknown') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'outcome-unknown' } })
    }
    if (writes.length) await app.write(writes)
    for (const r of replays) {
      const spec = ACTS[r.command as keyof typeof ACTS]
      if (spec) void execute(r, spec)
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────
  const previewCard = async (raw: string): Promise<Result<CardPreview>> => {
    const card = decodeCardLink(raw)
    if (!card) return { ok: false, error: { kind: 'refused', code: 'card-invalid' } }
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
  const replayOpen = async () => {
    if (stopped) return
    const snap = await app.readAll()
    for (const v of snap.intents.values()) {
      const r = v as IntentRecord
      const spec = ACTS[r.command as keyof typeof ACTS]
      if (!spec || r.policy !== 'replay' || r.state !== 'outcome-unknown' || r.createdAt + horizonMs < when()) continue
      const key = `retry|${r.actId}`
      if (inflight.has(key)) continue
      const h = { actId: r.actId, done: execute(r, spec).finally(() => inflight.delete(key)) }
      inflight.set(key, h)
    }
  }
  let wasOnline = deps.transport.status.get().network === 'online'
  const offStatus = deregOnly
    ? () => undefined
    : deps.transport.status.subscribe(() => {
        const online = deps.transport.status.get().network === 'online'
        if (online && !wasOnline) {
          void replayOpen().catch(() => undefined)
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
      void due()
      void replayOpen().catch(() => undefined)
    }) ?? (() => undefined)
  undo.push(() => offLifecycle())

  // ── first bundle, recovery, catch-up ────────────────────────────────────────────────────────
  undo.push(() => (timer as { cancel(): void } | null)?.cancel())
  await syncStrict()
  if (!deregOnly) {
    await recover()
    await sync()
    // the deadlines first (tick; resume gives up what expired while closed), then the hand-over from
    // the holder's custody: nothing goes out before a resume of this opening completed (RLTP-DEL-6130)
    await due()
  }

  /** The end of the opening up to the holder's close (TRANSPORT.md rule 4): new work is blocked, the
   *  running hand-overs end within a deadline, reception closes. */
  let ending: Promise<void> | null = null
  const end = () =>
    (ending ??= (async () => {
      stopped = true
      gate.close()
      // the generation ends at once: an answer computed from now on is `later` (rule 3)
      deps.transport.deactivate()
      offStatus()
      offLifecycle()
      retryTimer?.()
      timer?.cancel()
      timer = null
      unsubscribe()
      await gate.drain(2000, (ms) => new Promise((r) => setTimeout(r, ms)))
      deps.transport.stop()
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
    async sentCard(contactId) {
      const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
      return encounters.sent[contactId]?.qr ?? null
    },
    async setProfile(input, actId) {
      const r = await gate.run((h) => h.setProfile(input.image === undefined ? { name: input.name } : { name: input.name, image: input.image }, { when: when(), actId }))
      if (r.ok) schedule(r.nextDueAt)
      await sync()
    },
    async idle() {
      for (let i = 0; i < 3; i++) await queue(async () => undefined)
      await offering
      // and no holder call runs (a receive, a report, a due time)
      await gate.drain(5000, (ms) => new Promise((r) => setTimeout(r, ms)))
    },
    offer() {
      if (deregOnly) return
      parked.clear()
      void offer()
    },
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
      // rejects, keeps the stores open and is tried again by the next close
      await closeHolder()
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
      return e.kind === 'encounter-confirm' ? { ...base, type: 'decision.opened', decision: e.promptId as never, kind: 'encounter-confirm' } : null
    case 'trust.received':
      return { ...base, type: 'trust.received', contactId: e.contactId as ContactId }
    default:
      return null
  }
}
