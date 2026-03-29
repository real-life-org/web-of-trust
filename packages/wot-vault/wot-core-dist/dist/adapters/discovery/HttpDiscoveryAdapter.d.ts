import { PublicProfile } from '../../types/identity';
import { Verification } from '../../types/verification';
import { Attestation } from '../../types/attestation';
import { WotIdentity } from '../../identity/WotIdentity';
import { DiscoveryAdapter, ProfileResolveResult, PublicVerificationsData, PublicAttestationsData, ProfileSummary } from '../interfaces/DiscoveryAdapter';
/**
 * HTTP-based DiscoveryAdapter implementation.
 *
 * POC implementation backed by wot-profiles (HTTP REST + SQLite).
 * Replaceable by Automerge Auto-Groups, IPFS, DHT, etc.
 */
export declare class HttpDiscoveryAdapter implements DiscoveryAdapter {
    private baseUrl;
    private readonly TIMEOUT_MS;
    constructor(baseUrl: string);
    private fetchWithTimeout;
    publishProfile(data: PublicProfile, identity: WotIdentity): Promise<void>;
    publishVerifications(data: PublicVerificationsData, identity: WotIdentity): Promise<void>;
    publishAttestations(data: PublicAttestationsData, identity: WotIdentity): Promise<void>;
    resolveProfile(did: string): Promise<ProfileResolveResult>;
    resolveVerifications(did: string): Promise<Verification[]>;
    resolveAttestations(did: string): Promise<Attestation[]>;
    resolveSummaries(dids: string[]): Promise<ProfileSummary[]>;
}
//# sourceMappingURL=HttpDiscoveryAdapter.d.ts.map