import { BrokerErrorCode } from './broker-error';
export declare const BROKER_AUTH_TRANSCRIPT_PROTOCOL = "wot/broker-auth/v1";
export declare const BROKER_AUTH_TRANSCRIPT_TYPE = "challenge-response";
export interface BrokerAuthTranscriptInput {
    did: string;
    deviceId: string;
    nonce: string;
}
export interface BrokerAuthTranscript {
    protocol: typeof BROKER_AUTH_TRANSCRIPT_PROTOCOL;
    type: typeof BROKER_AUTH_TRANSCRIPT_TYPE;
    did: string;
    deviceId: string;
    nonce: string;
}
export interface BrokerAuthPendingChallenge {
    did: string;
    deviceId: string;
    nonce: string;
}
export interface BrokerAuthChallengeResponseCandidate {
    type: typeof BROKER_AUTH_TRANSCRIPT_TYPE;
    did: string;
    deviceId: string;
    nonce: string;
}
export interface BrokerAuthChallengeResponseBindingInput {
    pendingChallenge: BrokerAuthPendingChallenge;
    candidate: BrokerAuthChallengeResponseCandidate;
}
export type BrokerAuthChallengeResponseBindingDisposition = {
    disposition: 'accepted';
    transcript: BrokerAuthTranscript;
    signingBytes: Uint8Array;
} | {
    disposition: 'rejected';
    errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>;
};
/**
 * Builds the Sync 003 Broker-Auth-Transcript object signed by
 * `challenge-response`. The `signature` wire field is intentionally excluded
 * because this transcript is the signed payload, not the control-frame parser.
 * Wire-level signature encoding lives in broker-challenge-response-frame.ts.
 */
export declare function buildBrokerAuthTranscript(input: BrokerAuthTranscriptInput): BrokerAuthTranscript;
export declare function createBrokerAuthTranscriptSigningBytes(transcript: BrokerAuthTranscript): Uint8Array;
/**
 * Applies the Sync 003 pending-challenge binding rule before signature
 * verification: `did`, `deviceId`, and `nonce` must exactly match the
 * caller-owned outstanding challenge.
 */
export declare function classifyBrokerAuthChallengeResponseBinding(input: BrokerAuthChallengeResponseBindingInput): BrokerAuthChallengeResponseBindingDisposition;
//# sourceMappingURL=broker-auth-transcript.d.ts.map