export type LocalBrokerSeqConsistencyDisposition = 'restore-clone-required' | 'no-restore-clone-detected';
export type LocalBrokerSeqConsistencyReason = 'broker-seq-greater-than-local-seq' | 'broker-seq-not-greater-than-local-seq';
export interface LocalBrokerSeqConsistencyInput {
    docId: string;
    deviceId: string;
    localSeq: number;
    brokerSeq: number;
}
export interface LocalBrokerSeqConsistencyResult {
    disposition: LocalBrokerSeqConsistencyDisposition;
    reason: LocalBrokerSeqConsistencyReason;
}
export type BrokerSeqCollisionDisposition = 'accept-new-entry' | 'idempotent-retransmission' | 'reject-seq-collision';
export interface BrokerSeqCollisionInput {
    docId: string;
    deviceId: string;
    seq: number;
    existingContentHash: string | null | undefined;
    incomingContentHash: string;
}
export type BrokerSeqCollisionResult = {
    disposition: 'accept-new-entry';
} | {
    disposition: 'idempotent-retransmission';
} | {
    disposition: 'reject-seq-collision';
    errorCode: 'SEQ_COLLISION_DETECTED';
    clientHint: 'restore-clone-required';
};
/** Implements Sync 002 seq-Konsistenz for broker/local seq comparison. */
export declare function classifyLocalBrokerSeqConsistency(input: LocalBrokerSeqConsistencyInput): LocalBrokerSeqConsistencyResult;
export declare function classifyBrokerSeqCollision(input: BrokerSeqCollisionInput): BrokerSeqCollisionResult;
//# sourceMappingURL=seq-consistency.d.ts.map