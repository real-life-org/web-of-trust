// What the adapter keeps in app-db beside the library (architecture §2.9): values the library holds
// only in events or not in a view. Plain JSON; sealed by app-db.

import type { ConversationKey, DecisionResolution, DeliveryState, SystemItem, SystemKind } from '../../port'

/** Encounter cache (§2.9 rows "eigene QR-Karte", "gesendete Karte", metAt/lastMetAt). */
export interface EncounterCache {
  /** own displayed cards by challenge value */
  readonly own: Readonly<Record<string, { readonly qr: string; readonly issuedAt: number; readonly expiresAt: number }>>
  /** sent cards per contact until mutual (the optical return path) */
  readonly sent: Readonly<Record<string, { readonly qr: string }>>
  /** first and last encounter per contact, from encounter.recorded / contact.chained */
  readonly met: Readonly<Record<string, { readonly metAt: number; readonly lastMetAt: number }>>
  /** sent card anchor → contact, from own optical captures (a repeated capture reports no contact, N9) */
  readonly capturedBy?: Readonly<Record<string, string>>
}

export const EMPTY_ENCOUNTERS: EncounterCache = { own: {}, sent: {}, met: {} }

/** The projection ledger (§2.9 "SystemItem"): the last booked extract per contact and the prompts
 *  seen, so the next sync books what changed as an observed line. */
export interface Ledger {
  readonly contacts: Readonly<Record<string, LedgerContact>>
  readonly prompts: Readonly<Record<string, { readonly contactId: string | null; readonly kind: string; readonly openedAt: number }>>
}

/** One booked contact. `name` and `image` are the profile last shown: kept as they were while the
 *  contact is blocked, so a profile update under a block is processed but never shown (Message Tasks
 *  6230, `profile/0.1` "process, do not show"); absent in entries booked before they existed. */
export interface LedgerContact {
  readonly verification: string
  readonly given: boolean
  readonly received: boolean
  readonly blocked: boolean
  readonly name?: string | null
  readonly image?: string | null
}

export const EMPTY_LEDGER: Ledger = { contacts: {}, prompts: {} }

/** A conversation line the adapter owns (log store). */
export type LogLine =
  | {
      readonly kind: 'system'
      readonly id: string
      readonly key: ConversationKey
      readonly at: number
      readonly system: SystemKind
      readonly basis: SystemItem['basis']
      readonly subject?: string
    }
  | {
      readonly kind: 'decision'
      readonly id: string
      readonly key: ConversationKey
      readonly at: number
      readonly decision: string
      /** written with the own deciding intent (§3.4 step 4): survives the journal's clean-up */
      readonly resolution?: DecisionResolution
    }
  | MessageLine

/** A message in the app's history (architecture §2.9 "MessageItem"): received ones taken over from
 *  the library's inbox (id `msg:in:<inbox id>`), own ones from the send intent (`msg:out:<draftKey>`).
 *  `at` is the display time: min(sentAt, receivedAt) for received (Message Tasks 4430), sentAt for own. */
export interface MessageLine {
  readonly kind: 'message'
  readonly id: string
  readonly key: ConversationKey
  readonly at: number
  readonly dir: 'in' | 'out'
  readonly contactId: string
  readonly text: string
  /** null while an own message is held unsent */
  readonly mid: string | null
  readonly replyTo: string | null
  readonly sentAt: number
  readonly receivedAt: number | null
  /** own: the document digest whose sender status deliveryStatus answers */
  readonly digest: string | null
  /** own: the draft key of the composer (dedupe) */
  readonly draftKey: string | null
  /** own: why the app holds it unsent */
  readonly held: Extract<DeliveryState, { phase: 'held' }>['reason'] | null
  /** own: the last sender status read inside a fence */
  readonly status: DeliveryState | null
}

/** Where a line stands in its conversation: display time, then system before decision before
 *  message, then mid (messages, 4430) or id. One key for the order, the read mark and unread (R1-4). */
export interface OrderKey {
  readonly at: number
  readonly rank: number
  readonly tie: string
}

export function orderKey(l: LogLine): OrderKey {
  return { at: l.at, rank: l.kind === 'system' ? 0 : l.kind === 'decision' ? 1 : 2, tie: l.kind === 'message' ? (l.mid ?? l.id) : l.id }
}

export function compareOrder(a: OrderKey, b: OrderKey): number {
  return a.at - b.at || a.rank - b.rank || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0)
}

/** Read marks per conversation (architecture §2.9 "unread"): the order key of the last item shown. */
export type ReadMarks = Readonly<Record<string, OrderKey>>

export const KV = {
  applied: 'applied',
  encounters: 'encounters',
  ledger: 'ledger',
  clock: 'clock',
  reads: 'reads',
} as const
