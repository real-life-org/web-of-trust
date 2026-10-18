// Diagnostic store (architecture §2.6). Core code, rule number and detail of an error live only
// here; errors carry only the DiagnosticId. Allowed importers: adapters (writing), harness/ and
// app/error-report (reading). Enforced by .dependency-cruiser.cjs. Holds no secrets and no
// message texts; cleared on lock.

import type { DiagnosticId } from './errors'

export interface DiagnosticEntry {
  readonly id: DiagnosticId
  readonly at: number
  /** e.g. the core error code */
  readonly code: string
  /** e.g. a rule reference like RLTP-ENC-5460 */
  readonly ref?: string
  readonly detail?: string
}

export interface DiagnosticStore {
  record(entry: Omit<DiagnosticEntry, 'id'>): DiagnosticId
  read(id: DiagnosticId): DiagnosticEntry | null
  clear(): void
}
