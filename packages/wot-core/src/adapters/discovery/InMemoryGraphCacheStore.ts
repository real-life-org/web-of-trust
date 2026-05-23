import type { PublicProfile } from '../../types/identity'
import type { Attestation } from '../../types/attestation'
import type { GraphCacheStore, CachedGraphEntry } from '../../ports/GraphCacheStore'

/**
 * In-memory implementation of GraphCacheStore.
 *
 * Useful for tests. Data is lost on page reload.
 */
export class InMemoryGraphCacheStore implements GraphCacheStore {
  private profiles = new Map<string, PublicProfile>()
  private attestationsBySubject = new Map<string, Attestation[]>()
  private fetchedAt = new Map<string, string>()
  private summaryCounts = new Map<string, { verificationCount: number; attestationCount: number }>()

  async cacheEntry(
    did: string,
    profile: PublicProfile | null,
    attestations: Attestation[],
  ): Promise<void> {
    if (profile) {
      this.profiles.set(did, profile)
    }
    this.attestationsBySubject.set(did, attestations)
    this.fetchedAt.set(did, new Date().toISOString())
    this.summaryCounts.delete(did) // Full refresh is authoritative
  }

  async getEntry(did: string): Promise<CachedGraphEntry | null> {
    const fetchedAt = this.fetchedAt.get(did)
    if (!fetchedAt) return null

    const profile = this.profiles.get(did)
    const attestations = this.attestationsBySubject.get(did) ?? []
    const summary = this.summaryCounts.get(did)

    return {
      did,
      name: profile?.name,
      bio: profile?.bio,
      avatar: profile?.avatar,
      verificationCount: summary?.verificationCount ?? 0,
      attestationCount: summary?.attestationCount ?? attestations.length,
      verifierDids: [],
      fetchedAt,
    }
  }

  async getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>> {
    const result = new Map<string, CachedGraphEntry>()
    for (const did of dids) {
      const entry = await this.getEntry(did)
      if (entry) result.set(did, entry)
    }
    return result
  }

  async getCachedAttestations(did: string): Promise<Attestation[]> {
    return this.attestationsBySubject.get(did) ?? []
  }

  async resolveName(did: string): Promise<string | null> {
    return this.profiles.get(did)?.name ?? null
  }

  async resolveNames(dids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const did of dids) {
      const name = this.profiles.get(did)?.name
      if (name) result.set(did, name)
    }
    return result
  }

  async findMutualContacts(_targetDid: string, _myContactDids: string[]): Promise<string[]> {
    return []
  }

  async search(query: string): Promise<CachedGraphEntry[]> {
    const lower = query.toLowerCase()
    const results: CachedGraphEntry[] = []
    for (const [did] of this.fetchedAt) {
      const profile = this.profiles.get(did)
      const nameMatch = profile?.name?.toLowerCase().includes(lower)
      const bioMatch = profile?.bio?.toLowerCase().includes(lower)
      const attestations = this.attestationsBySubject.get(did) ?? []
      const claimMatch = attestations.some(a => a.claim.toLowerCase().includes(lower))
      if (nameMatch || bioMatch || claimMatch) {
        const entry = await this.getEntry(did)
        if (entry) results.push(entry)
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
    if (name !== null) {
      const existing = this.profiles.get(did)
      this.profiles.set(did, {
        did,
        name,
        ...(existing?.bio ? { bio: existing.bio } : {}),
        ...(existing?.avatar ? { avatar: existing.avatar } : {}),
        updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      })
    }
    this.summaryCounts.set(did, { verificationCount, attestationCount })
    if (!this.fetchedAt.has(did)) {
      this.fetchedAt.set(did, new Date().toISOString())
    }
  }

  async evict(did: string): Promise<void> {
    this.profiles.delete(did)
    this.attestationsBySubject.delete(did)
    this.fetchedAt.delete(did)
    this.summaryCounts.delete(did)
  }

  async clear(): Promise<void> {
    this.profiles.clear()
    this.attestationsBySubject.clear()
    this.fetchedAt.clear()
    this.summaryCounts.clear()
  }
}
