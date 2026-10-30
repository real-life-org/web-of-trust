// Diagnostic store (architecture §2.6). Core code, rule number and detail of an error live only
// here; errors carry only the DiagnosticId. Allowed importers: adapters (writing), harness/ and
// app/error-report (reading). Enforced by .dependency-cruiser.cjs. Holds no secrets and no
// message texts; cleared on lock.

import type { DiagnosticId } from './errors'

/** The closed catalog of diagnostic codes the adapters record (review 434: a free code field is a
 *  way around the redaction). A new code joins here. 'unknown-code' stands for a value outside the
 *  catalog that reached the store around the type system. */
export const DIAGNOSTIC_CODES = [
  'holder-close-timeout',
  'contact-order-invalid-journal',
  // the VTI wire refused a frame for good (RLTP-VTI-7140): the detail names its kind (a frame of another
  // TSP version: that version, e.g. `frame/version Rev 3 (YTSP-AAC)`); a sender only shortened
  // (`did:key:z6Mk…xxxx`), for a displayed card's instance and for a frame of another version
  'wire-frame-refused',
  // the mediator answered a deposit with a problem report (RLTP-VTI-3120, §5): the detail is
  // `direct/<code>`, with ` locked` for e.p.direct_delivery.denied, after which the relationship's
  // deposits in mode direct are retriable carrier refusals
  'wire-deposit-refused',
  // the adapter acknowledged a payload or an answer without delivering it (RLTP-VTI-5040, 7160): no
  // envelope, an answer that binds nothing or not from the recipient of the document it names; the
  // detail is the library's line, every identifier shortened (`did:key:z6Mk…xxxx`)
  'carrier-adapter-log',
  // the counterpart answered a carried document `indeterminate` (trust-task-error/0.6, RLTP-VTI-5020):
  // never a refusal, the document's state is unchanged; recorded when the answer is concluded
  // (acknowledged at the mediator); the detail is `retryable true` or `retryable false`
  'carrier-answer-indeterminate',
  // the library refused a persisted ack state (fail-closed): the relationship is not carried in this opening
  'carrier-ack-state-refused',
  // an ack state could not be written: the next change writes again
  'carrier-ack-state-unsaved',
  // a frame at a displayed card's instance was dropped before its binding (RLTP-VTI-1265): the detail names why and the
  // sender, which the redaction of lib/error-filter.ts removes on the way in
  'carrier-card-frame-refused',
  // the frame that carried a displayed card's bundle came from another sender than the connection DID
  // the sent card's hint names: a diagnosis only, the instance binds to the hint (RLTP-VTI-1255); the
  // detail names the sender, redacted on the way in
  'carrier-hint-mismatch',
  // the library refused the stored holder state at an opening (fail-closed): the detail is its
  // StateCodecError code (lib 0.9.0: `codec-type-uri` for a state of the earlier Type URIs)
  'holder-state-refused',
  /** the personal community could not be founded at the opening (the library's refusal in detail) */
  'community-not-founded',
  'unknown-code',
] as const
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number]

export interface DiagnosticEntry {
  readonly id: DiagnosticId
  readonly at: number
  /** a code of the closed catalog */
  readonly code: DiagnosticCode
  /** e.g. a rule reference like RLTP-ENC-5460 */
  readonly ref?: string
  readonly detail?: string
}

export interface DiagnosticStore {
  record(entry: Omit<DiagnosticEntry, 'id'>): DiagnosticId
  read(id: DiagnosticId): DiagnosticEntry | null
  clear(): void
}
