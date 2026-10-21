// The app port: the only contract between the surface (hooks, screens) and a core adapter
// (adapters/rltp on @real-life/trust-protocol, adapters/sim for the simulation).
//
// No stability promise until after IIW (architecture §1.2): Guss 0.32 and E15 may change commands
// and decision models; the decoupling promises that such changes land in the port and the adapter,
// not in screens.
//
// Runtime exports are limited to the store helpers and the Secret class (tests/port-purity.test.ts).
// port/diagnostics.ts is deliberately not re-exported.

export type * from './ids'
export type * from './models'
export type * from './commands'
export type * from './identity'
export type * from './events'
export type * from './errors'
export type { ReadStore, Revision, Loadable, StoreFamily, WritableStore } from './store'
export { LOADING, ready, revision, deepFreeze, structuralShare, writableStore } from './store'
export { secret, isSecret, SecretBox } from './secret'

import type { ReadStore, Loadable, StoreFamily } from './store'
import type { ContactId, ConversationKey, GroupId } from './ids'
import type {
  BlockedEntry,
  Candidacy,
  Capabilities,
  Connectivity,
  ContactDetail,
  ContactListItem,
  Conversation,
  Decision,
  GroupDetail,
  GroupListItem,
  IdentityState,
  IntentView,
  MessageItem,
  ProfileModel,
  TrustStandingSummary,
  VisibilityEntry,
} from './models'
import type { IntentCommands, ReportStatus, TrustCommands } from './commands'
import type { IdentityCommands } from './identity'
import type { AppEvents } from './events'

/** One store per screen need, not one global state (architecture §2.1 "granularity"). */
export interface AppStores {
  readonly identity: ReadStore<IdentityState>
  readonly capabilities: ReadStore<Capabilities>
  readonly connectivity: ReadStore<Connectivity>
  readonly intents: ReadStore<readonly IntentView[]>
  readonly contacts: ReadStore<Loadable<readonly ContactListItem[]>>
  readonly contact: StoreFamily<ContactId, Loadable<ContactDetail | null>>
  readonly groups: ReadStore<Loadable<readonly GroupListItem[]>>
  readonly group: StoreFamily<GroupId, Loadable<GroupDetail | null>>
  readonly conversation: StoreFamily<ConversationKey, Loadable<Conversation>>
  /** the messages a report may select (paper §6), by display time: those of the conversation, and for a
   *  blocked contact also the ones the conversation hides (Message Tasks 6230). Read only by the report
   *  selection, the one place where reporting discloses them on purpose (Anton 21.10.) */
  readonly reportable: StoreFamily<ContactId, Loadable<readonly MessageItem[]>>
  readonly decisions: ReadStore<Loadable<readonly Decision[]>>
  readonly candidacies: ReadStore<Loadable<readonly Candidacy[]>>
  readonly profile: ReadStore<Loadable<ProfileModel>>
  readonly standing: ReadStore<Loadable<TrustStandingSummary>>
  readonly visibility: ReadStore<Loadable<readonly VisibilityEntry[]>>
  readonly blocked: ReadStore<Loadable<readonly BlockedEntry[]>>
  readonly reports: ReadStore<Loadable<readonly ReportStatus[]>>
}

export interface AppPort {
  readonly stores: AppStores
  readonly identity: IdentityCommands
  readonly trust: TrustCommands
  readonly intents: IntentCommands
  readonly events: AppEvents
}
