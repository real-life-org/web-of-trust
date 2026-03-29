import { SpaceInfo } from '../../types/space';
/**
 * Persisted state for a single space.
 */
export interface PersistedSpace {
    info: SpaceInfo;
    /** Automerge.save() binary */
    docBinary: Uint8Array;
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
 * SpaceStorageAdapter — Persistence for CRDT Spaces and Group Keys.
 *
 * Implemented by platform-specific backends (IndexedDB, SQLite, filesystem).
 * Used by AutomergeReplicationAdapter to survive restarts.
 */
export interface SpaceStorageAdapter {
    saveSpace(space: PersistedSpace): Promise<void>;
    loadSpace(spaceId: string): Promise<PersistedSpace | null>;
    loadAllSpaces(): Promise<PersistedSpace[]>;
    deleteSpace(spaceId: string): Promise<void>;
    saveGroupKey(key: PersistedGroupKey): Promise<void>;
    loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]>;
    deleteGroupKeys(spaceId: string): Promise<void>;
}
//# sourceMappingURL=SpaceStorageAdapter.d.ts.map