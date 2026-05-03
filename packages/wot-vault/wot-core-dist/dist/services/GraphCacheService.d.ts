import { DiscoveryAdapter } from '../ports/DiscoveryAdapter';
import { GraphCacheStore, CachedGraphEntry } from '../ports/GraphCacheStore';
export interface GraphCacheOptions {
    /** How long before cached data is considered stale (ms). Default: 1 hour. */
    staleDurationMs?: number;
    /** Maximum concurrent fetches during bulk refresh. Default: 3. */
    concurrency?: number;
}
/**
 * Orchestrator that fetches graph data via DiscoveryAdapter
 * and persists it to GraphCacheStore.
 *
 * Implements stale-while-revalidate: returns cached data immediately,
 * refreshes in background when stale.
 */
export declare class GraphCacheService {
    private discovery;
    private store;
    private staleDurationMs;
    private concurrency;
    private refreshing;
    constructor(discovery: DiscoveryAdapter, store: GraphCacheStore, options?: GraphCacheOptions);
    /**
     * Ensure a DID's data is cached. Returns cached data immediately.
     * If stale or missing, fetches in background.
     */
    ensureCached(did: string): Promise<CachedGraphEntry | null>;
    /**
     * Force-refresh a DID's graph data from the network.
     * Returns the fresh data, or existing cached data if fetch fails.
     */
    refresh(did: string): Promise<CachedGraphEntry | null>;
    /**
     * Refresh graph data for all given contact DIDs.
     * Used on app start to populate cache for contacts.
     * Respects concurrency limit. Only refreshes stale/missing entries.
     */
    refreshContacts(contactDids: string[]): Promise<void>;
    /**
     * Lightweight batch refresh: fetches only name + counts for all DIDs
     * in a single HTTP request via resolveSummaries().
     *
     * Falls back to full refreshContacts() if the DiscoveryAdapter
     * doesn't support resolveSummaries().
     */
    refreshContactSummaries(contactDids: string[]): Promise<void>;
    /** Resolve DID to display name from cache. */
    resolveName(did: string): Promise<string | null>;
    /** Batch resolve DIDs to names from cache. */
    resolveNames(dids: string[]): Promise<Map<string, string>>;
    /** Find which of myContactDids have also verified the target DID. */
    findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]>;
    private isStale;
    private refreshInBackground;
}
//# sourceMappingURL=GraphCacheService.d.ts.map