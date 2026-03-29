import { SpaceMetadataStorage, PersistedSpaceMetadata, PersistedGroupKey } from '../interfaces/SpaceMetadataStorage';
export declare class IndexedDBSpaceMetadataStorage implements SpaceMetadataStorage {
    private dbPromise;
    constructor(dbName?: string);
    saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void>;
    loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null>;
    loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]>;
    deleteSpaceMetadata(spaceId: string): Promise<void>;
    saveGroupKey(key: PersistedGroupKey): Promise<void>;
    loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]>;
    deleteGroupKeys(spaceId: string): Promise<void>;
    clearAll(): Promise<void>;
    private deserialize;
}
//# sourceMappingURL=IndexedDBSpaceMetadataStorage.d.ts.map