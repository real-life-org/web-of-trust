import type { PublicProfile } from '../types/identity'
import type { Attestation } from '../types/attestation'
import type { DidDocument } from '../protocol/identity/did-document'

/**
 * Summary of cached graph data for a DID.
 * Pre-computed for fast UI rendering (contact list, profile cards).
 */
export interface CachedGraphEntry {
  did: string
  name?: string
  bio?: string
  avatar?: string
  verificationCount: number
  attestationCount: number
  fetchedAt: string // ISO 8601
  /** keyAgreement x25519 public key (multibase) of the DID, if known.
   *  Enables offline ECIES delivery / space invites (Sync 004 §keyAgreement). */
  encryptionKeyMultibase?: string
}

/**
 * Persistent store for social graph cache data.
 *
 * Caches profiles and attestations fetched via DiscoveryAdapter for
 * offline access, DID-to-name resolution, and trust signal computation.
 *
 * Implementations:
 * - InMemoryGraphCacheStore (for tests)
 * - AutomergeGraphCacheStore (for Demo App, backed by LocalCacheStore)
 */
/**
 * Complete graph snapshot for a DID, carrying both resource lists.
 *
 * `verifications` is the DERIVED `Attestation[]` form (Sync 004 `/v` resolves
 * to verified verification-attestations), NOT the legacy structured
 * `Verification` type — this port deliberately never imports the legacy
 * verification type module.
 */
export interface GraphCacheSnapshot {
  profile: PublicProfile | null
  attestations: Attestation[]
  verifications: Attestation[]
  /** Canonical key source (Sync 004 Z.153). When present, the store extracts the
   *  keyAgreement x25519 key into `CachedGraphEntry.encryptionKeyMultibase` for
   *  offline ECIES delivery. Optional + PRESERVE-ON-MISSING: a snapshot without a
   *  didDocument must NEVER null an already-cached key. The key lives in the local
   *  cache only — it is never written back into profile metadata (non-redundancy). */
  didDocument?: DidDocument | null
}

export interface GraphCacheStore {
  // --- Write (called by GraphCacheService after fetching) ---

  /** Cache a complete graph snapshot for a DID (profile + attestations + verifications) */
  cacheEntry(did: string, snapshot: GraphCacheSnapshot): Promise<void>

  // --- Read: Summary (for contact list, badges) ---

  /** Get the cached summary for a DID (fast, pre-computed) */
  getEntry(did: string): Promise<CachedGraphEntry | null>

  /** Get summaries for multiple DIDs (batch, for contact list) */
  getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>>

  // --- Read: Detail (for profile page) ---

  /** Get cached attestations for a DID */
  getCachedAttestations(did: string): Promise<Attestation[]>

  /** Get cached verifications for a DID (derived Attestation[] form) */
  getCachedVerifications(did: string): Promise<Attestation[]>

  // --- Read: Graph queries ---

  /** Resolve DID to display name (returns null if not cached) */
  resolveName(did: string): Promise<string | null>

  /** Batch resolve DIDs to names (for rendering verifier/attester lists) */
  resolveNames(dids: string[]): Promise<Map<string, string>>

  /**
   * Search cached profiles by name or claim text.
   * For "does anyone offer X?" type queries.
   */
  search(query: string): Promise<CachedGraphEntry[]>

  // --- Write: Summary-only update (from batch endpoint) ---

  /**
   * Update only summary fields (name, counts) without touching detail data.
   * Used by refreshContactSummaries() for lightweight batch updates.
   */
  updateSummary(
    did: string,
    name: string | null,
    verificationCount: number,
    attestationCount: number,
  ): Promise<void>

  // --- Lifecycle ---

  /** Remove all cached data for a DID */
  evict(did: string): Promise<void>

  /** Remove all cached data */
  clear(): Promise<void>
}
