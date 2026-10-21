// Seed of a simulated world, in port terms (architecture §3.2): contacts with verification and
// trust, conversations, decisions, groups. No protocol bytes. Times are ISO strings with offset.

import type { ConversationKey, SystemItem, SystemKind, Verification } from '../../port'

export interface PersonSeed {
  readonly id: string
  readonly name: string
}

export interface ContactSeed {
  /** person id; doubles as ContactId in the simulation */
  readonly person: string
  readonly verification: Verification
  readonly trust: { readonly given: boolean; readonly received: boolean; readonly paused?: boolean }
  readonly metAt: string | null
  readonly introducedBy?: string
  readonly blocked?: boolean
}

/** Author of a seeded message: 'me', a person id, or an anonymous group member `member:<handle>`. */
export type SeedAuthor = 'me' | `member:${string}` | (string & {})

export type SeedItem =
  | {
      readonly t: 'msg'
      readonly from: SeedAuthor
      readonly text: string
      readonly at: string
      /** own messages: the design words of the prototype, plus held (waiting for connection) and failed */
      readonly status?: 'sending' | 'sent' | 'delivered' | 'held' | 'failed' | 'expired'
      /** index (in this conversation's items) of the message this one answers */
      readonly replyTo?: number
    }
  | {
      readonly t: 'sys'
      readonly system: SystemKind
      readonly at: string
      readonly basis?: SystemItem['basis']
      readonly values?: Readonly<Record<string, string | number>>
    }
  | { readonly t: 'decision'; readonly decision: string; readonly at: string }

export interface ConversationSeed {
  readonly key: ConversationKey
  readonly items: readonly SeedItem[]
}

export type DecisionSeed =
  | { readonly id: string; readonly openedAt: string; readonly kind: 'encounter-confirm'; readonly contact: string }
  | {
      readonly id: string
      readonly openedAt: string
      readonly kind: 'group-invite'
      readonly inviter: string
      readonly groupName: string | null
    }
  | {
      readonly id: string
      readonly openedAt: string
      readonly kind: 'vouch'
      readonly group: string
      readonly member: string
      readonly memberName: string | null
      readonly have: number
      readonly need: number
    }

export interface GroupSeed {
  readonly id: string
  readonly name: string
  readonly role: 'founder' | 'member'
  readonly knownMembers: number
  readonly myHandle: string
  readonly openAdmissions: number
}

export interface CandidacySeed {
  readonly groupName: string
  readonly inviter: string | null
  readonly have: number
  readonly need: number
}

export interface SimWorldSeed {
  readonly me: { readonly name: string; readonly anchorShort: string }
  readonly persons: readonly PersonSeed[]
  readonly contacts: readonly ContactSeed[]
  readonly groups: readonly GroupSeed[]
  readonly conversations: readonly ConversationSeed[]
  readonly decisions: readonly DecisionSeed[]
  readonly candidacies?: readonly CandidacySeed[]
  readonly unread?: Readonly<Partial<Record<ConversationKey, number>>>
}
