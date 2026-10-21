// The adapter's diagnostic store (architecture §2.6, port/diagnostics.ts): codes and rule references
// of what the adapter met, never secrets, message texts or contact ids. In memory, the last 100
// entries, cleared when no session is current (lock). Every field passes the redaction of
// lib/error-filter.ts on the way in, so a detail built from a core error cannot carry key material.

import type { DiagnosticEntry, DiagnosticStore } from '../../port/diagnostics'
import type { DiagnosticId } from '../../port/errors'
import { redactText } from '../../lib/error-filter'

export interface DiagnosticLog extends DiagnosticStore {
  /** every entry kept, oldest first (tests and the harness) */
  list(): readonly DiagnosticEntry[]
}

export function diagnosticLog(uuid: () => string, limit = 100): DiagnosticLog {
  let entries: DiagnosticEntry[] = []
  return {
    record(entry) {
      const id = uuid() as DiagnosticId
      const clean: DiagnosticEntry = {
        id,
        at: entry.at,
        code: redactText(entry.code),
        ...(entry.ref !== undefined ? { ref: redactText(entry.ref) } : {}),
        ...(entry.detail !== undefined ? { detail: redactText(entry.detail) } : {}),
      }
      entries = [...entries, clean].slice(-limit)
      return id
    },
    read: (id) => entries.find((e) => e.id === id) ?? null,
    clear() {
      entries = []
    },
    list: () => entries,
  }
}
