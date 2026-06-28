/**
 * GraphCacheStore backed by LocalCacheStore (plain JSON in IndexedDB).
 *
 * Local-only cache — NOT synced to other devices, NOT stored in PersonalDoc.
 * Used as offline fallback for profile lookups (OfflineFirstDiscoveryAdapter).
 */
import type {
  GraphCacheStore,
  GraphCacheSnapshot,
  CachedGraphEntry,
} from '@web_of_trust/core/ports'
import type {
  Attestation,
} from '@web_of_trust/core/types'
import { isVerificationVcJws, encryptionKeyMultibaseFromDidDocument } from '@web_of_trust/core/protocol'
import type { LocalCacheStore } from './LocalCacheStore'

const ENTRIES_KEY = 'graph:entries'
const ATTESTATIONS_KEY = 'graph:attestations'
const VERIFICATIONS_KEY = 'graph:verifications'

interface EntryDoc {
  did: string
  name: string | null
  bio: string | null
  avatar: string | null
  verificationCount: number
  attestationCount: number
  fetchedAt: string
  /** keyAgreement x25519 public key (multibase) of the DID, if known. Enables
   *  offline ECIES delivery / space invites (Sync 004 §keyAgreement). Old persisted
   *  EntryDocs lack the field → undefined → no key (today's behavior) until the
   *  next online cacheEntry backfills it. No schema version bump. */
  encryptionKeyMultibase: string | null
}

interface AttestationDoc {
  subjectDid: string
  attestationId: string
  fromDid: string
  toDid: string
  claim: string
  tagsJson: string | null
  context: string | null
  attestationCreatedAt: string
  vcJws: string
}

export class AutomergeGraphCacheStore implements GraphCacheStore {
  private store: LocalCacheStore
  // In-memory cache — loaded once, then kept in sync
  private entries: Record<string, EntryDoc> = {}
  private attestations: Record<string, AttestationDoc> = {}
  // Derived Attestation[] verification list per subject (Sync 004 `/v`), keyed
  // like attestations; NOT the legacy structured Verification type.
  private verifications: Record<string, AttestationDoc> = {}

  constructor(store: LocalCacheStore) {
    this.store = store
  }

  /** Load cached data from IDB into memory. Call once after LocalCacheStore.open(). */
  async load(): Promise<void> {
    this.entries = await this.store.get<Record<string, EntryDoc>>(ENTRIES_KEY) ?? {}
    this.attestations = await this.store.get<Record<string, AttestationDoc>>(ATTESTATIONS_KEY) ?? {}
    this.verifications = await this.store.get<Record<string, AttestationDoc>>(VERIFICATIONS_KEY) ?? {}
  }

  async cacheEntry(did: string, snapshot: GraphCacheSnapshot): Promise<void> {
    const { profile, attestations, verifications } = snapshot
    const now = new Date().toISOString()

    // PRESERVE-ON-MISSING: extract the key via the canonical validating helper;
    // when the snapshot carries no (valid) didDocument, keep the previously
    // cached key instead of nulling it. A snapshot without a didDocument must
    // NEVER lose an already-cached key.
    const encryptionKeyMultibase =
      encryptionKeyMultibaseFromDidDocument(snapshot.didDocument)
        ?? this.entries[did]?.encryptionKeyMultibase
        ?? null

    this.entries[did] = {
      did,
      name: profile?.name ?? null,
      bio: profile?.bio ?? null,
      avatar: profile?.avatar ?? null,
      verificationCount: verifications.length,
      attestationCount: attestations.length,
      fetchedAt: now,
      encryptionKeyMultibase,
    }

    this.replaceSubjectDocs(this.attestations, did, attestations)
    this.replaceSubjectDocs(this.verifications, did, verifications)

    // Persist (fire-and-forget — cache loss is acceptable)
    this.persistAll()
  }

  private replaceSubjectDocs(
    target: Record<string, AttestationDoc>,
    did: string,
    items: Attestation[],
  ): void {
    for (const key of Object.keys(target)) {
      if (target[key].subjectDid === did) delete target[key]
    }
    for (const a of items) {
      target[`${did}-${a.id}`] = {
        subjectDid: did,
        attestationId: a.id,
        fromDid: a.from,
        toDid: a.to,
        claim: a.claim,
        tagsJson: a.tags ? JSON.stringify(a.tags) : null,
        context: a.context ?? null,
        attestationCreatedAt: a.createdAt,
        vcJws: a.vcJws,
      }
    }
  }

  async getEntry(did: string): Promise<CachedGraphEntry | null> {
    const entry = this.entries[did]
    return entry ? this.toGraphEntry(entry) : null
  }

  async getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>> {
    const didSet = new Set(dids)
    const map = new Map<string, CachedGraphEntry>()
    for (const [did, entry] of Object.entries(this.entries)) {
      if (didSet.has(did)) {
        map.set(did, this.toGraphEntry(entry))
      }
    }
    return map
  }

  async getCachedAttestations(did: string): Promise<Attestation[]> {
    return this.mapSubjectDocs(this.attestations, did)
  }

  async getCachedVerifications(did: string): Promise<Attestation[]> {
    return this.mapSubjectDocs(this.verifications, did)
  }

  private mapSubjectDocs(target: Record<string, AttestationDoc>, did: string): Attestation[] {
    return Object.values(target)
      .filter(a => a.subjectDid === did)
      .map(a => ({
        id: a.attestationId,
        from: a.fromDid,
        to: a.toDid,
        claim: a.claim,
        ...(a.tagsJson != null ? { tags: JSON.parse(a.tagsJson) } : {}),
        ...(a.context != null ? { context: a.context } : {}),
        createdAt: a.attestationCreatedAt,
        vcJws: a.vcJws,
        // Re-derive the type-borne verification marker from the cached vcJws
        // (review BLOCKER fix, extended to the /v cache fallback per Codex
        // review #198): OfflineFirstDiscoveryAdapter.resolveVerifications() can
        // return this fallback, and consumers classify via isVerification —
        // absent would misclassify a genuine /v verification as a generic one.
        ...(isVerificationVcJws(a.vcJws) ? { isVerification: true } : {}),
      }))
  }

  async resolveName(did: string): Promise<string | null> {
    return this.entries[did]?.name ?? null
  }

  async resolveNames(dids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for (const did of dids) {
      const name = this.entries[did]?.name
      if (name) map.set(did, name)
    }
    return map
  }

  async search(query: string): Promise<CachedGraphEntry[]> {
    const lower = query.toLowerCase()
    const results: CachedGraphEntry[] = []

    for (const entry of Object.values(this.entries)) {
      if (entry.name?.toLowerCase().includes(lower) || entry.bio?.toLowerCase().includes(lower)) {
        results.push(this.toGraphEntry(entry))
        continue
      }
      for (const a of Object.values(this.attestations)) {
        if (a.subjectDid === entry.did && a.claim.toLowerCase().includes(lower)) {
          results.push(this.toGraphEntry(entry))
          break
        }
      }
    }

    return results
  }

  async updateSummary(
    did: string,
    name: string | null,
    verificationCount: number,
    attestationCount: number,
  ): Promise<void> {
    const existing = this.entries[did]
    if (existing) {
      // Summary-only update: never touch the cached encryptionKeyMultibase.
      existing.name = name
      existing.verificationCount = verificationCount
      existing.attestationCount = attestationCount
      existing.fetchedAt = new Date().toISOString()
    } else {
      this.entries[did] = {
        did,
        name,
        bio: null,
        avatar: null,
        verificationCount,
        attestationCount,
        fetchedAt: new Date().toISOString(),
        encryptionKeyMultibase: null,
      }
    }
    this.store.set(ENTRIES_KEY, this.entries).catch(() => {})
  }

  async evict(did: string): Promise<void> {
    delete this.entries[did]
    for (const key of Object.keys(this.attestations)) {
      if (this.attestations[key].subjectDid === did) delete this.attestations[key]
    }
    for (const key of Object.keys(this.verifications)) {
      if (this.verifications[key].subjectDid === did) delete this.verifications[key]
    }
    this.persistAll()
  }

  async clear(): Promise<void> {
    this.entries = {}
    this.attestations = {}
    this.verifications = {}
    this.persistAll()
  }

  private toGraphEntry(entry: EntryDoc): CachedGraphEntry {
    return {
      did: entry.did,
      ...(entry.name != null ? { name: entry.name } : {}),
      ...(entry.bio != null ? { bio: entry.bio } : {}),
      ...(entry.avatar != null ? { avatar: entry.avatar } : {}),
      verificationCount: entry.verificationCount,
      attestationCount: entry.attestationCount,
      fetchedAt: entry.fetchedAt,
      // Old persisted EntryDocs lack the field → undefined → omitted (no key,
      // today's behavior) until the next online cacheEntry backfills it.
      ...(entry.encryptionKeyMultibase != null ? { encryptionKeyMultibase: entry.encryptionKeyMultibase } : {}),
    }
  }

  private persistAll(): void {
    // Fire-and-forget — cache loss is acceptable, will be re-fetched
    this.store.set(ENTRIES_KEY, this.entries).catch(() => {})
    this.store.set(ATTESTATIONS_KEY, this.attestations).catch(() => {})
    this.store.set(VERIFICATIONS_KEY, this.verifications).catch(() => {})
  }
}
