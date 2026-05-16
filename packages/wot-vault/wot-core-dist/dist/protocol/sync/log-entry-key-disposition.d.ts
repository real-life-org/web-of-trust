export type LogEntryKeyDisposition = 'process-decrypt' | 'blocked-by-key';
export interface ClassifyLogEntryKeyDispositionInput {
    keyGeneration: number;
    availableKeyGenerations: readonly number[];
}
/**
 * Classifies `log_entry_jws.payload.keyGeneration` for wot-sync blocked-by-key handling.
 * Reference: wot-sync@0.1 Sync 002. Applies only to otherwise valid log entries with a present
 * non-negative integer `keyGeneration`; malformed entries missing that field are rejected by
 * log-entry validation, not classified as `blocked-by-key` here (real-life-org/wot-spec#25 closed).
 */
export declare function classifyLogEntryKeyDisposition(input: ClassifyLogEntryKeyDispositionInput): LogEntryKeyDisposition;
//# sourceMappingURL=log-entry-key-disposition.d.ts.map