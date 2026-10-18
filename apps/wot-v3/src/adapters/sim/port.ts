// The app port over a simulated world. Same snapshot semantics as the real adapter
// (architecture §2.1): every store reads only its cache; a published bundle swaps all caches in
// one synchronous block, notifications follow batched in one microtask.

import type {
  ActId,
  AppEvent,
  AppPort,
  AppStores,
  Capabilities,
  Connectivity,
  ContactDetail,
  Conversation,
  IdentityCommands,
  IdentityState,
  IntentCommands,
  IntentHandle,
  IntentView,
  Loadable,
  ReadStore,
  Result,
  TrustCommands,
  WritableStore,
} from '../../port'
import { LOADING, ready, writableStore } from '../../port'
import type { Bundle } from './project'
import type { SimWorld } from './world'

const CAPABILITIES: Capabilities = {
  messaging: false,
  groupMessaging: false,
  report: false,
  block: 'local',
  leaveGroup: false,
  vouchThresholdAboveOne: true,
  candidacyVisibility: true,
  introduce: 'later',
  push: false,
}

const CONNECTIVITY: Connectivity = {
  network: 'online',
  carrier: 'connected',
  queued: 0,
  lastReceiveAt: null,
  projection: 'current',
  clock: 'ok',
}

const NOT_SUPPORTED = { ok: false, error: { kind: 'unavailable', reason: 'not-supported' } } as const

export function createSimPort(world: SimWorld): AppPort {
  const loadable = <T>(b: Bundle | null, pick: (b: Bundle) => T): Loadable<T> => (b ? ready(pick(b), b.revision) : LOADING)

  const top = {
    contacts: writableStore(loadable(world.bundle(), (b) => b.contacts)),
    groups: writableStore(loadable(world.bundle(), (b) => b.groups)),
    decisions: writableStore(loadable(world.bundle(), (b) => b.decisions)),
    candidacies: writableStore(loadable(world.bundle(), (b) => b.candidacies)),
    profile: writableStore(loadable(world.bundle(), (b) => b.profile)),
    standing: writableStore(loadable(world.bundle(), (b) => b.standing)),
    visibility: writableStore(loadable(world.bundle(), (b) => b.visibility)),
    blocked: writableStore(loadable(world.bundle(), (b) => b.blocked)),
    reports: writableStore(loadable(world.bundle(), (b) => b.reports)),
  }
  const identityOf = (b: Bundle | null): IdentityState =>
    b
      ? { status: 'unlocked', anchorShort: b.profile.anchorShort, protection: 'passphrase+biometric', recovered: null, termsAccepted: true }
      : { status: 'booting' }
  const identityStore = writableStore<IdentityState>(identityOf(world.bundle()))

  // Store families: one instance per key. TODO(architecture §2.1 rule 8): reference counting with
  // 30 s grace; the scaffold keeps every requested key.
  const conversations = new Map<string, WritableStore<Loadable<Conversation>>>()
  const contactDetails = new Map<string, WritableStore<Loadable<ContactDetail | null>>>()
  const conversationValue = (b: Bundle | null, key: string): Loadable<Conversation> => {
    if (!b) return LOADING
    const c = b.conversations.get(key as Conversation['key'])
    return c ? ready(c, b.revision) : { status: 'error', error: { kind: 'refused', code: 'unknown-contact' } }
  }
  const contactValue = (b: Bundle | null, id: string): Loadable<ContactDetail | null> =>
    loadable(b, (bb) => bb.contactDetails.get(id) ?? null)

  world.onPublish((b) => {
    // Atomic swap (rule 6): every cache first; notifications run in the next microtask.
    top.contacts.set(loadable(b, (x) => x.contacts))
    top.groups.set(loadable(b, (x) => x.groups))
    top.decisions.set(loadable(b, (x) => x.decisions))
    top.candidacies.set(loadable(b, (x) => x.candidacies))
    top.profile.set(loadable(b, (x) => x.profile))
    top.standing.set(loadable(b, (x) => x.standing))
    top.visibility.set(loadable(b, (x) => x.visibility))
    top.blocked.set(loadable(b, (x) => x.blocked))
    top.reports.set(loadable(b, (x) => x.reports))
    identityStore.set(identityOf(b))
    for (const [key, store] of conversations) store.set(conversationValue(b, key))
    for (const [id, store] of contactDetails) store.set(contactValue(b, id))
  })

  const fixed = <T>(v: T): ReadStore<T> => writableStore(v)

  const stores: AppStores = {
    identity: identityStore,
    capabilities: fixed(CAPABILITIES),
    connectivity: fixed(CONNECTIVITY),
    intents: fixed<readonly IntentView[]>([]),
    contacts: top.contacts,
    groups: top.groups,
    decisions: top.decisions,
    candidacies: top.candidacies,
    profile: top.profile,
    standing: top.standing,
    visibility: top.visibility,
    blocked: top.blocked,
    reports: top.reports,
    contact(id) {
      let s = contactDetails.get(id)
      if (!s) {
        s = writableStore(contactValue(world.bundle(), id))
        contactDetails.set(id, s)
      }
      return s
    },
    group() {
      // Group details come with the group screens (not in the scaffold).
      return fixed<Loadable<null>>({ status: 'error', error: { kind: 'unavailable', reason: 'not-supported' } })
    },
    conversation(key) {
      let s = conversations.get(key)
      if (!s) {
        s = writableStore(conversationValue(world.bundle(), key))
        conversations.set(key, s)
      }
      return s
    },
  }

  // Commands: the scaffold renders read-only. Every state-changing command returns an intent that
  // ends in unavailable/not-supported; the command service with the intent journal follows (§3.4).
  const intent = <T>(): IntentHandle<T> => ({
    actId: world.entropy.uuid() as ActId,
    done: Promise.resolve(NOT_SUPPORTED as Result<T>),
  })
  const later = <T>(): Promise<Result<T>> => Promise.resolve(NOT_SUPPORTED as Result<T>)

  const identity: IdentityCommands = {
    generate: later,
    checkMnemonic: () => NOT_SUPPORTED,
    create: intent,
    restore: intent,
    unlock: later,
    lock: async () => {},
    changeProtection: intent,
    deleteIdentity: intent,
    resetLegacy: intent,
    acceptTerms: later,
  }

  const trust: TrustCommands = {
    showCard: intent,
    previewCard: later,
    confirmCard: intent,
    sentCardFor: later,
    counterVerify: intent,
    giveTrust: intent,
    withdrawTrust: intent,
    setPaused: intent,
    removeContact: intent,
    decide: intent,
    send: intent,
    retry: intent,
    markRead: (key, upTo) => world.apply({ type: 'mark-read', key, upTo }),
    loadEarlier: later,
    foundGroup: intent,
    invite: intent,
    vouch: intent,
    leaveGroup: intent,
    prepareReport: later,
    report: intent,
    block: intent,
    unblock: intent,
    mute: later,
    setProfile: intent,
    introduce: intent,
  }

  const intents: IntentCommands = { retryIntent: intent, confirmIntent: intent, discardIntent: later }

  const eventListeners = new Set<(e: AppEvent) => void>()
  world.onReceive((key, messageId) => {
    const e: AppEvent = { eventId: world.entropy.uuid(), type: 'message.received', key, messageId }
    for (const l of [...eventListeners]) l(e)
  })

  return {
    stores,
    identity,
    trust,
    intents,
    events: {
      subscribe(listener) {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
    },
  }
}
