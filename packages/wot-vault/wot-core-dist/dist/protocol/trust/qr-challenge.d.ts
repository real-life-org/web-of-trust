import { AttestationVcPayload } from './attestation-vc-jws';
export interface QrChallenge {
    did: string;
    name: string;
    enc: string;
    nonce: string;
    ts: string;
    broker?: string;
}
export interface ActiveQrChallengeValidityOptions {
    now: Date;
    maxAgeMs?: number;
}
export interface VerificationAttestationAcceptanceOptions {
    payload: AttestationVcPayload;
    localDid: string;
    activeChallenge?: Pick<QrChallenge, 'nonce' | 'ts'>;
    now: Date;
    consumedNonces: ReadonlySet<string>;
}
export type VerificationAttestationAcceptanceDecision = {
    decision: 'accept-in-person';
    nonce: string;
} | {
    decision: 'remote-unbound';
    reason: 'missing-jti-nonce' | 'no-active-matching-nonce';
} | {
    decision: 'reject';
    reason: 'wrong-subject' | 'not-verification-attestation' | 'nonce-consumed' | 'challenge-expired';
};
/**
 * Implements wot-spec Trust 002 QR challenge parsing and online nonce acceptance.
 * References: Trust 002 `QR-Code-Format`, `Acceptance Gate fuer Online-Verifikation`, and `qr-challenge.schema.json`.
 */
export declare function parseQrChallenge(rawJson: string): QrChallenge;
export declare function isActiveQrChallengeValid(challenge: Pick<QrChallenge, 'ts'>, options: ActiveQrChallengeValidityOptions): boolean;
export declare function decideVerificationAttestationAcceptance(options: VerificationAttestationAcceptanceOptions): VerificationAttestationAcceptanceDecision;
export declare function parseVerificationJtiNonce(jti: string): string | null;
//# sourceMappingURL=qr-challenge.d.ts.map