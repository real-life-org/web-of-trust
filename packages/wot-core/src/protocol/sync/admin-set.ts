/**
 * Doc-internes Admin-Set fuer die kanonische Admin-Liste (Sync 005 Z.111-130, Z.221).
 *
 * Sync 005 Z.111-130: "`admins` enthaelt die Haupt-DIDs der Admins (Teilmenge von
 * `members`)". Z.221: "Ein Admin DARF einen bestehenden Member zum Admin befoerdern.
 * Dafuer wird die Admin-Liste im CRDT um die Haupt-DID des neuen Admins erweitert."
 *
 * Das Set lebt als grow-only Add-only-Set im synchronisierten Space-Dokument: Eintraege
 * werden ausschliesslich hinzugefuegt, nie ueberschrieben oder geloescht. Sync 005
 * beschreibt nur Promotion (Z.221), keinen admin-remove-Flow → keine Tombstones,
 * keine Demotion (deferred). Konkurrierende Promotion derselben DID treffen denselben
 * DID-Key (`_admins[did]`), die CRDT-Merge-Semantik kann strukturell nichts verlieren;
 * derselbe Key zweimal geschrieben traegt denselben semantischen Inhalt (idempotent).
 *
 * Die spec-sichtbare Form ist die `admins: string[]`-Projektion der AKTIVEN Admins
 * (Sync 005 Z.130 "Teilmenge von members") via `resolveActiveAdmins`. `_admins` ist
 * grow-only und kennt keine Entfernung — aber Members werden entfernt; ein als Member
 * entfernter Admin DARF nicht weiterzaehlen. Deshalb schneidet `resolveActiveAdmins`
 * das Set immer mit den aktiven Members, ohne `_admins` anzufassen.
 */

export interface AdminEntry {
  did: string
  /** informativ, KEIN Autoritaetstraeger (wie membership `addedBy`) */
  addedBy?: string
}

const DID_PATTERN = /^did:[a-z0-9]+:.+/

/**
 * Lese-Regel des Admin-Sets: die DIDs aller Eintraege, dedupliziert (grow-only Set,
 * pro DID genau ein Admin) und lexikographisch sortiert. Das Set traegt keine
 * Ordnung (CRDT-Map-Keys), die Projektion muss auf allen Peers deterministisch
 * identisch sein.
 */
export function resolveAdmins(entries: Iterable<AdminEntry>): string[] {
  const dids = new Set<string>()
  for (const entry of entries) {
    dids.add(entry.did)
  }
  return Array.from(dids).sort()
}

/**
 * Spec-sichtbare Projektion der AKTIVEN Admins (Sync 005 Z.130 "Teilmenge von
 * members"): `resolveAdmins(adminEntries) ∩ activeMembers`. Ein im grow-only
 * `_admins`-Set stehender, aber als Member entfernter Admin faellt automatisch
 * heraus — die Member-Removal entzieht die Admin-Autoritaet, ohne `_admins`
 * anzufassen. Ergebnis ist dedupliziert und lexikographisch sortiert.
 */
export function resolveActiveAdmins(adminEntries: Iterable<AdminEntry>, activeMembers: Iterable<string>): string[] {
  const active = new Set<string>(activeMembers)
  const result = new Set<string>()
  for (const did of resolveAdmins(adminEntries)) {
    if (active.has(did)) result.add(did)
  }
  return Array.from(result).sort()
}

export function assertAdminEntry(value: unknown): asserts value is AdminEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid admin-entry')
  }
  const entry = value as Record<string, unknown>
  const allowed = new Set(['did', 'addedBy'])
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) throw new Error(`Invalid admin-entry property: ${key}`)
  }
  assertAdminDid(entry.did, 'admin-entry did')
  if (entry.addedBy !== undefined) assertAdminDid(entry.addedBy, 'admin-entry addedBy')
}

function assertAdminDid(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !DID_PATTERN.test(value)) throw new Error(`Invalid ${name}`)
}
