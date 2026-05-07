import type { PublicProfile } from '../../types/identity'
import type { Verification } from '../../types/verification'
import type { Attestation } from '../../types/attestation'
import type { GraphCacheStore, CachedGraphEntry } from '../../ports/GraphCacheStore'

/**
 * In-memory implementation of GraphCacheStore.
 *
 * Useful for tests. Data is lost on page reload.
 */
export class InMemoryGraphCacheStore implements GraphCacheStore {
  private profiles = new Map<string, PublicProfile>()
  private verifications = new Map<string, Verification[]>()
  private attestations = new Map<string, Attestation[]>()
  private fetchedAt = new Map<string, string>()
  private summaryCounts = new Map<string, { verificationCount: number; attestationCount: number }>()

  async cacheEntry(
    did: string,
    profile: PublicProfile | null,
    verifications: Verification[],
    attestations: Attestation[],
  ): Promise<void> {
    if (profile) {
      this.profiles.set(did, profile)
    }
    this.verifications.set(did, verifications)
    this.attestations.set(did, attestations)
    this.fetchedAt.set(did, new Date().toISOString())
    this.summaryCounts.delete(did) // Full refresh is authoritative
  }

  async getEntry(did: string): Promise<CachedGraphEntry | null> {
    const fetchedAt = this.fetchedAt.get(did)
    if (!fetchedAt) return null

    const profile = this.profiles.get(did)
    const verifications = this.verifications.get(did) ?? []
    const attestations = this.attestations.get(did) ?? []
    const summary = this.summaryCounts.get(did)

    return {
      did,
      name: profile?.name,
      bio: profile?.bio,
      avatar: profile?.avatar,
      verificationCount: summary?.verificationCount ?? verifications.length,
      attestationCount: summary?.attestationCount ?? attestations.length,
      verifierDids: verifications.map(v => v.from),
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

  async getCachedVerifications(did: string): Promise<Verification[]> {
    return this.verifications.get(did) ?? []
  }

  async getCachedAttestations(did: string): Promise<Attestation[]> {
    return this.attestations.get(did) ?? []
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

  async findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]> {
    const verifiers = this.verifications.get(targetDid) ?? []
    const verifierDids = new Set(verifiers.map(v => v.from))
    return myContactDids.filter(did => verifierDids.has(did))
  }

  async search(query: string): Promise<CachedGraphEntry[]> {
    const lower = query.toLowerCase()
    const results: CachedGraphEntry[] = []
    for (const [did] of this.fetchedAt) {
      const profile = this.profiles.get(did)
      const nameMatch = profile?.name?.toLowerCase().includes(lower)
      const bioMatch = profile?.bio?.toLowerCase().includes(lower)
      const attestations = this.attestations.get(did) ?? []
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
    this.verifications.delete(did)
    this.attestations.delete(did)
    this.fetchedAt.delete(did)
    this.summaryCounts.delete(did)
  }

  async clear(): Promise<void> {
    this.profiles.clear()
    this.verifications.clear()
    this.attestations.clear()
    this.fetchedAt.clear()
    this.summaryCounts.clear()
  }
}
