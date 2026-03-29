import { SpaceStorageAdapter, PersistedSpace, PersistedGroupKey } from '../interfaces/SpaceStorageAdapter';
/**
 * In-memory implementation of SpaceStorageAdapter for testing.
 */
export declare class InMemorySpaceStorageAdapter implements SpaceStorageAdapter {
    private spaces;
    private groupKeys;
    saveSpace(space: PersistedSpace): Promise<void>;
    loadSpace(spaceId: string): Promise<PersistedSpace | null>;
    loadAllSpaces(): Promise<PersistedSpace[]>;
    deleteSpace(spaceId: string): Promise<void>;
    saveGroupKey(key: PersistedGroupKey): Promise<void>;
    loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]>;
    deleteGroupKeys(spaceId: string): Promise<void>;
}
//# sourceMappingURL=InMemorySpaceStorageAdapter.d.ts.map