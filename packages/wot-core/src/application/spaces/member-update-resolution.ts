import type { MemberUpdateSignal, SeenMemberUpdateSignal } from '../../protocol/sync/member-update-disposition'
import { resolveMembershipWinner, type MembershipEvent } from '../../protocol/sync/membership-events'

export interface ResolveMemberUpdatesAgainstCanonicalInput {
  /** Pending-Signale aus `MemberUpdatePendingStore.listSeenForSpace` */
  pending: readonly SeenMemberUpdateSignal[]
  /** Aktive DIDs der kanonischen Mitgliederliste (VE-1-Lese-Regel `resolveActiveMembers`) */
  canonicalActiveMembers: readonly string[]
  localDid: string
}

export interface MemberUpdateResolution {
  /** Sync 005 Z.196-197: kanonisch bestaetigte Pending-Updates */
  confirmed: MemberUpdateSignal[]
  /** Sync 005 Z.198: widersprochene Pending-Updates — verwerfen, kanonischen State behalten */
  discarded: MemberUpdateSignal[]
  /** Sync 005 Z.253 Weg (a): eigene Entfernung kanonisch bestaetigt → Cleanup-Trigger */
  localRemovalConfirmed: boolean
}

/**
 * Loest Pending-member-updates gegen die kanonische Mitgliederliste auf.
 *
 * Sync 005 Z.194-198 (MUSS):
 * "Nach dem naechsten Space-Sync MUSS der Client Pending-Updates gegen die kanonische
 * Mitgliederliste aufloesen:
 * - Wenn `action="added"` und die kanonische Mitgliederliste `memberDid` enthaelt,
 *   MUSS der Client die Hinzufuegung als bestaetigt behandeln.
 * - Wenn `action="removed"` und die kanonische Mitgliederliste `memberDid` nicht
 *   enthaelt, MUSS der Client die Entfernung als bestaetigt behandeln.
 * - Wenn die kanonische Mitgliederliste dem Pending-Update widerspricht, MUSS der
 *   Client das Pending-Update verwerfen und den kanonischen Membership-State beibehalten."
 *
 * `localRemovalConfirmed` bildet Sync 005 Z.253 Weg (a) ab: "Entfernte Members duerfen
 * `member-update(action="removed")` erst als dauerhaften lokalen Austritt behandeln,
 * wenn der naechste Space-Sync die kanonische Mitgliederliste ohne diese DID bestaetigt
 * […]" — es wird also nur gesetzt, wenn ein Pending-Removal fuer `localDid` bestaetigt
 * wurde; kanonische Abwesenheit allein (ohne Pending-Signal) traegt keinen Cleanup.
 *
 * Pure Funktion, kein Storage: die Adapter rufen sie bei jeder kanonischen Aenderung
 * der Mitgliederliste auf, persistieren confirmed/discarded via `resolvePending` und
 * triggern bei `localRemovalConfirmed` den Cleanup (leaveSpace-Mechanik). Die
 * Rueckgabe-Arrays referenzieren die uebergebenen Signal-Objekte.
 */
export function resolveMemberUpdatesAgainstCanonical(
  input: ResolveMemberUpdatesAgainstCanonicalInput,
): MemberUpdateResolution {
  const canonical = new Set(input.canonicalActiveMembers)
  const confirmed: MemberUpdateSignal[] = []
  const discarded: MemberUpdateSignal[] = []
  let localRemovalConfirmed = false

  for (const signal of input.pending) {
    const isCanonicalMember = canonical.has(signal.memberDid)
    const isConfirmed = signal.action === 'added' ? isCanonicalMember : !isCanonicalMember
    if (isConfirmed) {
      confirmed.push(signal)
      if (signal.action === 'removed' && signal.memberDid === input.localDid) {
        localRemovalConfirmed = true
      }
    } else {
      discarded.push(signal)
    }
  }

  return { confirmed, discarded, localRemovalConfirmed }
}

/**
 * Review-M1 (Sync 005 Z.194/Z.253): prueft, ob das kanonische Membership-
 * Event-Set die Antwort auf ein Pending-Signal BEREITS traegt.
 *
 * Hintergrund: trifft die kanonische Aenderung VOR dem member-update ein (per
 * Z.231-Design die haeufigste Online-Reihenfolge — das Doc-Update reist vor der
 * Rotation und ist mit dem alten Key entschluesselbar), laeuft die Observer-
 * Resolution mit leerer Pending-Liste; das danach gespeicherte Pending wuerde
 * ohne diese Pruefung NIE aufgeloest (Resolution-Deadlock).
 *
 * Kriterium: die Antwort steht fest, wenn das zum Pending gehoerende kanonische
 * Event (`active@N` fuer added, `removed@N` fuer removed) den aktuellen
 * Gewinner fuer die DID nach der Z.305-Lese-Regel (hoehere Generation gewinnt,
 * Tie-Break removed) nicht mehr kippen koennte. Nur dann darf ein Adapter das
 * Pending sofort (nach savePending bzw. beim Restore) gegen die aktuelle
 * Projektion aufloesen — andernfalls bleibt es offen, bis der naechste
 * Space-Sync die vollstaendige Aufloesung uebernimmt (Z.194, Observer-Pfad).
 */
export function canonicalEventSetAnswersPending(
  events: Iterable<MembershipEvent>,
  signal: MemberUpdateSignal,
): boolean {
  const winner = resolveMembershipWinner(events, signal.memberDid)
  if (winner === undefined) return false
  if (winner.sinceGeneration > signal.effectiveKeyGeneration) return true
  if (winner.sinceGeneration < signal.effectiveKeyGeneration) return false
  // Generation-Gleichstand: removed gewinnt den Tie-Break — ein removed-Gewinner
  // steht damit fest; ein active-Gewinner koennte von removed@N (Pending-Event
  // einer removal) noch gekippt werden, von active@N (added) nicht.
  return winner.status === 'removed' || signal.action === 'added'
}
