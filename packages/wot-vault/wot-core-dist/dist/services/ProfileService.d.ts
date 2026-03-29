import { PublicProfile } from '../types/identity';
import { WotIdentity } from '../identity/WotIdentity';
export declare class ProfileService {
    /**
     * Sign a public profile as JWS using the identity's private key
     */
    static signProfile(profile: PublicProfile, identity: WotIdentity): Promise<string>;
    /**
     * Verify a JWS-signed profile.
     * Extracts the DID from the payload, resolves the public key,
     * and verifies the signature.
     */
    static verifyProfile(jws: string): Promise<{
        valid: boolean;
        profile?: PublicProfile;
        error?: string;
    }>;
}
//# sourceMappingURL=ProfileService.d.ts.map