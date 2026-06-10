import type { WireMessage } from './MessagingAdapter'
import type { Subscribable } from './Subscribable'

/**
 * Outbox entry with metadata for retry logic.
 */
export interface OutboxEntry {
  envelope: WireMessage
  createdAt: string      // ISO 8601 — when the message was first queued
  retryCount: number     // number of failed send attempts
}

/**
 * Persistent store for the messaging outbox.
 *
 * Stores unsent wire messages (both families, VE-8) for retry when
 * connectivity is restored. Implementations: InMemoryOutboxStore (Tests),
 * PersonalDocOutboxStore/AutomergeOutboxStore (CRDT-Personal-Doc),
 * SqliteOutboxStore (CLI), LocalOutboxStore (Demo, IndexedDB).
 */
export interface OutboxStore {
  /** Add an envelope to the outbox. Idempotent on envelope.id. */
  enqueue(envelope: WireMessage): Promise<void>

  /** Remove a successfully sent envelope from the outbox. */
  dequeue(envelopeId: string): Promise<void>

  /** Get all pending outbox entries, ordered by createdAt ascending. */
  getPending(): Promise<OutboxEntry[]>

  /** Check if an envelope is already in the outbox (dedup guard). */
  has(envelopeId: string): Promise<boolean>

  /** Increment retry count for a failed attempt. */
  incrementRetry(envelopeId: string): Promise<void>

  /** Get the count of pending messages (for UI badge). */
  count(): Promise<number>

  /** Reactive pending count for UI binding. Optional — implementations may return undefined. */
  watchPendingCount?(): Subscribable<number>
}
