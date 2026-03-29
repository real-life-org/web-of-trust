import { PublicProfile } from '../../types/identity';
import { Verification } from '../../types/verification';
import { Attestation } from '../../types/attestation';
import { GraphCacheStore, CachedGraphEntry } from '../interfaces/GraphCacheStore';
/**
 * In-memory implementation of GraphCacheStore.
 *
 * Useful for tests. Data is lost on page reload.
 */
export declare class InMemoryGraphCacheStore implements GraphCacheStore {
    private profiles;
    private verifications;
    private attestations;
    private fetchedAt;
    private summaryCounts;
    cacheEntry(did: string, profile: PublicProfile | null, verifications: Verification[], attestations: Attestation[]): Promise<void>;
    getEntry(did: string): Promise<CachedGraphEntry | null>;
    getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>>;
    getCachedVerifications(did: string): Promise<Verification[]>;
    getCachedAttestations(did: string): Promise<Attestation[]>;
    resolveName(did: string): Promise<string | null>;
    resolveNames(dids: string[]): Promise<Map<string, string>>;
    findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]>;
    search(query: string): Promise<CachedGraphEntry[]>;
    updateSummary(did: string, name: string | null, verificationCount: number, attestationCount: number): Promise<void>;
    evict(did: string): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=InMemoryGraphCacheStore.d.ts.map