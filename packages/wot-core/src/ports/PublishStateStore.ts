/**
 * Field types for discovery publish operations.
 *
 * `verifications` was added in Step 4 (1.B.3): the holder's published live
 * verification list (`/p/{did}/v`, Sync 004 Z.24-32) is an independently
 * published resource and therefore needs its own dirty flag for offline retry.
 */
export type PublishStateField = 'profile' | 'attestations' | 'verifications'

/**
 * Persistent store for publish state tracking.
 *
 * Tracks which publish operations are pending (dirty flags)
 * so they can be retried when connectivity is restored.
 *
 * Implementations:
 * - InMemoryPublishStateStore (for tests)
 * - EvoluPublishStateStore (for Demo App, backed by Evolu/SQLite)
 */
export interface PublishStateStore {
  /** Mark a field as needing sync to the discovery service */
  markDirty(did: string, field: PublishStateField): Promise<void>

  /** Clear the dirty flag after successful sync */
  clearDirty(did: string, field: PublishStateField): Promise<void>

  /** Get all fields that need syncing for a DID */
  getDirtyFields(did: string): Promise<Set<PublishStateField>>
}
