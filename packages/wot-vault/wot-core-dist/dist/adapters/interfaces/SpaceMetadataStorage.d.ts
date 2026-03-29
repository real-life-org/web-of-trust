import { SpaceInfo } from '../../types/space';
/**
 * Persisted metadata for a single space.
 *
 * Does NOT include the Automerge document binary — that is managed
 * by automerge-repo's own StorageAdapter (e.g. IndexedDB).
 */
export interface PersistedSpaceMetadata {
    info: SpaceInfo;
    /** automerge-repo DocumentId */
    documentId: string;
    /** automerge-repo AutomergeUrl (automerge:<base58-id>) */
    documentUrl: string;
    /** Encryption public keys per member DID */
    memberEncryptionKeys: Record<string, Uint8Array>;
}
/**
 * Persisted group key for a space at a specific generation.
 */
export interface PersistedGroupKey {
    spaceId: string;
    generation: number;
    key: Uint8Array;
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
export interface SpaceMetadataStorage {
    saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void>;
    loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null>;
    loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]>;
    deleteSpaceMetadata(spaceId: string): Promise<void>;
    saveGroupKey(key: PersistedGroupKey): Promise<void>;
    loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]>;
    deleteGroupKeys(spaceId: string): Promise<void>;
    /** Delete all stored metadata and group keys. Used on identity switch/logout. */
    clearAll(): Promise<void>;
}
//# sourceMappingURL=SpaceMetadataStorage.d.ts.map