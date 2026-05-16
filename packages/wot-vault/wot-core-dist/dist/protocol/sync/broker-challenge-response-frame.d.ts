import { BrokerAuthPendingChallenge, BrokerAuthTranscript } from './broker-auth-transcript';
import { ProtocolCryptoAdapter } from '../crypto/ports';
import { BrokerErrorCode } from './broker-error';
export declare const BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE = "challenge-response";
export interface BrokerChallengeResponseControlFrame {
    type: typeof BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE;
    did: string;
    deviceId: string;
    nonce: string;
    signature: string;
}
export interface ParsedBrokerChallengeResponseControlFrame extends BrokerChallengeResponseControlFrame {
    signatureBytes: Uint8Array;
    transcript: BrokerAuthTranscript;
    signingBytes: Uint8Array;
}
export interface CreateBrokerChallengeResponseControlFrameOptions {
    did: string;
    deviceId: string;
    nonce: string;
    signature: Uint8Array;
}
export interface VerifyBrokerChallengeResponseControlFrameOptions {
    frame: unknown;
    pendingChallenge: BrokerAuthPendingChallenge;
    publicKey: Uint8Array;
    crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>;
}
export type BrokerChallengeResponseVerificationResult = {
    disposition: 'accepted';
    frame: BrokerChallengeResponseControlFrame;
    transcript: BrokerAuthTranscript;
    signingBytes: Uint8Array;
} | {
    disposition: 'rejected';
    errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>;
};
/**
 * Creates the Sync 003 `challenge-response` Broker Control-Frame wire shape.
 * See Sync 003 "Wire-Encoding der `signature` (MUSS)" and
 * real-life-org/wot-spec#50 for the normative signature field encoding.
 *
 * This helper only serializes the normative frame fields. Ed25519 signing,
 * DID resolution, pending-challenge storage, and WebSocket
 * connection binding remain caller/runtime responsibilities.
 */
export declare function createBrokerChallengeResponseControlFrame(options: CreateBrokerChallengeResponseControlFrameOptions): BrokerChallengeResponseControlFrame;
export declare function parseBrokerChallengeResponseControlFrame(value: unknown): ParsedBrokerChallengeResponseControlFrame;
export declare function assertBrokerChallengeResponseControlFrame(value: unknown): asserts value is BrokerChallengeResponseControlFrame;
/**
 * Verifies a Sync 003 `challenge-response` Broker Control-Frame against a
 * caller-owned pending challenge and caller-supplied Ed25519 public key bytes.
 * See Sync 003 `03-wot-sync/003-transport-und-broker.md`
 * "Broker-Auth-Transcript (MUSS)", "Wire-Encoding der `signature` (MUSS)",
 * and the pending-challenge binding rule.
 *
 * This protocol helper is deterministic and storage-free: it does not resolve
 * DIDs, bind WebSocket connections, consume nonce history, emit runtime broker
 * errors, or mutate device registration state.
 */
export declare function verifyBrokerChallengeResponseControlFrame(options: VerifyBrokerChallengeResponseControlFrameOptions): Promise<BrokerChallengeResponseVerificationResult>;
export declare function formatBrokerChallengeResponseSignature(bytes: Uint8Array): string;
//# sourceMappingURL=broker-challenge-response-frame.d.ts.map