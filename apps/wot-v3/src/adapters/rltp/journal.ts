// The intent journal record (architecture §3.4): one per human gesture, in app-db `intents`, written
// before the first effect. Inputs are the canonical, frozen form the library hashes; secrets never
// go in. A finished intent keeps only its outcome.

import type { ActId, AppError, CardPreview, CommandName } from '../../port'

/** replay: re-run with the same actId; confirm-again: encounter acts, never run without the human
 *  again (N3); discard: showCard, never re-run */
export type IntentPolicy = 'replay' | 'confirm-again' | 'discard'

export type IntentState = 'journaled' | 'running' | 'outcome-unknown' | 'needs-confirmation' | 'partial' | 'expired' | 'done'

export interface IntentRecord {
  readonly actId: ActId
  readonly command: CommandName
  /** 'c:…', a decision id, …; never an anchor */
  readonly target: string
  readonly policy: IntentPolicy
  /** the dedupe key of the gesture (§3.4 step 1): while this record is open, the same gesture finds it
   *  again, also after a restart (review 421 R1-1) */
  readonly dedupe?: string
  readonly state: IntentState
  /** canonical inputs; removed when done */
  readonly input: Readonly<Record<string, unknown>> | null
  /** the act's time, journaled once and reused by every repeat (§2.7 rule 1) */
  readonly when: number
  readonly createdAt: number
  readonly attempts: number
  /** what the human confirms again (needs-confirmation only) */
  readonly preview?: CardPreview
  readonly outcome?: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: AppError }
  readonly finishedAt?: number
}

/** The library's retry horizon by default. An open record is settled through the library's act journal
 *  (holder.replay) until one day before its retention, max(P90D, horizon) (session.ts). */
export const RETRY_HORIZON_MS = 7 * 86_400_000
/** finished entries are dropped after seven days (§3.4 step 4) */
export const DONE_RETENTION_MS = 7 * 86_400_000

export const isOpen = (r: IntentRecord): boolean => r.state !== 'done' && r.state !== 'expired'
