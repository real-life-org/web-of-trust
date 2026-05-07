import { SpaceMetadataStorage, PersistedSpaceMetadata, PersistedGroupKey } from '../../ports/SpaceMetadataStorage';
export interface SpaceMetadataDocFunctions {
    getPersonalDoc: () => any;
    changePersonalDoc: (fn: (doc: any) => void, options?: {
        background?: boolean;
    }) => any;
}
export declare class PersonalDocSpaceMetadataStorage implements SpaceMetadataStorage {
    private getPersonalDoc;
    private changePersonalDoc;
    constructor(fns: SpaceMetadataDocFunctions);
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
//# sourceMappingURL=AutomergeSpaceMetadataStorage.d.ts.map