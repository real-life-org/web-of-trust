import { PublicProfile } from '../types/identity';
import { IdentitySession } from '../types/identity-session';
import { DidDocument } from '../protocol';
export interface ProfileServiceDocument {
    did: string;
    version: number;
    didDocument: DidDocument;
    profile: {
        name: string;
        bio?: string;
        avatar?: string;
        offers?: string[];
        needs?: string[];
        protocols?: string[];
    };
    updatedAt: string;
}
export interface ProfileVerificationResult {
    valid: boolean;
    profile?: PublicProfile;
    didDocument?: DidDocument;
    version?: number;
    error?: string;
}
export declare class ProfileService {
    static createProfileDocument(profile: PublicProfile, identity: IdentitySession, version?: number): Promise<ProfileServiceDocument>;
    /**
     * Sign a public profile as JWS using the identity's private key
     */
    static signProfile(profile: PublicProfile, identity: IdentitySession, options?: {
        version?: number;
    }): Promise<string>;
    static verifySignedPayload(jws: string): Promise<{
        valid: boolean;
        payload?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * Verify a JWS-signed profile.
     * Extracts the DID from the payload, resolves the public key,
     * and verifies the signature.
     */
    static verifyProfile(jws: string): Promise<ProfileVerificationResult>;
}
//# sourceMappingURL=ProfileService.d.ts.map