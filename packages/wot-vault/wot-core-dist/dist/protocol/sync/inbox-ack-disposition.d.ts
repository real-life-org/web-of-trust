export type InboxAckProcessingStatus = 'incomplete' | 'complete' | 'failed';
export type InboxAckReplayStatus = 'incomplete' | 'unique' | 'duplicate-known' | 'failed';
export type InboxAckScope = 'authenticated-device-only';
export type InboxAckMeaning = 'transport-persistence-only';
export type InboxAckSemanticEffect = 'none';
export type InboxMessageKind = 'attestation' | 'verification' | 'space-invite' | 'member-update' | 'key-rotation' | 'inbox' | 'unknown';
export type InboxAckMissingDependency = {
    kind: 'missing-key-generation';
    docId: string;
    keyGeneration: number;
} | {
    kind: 'missing-space-invite';
    docId: string;
} | {
    kind: 'missing-log-entry';
    docId: string;
    deviceId?: string;
    seq?: number;
} | {
    kind: 'missing-personal-doc';
    docId?: string;
} | {
    kind: 'missing-other';
    detail: string;
};
export type InboxAckIncompleteWork = 'decryption' | 'inner-verification' | 'replay-check' | 'durable-apply' | 'durable-buffer' | 'invalid-rejection-audit';
export type InboxInvalidRejectionReason = 'decryption-failed' | 'inner-verification-failed' | 'replay-rejected' | 'wrong-recipient' | 'expired' | 'malformed' | 'unknown-required-type';
export type InboxAckLocalOutcome = {
    kind: 'applied';
    durable: boolean;
} | {
    kind: 'pending';
    durability: 'durable' | 'volatile' | 'not-buffered';
    dependencies: readonly InboxAckMissingDependency[];
} | {
    kind: 'processing-incomplete';
    waitingOn: InboxAckIncompleteWork;
} | {
    kind: 'invalid-rejected';
    rejection: InboxInvalidRejectionReason;
    authoritativeStateChanged: boolean;
} | {
    kind: 'duplicate';
    source: 'replay-history';
};
export interface InboxAckDispositionInput {
    messageKind?: InboxMessageKind;
    decryption: InboxAckProcessingStatus;
    innerVerification: InboxAckProcessingStatus;
    replayCheck: InboxAckReplayStatus;
    localOutcome: InboxAckLocalOutcome;
}
export type InboxAckDisposition = {
    action: 'send-ack';
    reason: 'applied' | 'durably-buffered-pending' | 'duplicate-replay-history';
    ackScope: InboxAckScope;
    ackMeaning: InboxAckMeaning;
    semanticEffect: InboxAckSemanticEffect;
} | {
    action: 'may-ack-invalid-and-drop';
    reason: 'invalid-rejected';
    authoritativeStateChanged: false;
    ackScope: InboxAckScope;
    ackMeaning: InboxAckMeaning;
    semanticEffect: InboxAckSemanticEffect;
} | {
    action: 'do-not-ack';
    reason: 'processing-incomplete' | 'pending-not-durable' | 'apply-not-durable' | 'invalid-changed-state';
};
export declare function evaluateInboxAckDisposition(input: InboxAckDispositionInput): InboxAckDisposition;
//# sourceMappingURL=inbox-ack-disposition.d.ts.map