// Commands of the app port (architecture §2.4). Every state-changing command is an intent:
// the command service under the port mints the actId, locks double taps synchronously and
// journals before the first effect (architecture §3.4).

import type { AppError } from './errors'
import type { ActId, Brand, CardRef, ContactId, ConversationKey, DecisionId, GroupId, MemberRef, MessageId } from './ids'
import type { AuthorLabel, DeliveryState } from './models'

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
  /** displayed card → scan; sent card → optical return path */
  readonly role: 'displayed' | 'sent'
  readonly name: string | null
  /** recognized before confirming */
  readonly knownContact: ContactId | null
  /** own code */
  readonly self: boolean
}

/** Outcome of an encounter act. No outcome means "mutual"; only ContactSummary.verification says that. */
export type EncounterOutcome =
  | { readonly kind: 'scanned'; readonly contactId: ContactId }
  | { readonly kind: 'completes'; readonly contactId: ContactId }
  | { readonly kind: 'recognized'; readonly contactId: ContactId }
  | { readonly kind: 'captured'; readonly contactId: ContactId; readonly decision: DecisionId }
  | { readonly kind: 'already-captured'; readonly contactId: ContactId | null }

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
  confirmCard(raw: string): IntentHandle<EncounterOutcome>
  /** return path for the scanner: the own sent card as QR */
  sentCardFor(contactId: ContactId): Promise<Result<{ qr: string }>>
  counterVerify(contactId: ContactId): IntentHandle<void>

  // Trust
  giveTrust(contactId: ContactId): IntentHandle<void>
  withdrawTrust(contactId: ContactId): IntentHandle<void>
  setPaused(contactId: ContactId, paused: boolean): IntentHandle<void>
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
