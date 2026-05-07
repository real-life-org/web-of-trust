import type { DiscoveryAdapter } from '../ports/DiscoveryAdapter'
import type { GraphCacheStore, CachedGraphEntry } from '../ports/GraphCacheStore'

export interface GraphCacheOptions {
  /** How long before cached data is considered stale (ms). Default: 1 hour. */
  staleDurationMs?: number
  /** Maximum concurrent fetches during bulk refresh. Default: 3. */
  concurrency?: number
}

/**
 * Orchestrator that fetches graph data via DiscoveryAdapter
 * and persists it to GraphCacheStore.
 *
 * Implements stale-while-revalidate: returns cached data immediately,
 * refreshes in background when stale.
 */
export class GraphCacheService {
  private staleDurationMs: number
  private concurrency: number
  private refreshing = new Set<string>()

  constructor(
    private discovery: DiscoveryAdapter,
    private store: GraphCacheStore,
    options?: GraphCacheOptions,
  ) {
    this.staleDurationMs = options?.staleDurationMs ?? 60 * 60 * 1000 // 1 hour
    this.concurrency = options?.concurrency ?? 3
  }

  /**
   * Ensure a DID's data is cached. Returns cached data immediately.
   * If stale or missing, fetches in background.
   */
  async ensureCached(did: string): Promise<CachedGraphEntry | null> {
    const existing = await this.store.getEntry(did)

    if (!existing || this.isStale(existing)) {
      this.refreshInBackground(did)
    }

    return existing
  }

  /**
   * Force-refresh a DID's graph data from the network.
   * Returns the fresh data, or existing cached data if fetch fails.
   */
  async refresh(did: string): Promise<CachedGraphEntry | null> {
    try {
      const [profileResult, verifications, attestations] = await Promise.all([
        this.discovery.resolveProfile(did),
        this.discovery.resolveVerifications(did),
        this.discovery.resolveAttestations(did),
      ])

      await this.store.cacheEntry(did, profileResult.profile, verifications, attestations)
      return this.store.getEntry(did)
    } catch {
      return this.store.getEntry(did)
    }
  }

  /**
   * Refresh graph data for all given contact DIDs.
   * Used on app start to populate cache for contacts.
   * Respects concurrency limit. Only refreshes stale/missing entries.
   */
  async refreshContacts(contactDids: string[]): Promise<void> {
    const entries = await this.store.getEntries(contactDids)
    const staleOrMissing = contactDids.filter(did => {
      const entry = entries.get(did)
      return !entry || this.isStale(entry)
    })

    if (staleOrMissing.length === 0) return

    for (let i = 0; i < staleOrMissing.length; i += this.concurrency) {
      const batch = staleOrMissing.slice(i, i + this.concurrency)
      await Promise.allSettled(batch.map(did => this.refresh(did)))
    }
  }

  /**
   * Lightweight batch refresh: fetches only name + counts for all DIDs
   * in a single HTTP request via resolveSummaries().
   *
   * Falls back to full refreshContacts() if the DiscoveryAdapter
   * doesn't support resolveSummaries().
   */
  async refreshContactSummaries(contactDids: string[]): Promise<void> {
    if (contactDids.length === 0) return

    if (!this.discovery.resolveSummaries) {
      return this.refreshContacts(contactDids)
    }

    try {
      const summaries = await this.discovery.resolveSummaries(contactDids)
      for (const s of summaries) {
        await this.store.updateSummary(s.did, s.name, s.verificationCount, s.attestationCount)
      }
    } catch {
      // Network error — counts stay as cached
    }
  }

  /** Resolve DID to display name from cache. */
  async resolveName(did: string): Promise<string | null> {
    return this.store.resolveName(did)
  }

  /** Batch resolve DIDs to names from cache. */
  async resolveNames(dids: string[]): Promise<Map<string, string>> {
    return this.store.resolveNames(dids)
  }

  /** Find which of myContactDids have also verified the target DID. */
  async findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]> {
    return this.store.findMutualContacts(targetDid, myContactDids)
  }

  private isStale(entry: CachedGraphEntry): boolean {
    const age = Date.now() - new Date(entry.fetchedAt).getTime()
    return age > this.staleDurationMs
  }

  private async refreshInBackground(did: string): Promise<void> {
    if (this.refreshing.has(did)) return
    this.refreshing.add(did)
    try {
      await this.refresh(did)
    } finally {
      this.refreshing.delete(did)
    }
  }
}
