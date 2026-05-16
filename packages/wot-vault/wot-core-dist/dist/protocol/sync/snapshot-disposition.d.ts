export type SnapshotKeyMaterialStatus = 'available' | 'missing' | 'unavailable' | 'future';
export type SnapshotDispositionStatus = 'rejected' | 'blocked-by-key' | 'crdt-merge-helper-only' | 'catch-up-optimization-eligible';
export type SnapshotDispositionReason = 'invalid-key-generation' | 'doc-id-mismatch' | 'key-generation-mismatch' | 'missing-key-material' | 'unavailable-key-material' | 'future-key-material' | 'missing-coverage-metadata' | 'matching-metadata-with-coverage';
export type SnapshotDispositionAction = 'durable-buffer-or-retry' | 'key-catch-up' | 'do-not-mark-processed' | 'crdt-merge-only' | 'sync-request-log-catch-up' | 'crdt-merge' | 'log-head-coverage-optimization';
export interface SnapshotCoverageHeads {
    readonly [deviceId: string]: number;
}
export interface SnapshotMetadata {
    readonly docId: string;
    readonly keyGeneration: number;
    readonly heads?: SnapshotCoverageHeads;
}
export interface SnapshotLogSafetyGuidance {
    readonly nonAuthoritativeOverKnownValidLogEntries: true;
    readonly noRollbackKnownValidLogEntries: true;
    readonly noOverwriteKnownValidLogEntries: true;
    readonly notAppendOnlyLogReplacement: true;
}
export interface SnapshotDisposition {
    readonly status: SnapshotDispositionStatus;
    readonly reason: SnapshotDispositionReason;
    readonly mergeEligible: boolean;
    readonly markSnapshotProcessed: false;
    readonly actions: readonly SnapshotDispositionAction[];
    readonly logSafety?: SnapshotLogSafetyGuidance;
}
export interface ClassifySnapshotDispositionInput {
    readonly expectedDocId: string;
    readonly expectedKeyGeneration: number;
    readonly keyMaterial: SnapshotKeyMaterialStatus;
    readonly snapshot: SnapshotMetadata;
}
export declare function classifySnapshotDisposition(input: ClassifySnapshotDispositionInput): SnapshotDisposition;
//# sourceMappingURL=snapshot-disposition.d.ts.map