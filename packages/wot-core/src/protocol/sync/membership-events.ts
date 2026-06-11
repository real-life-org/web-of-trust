/**
 * Doc-internes Membership-Event-Set fuer die kanonische Mitgliederliste (Sync 005).
 *
 * Sync 005 Z.163: "Empfaenger MUESSEN `member-update` gegen den naechsten Space-Sync
 * verifizieren. Die kanonische Mitgliederliste bleibt das signierte und synchronisierte
 * Space-Dokument. `member-update` allein DARF keine dauerhafte Membership-State-Aenderung
 * erzwingen."
 *
 * Die Liste lebt als grow-only Event-Set im synchronisierten Space-Dokument: Eintraege
 * werden ausschliesslich hinzugefuegt, nie ueberschrieben oder geloescht. Konkurrierende
 * Schreiber treffen verschiedene Keys (`${did}:${generation}:${status}`), die CRDT-Merge-
 * Semantik kann strukturell nichts verlieren; derselbe Key zweimal geschrieben traegt
 * denselben semantischen Inhalt (idempotent). Die spec-sichtbare Form bleibt die
 * `members: string[]`-Projektion (Sync 005 Z.109-130) via `resolveActiveMembers`.
 */

export type MembershipStatus = 'active' | 'removed'

export interface MembershipEvent {
  did: string
  status: MembershipStatus
  /** Key-Generation, ab der dieser Status gilt */
  sinceGeneration: number
  /** informativ, KEIN Autoritaetstraeger */
  addedBy?: string
}

/** Die DID-Anteile des Event-Keys; `addedBy` reist nur im Event-Value, nie im Key. */
export type MembershipEventKeyParts = Pick<MembershipEvent, 'did' | 'sinceGeneration' | 'status'>

const DID_PATTERN = /^did:[a-z0-9]+:.+/
// Kanonische Dezimalform ohne fuehrende Nullen — Key-Identitaet muss eindeutig sein.
const CANONICAL_GENERATION_PATTERN = /^(0|[1-9][0-9]*)$/

/**
 * Formatiert den Event-Key `${did}:${generation}:${status}`.
 * DIDs enthalten selbst ":" — der Codec bleibt eindeutig, weil Generation und Status
 * als festes SUFFIX (letzte zwei Segmente) angehaengt und geparst werden.
 */
export function formatMembershipEventKey(parts: MembershipEventKeyParts): string {
  assertMembershipDid(parts.did, 'membership-event did')
  assertNonNegativeInteger(parts.sinceGeneration, 'membership-event sinceGeneration')
  assertMembershipStatus(parts.status)
  return `${parts.did}:${parts.sinceGeneration}:${parts.status}`
}

/**
 * Parst den Event-Key robust ueber das SUFFIX: letztes Segment = Status,
 * vorletztes Segment = Generation, der Rest (inkl. aller ":") ist die DID.
 */
export function parseMembershipEventKey(key: string): MembershipEventKeyParts {
  if (typeof key !== 'string') throw new Error('Invalid membership-event key')
  const lastSeparator = key.lastIndexOf(':')
  if (lastSeparator === -1) throw new Error('Invalid membership-event key')
  const secondLastSeparator = key.lastIndexOf(':', lastSeparator - 1)
  if (secondLastSeparator === -1) throw new Error('Invalid membership-event key')

  const did = key.slice(0, secondLastSeparator)
  const generationSegment = key.slice(secondLastSeparator + 1, lastSeparator)
  const statusSegment = key.slice(lastSeparator + 1)

  assertMembershipDid(did, 'membership-event key did')
  if (!CANONICAL_GENERATION_PATTERN.test(generationSegment)) {
    throw new Error('Invalid membership-event key generation')
  }
  assertMembershipStatus(statusSegment)

  return { did, sinceGeneration: Number(generationSegment), status: statusSegment }
}

/**
 * Lese-Regel der kanonischen Mitgliederliste: pro DID gewinnt das Event mit der
 * hoechsten `sinceGeneration` (Sync 005 Z.305: "Wenn Einladung und Entfernung
 * konkurrieren, gewinnt die hoehere Key-Generation."). Aktiv ⇔ Gewinner-Event hat
 * `status: 'active'`.
 *
 * Rueckgabe ist die spec-sichtbare `members: string[]`-Projektion (Sync 005 Z.109-130),
 * lexikographisch sortiert — das Event-Set traegt keine Ordnung (CRDT-Map-Keys),
 * die Projektion muss auf allen Peers deterministisch identisch sein.
 */
export function resolveActiveMembers(events: Iterable<MembershipEvent>): string[] {
  const winners = new Map<string, MembershipEvent>()
  for (const event of events) {
    const incumbent = winners.get(event.did)
    if (incumbent === undefined || membershipEventWins(event, incumbent)) {
      winners.set(event.did, event)
    }
  }
  const active: string[] = []
  for (const winner of winners.values()) {
    if (winner.status === 'active') active.push(winner.did)
  }
  return active.sort()
}

/**
 * Gewinner-Event fuer EINE DID nach derselben Lese-Regel wie `resolveActiveMembers`
 * (hoechste `sinceGeneration`, Tie-Break removed). `undefined`, wenn das Event-Set
 * keine Events fuer die DID traegt. Grundlage der Review-M1-Pruefung, ob das
 * Event-Set die Antwort auf ein Pending-member-update bereits enthaelt
 * (`canonicalEventSetAnswersPending`).
 */
export function resolveMembershipWinner(events: Iterable<MembershipEvent>, did: string): MembershipEvent | undefined {
  let winner: MembershipEvent | undefined
  for (const event of events) {
    if (event.did !== did) continue
    if (winner === undefined || membershipEventWins(event, winner)) {
      winner = event
    }
  }
  return winner
}

// Bei Generation-Gleichstand gewinnt 'removed': konservativer Tie-Break, ein entfernter
// Member bleibt draussen — die Spec definiert den Gleichstand nicht. Der Re-Invite-Pfad
// muss deshalb VOR dem erneuten addMember rotieren (Re-Invite-Guard, sicherheitlich
// ohnehin geboten: der zuvor Entfernte kennt die alten Keys).
// SPEC-UNKLAR: Doc-interne Listen-Form vs. Z.305, Issue folgt im PR
function membershipEventWins(candidate: MembershipEvent, incumbent: MembershipEvent): boolean {
  if (candidate.sinceGeneration !== incumbent.sinceGeneration) {
    return candidate.sinceGeneration > incumbent.sinceGeneration
  }
  return candidate.status === 'removed' && incumbent.status === 'active'
}

export function assertMembershipEvent(value: unknown): asserts value is MembershipEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid membership-event')
  }
  const event = value as Record<string, unknown>
  const allowed = new Set(['did', 'status', 'sinceGeneration', 'addedBy'])
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) throw new Error(`Invalid membership-event property: ${key}`)
  }
  assertMembershipDid(event.did, 'membership-event did')
  assertMembershipStatus(event.status)
  assertNonNegativeInteger(event.sinceGeneration, 'membership-event sinceGeneration')
  if (event.addedBy !== undefined) assertMembershipDid(event.addedBy, 'membership-event addedBy')
}

function assertMembershipStatus(value: unknown): asserts value is MembershipStatus {
  if (value !== 'active' && value !== 'removed') throw new Error('Invalid membership-event status')
}

function assertMembershipDid(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !DID_PATTERN.test(value)) throw new Error(`Invalid ${name}`)
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`)
}
