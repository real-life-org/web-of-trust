export type SyncHeads = Readonly<Record<string, number>>;
export type SyncResponseDisposition = 'request-next-page' | 'complete';
export type SyncHeadsComparison = 'consistent' | 'divergent';
export interface SyncResponseTruncation {
    truncated: boolean;
}
export declare function deriveSyncStartSeq(heads: SyncHeads, deviceId: string): number;
export declare function evaluateSyncResponseDisposition(response: SyncResponseTruncation): SyncResponseDisposition;
export declare function compareSyncHeads(left: SyncHeads, right: SyncHeads): SyncHeadsComparison;
//# sourceMappingURL=heads.d.ts.map