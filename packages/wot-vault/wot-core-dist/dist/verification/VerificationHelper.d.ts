import { WotIdentity } from '../identity/WotIdentity';
import { Verification } from '../types/verification';
/**
 * VerificationHelper - Utilities for in-person verification flow
 *
 * Implements challenge-response protocol with Ed25519 signatures.
 */
export declare class VerificationHelper {
    /**
     * Create a verification challenge
     *
     * @param identity - WotIdentity of challenger
     * @param name - Display name of challenger
     * @returns Base64-encoded challenge string
     */
    static createChallenge(identity: WotIdentity, name: string): Promise<string>;
    /**
     * Respond to a verification challenge
     *
     * @param challengeCode - Base64-encoded challenge
     * @param identity - WotIdentity of responder
     * @param name - Display name of responder
     * @returns Base64-encoded response string
     */
    static respondToChallenge(challengeCode: string, identity: WotIdentity, name: string): Promise<string>;
    /**
     * Complete verification by creating signed verification object
     *
     * @param responseCode - Base64-encoded response
     * @param identity - WotIdentity of initiator (signer)
     * @param expectedNonce - Nonce from original challenge
     * @returns Signed Verification object
     * @throws Error if nonce mismatch
     */
    static completeVerification(responseCode: string, identity: WotIdentity, expectedNonce: string): Promise<Verification>;
    /**
     * Create a verification for a specific DID (Empfänger-Prinzip).
     * Used when Bob verifies Alice: from=Bob, to=Alice.
     *
     * @param identity - WotIdentity of the signer (from)
     * @param toDid - DID of the person being verified (to/recipient)
     * @param nonce - Nonce from the challenge for deterministic ID
     * @returns Signed Verification object
     */
    static createVerificationFor(identity: WotIdentity, toDid: string, nonce: string): Promise<Verification>;
    /**
     * Verify signature on a verification object
     *
     * @param verification - Verification object to verify
     * @returns True if signature is valid
     */
    static verifySignature(verification: Verification): Promise<boolean>;
    /**
     * Extract public key from did:key DID
     *
     * @param did - DID in format did:key:z6Mk...
     * @returns Multibase-encoded public key (z6Mk...)
     */
    static publicKeyFromDid(did: string): string;
    /**
     * Convert multibase (base58btc) to bytes
     *
     * @param multibase - Multibase string (z-prefixed base58btc)
     * @returns Uint8Array of decoded bytes
     */
    static multibaseToBytes(multibase: string): Uint8Array;
    /**
     * Convert base64url to bytes
     *
     * @param base64url - Base64url-encoded string
     * @returns Uint8Array of decoded bytes
     */
    static base64UrlToBytes(base64url: string): Uint8Array;
}
//# sourceMappingURL=VerificationHelper.d.ts.map