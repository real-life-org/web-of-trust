import { IdentitySession } from '../identity';
import { Attestation } from '../../types/attestation';
import { Verification, VerificationChallenge, VerificationResponse } from '../../types/verification';
import { VerificationStateStore } from '../../ports/VerificationStateStore';
import { AttestationVcPayload, ProtocolCryptoAdapter, QrChallenge, VerificationAttestationAcceptanceDecision } from '../../protocol';
export interface VerificationWorkflowOptions {
    crypto: ProtocolCryptoAdapter;
    randomId?: () => string;
    now?: () => Date;
    stateStore?: VerificationStateStore;
}
export interface CreateChallengeResult {
    challenge: VerificationChallenge;
    code: string;
}
export interface CreateResponseResult {
    response: VerificationResponse;
    code: string;
}
export interface CreateOnlineQrChallengeOptions {
    broker?: string;
}
export interface CreateOnlineQrChallengeResult {
    challenge: QrChallenge;
    rawJson: string;
}
export interface CreateVerificationAttestationInput {
    issuer: IdentitySession;
    subjectDid: string;
    challengeNonce: string;
}
export interface CreateCounterVerificationAttestationInput {
    issuer: IdentitySession;
    subjectDid: string;
    /** The `jti` of the original nonce-bound Verification-Attestation this response answers. */
    inResponseTo: string;
}
export interface PendingCounterVerification {
    counterpartyDid: string;
    /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
    originalVerificationId: string;
    createdAt: string;
    expiresAt: string;
}
export interface RecordPendingCounterVerificationOptions {
    counterpartyDid: string;
    /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
    originalVerificationId: string;
}
export type CounterVerificationAcceptanceDecision = {
    decision: 'accept-mutual-in-person';
    originalVerificationId: string;
} | {
    decision: 'remote-unbound';
    reason: 'missing-in-response-to' | 'no-pending-counter-verification' | 'pending-counter-expired';
} | {
    decision: 'reject';
    reason: 'wrong-subject' | 'wrong-issuer' | 'not-verification-attestation';
};
export declare class VerificationWorkflow {
    private readonly crypto;
    private readonly randomId;
    private readonly now;
    private readonly stateStore;
    private activeQrChallenge;
    private readonly consumedNonces;
    private readonly pendingCounterVerifications;
    constructor(options: VerificationWorkflowOptions);
    createChallenge(identity: IdentitySession, name: string): Promise<CreateChallengeResult>;
    createOnlineQrChallenge(identity: IdentitySession, name: string, options?: CreateOnlineQrChallengeOptions): Promise<CreateOnlineQrChallengeResult>;
    getActiveQrChallenge(): QrChallenge | null;
    resetActiveQrChallenge(): void;
    createVerificationAttestation(input: CreateVerificationAttestationInput): Promise<Attestation>;
    createCounterVerificationAttestation(input: CreateCounterVerificationAttestationInput): Promise<Attestation>;
    acceptVerifiedVerificationAttestation(identity: IdentitySession, payload: AttestationVcPayload): VerificationAttestationAcceptanceDecision | Promise<VerificationAttestationAcceptanceDecision>;
    /**
     * Public for composition code that imports an already accepted in-person Verification-Attestation.
     */
    recordPendingCounterVerification(options: RecordPendingCounterVerificationOptions): PendingCounterVerification | Promise<PendingCounterVerification>;
    getPendingCounterVerification(originalVerificationId: string): PendingCounterVerification | null | Promise<PendingCounterVerification | null>;
    getPendingCounterVerifications(): PendingCounterVerification[] | Promise<PendingCounterVerification[]>;
    acceptVerifiedCounterVerification(identity: IdentitySession, payload: AttestationVcPayload): CounterVerificationAcceptanceDecision | Promise<CounterVerificationAcceptanceDecision>;
    decodeChallenge(code: string): VerificationChallenge;
    prepareChallenge(code: string, localDid?: string): VerificationChallenge;
    createResponse(challengeCode: string, identity: IdentitySession, name: string): Promise<CreateResponseResult>;
    decodeResponse(code: string): VerificationResponse;
    completeVerification(responseCode: string, identity: IdentitySession, expectedNonce: string): Promise<Verification>;
    createVerificationFor(identity: IdentitySession, toDid: string, nonce: string): Promise<Verification>;
    verifySignature(verification: Verification): Promise<boolean>;
    publicKeyFromDid(did: string): string;
    multibaseToBytes(multibase: string): Uint8Array;
    base64UrlToBytes(base64url: string): Uint8Array;
    private createSignedVerification;
    private createSignedVerificationAttestation;
    private pruneConsumedNonces;
    private prunePendingCounterVerifications;
    private findConsumedNonce;
    private acceptVerifiedVerificationAttestationWithStore;
    private recordPendingCounterVerificationWithStore;
    private getPendingCounterVerificationWithStore;
    private getPendingCounterVerificationsWithStore;
    private acceptVerifiedCounterVerificationWithStore;
    private findConsumedNonceWithStore;
}
//# sourceMappingURL=verification-workflow.d.ts.map