// The adapter's diagnostic store (architecture §2.6, port/diagnostics.ts): codes and rule references
// of what the adapter met, never secrets, message texts or contact ids. In memory, the last 100
// entries, cleared when no session is current (lock).

import type { DiagnosticEntry, DiagnosticStore } from '../../port/diagnostics'
import type { DiagnosticId } from '../../port/errors'

export interface DiagnosticLog extends DiagnosticStore {
  /** every entry kept, oldest first (tests and the harness) */
  list(): readonly DiagnosticEntry[]
}

export function diagnosticLog(uuid: () => string, limit = 100): DiagnosticLog {
  let entries: DiagnosticEntry[] = []
  return {
    record(entry) {
      const id = uuid() as DiagnosticId
      entries = [...entries, { ...entry, id }].slice(-limit)
      return id
    },
    read: (id) => entries.find((e) => e.id === id) ?? null,
    clear() {
      entries = []
    },
    list: () => entries,
  }
}
