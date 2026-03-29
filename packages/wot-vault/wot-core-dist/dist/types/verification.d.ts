import { Proof } from './proof';
/**
 * A verification is a signed statement: "I have verified this person"
 *
 * Empfänger-Prinzip: Stored at the recipient (to).
 * Each direction is a separate Verification document.
 *
 * Example: Anna verifies Ben
 * - Anna creates: { from: anna, to: ben, proof: anna_sig }
 * - Stored at: Ben
 */
export interface Verification {
    id: string;
    from: string;
    to: string;
    timestamp: string;
    location?: GeoLocation;
    proof: Proof;
}
export interface GeoLocation {
    latitude: number;
    longitude: number;
    accuracy?: number;
}
/**
 * Challenge sent during verification handshake
 */
export interface VerificationChallenge {
    nonce: string;
    timestamp: string;
    fromDid: string;
    fromPublicKey: string;
    fromName?: string;
}
/**
 * Response to a verification challenge
 * Includes both responder's info and original challenge info
 */
export interface VerificationResponse {
    nonce: string;
    timestamp: string;
    toDid: string;
    toPublicKey: string;
    toName?: string;
    fromDid: string;
    fromPublicKey: string;
    fromName?: string;
}
//# sourceMappingURL=verification.d.ts.map