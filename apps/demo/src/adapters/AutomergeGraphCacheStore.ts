/**
 * AutomergeGraphCacheStore - GraphCacheStore backed by Personal Automerge Doc
 *
 * Replaces EvoluGraphCacheStore. Stores cached graph data in doc.cachedGraph.
 */
import type {
  GraphCacheStore,
  CachedGraphEntry,
  PublicProfile,
  Verification,
  Attestation,
} from '@real-life/wot-core'
import {
  getPersonalDoc,
  changePersonalDoc,
} from '../personalDocManager'

export class AutomergeGraphCacheStore implements GraphCacheStore {

  async cacheEntry(
    did: string,
    profile: PublicProfile | null,
    verifications: Verification[],
    attestations: Attestation[],
  ): Promise<void> {
    const verifierDids = [...new Set(verifications.map(v => v.from))]
    const now = new Date().toISOString()

    changePersonalDoc(doc => {
      // Update summary entry
      doc.cachedGraph.entries[did] = {
        did,
        name: profile?.name ?? null,
        bio: profile?.bio ?? null,
        avatar: profile?.avatar ?? null,
        encryptionPublicKey: profile?.encryptionPublicKey ?? null,
        verificationCount: verifications.length,
        attestationCount: attestations.length,
        verifierDidsJson: verifierDids.length > 0 ? JSON.stringify(verifierDids) : null,
        fetchedAt: now,
      }

      // Delete old detail records for this subject
      for (const [key, v] of Object.entries(doc.cachedGraph.verifications)) {
        if (v.subjectDid === did) delete doc.cachedGraph.verifications[key]
      }
      for (const [key, a] of Object.entries(doc.cachedGraph.attestations)) {
        if (a.subjectDid === did) delete doc.cachedGraph.attestations[key]
      }

      // Insert new detail records
      for (const v of verifications) {
        const key = `${did}-${v.id}`
        doc.cachedGraph.verifications[key] = {
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
        doc.cachedGraph.attestations[key] = {
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
    })
  }

  async getEntry(did: string): Promise<CachedGraphEntry | null> {
    const doc = getPersonalDoc()
    const entry = doc.cachedGraph.entries[did]
    if (!entry) return null
    return this.toGraphEntry(entry)
  }

  async getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>> {
    const doc = getPersonalDoc()
    const didSet = new Set(dids)
    const map = new Map<string, CachedGraphEntry>()
    for (const [did, entry] of Object.entries(doc.cachedGraph.entries)) {
      if (didSet.has(did)) {
        map.set(did, this.toGraphEntry(entry))
      }
    }
    return map
  }

  async getCachedVerifications(did: string): Promise<Verification[]> {
    const doc = getPersonalDoc()
    return Object.values(doc.cachedGraph.verifications)
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
    const doc = getPersonalDoc()
    return Object.values(doc.cachedGraph.attestations)
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
    const doc = getPersonalDoc()
    const entry = doc.cachedGraph.entries[did]
    return entry?.name ?? null
  }

  async resolveNames(dids: string[]): Promise<Map<string, string>> {
    const doc = getPersonalDoc()
    const map = new Map<string, string>()
    for (const did of dids) {
      const entry = doc.cachedGraph.entries[did]
      if (entry?.name) map.set(did, entry.name)
    }
    return map
  }

  async findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]> {
    const doc = getPersonalDoc()
    const entry = doc.cachedGraph.entries[targetDid]
    if (!entry?.verifierDidsJson) return []
    const verifierDids: string[] = JSON.parse(entry.verifierDidsJson)
    const myContactSet = new Set(myContactDids)
    return verifierDids.filter(d => myContactSet.has(d))
  }

  async search(query: string): Promise<CachedGraphEntry[]> {
    const doc = getPersonalDoc()
    const lower = query.toLowerCase()
    const results: CachedGraphEntry[] = []

    for (const entry of Object.values(doc.cachedGraph.entries)) {
      // Search in name and bio
      if (entry.name?.toLowerCase().includes(lower) || entry.bio?.toLowerCase().includes(lower)) {
        results.push(this.toGraphEntry(entry))
        continue
      }
      // Search in attestation claims
      for (const a of Object.values(doc.cachedGraph.attestations)) {
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
    changePersonalDoc(doc => {
      const existing = doc.cachedGraph.entries[did]
      if (existing) {
        existing.name = name
        existing.verificationCount = verificationCount
        existing.attestationCount = attestationCount
        existing.fetchedAt = new Date().toISOString()
      } else {
        doc.cachedGraph.entries[did] = {
          did,
          name,
          bio: null,
          avatar: null,
          encryptionPublicKey: null,
          verificationCount,
          attestationCount,
          verifierDidsJson: null,
          fetchedAt: new Date().toISOString(),
        }
      }
    })
  }

  async evict(did: string): Promise<void> {
    changePersonalDoc(doc => {
      delete doc.cachedGraph.entries[did]
      for (const [key, v] of Object.entries(doc.cachedGraph.verifications)) {
        if (v.subjectDid === did) delete doc.cachedGraph.verifications[key]
      }
      for (const [key, a] of Object.entries(doc.cachedGraph.attestations)) {
        if (a.subjectDid === did) delete doc.cachedGraph.attestations[key]
      }
    })
  }

  async clear(): Promise<void> {
    changePersonalDoc(doc => {
      // Clear all entries
      for (const key of Object.keys(doc.cachedGraph.entries)) {
        delete doc.cachedGraph.entries[key]
      }
      for (const key of Object.keys(doc.cachedGraph.verifications)) {
        delete doc.cachedGraph.verifications[key]
      }
      for (const key of Object.keys(doc.cachedGraph.attestations)) {
        delete doc.cachedGraph.attestations[key]
      }
    })
  }

  private toGraphEntry(entry: {
    did: string
    name: string | null
    bio: string | null
    avatar: string | null
    encryptionPublicKey: string | null
    verificationCount: number
    attestationCount: number
    verifierDidsJson: string | null
    fetchedAt: string
  }): CachedGraphEntry {
    return {
      did: entry.did,
      ...(entry.name != null ? { name: entry.name } : {}),
      ...(entry.bio != null ? { bio: entry.bio } : {}),
      ...(entry.avatar != null ? { avatar: entry.avatar } : {}),
      ...(entry.encryptionPublicKey != null ? { encryptionPublicKey: entry.encryptionPublicKey } : {}),
      verificationCount: entry.verificationCount,
      attestationCount: entry.attestationCount,
      verifierDids: entry.verifierDidsJson ? JSON.parse(entry.verifierDidsJson) : [],
      fetchedAt: entry.fetchedAt,
    }
  }
}
