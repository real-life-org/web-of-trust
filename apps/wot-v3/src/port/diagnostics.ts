// Diagnostic store (architecture §2.6). Core code, rule number and detail of an error live only
// here; errors carry only the DiagnosticId. Allowed importers: adapters (writing), harness/ and
// app/error-report (reading). Enforced by .dependency-cruiser.cjs. Holds no secrets and no
// message texts; cleared on lock.

import type { DiagnosticId } from './errors'

/** The closed catalog of diagnostic codes the adapters record (review 434: a free code field is a
 *  way around the redaction). A new code joins here. 'unknown-code' stands for a value outside the
 *  catalog that reached the store around the type system. */
export const DIAGNOSTIC_CODES = ['holder-close-timeout', 'contact-order-invalid-journal', 'unknown-code'] as const
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
