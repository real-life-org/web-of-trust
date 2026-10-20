// The real adapter on @real-life/trust-protocol (architecture §3.1). The only place in src/ that may
// import the library (enforced by .dependency-cruiser.cjs and ESLint). Pinned to 0.6.0 exactly.
//
// createRltpPort composes the identity runtime (adapters/identity) with the holder host of this
// adapter and serves the app port from the current session. This step covers the encounter
// (show, preview, scan or capture, counter-step, decide on encounter-confirm), the contact read
// models and 1:1 messages (send with held drafts, inbox take-over, sender status); reporting and
// blocking follow (TODO.md).

import type { RetryPolicy } from '@real-life/trust-protocol'
import type {
  ActId,
  AppEvent,
  AppPort,
  AppStores,
  Capabilities,
  Connectivity,
  ContactDetail,
  Conversation,
  IntentHandle,
  IntentView,
  Loadable,
  ReadStore,
  Result,
  TrustCommands,
  WritableStore,
} from '../../port'
import { LOADING, ready, writableStore } from '../../port'
import type { IdentityPlatform } from '../../platform/ports'
import { createIdentityRuntime, type IdentityRuntime } from '../identity'
import { decodeCardLink } from './card-link'
import { rltpHolderHost } from './host'
import type { ReadModels } from './projection'
import type { RltpFaults, Session } from './session'
import { webLockWriter, type SingleWriter } from './single-writer'
import type { Transport } from './transport'

export { memoryCarrier, unconfiguredTransport, type MemoryCarrier, type Transport } from './transport'
export { webLockWriter, type SingleWriter } from './single-writer'
export { CARD_LINK_PREFIX } from './card-link'
export type { RltpFaults } from './session'

export interface RltpDeps {
  readonly identity: IdentityPlatform
  readonly idb: IDBFactory
  readonly transport: Transport
  /** default: the Web Lock `wot-v3-holder` over navigator.locks */
  readonly writer?: SingleWriter
  readonly retry?: Partial<RetryPolicy>
  readonly subtle?: SubtleCrypto
  /** tests and harness only */
  readonly faults?: RltpFaults
  /** foreground / background of the app (LifecyclePort.onState) */
  readonly lifecycle?: { onState(cb: (s: 'active' | 'background') => void): () => void }
}

export interface RltpPort extends AppPort {
  readonly runtime: IdentityRuntime
  /** the open session (tests and the harness) */
  session(): Session | null
}

const CAPABILITIES: Capabilities = {
  messaging: true,
  groupMessaging: false,
  // report: a mail draft to the publisher (paper §6), built in the app; block in the holder state (§7)
  report: true,
  block: 'full',
  leaveGroup: false,
  vouchThresholdAboveOne: false,
  candidacyVisibility: false,
  introduce: 'later',
  push: false,
}

const NOT_SUPPORTED = { ok: false, error: { kind: 'unavailable', reason: 'not-supported' } } as const
const LOCKED = { ok: false, error: { kind: 'locked' } } as const

export function createRltpPort(deps: RltpDeps): RltpPort {
  const { clock, entropy } = deps.identity
  let models: ReadModels | null = null
  let session: Session | null = null

  const loadable = <T>(pick: (m: ReadModels) => T): Loadable<T> => (models ? ready(pick(models), models.revision) : LOADING)
  const top = {
    contacts: writableStore(loadable((m) => m.contacts)),
    groups: writableStore(loadable(() => [] as never[])),
    decisions: writableStore(loadable((m) => m.decisions)),
    candidacies: writableStore(loadable(() => [] as never[])),
    profile: writableStore(loadable((m) => m.profile)),
    standing: writableStore(loadable((m) => m.standing)),
    visibility: writableStore(loadable((m) => m.visibility)),
    blocked: writableStore(loadable((m) => m.blocked)),
    reports: writableStore(loadable(() => [] as never[])),
  }
  const intents = writableStore<readonly IntentView[]>([])
  const connectivity = writableStore<Connectivity>({ network: 'unknown', carrier: 'not-configured', queued: 0, lastReceiveAt: null, projection: 'current', clock: 'ok' })
  const conversations = new Map<string, WritableStore<Loadable<Conversation>>>()
  const details = new Map<string, WritableStore<Loadable<ContactDetail | null>>>()
  const conversationValue = (key: string): Loadable<Conversation> => {
    if (!models) return LOADING
    const c = models.conversations.get(key as Conversation['key'])
    return c ? ready(c, models.revision) : { status: 'error', error: { kind: 'refused', code: 'unknown-contact' } }
  }
  const detailValue = (id: string): Loadable<ContactDetail | null> => loadable((m) => m.contactDetails.get(id) ?? null)

  const publish = (next: ReadModels | null) => {
    models = next
    // atomic swap (§2.1 rule 6): every cache first, notifications follow in one microtask
    top.contacts.set(loadable((m) => m.contacts))
    top.groups.set(loadable(() => []))
    top.decisions.set(loadable((m) => m.decisions))
    top.candidacies.set(loadable(() => []))
    top.profile.set(loadable((m) => m.profile))
    top.standing.set(loadable((m) => m.standing))
    top.visibility.set(loadable((m) => m.visibility))
    top.blocked.set(loadable((m) => m.blocked))
    top.reports.set(loadable(() => []))
    intents.set(next?.intents ?? [])
    for (const [k, s] of conversations) s.set(conversationValue(k))
    for (const [k, s] of details) s.set(detailValue(k))
  }

  const listeners = new Set<(e: AppEvent) => void>()
  let unwatchTransport: (() => void) | null = null
  const host = rltpHolderHost({
    idb: deps.idb,
    clock,
    entropy,
    transport: deps.transport,
    writer: deps.writer ?? webLockWriter(globalThis.navigator?.locks),
    ...(deps.retry ? { retry: deps.retry } : {}),
    ...(deps.subtle ? { subtle: deps.subtle } : {}),
    ...(deps.faults ? { faults: deps.faults } : {}),
    ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
    publish,
    emit: (e) => {
      for (const l of [...listeners]) l(e)
    },
    onCurrent: (s) => {
      session = s
      unwatchTransport?.()
      unwatchTransport = null
      if (s) {
        const sync = () => connectivity.set({ ...connectivity.get(), ...deps.transport.status.get() })
        sync()
        unwatchTransport = deps.transport.status.subscribe(sync)
      }
    },
  })
  const runtime = createIdentityRuntime(deps.identity, host, deps.subtle ? { subtle: deps.subtle } : {})

  const fixed = <T>(v: T): ReadStore<T> => writableStore(v)
  const stores: AppStores = {
    identity: runtime.state,
    capabilities: fixed(CAPABILITIES),
    connectivity,
    intents,
    ...top,
    contact(id) {
      let s = details.get(id)
      if (!s) details.set(id, (s = writableStore(detailValue(id))))
      return s
    },
    conversation(key) {
      let s = conversations.get(key)
      if (!s) conversations.set(key, (s = writableStore(conversationValue(key))))
      return s
    },
    group: () => fixed<Loadable<null>>({ status: 'error', error: { kind: 'unavailable', reason: 'not-supported' } }),
  }

  const handle = <T>(r: Result<T>): IntentHandle<T> => ({ actId: entropy.uuid() as ActId, done: Promise.resolve(r) })
  const unsupported = <T>(): IntentHandle<T> => handle(NOT_SUPPORTED as Result<T>)
  const withSession = <T>(fn: (s: Session) => IntentHandle<T>): IntentHandle<T> => (session ? fn(session) : handle(LOCKED as Result<T>))
  const later = <T>(): Promise<Result<T>> => Promise.resolve(NOT_SUPPORTED as Result<T>)

  const trust: TrustCommands = {
    showCard: () => withSession((s) => s.intent('showCard', 'encounter', 'showCard', {})),
    previewCard: async (raw) => (session ? session.previewCard(raw) : (LOCKED as Result<never>)),
    confirmCard(raw) {
      return withSession((s) => {
        const card = decodeCardLink(raw)
        if (!card) return handle({ ok: false, error: { kind: 'refused', code: 'card-invalid' } })
        const role = typeof card.sentTo === 'string' ? 'sent' : 'displayed'
        const name = typeof card.name === 'string' ? card.name : null
        return s.intent('confirmCard', 'encounter', `confirmCard|${raw.trim()}`, { card, role }, { role, name, knownContact: null, self: false })
      })
    },
    async sentCardFor(contactId) {
      const qr = session ? await session.sentCard(contactId) : null
      return qr ? { ok: true, value: { qr } } : { ok: false, error: { kind: 'refused', code: 'nothing-to-counter' } }
    },
    counterVerify(contactId) {
      return withSession((s) => {
        const open = s.models()?.decisions.find((d) => d.kind === 'encounter-confirm' && d.contactId === contactId)
        const input = open ? { contactId, promptId: open.id } : { contactId }
        return s.intent('counterVerify', `c:${contactId}`, `counterVerify|${contactId}`, input)
      })
    },
    decide(id, choice) {
      return withSession((s) => {
        const d = s.models()?.decisions.find((x) => x.id === id)
        const contactId = d?.kind === 'encounter-confirm' ? d.contactId : null
        return s.intent('decide', id, `decide|${id}`, { promptId: id, choice, ...(contactId ? { contactId } : {}) })
      })
    },
    giveTrust: unsupported,
    withdrawTrust: unsupported,
    setPaused: unsupported,
    removeContact: unsupported,
    send(key, text, draftKey) {
      return withSession((s) => {
        if (!key.startsWith('c:')) return unsupported()
        // the composer is closed for a blocked contact; nothing is journaled or kept (paper §7.4)
        if (s.models()?.contactDetails.get(key.slice(2))?.blocked) return handle({ ok: false, error: { kind: 'refused', code: 'contact-blocked' } })
        return s.intent('send', key, `send|${draftKey}`, { contactId: key.slice(2), text, draftKey })
      })
    },
    // a failed document is not sent again in 0.6.0 (no controlled retry, §2.7 N11): the UI offers
    // "send as new message", a new send with a new draft key
    retry: unsupported,
    markRead: (key, upTo) => session?.markRead(key, upTo),
    loadEarlier: later,
    foundGroup: unsupported,
    invite: unsupported,
    vouch: unsupported,
    leaveGroup: unsupported,
    prepareReport: later,
    report: unsupported,
    block: (target) => withSession((s) => (target.kind === 'contact' ? s.intent('block', `c:${target.contactId}`, `block|${target.contactId}`, { contactId: target.contactId }) : unsupported())),
    unblock: (target) => withSession((s) => (target.kind === 'contact' ? s.intent('unblock', `c:${target.contactId}`, `unblock|${target.contactId}`, { contactId: target.contactId }) : unsupported())),
    mute: later,
    setProfile: unsupported,
    introduce: unsupported,
  }

  return {
    stores,
    identity: runtime,
    trust,
    intents: {
      retryIntent: (actId) => withSession((s) => s.retryIntent(actId)),
      confirmIntent: (actId) => withSession((s) => s.confirmIntent(actId)),
      discardIntent: async (actId) => (session ? session.discardIntent(actId) : (LOCKED as Result)),
    },
    events: {
      subscribe(l) {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    },
    runtime,
    session: () => session,
  }
}
