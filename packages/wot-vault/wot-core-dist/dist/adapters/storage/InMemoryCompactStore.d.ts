/**
 * In-memory implementation of CompactStorageManager for testing.
 * Same interface as CompactStorageManager but without IndexedDB.
 */
export declare class InMemoryCompactStore {
    private data;
    open(): Promise<void>;
    save(docId: string, binary: Uint8Array): Promise<void>;
    load(docId: string): Promise<Uint8Array | null>;
    delete(docId: string): Promise<void>;
    list(): Promise<string[]>;
    close(): void;
    /** Test helper: check if a snapshot exists */
    has(docId: string): boolean;
    /** Test helper: get snapshot size */
    size(docId: string): number;
}
//# sourceMappingURL=InMemoryCompactStore.d.ts.map