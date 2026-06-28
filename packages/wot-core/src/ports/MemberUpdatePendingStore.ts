import type { MemberUpdateSignal, SeenMemberUpdateSignal } from '../protocol/sync/member-update-disposition'

/**
 * Durable persistence for pending member-update signals (Sync 005 Z.167/Z.179/Z.205).
 *
 * Seen pending signals (with a classified storedDisposition) feed the classifier's
 * `seenUpdates` input; future-buffered signals (no disposition yet) are stored
 * separately and only replayed after the generation gap closes.
 *
 * The reference implementation ships an in-memory default; a production app wires a
 * durable KV-backed store (Adapter concern, see 1.D Demo-Hooks).
 */
export interface MemberUpdatePendingStore {
  /** Persist a new seen pending signal (storedDisposition required). Idempotent for exact Tuple+Signer+Authority duplicates. */
  savePending(signal: SeenMemberUpdateSignal): Promise<void>

  /** Upgrade an existing pending record's authority level. Idempotent if already at target level. */
  upgradePending(signal: SeenMemberUpdateSignal): Promise<void>

  /** Persist a future-generation signal (no storedDisposition). Separate storage from seenUpdates. */
  bufferFuture(signal: MemberUpdateSignal): Promise<void>

  /**
   * List seen pending signals for the classifier's `seenUpdates` input.
   * MUST only return entries with `storedDisposition` set — no future-buffer entries leak here.
   */
  listSeenForSpace(spaceId: string): Promise<readonly SeenMemberUpdateSignal[]>

  /**
   * List future-buffered signals for a space.
   * Used by Catch-Up after a generation gap closes, NOT by the classifier.
   */
  listFutureForSpace(spaceId: string): Promise<readonly MemberUpdateSignal[]>

  /** Drop a seen pending record after canonical Space-Sync confirmation. */
  resolvePending(spaceId: string, signal: MemberUpdateSignal): Promise<void>

  /** Drop a future-buffered signal after the generation gap closes (signal becomes seen pending). */
  resolveFuture(spaceId: string, signal: MemberUpdateSignal): Promise<void>
}
