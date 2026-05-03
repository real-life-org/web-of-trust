import { SpaceMetadataStorage, PersistedSpaceMetadata, PersistedGroupKey } from '../../ports/SpaceMetadataStorage';
/**
 * In-memory implementation of SpaceMetadataStorage for testing.
 */
export declare class InMemorySpaceMetadataStorage implements SpaceMetadataStorage {
    private spaces;
    private groupKeys;
    saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void>;
    loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null>;
    loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]>;
    deleteSpaceMetadata(spaceId: string): Promise<void>;
    saveGroupKey(key: PersistedGroupKey): Promise<void>;
    loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]>;
    deleteGroupKeys(spaceId: string): Promise<void>;
    clearAll(): Promise<void>;
}
//# sourceMappingURL=InMemorySpaceMetadataStorage.d.ts.map