// The simulated world (architecture §3.2): a pure TS model without the core library. It holds the
// state of "me" in port terms and serves it through the same port semantics as the real adapter
// (immutable cached read models, one bundle per revision, atomic swap, microtask-batched notifications).
//
// Scaffold scope: one person ("me"), one device, read models for lists and conversations, the
// world actions the tests need. Counterpart scripts, fault switches, several persons and devices,
// the intent journal and session generations follow with the flows (architecture §3.2, §3.4).

import type { ConversationKey, MessageId } from '../../port'
import { revision } from '../../port'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import { project, type Bundle, type WorldItem, type WorldState } from './project'
import type { SeedAuthor, SimWorldSeed } from './seed'

/** Marker for the build check (architecture §8.2: second, cheap signal beside the module graph). */
export const SIM_MARKER = '__WOT_SIM__'

export type WorldAction =
  /** a counterpart's message arrives */
  | { readonly type: 'receive'; readonly key: ConversationKey; readonly from: SeedAuthor; readonly text: string }
  /** local: read marks up to and including the item `upTo` (see TrustCommands.markRead) */
  | { readonly type: 'mark-read'; readonly key: ConversationKey; readonly upTo: string }
  /** the identity opened in the simulation sets the own profile (sim holder host) */
  | { readonly type: 'set-me'; readonly name: string; readonly anchorShort: string }

export interface SimOptions {
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  /** delays the first bundle so loading states become visible (fault switch projectionDelayMs) */
  readonly projectionDelayMs?: number
}

export interface SimWorld {
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  /** the current bundle, or null while the first projection is pending */
  bundle(): Bundle | null
  apply(action: WorldAction): void
  /** called after every published bundle */
  onPublish(listener: (b: Bundle) => void): () => void
  /** called for every received message (feeds AppEvents) */
  onReceive(listener: (key: ConversationKey, messageId: MessageId) => void): () => void
}

function toState(seed: SimWorldSeed): WorldState {
  const conversations = new Map<ConversationKey, WorldItem[]>()
  for (const c of seed.conversations) {
    conversations.set(
      c.key,
      c.items.map((item, i) => ({ ...item, id: `${c.key}#${i}`, atMs: Date.parse(item.at) })),
    )
  }
  return {
    me: seed.me,
    persons: new Map(seed.persons.map((p) => [p.id, p])),
    contacts: seed.contacts,
    groups: seed.groups,
    conversations,
    decisions: seed.decisions,
    candidacies: (seed.candidacies ?? []).map((c) => ({
      groupName: c.groupName,
      inviterId: null,
      have: c.have,
      need: c.need,
      state: 'waiting' as const,
    })),
    readThrough: new Map([...conversations].map(([key, items]) => [key, readMarkFor(items, seed.unread?.[key] ?? 0)])),
  }
}

/** The read mark that leaves the last `unread` received messages unread. */
function readMarkFor(items: readonly WorldItem[], unread: number): number {
  let left = unread
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (left === 0) return i
    if (item?.t === 'msg' && item.from !== 'me') left--
  }
  return -1
}

export function createSimWorld(seed: SimWorldSeed, opts: SimOptions): SimWorld {
  let state = toState(seed)
  let appSeq = 0
  let current: Bundle | null = null
  const publishListeners = new Set<(b: Bundle) => void>()
  const receiveListeners = new Set<(key: ConversationKey, id: MessageId) => void>()

  const publish = (): void => {
    appSeq++
    current = project(state, revision(1, 0, appSeq), opts.clock.timeZone())
    for (const l of [...publishListeners]) l(current)
  }

  const delay = opts.projectionDelayMs ?? 0
  if (delay > 0) opts.clock.setTimer(opts.clock.now() + delay, publish)
  else publish()

  return {
    clock: opts.clock,
    entropy: opts.entropy,
    bundle: () => current,
    apply(action) {
      switch (action.type) {
        case 'receive': {
          const items = state.conversations.get(action.key) ?? []
          const id = `${action.key}#${items.length}`
          const item: WorldItem = { t: 'msg', from: action.from, text: action.text, at: new Date(opts.clock.now()).toISOString(), id, atMs: opts.clock.now() }
          const conversations = new Map(state.conversations)
          conversations.set(action.key, [...items, item])
          const readThrough = new Map(state.readThrough)
          // a conversation without a read mark so far was fully read before this message
          if (!readThrough.has(action.key)) readThrough.set(action.key, items.length - 1)
          state = { ...state, conversations, readThrough }
          if (current) publish()
          for (const l of [...receiveListeners]) l(action.key, id as MessageId)
          break
        }
        case 'set-me': {
          if (state.me.name === action.name && state.me.anchorShort === action.anchorShort) return
          state = { ...state, me: { name: action.name, anchorShort: action.anchorShort } }
          if (current) publish()
          break
        }
        case 'mark-read': {
          const items = state.conversations.get(action.key) ?? []
          const index = items.findIndex((i) => i.id === action.upTo)
          const mark = state.readThrough.get(action.key) ?? items.length - 1
          if (index <= mark) return
          const readThrough = new Map(state.readThrough)
          readThrough.set(action.key, index)
          state = { ...state, readThrough }
          if (current) publish()
          break
        }
      }
    },
    onPublish(listener) {
      publishListeners.add(listener)
      return () => publishListeners.delete(listener)
    },
    onReceive(listener) {
      receiveListeners.add(listener)
      return () => receiveListeners.delete(listener)
    },
  }
}
