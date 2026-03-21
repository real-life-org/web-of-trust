/**
 * GraphCacheStore backed by LocalCacheStore (plain JSON in IndexedDB).
 *
 * Local-only cache — NOT synced to other devices, NOT stored in PersonalDoc.
 * Used as offline fallback for profile lookups (OfflineFirstDiscoveryAdapter).
 */
import type {
  GraphCacheStore,
  CachedGraphEntry,
  PublicProfile,
  Verification,
  Attestation,
} from '@real-life/wot-core'
import type { LocalCacheStore } from './LocalCacheStore'

const ENTRIES_KEY = 'graph:entries'
const VERIFICATIONS_KEY = 'graph:verifications'
const ATTESTATIONS_KEY = 'graph:attestations'

interface EntryDoc {
  did: string
  name: string | null
  bio: string | null
  avatar: string | null
  encryptionPublicKey: string | null
  verificationCount: number
  attestationCount: number
  verifierDids: string[]
  fetchedAt: string
}

interface VerificationDoc {
  subjectDid: string
  verificationId: string
  fromDid: string
  toDid: string
  timestamp: string
  proofJson: string
  locationJson: string | null
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
  proofJson: string
}

export class AutomergeGraphCacheStore implements GraphCacheStore {
  private store: LocalCacheStore
  // In-memory cache — loaded once, then kept in sync
  private entries: Record<string, EntryDoc> = {}
  private verifications: Record<string, VerificationDoc> = {}
  private attestations: Record<string, AttestationDoc> = {}

  constructor(store: LocalCacheStore) {
    this.store = store
  }

  /** Load cached data from IDB into memory. Call once after LocalCacheStore.open(). */
  async load(): Promise<void> {
    this.entries = await this.store.get<Record<string, EntryDoc>>(ENTRIES_KEY) ?? {}
    this.verifications = await this.store.get<Record<string, VerificationDoc>>(VERIFICATIONS_KEY) ?? {}
    this.attestations = await this.store.get<Record<string, AttestationDoc>>(ATTESTATIONS_KEY) ?? {}
  }

  async cacheEntry(
    did: string,
    profile: PublicProfile | null,
    verifications: Verification[],
    attestations: Attestation[],
  ): Promise<void> {
    const verifierDids = [...new Set(verifications.map(v => v.from))]
    const now = new Date().toISOString()

    // Update entry
    this.entries[did] = {
      did,
      name: profile?.name ?? null,
      bio: profile?.bio ?? null,
      avatar: profile?.avatar ?? null,
      encryptionPublicKey: profile?.encryptionPublicKey ?? null,
      verificationCount: verifications.length,
      attestationCount: attestations.length,
      verifierDids,
      fetchedAt: now,
    }

    // Delete old detail records for this subject
    for (const key of Object.keys(this.verifications)) {
      if (this.verifications[key].subjectDid === did) delete this.verifications[key]
    }
    for (const key of Object.keys(this.attestations)) {
      if (this.attestations[key].subjectDid === did) delete this.attestations[key]
    }

    // Insert new detail records
    for (const v of verifications) {
      const key = `${did}-${v.id}`
      this.verifications[key] = {
        subjectDid: did,
        verificationId: v.id,
        fromDid: v.from,
        toDid: v.to,
        timestamp: v.timestamp,
        proofJson: JSON.stringify(v.proof),
        locationJson: v.location ? JSON.stringify(v.location) : null,
      }
    }
    for (const a of attestations) {
      const key = `${did}-${a.id}`
      this.attestations[key] = {
        subjectDid: did,
        attestationId: a.id,
        fromDid: a.from,
        toDid: a.to,
        claim: a.claim,
        tagsJson: a.tags ? JSON.stringify(a.tags) : null,
        context: a.context ?? null,
        attestationCreatedAt: a.createdAt,
        proofJson: JSON.stringify(a.proof),
      }
    }

    // Persist (fire-and-forget — cache loss is acceptable)
    this.persistAll()
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

  async getCachedVerifications(did: string): Promise<Verification[]> {
    return Object.values(this.verifications)
      .filter(v => v.subjectDid === did)
      .map(v => ({
        id: v.verificationId,
        from: v.fromDid,
        to: v.toDid,
        timestamp: v.timestamp,
        proof: JSON.parse(v.proofJson),
        ...(v.locationJson != null ? { location: JSON.parse(v.locationJson) } : {}),
      }))
  }

  async getCachedAttestations(did: string): Promise<Attestation[]> {
    return Object.values(this.attestations)
      .filter(a => a.subjectDid === did)
      .map(a => ({
        id: a.attestationId,
        from: a.fromDid,
        to: a.toDid,
        claim: a.claim,
        ...(a.tagsJson != null ? { tags: JSON.parse(a.tagsJson) } : {}),
        ...(a.context != null ? { context: a.context } : {}),
        createdAt: a.attestationCreatedAt,
        proof: JSON.parse(a.proofJson),
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

  async findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]> {
    const entry = this.entries[targetDid]
    if (!entry?.verifierDids?.length) return []
    const myContactSet = new Set(myContactDids)
    return entry.verifierDids.filter(d => myContactSet.has(d))
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
        encryptionPublicKey: null,
        verificationCount,
        attestationCount,
        verifierDids: [],
        fetchedAt: new Date().toISOString(),
      }
    }
    this.store.set(ENTRIES_KEY, this.entries).catch(() => {})
  }

  async evict(did: string): Promise<void> {
    delete this.entries[did]
    for (const key of Object.keys(this.verifications)) {
      if (this.verifications[key].subjectDid === did) delete this.verifications[key]
    }
    for (const key of Object.keys(this.attestations)) {
      if (this.attestations[key].subjectDid === did) delete this.attestations[key]
    }
    this.persistAll()
  }

  async clear(): Promise<void> {
    this.entries = {}
    this.verifications = {}
    this.attestations = {}
    this.persistAll()
  }

  private toGraphEntry(entry: EntryDoc): CachedGraphEntry {
    return {
      did: entry.did,
      ...(entry.name != null ? { name: entry.name } : {}),
      ...(entry.bio != null ? { bio: entry.bio } : {}),
      ...(entry.avatar != null ? { avatar: entry.avatar } : {}),
      ...(entry.encryptionPublicKey != null ? { encryptionPublicKey: entry.encryptionPublicKey } : {}),
      verificationCount: entry.verificationCount,
      attestationCount: entry.attestationCount,
      verifierDids: entry.verifierDids ?? [],
      fetchedAt: entry.fetchedAt,
    }
  }

  private persistAll(): void {
    // Fire-and-forget — cache loss is acceptable, will be re-fetched
    this.store.set(ENTRIES_KEY, this.entries).catch(() => {})
    this.store.set(VERIFICATIONS_KEY, this.verifications).catch(() => {})
    this.store.set(ATTESTATIONS_KEY, this.attestations).catch(() => {})
  }
}
