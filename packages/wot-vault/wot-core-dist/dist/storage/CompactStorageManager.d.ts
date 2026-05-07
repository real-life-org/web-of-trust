/**
 * CompactStorageManager — Single-snapshot-per-doc IndexedDB store.
 *
 * Unlike automerge-repo's IndexedDBStorageAdapter (which accumulates chunks),
 * this store keeps exactly ONE Automerge.save() snapshot per docId.
 * Saves overwrite — no accumulation, no OOM.
 *
 * IDB: database name is configurable, object store 'snapshots'.
 */
export declare class CompactStorageManager {
    private dbName;
    private db;
    constructor(dbName?: string);
    open(): Promise<void>;
    save(docId: string, binary: Uint8Array): Promise<void>;
    load(docId: string): Promise<Uint8Array | null>;
    delete(docId: string): Promise<void>;
    list(): Promise<string[]>;
    close(): void;
    private getDb;
}
//# sourceMappingURL=CompactStorageManager.d.ts.map