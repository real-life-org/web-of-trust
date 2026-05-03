/**
 * TraceLog — Central tracing system for all store operations.
 *
 * Ring buffer of 1000 entries in memory, persisted asynchronously to IndexedDB.
 * Allows developers to see the full data flow: which stores are accessed,
 * in what order, with what timing and result.
 *
 * Usage:
 *   import { getTraceLog } from '@web_of_trust/core/storage'
 *   const trace = getTraceLog()
 *   trace.log({ store: 'compact-store', operation: 'write', label: 'save personal-doc', durationMs: 12, sizeBytes: 4096, success: true })
 *   trace.subscribe(entries => console.log('new trace:', entries))
 *   window.wotTrace() // → TraceEntry[]
 */
export type TraceStore = 'compact-store' | 'relay' | 'vault' | 'profiles' | 'outbox' | 'personal-doc' | 'crdt' | 'crypto';
export type TraceOp = 'read' | 'write' | 'send' | 'receive' | 'sync' | 'delete' | 'flush' | 'error' | 'connect' | 'disconnect';
export interface TraceEntry {
    id: number;
    timestamp: string;
    store: TraceStore;
    operation: TraceOp;
    label: string;
    durationMs: number;
    sizeBytes?: number;
    success: boolean;
    error?: string;
    meta?: Record<string, unknown>;
}
export type TraceFilter = {
    store?: TraceStore;
    operation?: TraceOp;
    success?: boolean;
    since?: string;
    limit?: number;
};
type TraceSubscriber = (entry: TraceEntry) => void;
export declare class TraceLog {
    private entries;
    private nextId;
    private subscribers;
    private db;
    private pendingWrites;
    private flushTimer;
    private initialized;
    init(): Promise<void>;
    log(entry: Omit<TraceEntry, 'id' | 'timestamp'>): TraceEntry;
    getAll(filter?: TraceFilter): TraceEntry[];
    getLatest(count?: number): TraceEntry[];
    getErrors(count?: number): TraceEntry[];
    getByStore(store: TraceStore): TraceEntry[];
    getPerformanceSummary(): Record<string, {
        count: number;
        avgMs: number;
        p95Ms: number;
        maxMs: number;
    }>;
    subscribe(callback: TraceSubscriber): () => void;
    clear(): void;
    get size(): number;
    private notifySubscribers;
    private startFlushTimer;
    private flushToDb;
    private openDb;
    private loadFromDb;
}
export declare function getTraceLog(): TraceLog;
/**
 * Convenience: time an async operation and log it.
 *
 * Usage:
 *   const data = await traceAsync('compact-store', 'read', 'load personal-doc', async () => {
 *     return await compactStore.load(docId)
 *   })
 */
export declare function traceAsync<T>(store: TraceStore, operation: TraceOp, label: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T>;
/**
 * Wrap fetch() to trace HTTP calls to Vault/Profiles servers.
 */
export declare function tracedFetch(store: TraceStore, label: string, url: string, init?: RequestInit, meta?: Record<string, unknown>): Promise<Response>;
/**
 * Register window.wotTrace() — always available, not sensitive data.
 */
export declare function registerTraceApi(traceLog: TraceLog): void;
export {};
//# sourceMappingURL=TraceLog.d.ts.map