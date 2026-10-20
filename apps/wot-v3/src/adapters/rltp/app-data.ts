// What the adapter keeps in app-db beside the library (architecture §2.9): values the library holds
// only in events or not in a view. Plain JSON; sealed by app-db.

import type { ConversationKey, DecisionResolution, SystemItem, SystemKind } from '../../port'

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
  readonly contacts: Readonly<Record<string, { readonly verification: string; readonly given: boolean; readonly received: boolean; readonly blocked: boolean }>>
  readonly prompts: Readonly<Record<string, { readonly contactId: string | null; readonly kind: string; readonly openedAt: number }>>
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

export const KV = {
  applied: 'applied',
  encounters: 'encounters',
  ledger: 'ledger',
  clock: 'clock',
} as const
