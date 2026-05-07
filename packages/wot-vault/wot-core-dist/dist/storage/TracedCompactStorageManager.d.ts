import { CompactStorageManager } from './CompactStorageManager';
export declare class TracedCompactStorageManager {
    private inner;
    constructor(inner: CompactStorageManager);
    open(): Promise<void>;
    save(docId: string, binary: Uint8Array): Promise<void>;
    load(docId: string): Promise<Uint8Array | null>;
    delete(docId: string): Promise<void>;
    list(): Promise<string[]>;
    close(): void;
}
//# sourceMappingURL=TracedCompactStorageManager.d.ts.map