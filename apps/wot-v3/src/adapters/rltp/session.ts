// One opening of a holder (architecture §3.1, §2.1 rules 7 and 9): holder store and app-db of a
// namespace, the write gate of its generation, the serial sync (ingest + fence + publish), timers,
// transport, and the command service with the intent journal (§3.4). The host (host.ts) creates one
// per HolderHost.open and drives its shutdown phases.

import { cardOk, CHALLENGE_MAX_AGE, createHolder, CryptoUnavailableError, InfraError } from '@real-life/trust-protocol'
import type { ActResult, ContactView, DeliveryReport, Holder, HolderEvent, Outbound, ProfileView, PromptView, RetryPolicy } from '@real-life/trust-protocol'
import type { ActId, AppError, AppEvent, CardPreview, ContactId, IntentHandle, Result } from '../../port'
import { revision } from '../../port'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import { ACTS, type ActSpec } from './acts'
import { EMPTY_ENCOUNTERS, EMPTY_LEDGER, KV, type EncounterCache, type Ledger, type LogLine } from './app-data'
import { idbAppDb, type AppDb, type AppWrite } from './app-db'
import { decodeCardLink } from './card-link'
import { mapActError } from './errors'
import { createGate, GateClosedError, type Gate } from './gate'
import { ingest } from './ingest'
import { DONE_RETENTION_MS, isOpen, MANUAL_LIMIT_MS, type IntentRecord } from './journal'
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
  discardIntent(actId: ActId): Promise<Result>
  previewCard(raw: string): Promise<Result<CardPreview>>
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

export async function openSession(deps: SessionDeps): Promise<Session> {
  const { ns, clock, entropy } = deps
  const sealer = await createSealer(deps.dek, deps.subtle ? { subtle: deps.subtle } : {})
  const seal = { sealed: false }
  const store: HolderStore = idbHolderStore({ idb: deps.idb, name: holderDbName(ns), sealer, uuid: () => entropy.uuid(), seal })
  const app: AppDb = idbAppDb({ idb: deps.idb, name: appDbName(ns), sealer, seal })
  const holder: Holder = await createHolder({ store, keys: keysFromRootIkm(deps.rootIkm), ...(deps.retry ? { retry: deps.retry } : {}) })
  const gate: Gate<Holder> = createGate(holder, deps.generation)

  let stopped = false
  let models: ReadModels | null = null
  let appSeq = 0
  let lastViews: { commitSeq: string; contacts: ContactView[]; prompts: PromptView[]; profile: ProfileView } | null = null
  /** events announced but not yet taken over, and the ids already taken (dedupe of act results) */
  let pending: HolderEvent[] = []
  const seen = new Set<string>()
  let highWhen = 0
  const now = () => clock.now()
  /** effectiveNow (§3.4): never behind a time this session already used */
  const when = () => (highWhen = Math.max(highWhen, now()))

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
      pending = pending.filter((e) => bigger(e.commitSeq, a))
      const encounters = (await app.get<EncounterCache>('kv', KV.encounters)) ?? EMPTY_ENCOUNTERS
      const ledger = (await app.get<Ledger>('kv', KV.ledger)) ?? EMPTY_LEDGER
      const out = ingest({ commitSeq: a, now: now(), events: take, contacts, prompts, encounters, ledger })
      const writes: AppWrite[] = [
        { store: 'kv', key: KV.encounters, value: out.encounters },
        { store: 'kv', key: KV.ledger, value: out.ledger },
        { store: 'kv', key: KV.applied, value: { commitSeq: a } },
        ...out.lines.map((l) => ({ store: 'log' as const, key: l.id, value: l })),
      ]
      await app.write(writes)
      lastViews = { commitSeq: a, contacts, prompts, profile }
      await publishFromDb()
      return
    }
    // five attempts without a stable fence: the last consistent bundle stays; the next commit retries
  }
  const sync = () => queue(syncOnce)

  // ── timers, transport ───────────────────────────────────────────────────────────────────────
  let timer: { at: number; cancel: () => void } | null = null
  const schedule = (at: number | undefined) => {
    if (at === undefined || stopped) return
    if (timer && timer.at <= at) return
    timer?.cancel()
    timer = { at, cancel: clock.setTimer(at, () => void due()) }
  }
  const submit = (out: readonly Outbound[]) => {
    if (!stopped && out.length > 0) deps.transport.submit(out)
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

  deps.transport.start({
    envelope: async (env) => {
      try {
        const r = await gate.run((h) => h.receive(env, when()))
        if (r.disposition === 'failed' && r.key === 'unknown') return 'not-mine'
        if (r.disposition === 'unique' || r.disposition === 'duplicate-known') submit(r.outbound)
        if (r.disposition === 'unique') schedule(r.nextDueAt)
        return 'taken'
      } catch {
        return 'not-mine'
      }
    },
    report: (r: DeliveryReport) => {
      void gate
        .run((h) => h.report(r, when()))
        .then((x) => {
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

  const putIntent = (r: IntentRecord) => app.write([{ store: 'intents', key: r.actId, value: r }])

  /** Runs the act of a journaled record (state running); finishes the record by its outcome. */
  const execute = async <T>(rec: IntentRecord, spec: ActSpec): Promise<Result<T>> => {
    const input = rec.input ?? {}
    const running: IntentRecord = { ...rec, state: 'running', attempts: rec.attempts + 1 }
    await putIntent(running)
    void queue(publishFromDb)
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
      if (error.kind !== 'locked') {
        await putIntent({ ...running, state: 'outcome-unknown' }).catch(() => undefined)
        void queue(publishFromDb)
      }
      return { ok: false, error }
    }
    if (!r.ok) {
      const error = mapActError(r.code)
      await queue(async () => {
        await putIntent({ ...running, state: 'done', input: null, outcome: { ok: false, error }, finishedAt: now() })
        await publishFromDb()
      })
      return { ok: false, error }
    }
    for (const e of r.events) {
      if (seen.has(e.eventId)) continue
      seen.add(e.eventId)
      pending.push(e)
    }
    submit(r.outbound)
    schedule(r.nextDueAt)
    const value = spec.outcome(r.events, input) as T
    // ingest the act's commit first (§3.4 step 4: the projections of the act are durable before done)
    await sync()
    await queue(async () => {
      await putIntent({ ...running, state: 'done', input: null, outcome: { ok: true, value }, finishedAt: now() })
      await publishFromDb()
    })
    return { ok: true, value }
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
      if (rec.createdAt + MANUAL_LIMIT_MS < now()) {
        await putIntent({ ...rec, state: 'expired', input: null })
        await queue(publishFromDb)
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
    await queue(async () => {
      await putIntent({ ...rec, state: 'expired', input: null, finishedAt: now() })
      await publishFromDb()
    })
    return { ok: true, value: undefined }
  }

  /** After unlocking (§3.4 "Wiederanlauf"): never runs an encounter act without the human (N3). */
  const recover = async () => {
    const snap = await app.readAll()
    const writes: AppWrite[] = []
    const replays: IntentRecord[] = []
    for (const v of snap.intents.values()) {
      const r = v as IntentRecord
      if (!isOpen(r)) {
        if ((r.finishedAt ?? r.createdAt) + DONE_RETENTION_MS < now()) writes.push({ store: 'intents', key: r.actId, value: null })
        continue
      }
      if (r.createdAt + MANUAL_LIMIT_MS < now()) {
        writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null } })
        continue
      }
      if (r.policy === 'discard') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'expired', input: null, finishedAt: now() } })
      else if (r.policy === 'confirm-again') {
        if (r.state !== 'needs-confirmation') writes.push({ store: 'intents', key: r.actId, value: { ...r, state: 'needs-confirmation' } })
      } else if (r.state !== 'partial') replays.push(r)
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

  // ── first bundle, recovery, catch-up ────────────────────────────────────────────────────────
  await sync()
  await recover()
  await queue(publishFromDb)
  void due()

  const session: Session = {
    ns,
    generation: deps.generation,
    models: () => models,
    intent,
    confirmIntent,
    discardIntent,
    previewCard,
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
    default:
      return null
  }
}
