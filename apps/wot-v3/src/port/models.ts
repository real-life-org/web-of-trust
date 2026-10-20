// Read models of the app port (architecture §2.3). Screens see only these, never core views.

import type { ActId, ContactId, ConversationKey, DecisionId, GroupId, MemberRef, MessageId } from './ids'
import type { CardPreview, CommandName, SafetyTarget } from './commands'

// ── Contacts ────────────────────────────────────────────────────────────────
/** 'introduced': came through an introduction, no encounter (design ◇). */
export type Verification = 'mutual' | 'outgoing' | 'incoming' | 'met' | 'introduced'

export interface TrustState {
  /** I gave trust */
  readonly given: boolean
  /** I was given trust */
  readonly received: boolean
  /** disclosure paused (nothing new flows) */
  readonly paused: boolean
  /** given, but not yet issued everywhere */
  readonly pending: boolean
}

export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: UnavailableReason }
export type UnavailableReason =
  | 'not-verified'
  | 'already-done'
  | 'blocked'
  | 'in-flight'
  | 'locked'
  /** announced, not built (introductions) */
  | 'later'
  /** this core cannot do it */
  | 'not-supported'
  /** needs network */
  | 'offline-required'

export interface ContactActions {
  readonly counterVerify: Availability
  readonly verifyAgain: Availability
  readonly giveTrust: Availability
  readonly withdrawTrust: Availability
  readonly pause: Availability
  readonly invite: Availability
  readonly introduce: Availability
  /** report and block (paper §6): a mail draft to the publisher, the contact blocked on this device */
  readonly report: Availability
  readonly block: Availability
  readonly unblock: Availability
  readonly remove: Availability
}

export interface ContactSummary {
  readonly id: ContactId
  /** profile name, else card name, else null */
  readonly name: string | null
  /** checked data: URL from profile@1 */
  readonly image: string | null
  readonly verification: Verification
  readonly trust: TrustState
  readonly blocked: boolean
}

export interface ConversationPreview {
  readonly kind: 'message' | 'system' | 'decision'
  readonly authorLabel: AuthorLabel | null
  /** message text; for system/decision empty, the text comes from `i18n` */
  readonly text: string
  readonly i18n?: { readonly key: string; readonly values: Readonly<Record<string, string>> }
  readonly at: number
}

export interface ConversationSummary {
  readonly key: ConversationKey
  readonly preview: ConversationPreview | null
  readonly unread: number
  readonly openDecisions: number
  readonly lastActivityAt: number | null
  readonly muted: boolean
}

/** One row of the contact list (messenger pattern: contact plus their conversation). */
export interface ContactListItem extends ContactSummary {
  readonly conversation: ConversationSummary
}

export interface ContactDetail extends ContactSummary {
  readonly introducedBy: ContactId | null
  readonly metAt: number | null
  readonly lastMetAt: number | null
  /** null = unknown, never pretend "empty" */
  readonly sharedGroups: readonly GroupId[] | null
  readonly actions: ContactActions
}

// ── Conversations ───────────────────────────────────────────────────────────
export type AuthorLabel =
  | { readonly kind: 'self' }
  | { readonly kind: 'contact'; readonly contactId: ContactId; readonly name: string | null }
  /** "Member 4F" */
  | { readonly kind: 'member'; readonly handle: string; readonly member: MemberRef }

/** Sender status of an own message. Mapping to the design words in architecture §6.3. */
export type DeliveryState =
  | { readonly phase: 'committing' }
  /** kept unsent by the app (Message Tasks 5.1): not-ready until a document of the contact arrived on
   *  the relationship, then sent by the app on its own; blocked / no-own-channel stay held */
  | { readonly phase: 'held'; readonly reason: 'not-ready' | 'blocked' | 'no-own-channel' }
  | { readonly phase: 'queued'; readonly reason: 'offline' | 'transport-unreachable' | 'carrier-retry' }
  | { readonly phase: 'submitted' }
  | { readonly phase: 'accepted' }
  | { readonly phase: 'delivered'; readonly late: boolean }
  | { readonly phase: 'partial'; readonly delivered: number; readonly of: number }
  | {
      readonly phase: 'failed'
      readonly reason: 'unroutable' | 'oversize' | 'expired' | 'rejected'
      readonly retry: Availability
    }

export interface MessageItem {
  readonly kind: 'message'
  readonly id: MessageId
  readonly author: AuthorLabel
  readonly text: string
  readonly at: number
  readonly origin: 'this-device' | 'other-device' | 'received'
  /** own messages only */
  readonly delivery: DeliveryState | null
  /** authenticated by the core (Message Tasks 0.1: a MAC under the relationship key, not a signature) */
  readonly signed: boolean
  readonly selectableForReport: boolean
  /** the sender's statement and, for received messages, the arrival (Message Tasks 4430; a report names both) */
  readonly sentAt?: number
  readonly receivedAt?: number | null
  /** the earlier message of this conversation this one answers; only when the app found it there */
  readonly replyTo?: { readonly id: MessageId; readonly author: AuthorLabel; readonly text: string }
}

export type SystemKind =
  | 'mutual'
  | 'nowMutual'
  | 'remet'
  | 'incoming'
  | 'outgoing'
  | 'introducedBy'
  | 'trustBoth'
  | 'trustOut'
  | 'trustIn'
  | 'trustWithdrawn'
  | 'paused'
  | 'resumed'
  | 'introduced'
  | 'invited'
  | 'vouched'
  | 'admitted'
  | 'founded'
  | 'joined'
  | 'left'
  | 'reported'
  | 'blocked'
  | 'unblocked'

export interface SystemItem {
  readonly kind: 'system'
  readonly id: string
  readonly system: SystemKind
  readonly at: number
  readonly subject?: ContactId
  readonly values?: Readonly<Record<string, string | number>>
  /** Where the line knows what it says from:
   *  'own-act'  the completed own intent (exact);
   *  'event'    a core event the running process took over (exact);
   *  'observed' the difference of two projections: an observed change of state, not an event.
   *             Text is therefore always state-shaped, never action-shaped. */
  readonly basis: 'own-act' | 'event' | 'observed'
}

export interface DecisionCardItem {
  readonly kind: 'decision'
  readonly id: string
  readonly decision: DecisionId
  readonly at: number
  /** open: current decision from `decisions`; resolved: result line */
  readonly resolution: DecisionResolution | null
}

export interface DayDivider {
  readonly kind: 'day'
  readonly id: string
  /** YYYY-MM-DD in the local time zone */
  readonly day: string
}

export type ConversationItem = DayDivider | MessageItem | SystemItem | DecisionCardItem

export interface Conversation {
  readonly key: ConversationKey
  readonly title: string | null
  /** chronological, day dividers inserted */
  readonly items: readonly ConversationItem[]
  readonly hasEarlier: boolean
  /** blocked, not-member, locked, not-supported */
  readonly composer: Availability
}

// ── Decisions ───────────────────────────────────────────────────────────────
interface DecisionBase {
  readonly id: DecisionId
  readonly openedAt: number
  readonly expiresAt: number | null
  readonly state: 'open' | 'in-flight'
}
export type Decision =
  /** "X verified you" */
  | (DecisionBase & { readonly kind: 'encounter-confirm'; readonly contactId: ContactId })
  | (DecisionBase & {
      readonly kind: 'group-invite'
      readonly inviterId: ContactId
      /** null while the core does not expose the invitation context (the group is not in groups() before acceptance) */
      readonly groupName: string | null
      readonly candidacyChoice: Availability
    })
  | (DecisionBase & {
      readonly kind: 'vouch'
      readonly groupId: GroupId
      readonly member: MemberRef
      readonly memberName: string | null
      readonly have: number
      readonly need: number
    })
  | (DecisionBase & { readonly kind: 'introduction'; readonly introducerId: ContactId; readonly label: string | null })

/** Outcome of a decision that is no longer open. A vanished prompt proves neither choice nor actor;
 *  without evidence (own completed intent or durable core data) it is 'unknown'. */
export interface DecisionResolution {
  readonly choice: 'accept' | 'decline' | 'expired' | 'unknown'
  readonly by: 'this-device' | 'other-device' | 'counterpart' | 'system' | 'unknown'
  readonly at: number
  readonly basis: 'own-act' | 'lib-record' | 'observed'
}

// ── Groups ──────────────────────────────────────────────────────────────────
export interface GroupListItem {
  readonly id: GroupId
  readonly name: string
  readonly role: 'founder' | 'member'
  readonly knownMembers: number
  readonly myHandle: string
  readonly openAdmissions: number
  readonly conversation: ConversationSummary
}

export interface GroupMember {
  readonly member: MemberRef
  readonly handle: string
  readonly self: boolean
  /** visible only with mutual trust */
  readonly contactId: ContactId | null
  readonly name: string | null
}

export interface Admission {
  readonly member: MemberRef
  /** only with a shown candidacy */
  readonly name: string | null
  readonly have: number
  readonly need: number
  readonly iVouched: boolean
  readonly vouch: Availability
}

export interface GroupDetail extends GroupListItem {
  readonly visibleMembers: readonly GroupMember[]
  readonly anonymousMembers: number
  readonly admissions: readonly Admission[]
  readonly invitesOut: readonly { readonly contactId: ContactId; readonly state: 'sent' | 'answered' }[]
  readonly listed: boolean
  readonly vouchThreshold: number
  readonly actions: { readonly invite: Availability; readonly leave: Availability; readonly report: Availability }
}

/** Own running admission (design "open candidacies"). */
export interface Candidacy {
  readonly groupName: string
  readonly inviterId: ContactId | null
  readonly have: number | null
  readonly need: number | null
  readonly state: 'waiting' | 'admitted' | 'expired'
}

// ── Profile, standing, visibility, blocked ──────────────────────────────────
export interface ProfileModel {
  readonly name: string | null
  readonly image: string | null
  readonly anchorShort: string
  /** revision not yet delivered everywhere */
  readonly pending: boolean
}
export interface TrustStandingSummary {
  readonly trustYou: number
  readonly youTrust: number
  readonly mutuallyVerified: number
  readonly groups: number
}
export interface VisibilityEntry {
  readonly contactId: ContactId
  readonly name: string | null
  readonly paused: boolean
}
export interface BlockedEntry {
  readonly target: SafetyTarget
  /** name or handle */
  readonly label: string
  readonly since: number
}

// ── Identity, connectivity, capabilities ────────────────────────────────────
export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'device-credential'

/** How the vault is protected. Stored unencrypted in the vault head (architecture §5.2). */
export type ProtectionMode =
  /** vault password = 32 random bytes, only in the keystore; the human knows none */
  | 'biometric-only'
  /** own passphrase, no biometrics */
  | 'passphrase'
  /** own passphrase, additionally in the keystore behind biometrics */
  | 'passphrase+biometric'

/** What the unlock flow needs to choose its path (architecture §4.2 "Entsperren", boot matrix). */
export interface LockInfo {
  readonly protection: ProtectionMode
  /** kind of biometrics available now, null if none */
  readonly biometric: BiometricKind | null
  /** keystore entry invalid or gone: with biometric-only only recovery remains */
  readonly biometricLost: boolean
  /** unauthenticated hint field (N8): biometrics last failed with invalidated/missing; ask for the passphrase first */
  readonly bioUnusable: boolean
  /** vault in an unknown format: only recovery or deleting remains */
  readonly unsupported: boolean
  /** passphrase mode, biometrics available, the one-time offer not dismissed */
  readonly offerBiometric: boolean
}

export type IdentityState =
  | { readonly status: 'booting' }
  | { readonly status: 'storage-blocked' }
  | { readonly status: 'crypto-unavailable'; readonly missing: readonly string[] }
  /** Gen-2 legacy data found; resume = a reset was interrupted, continue without showing the notice again */
  | { readonly status: 'legacy-gen2'; readonly resume: boolean }
  /** interrupted setup (marker setup/holder): unlock by the vault head, then finish the setup (boot matrix) */
  | ({ readonly status: 'resuming'; readonly step: 'setup' } & LockInfo)
  /** restore switched, the old namespace is being removed at boot */
  | { readonly status: 'resuming'; readonly step: 'restore-switch' }
  /** interrupted delete. before-seal: keys still there (offer to unlock for deregistration or delete without it);
   *  after-seal: the holder never opens again, the wipe continues */
  | { readonly status: 'resuming'; readonly step: 'wipe'; readonly phase: 'before-seal' | 'after-seal'; readonly lock: LockInfo | null }
  /** hint from the boot matrix: an interrupted setup was discarded, or the vault of the active identity is missing */
  | { readonly status: 'none'; readonly hint: 'setup-interrupted' | 'access-missing' | null }
  | ({ readonly status: 'locked' } & LockInfo)
  /** another tab holds the holder */
  | { readonly status: 'other-writer' }
  | {
      readonly status: 'unlocked'
      readonly anchorShort: string
      readonly protection: ProtectionMode
      readonly recovered: 'full' | 'keys-only' | null
      readonly termsAccepted: boolean
      /** biometrics available on this device now (for "change protection") */
      readonly biometric: BiometricKind | null
    }

export interface Connectivity {
  readonly network: 'online' | 'offline' | 'unknown'
  readonly carrier: 'connected' | 'connecting' | 'unreachable' | 'not-configured'
  /** own documents before the triad or in submitted */
  readonly queued: number
  readonly lastReceiveAt: number | null
  /** the last consistent bundle stays visible (architecture §3.1) */
  readonly projection: 'current' | 'behind'
  /** device clock below the high-water mark (architecture §3.4) */
  readonly clock: 'ok' | 'behind'
}

export interface Capabilities {
  readonly messaging: boolean
  readonly groupMessaging: boolean
  readonly report: boolean
  /** local: core documents still pass through (architecture §3.1) */
  readonly block: 'full' | 'local'
  readonly leaveGroup: boolean
  readonly vouchThresholdAboveOne: boolean
  readonly candidacyVisibility: boolean
  readonly introduce: 'later' | 'available'
  readonly push: boolean
}
// No DeviceSet and no multi-device switch: device management enters the port with E15.

/** An intent from the journal (architecture §3.4) as the UI sees it. No inputs, no secrets. */
export interface IntentView {
  readonly actId: ActId
  readonly command: CommandName
  /** e.g. 'c:…', 'g:…'; never an anchor */
  readonly target: string
  /** needs-confirmation: encounter act without evidence of its outcome; runs only after a renewed human confirmation */
  readonly state: 'journaled' | 'running' | 'outcome-unknown' | 'needs-confirmation' | 'partial' | 'expired'
  readonly since: number
  /** 'later' after the retry deadline */
  readonly retry: Availability
  /** only with needs-confirmation: what the human confirms again (card preview, no secrets) */
  readonly confirm?: { readonly kind: 'card'; readonly preview: CardPreview }
}
