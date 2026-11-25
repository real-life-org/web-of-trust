// Commands of the app port (architecture §2.4). Every state-changing command is an intent:
// the command service under the port mints the actId, locks double taps synchronously and
// journals before the first effect (architecture §3.4).

import type { AppError } from './errors'
import type { ActId, Brand, CardRef, ConnectionId, ContactId, ConversationKey, DecisionId, GroupId, MemberRef, MessageId } from './ids'
import type { AuthorLabel, DeliveryState, TrustClass, ClassSetting } from './models'

export interface IntentHandle<T> {
  readonly actId: ActId
  readonly done: Promise<Result<T>>
  /** true once the command service holds the intent durably (its journal is written, or the same
   *  gesture is already held or sent), false when it did not take it; absent: read from `done` */
  readonly journaled?: Promise<boolean>
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- X defaults to "no extra error fields"
export type Result<T = void, X extends object = {}> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError & Partial<X> }

/** English BIP-39 list, never localized. */
export type Mnemonic = Brand<readonly string[], 'Mnemonic'>
/** A secret in memory. The brand alone protects nothing at runtime; see port/secret.ts. */
export type Secret<T> = Brand<{ readonly reveal: () => T }, 'Secret'>
import type { IdentityCommands } from './identity'

export interface WipeReport {
  readonly local: { readonly ok: true } | { readonly ok: false; readonly survivors: readonly string[] }
  /** deregistration at carriers: continues after the local wipe; never summarized as "deleted" */
  readonly remote: { readonly done: number; readonly pending: number; readonly failed: number }
}

export interface CardPreview {
  /** displayed card → scan; sent card → optical return path; back → the back-code of a connection
   *  ceremony that answers one of this device's shown codes (no carrier in reach of the other side) */
  readonly role: 'displayed' | 'sent' | 'back'
  readonly name: string | null
  /** recognized before confirming */
  readonly knownContact: ContactId | null
  /** own code */
  readonly self: boolean
  /** a link this device's camera answered before, whose ceremony is open and whose code is still valid:
   *  the connection, so its back-code can be shown again (after a restart), and whether it was shown
   *  before (the contact it opened exists); absent otherwise */
  readonly answered?: { readonly connection: ConnectionId; readonly shown: boolean }
}

/** A back-code the camera read (`readBackCode`): the connection it answers and, while the person has not
 *  decided, its confirmation; the contact once accepted (the code read again after the acceptance) */
export interface BackRead {
  readonly connection: ConnectionId
  readonly decision: DecisionId | null
  /** the name the proposal states, unverified */
  readonly name: string | null
  /** the end of the code it answers, with the ceremony's clock tolerance */
  readonly validUntil: number
  readonly contactId: ContactId | null
}

/** Outcome of an encounter act. No outcome means "mutual"; only ContactSummary.verification says that. */
export type EncounterOutcome =
  | { readonly kind: 'scanned'; readonly contactId: ContactId }
  | { readonly kind: 'completes'; readonly contactId: ContactId }
  | { readonly kind: 'recognized'; readonly contactId: ContactId }
  | { readonly kind: 'captured'; readonly contactId: ContactId; readonly decision: DecisionId }
  | { readonly kind: 'already-captured'; readonly contactId: ContactId | null }
  /** the code of a connection ceremony was read and the own proposal is under way: the contact exists
   *  once the ceremony is complete (`stores.connections`) */
  /** `relayed`: the link names a relay its documents travel through; false for a link of a device without a
   *  carrier, whose ceremony can only go on optically (the back-code) */
  | { readonly kind: 'proposed'; readonly connection: ConnectionId; readonly contactId: null; readonly relayed?: boolean }

export type SafetyTarget =
  | { readonly kind: 'contact'; readonly contactId: ContactId }
  | { readonly kind: 'group-member'; readonly groupId: GroupId; readonly member: MemberRef }

/** Immutable report draft; the consent covers exactly this. draftHash = SHA-256 over the canonical form. */
export interface ReportDraft {
  readonly draftId: string
  readonly draftHash: string
  readonly target: SafetyTarget
  readonly documents: readonly {
    readonly messageId: MessageId
    readonly digest: string
    readonly author: AuthorLabel
    readonly at: number
    readonly text: string
  }[]
  readonly context: readonly {
    readonly field:
      | 'conversation-kind'
      | 'group-name'
      | 'group-id'
      | 'reporter-anchor'
      | 'author-anchor'
      | 'time-range'
      | 'note'
    readonly value: string
  }[]
  readonly recipients: {
    readonly moderation: { readonly operator: string; readonly address: string }
    readonly groupMembers: readonly { readonly member: MemberRef; readonly handle: string; readonly name: string | null }[]
    /** 'complete' only with a complete, versioned roster from the core; otherwise 'known-only' */
    readonly groupRoster?: { readonly coverage: 'complete' | 'known-only'; readonly version: string }
  }
  readonly createdAt: number
}

export interface ReportStatus {
  readonly draftId: string
  readonly sealed: boolean
  readonly perRecipient: readonly { readonly recipient: 'moderation' | MemberRef; readonly delivery: DeliveryState }[]
  /** from 'unknown' on, disclosure counts as possibly done and irreversible */
  readonly disclosure: 'none' | 'unknown' | 'partial' | 'complete'
}

export interface TrustCommands {
  // Encounter
  /** `card`: the card's instance where it is shown with a carrier offer (VTI §1c), else null */
  showCard(): IntentHandle<{ qr: string; expiresAt: number; card: CardRef | null }>
  /** pure, no commit */
  previewCard(raw: string): Promise<Result<CardPreview>>
  /** `origin`: where the code came in; only a code this device's camera read counts as read in one
   *  place (the connection is `met` when both sides say so), a link or typed text does not */
  confirmCard(raw: string, origin?: 'camera' | 'url' | 'manual'): IntentHandle<EncounterOutcome>
  /** return path for the scanner: the own sent card as QR */
  sentCardFor(contactId: ContactId): Promise<Result<{ qr: string }>>
  /** a connection ceremony without a carrier: the code the reader of a shown code shows back (its
   *  proposal with its card); the reader's contact exists from here on. Refused `no-card` for a code
   *  without the inviter's card (another app, an older version), `code-too-long` when it does not fit one
   *  QR code (a long name), `code-expired` once the code it answers expired or its ceremony ended */
  /** `validUntil`: the end of the link it answers; the code is not shown past it */
  showBackCode(connection: ConnectionId): IntentHandle<{ qr: string; validUntil: number }>
  /** the camera of the device that shows a code read the back-code: the proposal is asked like one that
   *  came over the carrier (a `connect-confirm` decision); accepting opens the contact. Not a human act */
  readBackCode(raw: string): Promise<Result<BackRead>>
  counterVerify(contactId: ContactId): IntentHandle<void>

  // Trust
  giveTrust(contactId: ContactId): IntentHandle<void>
  withdrawTrust(contactId: ContactId): IntentHandle<void>
  setPaused(contactId: ContactId, paused: boolean): IntentHandle<void>
  /** one class's setting toward the contact (Trust 2780, 2810): the individual switches */
  setClass(contactId: ContactId, cls: TrustClass, setting: ClassSetting): IntentHandle<void>
  removeContact(contactId: ContactId): IntentHandle<void>

  // Decisions
  decide(id: DecisionId, choice: 'accept' | 'decline', options?: { showCandidacy?: boolean }): IntentHandle<void>

  // Messages
  /** draftKey: created by the UI once per composer content; dedupe key against double taps */
  send(key: ConversationKey, text: string, draftKey: string): IntentHandle<{ messageId: MessageId }>
  /** document retry: the same document again (same digest), never a new send act */
  retry(messageId: MessageId): IntentHandle<void>
  /** Read boundary: `upTo` is the id of the last ConversationItem the screen has shown. Everything up to
   *  and including it counts as read, nothing after it. An id is used, not a time, because items can
   *  share a timestamp. A boundary behind the current read mark changes nothing. */
  markRead(key: ConversationKey, upTo: string): void
  loadEarlier(key: ConversationKey): Promise<Result>

  // Groups
  foundGroup(input: { name: string; listed?: boolean }): IntentHandle<{ groupId: GroupId }>
  invite(groupId: GroupId, contactId: ContactId): IntentHandle<void>
  vouch(groupId: GroupId, member: MemberRef): IntentHandle<void>
  leaveGroup(groupId: GroupId): IntentHandle<void>

  // Safety
  /** pure: builds the draft from the current bundle; nothing leaves the device */
  prepareReport(input: {
    target: SafetyTarget
    messageIds: readonly MessageId[]
    note?: string
    conversation: ConversationKey
  }): Promise<Result<ReportDraft>>
  report(draftId: string, confirmedHash: string): IntentHandle<ReportStatus>
  block(target: SafetyTarget): IntentHandle<void>
  unblock(target: SafetyTarget): IntentHandle<void>
  mute(key: ConversationKey, muted: boolean): Promise<Result>

  // Profile
  setProfile(input: { name: string; image?: string | null }): IntentHandle<void>

  // later, gated by capabilities
  introduce(requesterId: ContactId, targetId: ContactId): IntentHandle<void>
}

/** Intent recovery, separate from document retry. Acts only on journal entries. */
export interface IntentCommands {
  retryIntent(actId: ActId): IntentHandle<unknown>
  confirmIntent(actId: ActId): IntentHandle<EncounterOutcome>
  discardIntent(actId: ActId): Promise<Result>
}

export type CommandName = keyof TrustCommands | keyof IdentityCommands | keyof IntentCommands
