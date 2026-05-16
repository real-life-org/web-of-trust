import { PendingCounterVerificationRecord, VerificationStateStore } from '../../ports/VerificationStateStore';
/**
 * Volatile Trust 002 verification state store for tests and reference composition.
 */
export declare class InMemoryVerificationStateStore implements VerificationStateStore {
    private readonly consumedNonces;
    private readonly pendingCounterVerifications;
    recordConsumedNonce(nonce: string, consumedAt: string): Promise<void>;
    tryConsumeNonce(nonce: string, consumedAt: string): Promise<boolean>;
    hasConsumedNonce(nonce: string): Promise<boolean>;
    pruneConsumedNonces(olderThan: string): Promise<void>;
    recordPendingCounterVerification(pending: PendingCounterVerificationRecord): Promise<void>;
    getPendingCounterVerification(originalVerificationId: string): Promise<PendingCounterVerificationRecord | null>;
    getPendingCounterVerifications(): Promise<PendingCounterVerificationRecord[]>;
    deletePendingCounterVerification(originalVerificationId: string): Promise<void>;
    consumePendingCounterVerification(originalVerificationId: string, counterpartyDid: string, now: string): Promise<'consumed' | 'missing' | 'expired' | 'wrong-counterparty'>;
    prunePendingCounterVerifications(now: string): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=InMemoryVerificationStateStore.d.ts.map