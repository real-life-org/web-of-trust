/**
 * Replay-Schutz über bereits verarbeitete Inbox-Message-IDs (Sync 003 Z.466 MUSS):
 * `id` DARF nicht bereits VERARBEITET worden sein (Message-ID-History) — die zweite
 * Replay-Verteidigung neben dem `created_time`-Fenster des Inner-JWS (Z.465).
 *
 * "Verarbeitet" ist über die ACK-Vorbedingung 4 (Sync 003 Z.620-622) definiert:
 * lokaler State angewendet ODER durabel in der Pending-Inbox gepuffert. Deshalb
 * trennt der Port die lesende Replay-Prüfung bei der Reception (`has`) vom
 * Recorden am konklusiven Dispositions-Punkt (`checkAndRecord`) — eine Reception
 * ohne konklusiven Ausgang darf die Relay-Redelivery nicht als Replay verbrennen.
 *
 * Der Inner-JWS-Verifier ist pure (Prüfungen 1-4); Prüfung 5 macht der
 * Reception-Workflow über diesen Port. Die Referenzimplementierung liefert einen
 * In-Memory-Default (adapters/message-id-history); eine Produktions-App verdrahtet
 * einen durablen Store (1.D Demo-Hooks).
 */
export interface MessageIdHistoryPort {
  /**
   * Lesende Replay-Prüfung bei der Reception (Sync 003 Z.466 + Z.620-622):
   * recorded NICHTS. `nowIso` dient der Auswertung des Retention-Fensters.
   *
   * @returns `true` wenn die id bereits verarbeitet wurde (Replay → Nachricht
   *          verwerfen), `false` wenn sie unbekannt ist.
   */
  has(id: string, nowIso: string): Promise<boolean>

  /**
   * Markiert `id` als verarbeitet — aufzurufen erst bei konklusivem Ausgang
   * (angewendet / durabel gepuffert / deterministisch ungültig verworfen,
   * Sync 003 Z.466 + Z.620-622). Prüft und markiert atomar im selben Aufruf.
   *
   * @returns `true` wenn die id schon bekannt war (Duplikat-Record, harmlos),
   *          `false` wenn sie neu ist und jetzt als verarbeitet gilt.
   */
  checkAndRecord(id: string, nowIso: string): Promise<boolean>

  /**
   * Entfernt Einträge, die älter als `cutoffIso` sind (Retention ab Erstsicht,
   * Sync 003 Z.465 analog Nonce-History). Pflichtprüfung 4 ist beidseitig
   * (maxAgeMs zurück, maxClockSkewMs nach vorn): eine Nachricht, deren id aus
   * der History fällt, ist nur dann sicher nicht erneut zustellbar, wenn die
   * Retention mindestens maxAgeMs + maxClockSkewMs beträgt — created_time kann
   * bis maxClockSkewMs nach der Erstsicht liegen. Aufrufer wählen den Cutoff
   * entsprechend (Referenz-Default: InMemoryMessageIdHistory).
   */
  prune(cutoffIso: string): Promise<void>
}
