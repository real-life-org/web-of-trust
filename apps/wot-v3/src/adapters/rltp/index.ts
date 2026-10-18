// The real adapter on @real-life/trust-protocol (architecture §3.1). The only place in src/ that may
// import the library (enforced by .dependency-cruiser.cjs and ESLint). Pinned to 0.4.0 exactly.
//
// Scaffold state: the module compiles against the published types; creating the port throws
// NotImplementedError. What the adapter needs from the library beyond 0.4.0 is listed in TODO.md
// next to this file (architecture §3.1 "Lib-Anforderungen").

import type { ContactView, Holder, HolderEvent } from '@real-life/trust-protocol'
import { createHolder, seedKeys } from '@real-life/trust-protocol'
import type { AppPort } from '../../port'
import type { Platform } from '../../platform/ports'

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`adapters/rltp: ${what} is not implemented yet`)
    this.name = 'NotImplementedError'
  }
}

/**
 * Planned lifecycle (runtime.ts, architecture §3.1): open vault → seedKeys(rootIkm) → createHolder
 * with the IndexedDB store → subscribe → timers; session generations and phased shutdown (§2.1 rule 9);
 * write gate (gate.ts), projection (projection/), app-db, command service with intent journal (§3.4).
 */
export function createRltpPort(platform: Platform): AppPort {
  void platform
  throw new NotImplementedError('createRltpPort')
}

/** Kept referenced so the type-level binding to the pinned library is compiled in CI. */
export const LIBRARY_ENTRY_POINTS = { createHolder, seedKeys } as const
export type LibraryTypes = { holder: Holder; contact: ContactView; event: HolderEvent }
