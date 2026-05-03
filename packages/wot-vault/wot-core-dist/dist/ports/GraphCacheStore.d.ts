import { PublicProfile } from '../types/identity';
import { Verification } from '../types/verification';
import { Attestation } from '../types/attestation';
/**
 * Summary of cached graph data for a DID.
 * Pre-computed for fast UI rendering (contact list, profile cards).
 */
export interface CachedGraphEntry {
    did: string;
    name?: string;
    bio?: string;
    avatar?: string;
    verificationCount: number;
    attestationCount: number;
    /** DIDs that have verified this person */
    verifierDids: string[];
    fetchedAt: string;
}
/**
 * Persistent store for social graph cache data.
 *
 * Caches profiles, verifications, and attestations fetched via
 * DiscoveryAdapter for offline access, DID-to-name resolution,
 * and trust signal computation.
 *
 * Implementations:
 * - InMemoryGraphCacheStore (for tests)
 * - EvoluGraphCacheStore (for Demo App, backed by Evolu/SQLite)
 */
export interface GraphCacheStore {
    /** Cache a complete graph snapshot for a DID */
    cacheEntry(did: string, profile: PublicProfile | null, verifications: Verification[], attestations: Attestation[]): Promise<void>;
    /** Get the cached summary for a DID (fast, pre-computed) */
    getEntry(did: string): Promise<CachedGraphEntry | null>;
    /** Get summaries for multiple DIDs (batch, for contact list) */
    getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>>;
    /** Get cached verifications for a DID */
    getCachedVerifications(did: string): Promise<Verification[]>;
    /** Get cached attestations for a DID */
    getCachedAttestations(did: string): Promise<Attestation[]>;
    /** Resolve DID to display name (returns null if not cached) */
    resolveName(did: string): Promise<string | null>;
    /** Batch resolve DIDs to names (for rendering verifier/attester lists) */
    resolveNames(dids: string[]): Promise<Map<string, string>>;
    /**
     * Find mutual contacts: which of myContactDids also verified targetDid?
     * Returns the intersection of myContactDids and targetDid's verifierDids.
     */
    findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]>;
    /**
     * Search cached profiles by name or claim text.
     * For "does anyone offer X?" type queries.
     */
    search(query: string): Promise<CachedGraphEntry[]>;
    /**
     * Update only summary fields (name, counts) without touching detail data.
     * Used by refreshContactSummaries() for lightweight batch updates.
     */
    updateSummary(did: string, name: string | null, verificationCount: number, attestationCount: number): Promise<void>;
    /** Remove all cached data for a DID */
    evict(did: string): Promise<void>;
    /** Remove all cached data */
    clear(): Promise<void>;
}
//# sourceMappingURL=GraphCacheStore.d.ts.map