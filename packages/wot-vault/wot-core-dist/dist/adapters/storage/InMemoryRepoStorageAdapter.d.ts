import { StorageAdapterInterface } from '@automerge/automerge-repo';
type StorageKey = string[];
type Chunk = {
    key: StorageKey;
    data: Uint8Array;
};
/**
 * In-memory implementation of automerge-repo's StorageAdapterInterface.
 * Used for testing — persists documents across Repo restarts within the same process.
 */
export declare class InMemoryRepoStorageAdapter implements StorageAdapterInterface {
    private data;
    private keyToString;
    load(key: StorageKey): Promise<Uint8Array | undefined>;
    save(key: StorageKey, binary: Uint8Array): Promise<void>;
    remove(key: StorageKey): Promise<void>;
    loadRange(keyPrefix: StorageKey): Promise<Chunk[]>;
    removeRange(keyPrefix: string[]): Promise<void>;
}
export {};
//# sourceMappingURL=InMemoryRepoStorageAdapter.d.ts.map