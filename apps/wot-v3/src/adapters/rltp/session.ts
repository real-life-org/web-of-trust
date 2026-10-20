// One opening of a holder (architecture §3.1, §2.1 rules 7 and 9): holder store and app-db of a
// namespace, the write gate of its generation, the serial sync (ingest + fence + publish), timers,
// transport, and the command service with the intent journal (§3.4). The host (host.ts) creates one
// per HolderHost.open and drives its shutdown phases.

import { cardOk, CHALLENGE_MAX_AGE, createHolder, CryptoUnavailableError, InfraError } from '@real-life/trust-protocol'
import type { ActResult, ContactView, DeliveryItemView, DeliveryReport, Holder, HolderEvent, Outbound, ProfileView, PromptView, RetryPolicy } from '@real-life/trust-protocol'
import type { ActId, AppError, AppEvent, CardPreview, ContactId, DecisionResolution, EncounterOutcome, IntentHandle, MessageId, Result } from '../../port'
import { revision } from '../../port'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import { ACTS, ownMessageLine, type ActSpec } from './acts'
import { compareOrder, EMPTY_ENCOUNTERS, EMPTY_LEDGER, KV, orderKey, type EncounterCache, type Ledger, type LogLine, type MessageLine, type ReadMarks } from './app-data'
import { idbAppDb, type AppDb, type AppWrite } from './app-db'
import { decodeCardLink } from './card-link'
import { mapActError } from './errors'
import { createGate, GateClosedError, type Gate } from './gate'
import { applyEncounterEvents, ingest, statusFinal } from './ingest'
import { DONE_RETENTION_MS, isOpen, RETRY_HORIZON_MS, type IntentRecord } from './journal'
import { project, type ReadModels } from './projection'
import { createSealer } from './sealed'
import { keysFromRootIkm } from './keys'
import { idbHolderStore, type HolderStore } from './store-idb'
import type { Transport } from './transport'

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
  readonly transport: Transport
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
  /** after-journal: the process dies after an intent is journaled as running, before its act;
   *  before-take: after inbox messages are written to the history, before takeMessages */
  killAt: 'after-journal' | 'before-take' | null
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
  /** read boundary of a conversation: the item `upTo` and everything before it count as read */
  markRead(key: string, upTo: string): void
  /** entries in the library's inbox not yet taken over (tests) */
  inboxSize(): Promise<number>
  /** the sent card of the scanner toward this contact, as QR text, until mutual */
  sentCard(contactId: string): Promise<string | null>
  setProfile(input: { name: string; image?: string }, actId: string): Promise<void>
  /** resolves when nothing is queued (tests, harness) */
  idle(): Promise<void>
  quiesce(): Promise<void>
  seal(): void
  close(): void
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

/** kv keys of documents kept until the carrier took them */
const OUT_PREFIX = 'out:'

export async function openSession(deps: SessionDeps): Promise<Session> {
  const sealer = await createSealer(deps.dek, deps.subtle ? { subtle: deps.subtle } : {})
  const seal = { sealed: false }
  const store: HolderStore = idbHolderStore({ idb: deps.idb, name: holderDbName(deps.ns), sealer, uuid: () => deps.entropy.uuid(), seal })
  const app: AppDb = idbAppDb({ idb: deps.idb, name: appDbName(deps.ns), sealer, seal })
  // from the first store on, a failed opening leaves nothing open (review 420 R1-3, R2 R1-3): every
  // later step registers its own undo, run in reverse when the opening fails
  const undo: (() => void)[] = [
    () => {
      seal.sealed = true
      store.close()
      app.close()
    },
  ]
  try {
    return await build(deps, { store, app, seal }, undo)
  } catch (e) {
    for (const u of undo.reverse()) {
      try {
        u()
      } catch {
        // keep undoing
      }
    }
    throw e
  }
}

async function build(deps: SessionDeps, r: { store: HolderStore; app: AppDb; seal: { sealed: boolean } }, undo: (() => void)[]): Promise<Session> {
  const { ns, clock, entropy } = deps
  const { store, app, seal } = r
  const holder: Holder = await createHolder({ store, keys: keysFromRootIkm(deps.rootIkm), ...(deps.retry ? { retry: deps.retry } : {}) })
  const gate: Gate<Holder> = createGate(holder, deps.generation)
  undo.push(() => gate.close())

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
    const reads = (snap.kv.get(KV.reads) as ReadMarks | undefined) ?? {}
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
      reads,
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
      const [contacts, prompts, inbox, statusViews] = await gate.run((h) =>
        Promise.all([h.contacts(), h.prompts(), h.inbox(), Promise.all(pendingOut.map((l) => h.deliveryStatus(l.digest ?? '')))]),
      )
      const profile = await gate.run((h) => h.profile())
      if (profile.commitSeq !== a) continue
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
      lastViews = { commitSeq: a, contacts, prompts, profile }
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
  // handing documents to the transport never fails an act the library committed: a transport that
  // throws is a carrier problem, the core re-emits on resume (review 420 R3-2)
  const handToTransport = (out: readonly Outbound[]) => {
    if (stopped || out.length === 0) return
    try {
      deps.transport.submit(out)
    } catch {
      retrySoon()
    }
  }
  // Every document is kept sealed in the app db until the carrier took it: the library does not
  // re-emit what it was told is awaiting the transport, so the next opening of this namespace submits
  // the kept ones again; the wipe of the namespace removes them (review 420 R6-1, R7-1)
  const submit = (out: readonly Outbound[]) => {
    if (stopped || out.length === 0) return
    void app
      .write(out.map((o) => ({ store: 'kv' as const, key: `${OUT_PREFIX}${o.digest}`, value: o })))
      .catch(() => undefined)
      .finally(() => handToTransport(out))
  }
  const due = async () => {
    timer = null
    try {
      const t = await gate.run((h) => h.tick(when()))
      if (t.ok) {
        submit(t.outbound)
        schedule(t.nextDueAt)
      }
      const r = await gate.run((h) => h.resume(when()))
      submit(r.outbound)
      schedule(r.nextDueAt)
    } catch {
      // gate closed or storage failure: the next commit, unlock or timer tries again
    }
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
  })

  undo.push(() => unsubscribe())
  undo.push(() => deps.transport.stop())
  if (!deregOnly) deps.transport.start({
    envelope: async (env) => {
      try {
        const r = await gate.run((h) => h.receive(env, when()))
        if (r.disposition === 'failed' && r.key === 'unknown') return 'not-mine'
        // transient (Delivery 5820, 6270, 6280; Message Tasks 4120, 4140): nothing committed, the
        // carrier keeps the document and delivers it again later (review 421 R2-4)
        if (r.disposition === 'failed' && (r.reason === 'rate-limited' || r.reason === 'gate-future' || r.reason === 'consumed-challenge')) return 'later'
        if (r.disposition === 'unique' || r.disposition === 'duplicate-known') submit(r.outbound)
        if (r.disposition === 'unique') schedule(r.nextDueAt)
        return 'taken'
      } catch {
        // storage failure or a closed gate: nothing proves the document is not ours, the carrier keeps
        // it for a later pickup (review 421 R3-4); 'not-mine' only from the library's own answer
        return 'later'
      }
    },
    report: (r: DeliveryReport) => {
      void gate
        .run((h) => h.report(r, when()))
        .then((x) => {
          // the carrier took it or ended it: no later opening submits it again
          if (r.status !== 'awaiting-transport') void app.write([{ store: 'kv', key: `${OUT_PREFIX}${r.digest}`, value: null }]).catch(() => undefined)
          if (x.ok) {
            submit(x.outbound)
            schedule(x.nextDueAt)
          }
        })
        .catch(() => undefined)
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
  /** open with an unknown outcome; a record still 'journaled' whose running write failed counts too
   *  (nothing in flight holds it: callers check inflight first, review 421 R3-5) */
  const replayable = (r: IntentRecord) => r.state === 'outcome-unknown' || r.state === 'journaled'
  const scheduleReplay = (rec: IntentRecord) => {
    const wait = BACKOFF[rec.attempts - 1]
    if (wait === undefined || stopped || rec.createdAt + horizonMs < when()) return
    clock.setTimer(now() + wait, () => {
      if (stopped) return
      void findIntent(rec.actId).then((cur) => {
        const spec = cur ? ACTS[cur.command as keyof typeof ACTS] : undefined
        if (!cur || !spec || !replayable(cur) || cur.createdAt + horizonMs < when()) return
        const key = cur.dedupe ?? `retry|${cur.actId}`
        if (inflight.has(key)) return
        inflight.set(key, { actId: cur.actId, done: execute(cur, spec).finally(() => inflight.delete(key)) })
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
      const error = toAppError(e)
      // the record is journaled already: its inputs belong to the command service now, the outcome is
      // open (never "not taken": a caller would hand the text back and send another, review 421 R2-1);
      // recovery takes it like any unknown outcome, same actId (review 421 R3-5)
      if (error.kind !== 'locked') await unknownOutcome(running)
      return { ok: false, error: error.kind === 'locked' ? error : { kind: 'infra', code: 'unknown-outcome', retryable: true } }
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
      const code = r.code
      try {
        await queue(() => {
          const lines = spec.lines?.({ ok: false, code }, input, rec.when) ?? []
          return app.write([
            { store: 'intents', key: rec.actId, value: { ...running, state: 'done', input: null, outcome: { ok: false, error }, finishedAt: now() } },
            clockWrite(),
            ...lines.map((l) => ({ store: 'log' as const, key: l.id, value: l })),
          ])
        })
        await sync()
      } catch {
        // the refusal is the library's answer; a repeat with the same actId gets it again: recovery
        // takes the record like any unknown outcome (review 421 R4-2)
        await unknownOutcome(running)
      }
      return { ok: false, error }
    }
    for (const e of r.events) {
      if (seen.has(e.eventId)) continue
      seen.add(e.eventId)
      pending.push(e)
    }
    submit(r.outbound)
    schedule(r.nextDueAt)
    const events = r.events
    try {
      const value = (await enrich(rec, spec.outcome(events, input))) as T
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
      return { ok: true, value }
    } catch {
      // committed in the library, not finished here: a repeat with the same actId returns the result
      await unknownOutcome(running)
      return { ok: false, error: { kind: 'infra', code: 'unknown-outcome', retryable: true } }
    }
  }

  /** the inputs as the journal compares them (canonical JSON of plain values) */
  const sameInput = (a: Readonly<Record<string, unknown>> | null, b: Readonly<Record<string, unknown>>) => JSON.stringify(a) === JSON.stringify(structuredClone(b))

  const intent = <T>(
    command: keyof typeof ACTS & string,
    target: string,
    dedupe: string,
    input: Readonly<Record<string, unknown>>,
    preview?: CardPreview,
    opts: { auto?: boolean } = {},
  ): IntentHandle<T> => {
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
      dedupe,
      input: structuredClone(input),
      when: when(),
      createdAt: now(),
      attempts: 0,
      ...(preview ? { preview } : {}),
    }
    const done = (async (): Promise<Result<T>> => {
      try {
        // the same gesture while its record is still open (after a restart, or a held draft released
        // while its earlier act is being replayed): that record, its actId, never a second act
        const same = ([...(await app.readAll()).intents.values()] as IntentRecord[]).filter((r) => r.dedupe === dedupe)
        // a message whose record expired with an unknown outcome is spent: sending again is a new act
        // under a new draft key, never this one (review 421 R3-2); other gestures (a new card) are
        // new acts under their fixed key (R4-1)
        if (command === 'send' && same.some((r) => r.state === 'expired')) return { ok: false, error: { kind: 'refused', code: 'superseded' } }
        const open = same.find((r) => isOpen(r))
        if (open) {
          const openSpec = ACTS[open.command as keyof typeof ACTS]
          // the gesture with other inputs under the same key is refused, never the old inputs sent
          if (!sameInput(open.input, input)) return { ok: false, error: { kind: 'refused', code: 'superseded' } }
          // an automatic release (a held draft) never runs an open record: recovery does, within its limits
          if (opts.auto || open.policy !== 'replay' || !openSpec) return { ok: false, error: { kind: 'unavailable', reason: 'in-flight' } }
          // the human again: the manual limit holds (§3.4 "Retry-Frist", review 421 R2-2)
          if (open.createdAt + manualLimitMs < when()) return { ok: false, error: { kind: 'unavailable', reason: 'later' } }
          return execute<T>(open, openSpec)
        }
        // a draft that went out already is not sent twice (the same draft key after its intent ended)
        if (command === 'send') {
          const line = await app.get<LogLine>('log', `msg:out:${String(input.draftKey)}`)
          if (line?.kind === 'message' && line.digest !== null) return { ok: true, value: spec.outcome([], input) as T }
          // its record expired and left the journal, the line still says "outcome unknown" (R3-2)
          if (line?.kind === 'message' && line.status?.phase === 'unknown') return { ok: false, error: { kind: 'refused', code: 'superseded' } }
        }
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
      // a replay of the same record already runs: join it
      const joined = rec?.dedupe ? inflight.get(rec.dedupe) : undefined
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
    await queue(() => putIntent({ ...rec, state: 'expired', input: null, finishedAt: now() }))
    await sync().catch(() => undefined)
    return { ok: true, value: undefined }
  }

  /** After unlocking (§3.4 "Wiederanlauf"): never runs an encounter act without the human (N3). */
  /** An open intent past the manual limit is never run again. An own message keeps its text and an
   *  honest "outcome unknown" in the conversation (review 421 R2-3); its inputs leave the journal. */
  const expireWrites = (r: IntentRecord, log: ReadonlyMap<string, unknown>): AppWrite[] => {
    const writes: AppWrite[] = [{ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null, finishedAt: when() } }]
    if (r.command === 'send' && r.input) {
      const id = `msg:out:${String(r.input.draftKey)}`
      const line = log.get(id) as LogLine | undefined
      if (!(line?.kind === 'message' && line.digest !== null)) {
        writes.push({ store: 'log', key: id, value: ownMessageLine(r.input, Math.floor(r.when / 1000) * 1000, { status: { phase: 'unknown' } }) })
      }
    }
    return writes
  }

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
        writes.push(...expireWrites(r, snap.log))
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
      if (!spec) continue
      // registered under the gesture's dedupe key: the same gesture meanwhile joins this replay
      const key = r.dedupe ?? `retry|${r.actId}`
      const h = { actId: r.actId, done: execute(r, spec).finally(() => inflight.delete(key)) }
      inflight.set(key, h)
    }
  }

  /** Messages the app held unsent because the relationship was not ready (Message Tasks 5.1) go
   *  out once the contact view says canMessage; the same draft key, a new act. */
  const sendHeld = (contacts: readonly ContactView[]) => {
    if (stopped) return
    const ready = new Set(contacts.filter((c) => c.canMessage && !c.blocked).map((c) => c.id))
    void app.readAll().then((snap) => {
      for (const v of snap.log.values()) {
        const l = v as LogLine
        if (l.kind !== 'message' || l.dir !== 'out' || l.held !== 'not-ready' || !ready.has(l.contactId) || l.draftKey === null) continue
        intent('send', l.key, `send|${l.draftKey}`, { contactId: l.contactId, text: l.text, draftKey: l.draftKey, ...(l.replyTo ? { replyTo: l.replyTo } : {}) }, undefined, { auto: true })
      }
    })
  }

  const markRead = (key: string, upTo: string) => {
    void queue(async () => {
      if (stopped) return false
      // the line of the item, so the mark uses the conversation's own order (R1-4)
      const line = await app.get<LogLine>('log', upTo)
      if (!line || line.key !== key) return false
      const mark = orderKey(line)
      const reads = (await app.get<ReadMarks>('kv', KV.reads)) ?? {}
      const cur = reads[key]
      if (cur && compareOrder(cur, mark) >= 0) return false
      await app.write([{ store: 'kv', key: KV.reads, value: { ...reads, [key]: mark } }])
      return true
    })
      .then((changed) => (changed ? sync() : undefined))
      .catch(() => undefined)
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
      if (!spec || r.policy !== 'replay' || !replayable(r) || r.createdAt + horizonMs < when()) continue
      const key = r.dedupe ?? `retry|${r.actId}`
      if (inflight.has(key)) continue
      const h = { actId: r.actId, done: execute(r, spec).finally(() => inflight.delete(key)) }
      inflight.set(key, h)
    }
  }
  let wasOnline = deps.transport.status.get().network !== 'offline'
  const offStatus = deregOnly
    ? () => undefined
    : deps.transport.status.subscribe(() => {
        const online = deps.transport.status.get().network !== 'offline'
        if (online && !wasOnline) void replayOpen().catch(() => undefined)
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
    // what an earlier opening of this namespace submitted and the carrier never took (R7-1)
    const kept = [...(await app.readAll()).kv].filter(([k]) => k.startsWith(OUT_PREFIX)).map(([, v]) => v as Outbound)
    handToTransport(kept)
    void due()
  }

  const session: Session = {
    ns,
    generation: deps.generation,
    models: () => models,
    intent,
    confirmIntent,
    retryIntent,
    discardIntent,
    previewCard,
    markRead,
    async inboxSize() {
      return (await gate.run((h) => h.inbox())).length
    },
    async sentCard(contactId) {
      const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
      return encounters.sent[contactId]?.qr ?? null
    },
    async setProfile(input, actId) {
      const r = await gate.run((h) => h.setProfile(input.image === undefined ? { name: input.name } : { name: input.name, image: input.image }, { when: when(), actId }))
      if (r.ok) {
        submit(r.outbound)
        schedule(r.nextDueAt)
      }
      await sync()
    },
    async idle() {
      for (let i = 0; i < 3; i++) await queue(async () => undefined)
    },
    async quiesce() {
      gate.close()
      offStatus()
      offLifecycle()
      stopped = true
      timer?.cancel()
      timer = null
      deps.transport.stop()
      unsubscribe()
      await gate.drain(2000, (ms) => new Promise((r) => setTimeout(r, ms)))
    },
    seal() {
      seal.sealed = true
    },
    close() {
      stopped = true
      offStatus()
      offLifecycle()
      retryTimer?.()
      gate.close()
      timer?.cancel()
      deps.transport.stop()
      unsubscribe()
      store.close()
      app.close()
      models = null
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
    case 'message.received':
      return { ...base, type: 'message.received', key: `c:${e.contactId}`, messageId: `msg:in:${e.inboxId}` as MessageId }
    default:
      return null
  }
}
