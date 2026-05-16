export interface ParsedBrokerChallengeNonce {
    canonicalNonce: string;
    bytes: Uint8Array;
}
export interface BrokerChallengeNonceConsumptionOptions {
    nonce: ParsedBrokerChallengeNonce;
    consumedNonces: ReadonlySet<string>;
    now: Date;
}
export type BrokerChallengeNonceConsumptionDecision = {
    decision: 'accept';
    canonicalNonce: string;
    remember: {
        type: 'remember-consumed-nonce';
        canonicalNonce: string;
        until: Date;
    };
} | {
    decision: 'reject';
    reason: 'nonce-replay';
    canonicalNonce: string;
};
/**
 * Formats broker Challenge-Response nonce bytes for Sync 003
 * "Authentisierung" and "Nonce-Handling (MUSS)".
 *
 * This helper is intentionally limited to the normative nonce policy: exactly
 * 32 random bytes in, unpadded Base64URL out. Randomness is supplied by the
 * caller so protocol-core remains deterministic and storage-free.
 */
export declare function formatBrokerChallengeNonce(bytes: Uint8Array): string;
/**
 * Parses a broker Challenge-Response nonce for Sync 003 "Nonce-Handling (MUSS)".
 *
 * Padded, empty, malformed, non-canonical, and wrong-length values are rejected.
 */
export declare function parseBrokerChallengeNonce(value: string): ParsedBrokerChallengeNonce;
/**
 * Classifies an already-issued parsed broker nonce against caller-owned
 * history, following Sync 003 "Nonce-Handling (MUSS)" and Trust 002
 * "Nonce-History (MUSS)".
 *
 * The returned remember action is deterministic guidance for the caller's
 * storage layer; this helper does not mutate or persist nonce history.
 */
export declare function decideBrokerChallengeNonceConsumption(options: BrokerChallengeNonceConsumptionOptions): BrokerChallengeNonceConsumptionDecision;
//# sourceMappingURL=broker-auth-nonce.d.ts.map