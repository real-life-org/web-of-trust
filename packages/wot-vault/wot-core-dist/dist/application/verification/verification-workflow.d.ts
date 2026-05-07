import { IdentitySession } from '../identity';
import { Verification, VerificationChallenge, VerificationResponse } from '../../types/verification';
import { ProtocolCryptoAdapter } from '../../protocol';
export interface VerificationWorkflowOptions {
    crypto: ProtocolCryptoAdapter;
    randomId?: () => string;
    now?: () => Date;
}
export interface CreateChallengeResult {
    challenge: VerificationChallenge;
    code: string;
}
export interface CreateResponseResult {
    response: VerificationResponse;
    code: string;
}
export declare class VerificationWorkflow {
    private readonly crypto;
    private readonly randomId;
    private readonly now;
    constructor(options: VerificationWorkflowOptions);
    createChallenge(identity: IdentitySession, name: string): Promise<CreateChallengeResult>;
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
}
//# sourceMappingURL=verification-workflow.d.ts.map