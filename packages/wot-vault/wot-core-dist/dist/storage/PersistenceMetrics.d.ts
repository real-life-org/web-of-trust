/**
 * Persistence Metrics
 *
 * Structured logging and monitoring for the persistence layer.
 * Collects load/save/error metrics and exposes them via window.wotDebug().
 * Automatically writes to TraceLog for unified data-flow tracing.
 *
 * Output format:
 *   [persistence] ✓ load impl=legacy source=indexeddb time=3775ms size=12.3KB contacts=9
 *   [persistence] ✓ save impl=legacy target=vault time=210ms size=12.3KB
 *   [persistence] ✗ save impl=legacy target=vault error="NetworkError" time=5002ms
 */
export type ImplTag = 'legacy' | 'compact-store' | 'yjs';
export type LoadSource = 'compact-store' | 'indexeddb' | 'vault' | 'wot-profiles' | 'migration' | 'new';
export type SaveTarget = 'compact-store' | 'vault';
export interface LoadMetric {
    source: LoadSource;
    timeMs: number;
    sizeBytes: number;
    details: Record<string, unknown>;
    at: string;
}
export interface SaveMetric {
    target: SaveTarget;
    timeMs: number;
    sizeBytes: number;
    blockedUiMs?: number;
    at: string;
}
export interface ErrorMetric {
    operation: string;
    error: string;
    at: string;
}
export interface MigrationMetric {
    fromChunks: number;
    toSizeBytes: number;
    at: string;
}
export interface SaveStats {
    lastAt: string | null;
    lastTimeMs: number;
    lastSizeBytes: number;
    totalSaves: number;
    errors: number;
}
export interface SpaceMetric {
    spaceId: string;
    name: string | null;
    loadSource: LoadSource | null;
    loadTimeMs: number | null;
    docSizeBytes: number;
    compactStoreSaves: number;
    vaultSaves: number;
    lastSaveMs: number | null;
    members: number;
}
export interface DebugSnapshot {
    impl: ImplTag;
    persistence: {
        lastLoad: LoadMetric | null;
        saves: {
            compactStore: SaveStats;
            vault: SaveStats;
        };
        migration: MigrationMetric | null;
        errors: ErrorMetric[];
    };
    spaces: SpaceMetric[];
    sync: {
        relay: {
            connected: boolean;
            url: string | null;
            peers: number;
            lastMessage: string | null;
        };
    };
    automerge: {
        saveBlockedUiMs: {
            last: number;
            avg: number;
            max: number;
        };
        docSizeBytes: number;
        docStats: {
            contacts: number;
            attestations: number;
            spaces: number;
        };
    };
    legacy: {
        idbChunkCount: number | null;
        healthCheckResult: boolean | null;
        findDurationMs: number | null;
        flushDurationMs: number | null;
    };
}
export declare class PersistenceMetrics {
    private impl;
    private lastLoad;
    private compactStoreSaves;
    private vaultSaves;
    private migration;
    private errors;
    private blockedUiSamples;
    private spaceMetrics;
    private _idbChunkCount;
    private _healthCheckResult;
    private _findDurationMs;
    private _flushDurationMs;
    private _relayConnected;
    private _relayUrl;
    private _relayPeers;
    private _relayLastMessage;
    private _docSizeBytes;
    private _docContacts;
    private _docAttestations;
    private _docSpaces;
    constructor(impl: ImplTag);
    logLoad(source: LoadSource, timeMs: number, sizeBytes: number, details?: Record<string, unknown>): void;
    logSave(target: SaveTarget, timeMs: number, sizeBytes: number, blockedUiMs?: number): void;
    logError(operation: string, error: unknown): void;
    logMigration(fromChunks: number, toSizeBytes: number): void;
    setIdbChunkCount(count: number): void;
    setHealthCheckResult(healthy: boolean): void;
    setFindDuration(ms: number): void;
    setFlushDuration(ms: number): void;
    setRelayStatus(connected: boolean, url: string | null, peers: number): void;
    setDocStats(sizeBytes: number, contacts: number, attestations: number, spaces: number): void;
    logSpaceLoad(spaceId: string, name: string | null, source: LoadSource, timeMs: number, sizeBytes: number, members: number): void;
    logSpaceSave(spaceId: string, target: SaveTarget, timeMs: number, sizeBytes: number): void;
    removeSpace(spaceId: string): void;
    setImpl(impl: ImplTag): void;
    getSnapshot(): DebugSnapshot;
}
export declare function getMetrics(): PersistenceMetrics;
/**
 * Register window.wotDebug() and window.wotTrace() — always available, not sensitive data.
 */
export declare function registerDebugApi(metrics: PersistenceMetrics): void;
//# sourceMappingURL=PersistenceMetrics.d.ts.map