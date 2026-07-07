import type { SpaceInfo } from '../types/space'

/**
 * Persisted metadata for a single space.
 *
 * Does NOT include the Automerge document binary — that is managed
 * by automerge-repo's own StorageAdapter (e.g. IndexedDB).
 */
export interface PersistedSpaceMetadata {
  info: SpaceInfo
  /** automerge-repo DocumentId */
  documentId: string
  /** automerge-repo AutomergeUrl (automerge:<base58-id>) */
  documentUrl: string
  /** Encryption public keys per member DID */
  memberEncryptionKeys: Record<string, Uint8Array>
}

/**
 * Persisted group key for a space at a specific generation.
 */
export interface PersistedGroupKey {
  spaceId: string
  generation: number
  key: Uint8Array
}

/**
 * Persisted capability signing seed for a space at a specific generation.
 *
 * Kept in a SEPARATE grow-only map from group keys (not a field on
 * {@link PersistedGroupKey}): the seed for a (space, generation) is identical
 * for every member (shared write material), so concurrent set-if-absent writes
 * carry the same value → CRDT-merge-conflict-free, and a device without the seed
 * never writes the key (so it can never delete it). This is what lets a
 * recovered second device WRITE to a space it can already read. See #234.
 */
export interface PersistedCapabilitySigningSeed {
  spaceId: string
  generation: number
  seed: Uint8Array
}

/**
 * SpaceMetadataStorage — Persistence for Space metadata and Group Keys.
 *
 * Automerge document persistence is handled by automerge-repo's StorageAdapter.
 * This interface only stores metadata (SpaceInfo, document references, member keys)
 * and symmetric group keys.
 *
 * Implemented by platform-specific backends (IndexedDB, Evolu, in-memory for tests).
 * Used by AutomergeReplicationAdapter to restore space state across restarts.
 */
export function groupKeyId(spaceId: string, generation: number): string {
  return `${spaceId}:${generation}`
}

export interface SpaceMetadataStorage {
  // Space metadata
  saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void>
  loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null>
  loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]>
  deleteSpaceMetadata(spaceId: string): Promise<void>

  // Group Keys
  saveGroupKey(key: PersistedGroupKey): Promise<void>
  loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]>
  deleteGroupKeys(spaceId: string): Promise<void>

  // Capability signing seeds (#234) — separate grow-only map; enables a recovered
  // second device to WRITE, not just read. saveCapabilitySigningSeed is set-if-absent
  // (grow-only, never-overwrite): once a seed exists for a (space, generation) it is
  // never replaced or deleted by a later save.
  saveCapabilitySigningSeed(seed: PersistedCapabilitySigningSeed): Promise<void>
  loadCapabilitySigningSeeds(spaceId: string): Promise<PersistedCapabilitySigningSeed[]>

  // Lifecycle
  /** Delete all stored metadata, group keys and capability signing seeds. Used on identity switch/logout. */
  clearAll(): Promise<void>
}
