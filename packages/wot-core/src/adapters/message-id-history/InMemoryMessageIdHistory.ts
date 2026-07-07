import type { MessageIdHistoryPort } from '../../ports/MessageIdHistory'
import {
  INBOX_INNER_JWS_DEFAULT_MAX_AGE_MS,
  INBOX_INNER_JWS_DEFAULT_MAX_CLOCK_SKEW_MS,
} from '../../protocol/messaging/inbox-inner-jws'

// Sync 003 Z.465: Retention analog Nonce-History. Pflichtprüfung 4 ist
// beidseitig (maxAgeMs zurück, maxClockSkewMs nach vorn) — damit eine aus der
// History geprunte id sicher nicht erneut annehmbar ist, muss die Retention
// maxAgeMs + maxClockSkewMs abdecken (created_time darf bis maxClockSkewMs
// nach der Erstsicht liegen).
export const MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS =
  INBOX_INNER_JWS_DEFAULT_MAX_AGE_MS + INBOX_INNER_JWS_DEFAULT_MAX_CLOCK_SKEW_MS

export interface InMemoryMessageIdHistoryOptions {
  /** Retention-Fenster in Millisekunden; Default 24h + Clock-Skew (Sync 003 Z.465). */
  retentionMs?: number
}

function parseIsoMs(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO timestamp for ${field}: ${iso}`)
  return ms
}

/**
 * Referenz-Default für MessageIdHistoryPort — in-memory (Pattern analog
 * InMemoryMemberUpdatePendingStore). Eine Produktions-App verdrahtet einen
 * durablen Store (1.D Demo-Hooks).
 *
 * Defensiv: jeder checkAndRecord-Aufruf räumt Einträge außerhalb des
 * Retention-Fensters mit ab, damit der Speicher auch ohne explizite
 * prune-Aufrufe nicht unbegrenzt wächst.
 */
export class InMemoryMessageIdHistory implements MessageIdHistoryPort {
  /** Message-ID → Erstsicht-Zeitpunkt (ms). Replays frischen den Zeitstempel NICHT auf. */
  private readonly seenAtMs = new Map<string, number>()
  private readonly retentionMs: number

  constructor(options: InMemoryMessageIdHistoryOptions = {}) {
    this.retentionMs = options.retentionMs ?? MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS
  }

  /**
   * Lesende Replay-Prüfung (Sync 003 Z.466 + Z.620-622): recorded nichts —
   * das Recorden übernimmt checkAndRecord am konklusiven Dispositions-Punkt.
   */
  async has(id: string, nowIso: string): Promise<boolean> {
    const nowMs = parseIsoMs(nowIso, 'nowIso')
    const seenMs = this.seenAtMs.get(id)
    return seenMs !== undefined && seenMs >= nowMs - this.retentionMs
  }

  async checkAndRecord(id: string, nowIso: string): Promise<boolean> {
    const nowMs = parseIsoMs(nowIso, 'nowIso')
    this.pruneOlderThan(nowMs - this.retentionMs)
    // Atomar in einem Aufruf: erst prüfen, dann markieren — kein await dazwischen.
    if (this.seenAtMs.has(id)) return true
    this.seenAtMs.set(id, nowMs)
    return false
  }

  async prune(cutoffIso: string): Promise<void> {
    this.pruneOlderThan(parseIsoMs(cutoffIso, 'cutoffIso'))
  }

  /** Entfernt nur Einträge, deren Erstsicht strikt älter als der Cutoff ist. */
  private pruneOlderThan(cutoffMs: number): void {
    for (const [id, seenMs] of this.seenAtMs) {
      if (seenMs < cutoffMs) this.seenAtMs.delete(id)
    }
  }
}
