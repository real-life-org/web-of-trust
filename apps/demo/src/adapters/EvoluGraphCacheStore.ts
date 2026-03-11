/**
 * EvoluGraphCacheStore - Persistent GraphCacheStore backed by Evolu
 *
 * Caches social graph data (profiles, verifications, attestations)
 * for offline access, DID-to-name resolution, and trust signals.
 */
import {
  NonEmptyString,
  NonEmptyString1000,
  booleanToSqliteBoolean,
  createIdFromString,
  type Evolu,
} from '@evolu/common'
import type {
  GraphCacheStore,
  CachedGraphEntry,
  PublicProfile,
  Verification,
  Attestation,
} from '@real-life/wot-core'
import type { AppSchema } from '../db'

type AppEvolu = Evolu<AppSchema>

const str = (s: string) => NonEmptyString1000.orThrow(s)
const longStr = (s: string) => NonEmptyString.orThrow(s)

export class EvoluGraphCacheStore implements GraphCacheStore {
  constructor(private evolu: AppEvolu) {}

  async cacheEntry(
    did: string,
    profile: PublicProfile | null,
    verifications: Verification[],
    attestations: Attestation[],
  ): Promise<void> {
    const now = new Date().toISOString()
    const verifierDids = verifications.map(v => v.from)

    // Upsert the summary entry
    this.evolu.upsert('cachedGraphEntry', {
      id: createIdFromString<'CachedGraphEntry'>(`graph-${did}`),
      did: str(did),
      name: profile?.name ? str(profile.name) : null,
      bio: profile?.bio ? str(profile.bio) : null,
      avatar: profile?.avatar ? longStr(profile.avatar) : null,
      encryptionPublicKey: profile?.encryptionPublicKey ? str(profile.encryptionPublicKey) : null,
      verificationCount: str(String(verifications.length)),
      attestationCount: str(String(attestations.length)),
      verifierDidsJson: verifierDids.length > 0 ? longStr(JSON.stringify(verifierDids)) : null,
      fetchedAt: str(now),
    })

    // Soft-delete existing detail rows for this subject
    await this.deleteDetailRows(did)

    // Insert new verification detail rows
    for (const v of verifications) {
      this.evolu.upsert('cachedGraphVerification', {
        id: createIdFromString<'CachedGraphVerification'>(`gv-${did}-${v.id}`),
        subjectDid: str(did),
        verificationId: str(v.id),
        fromDid: str(v.from),
        toDid: str(v.to),
        timestamp: str(v.timestamp),
        proofJson: str(JSON.stringify(v.proof)),
        locationJson: v.location ? str(JSON.stringify(v.location)) : null,
      })
    }

    // Insert new attestation detail rows
    for (const a of attestations) {
      this.evolu.upsert('cachedGraphAttestation', {
        id: createIdFromString<'CachedGraphAttestation'>(`ga-${did}-${a.id}`),
        subjectDid: str(did),
        attestationId: str(a.id),
        fromDid: str(a.from),
        toDid: str(a.to),
        claim: str(a.claim),
        tagsJson: a.tags ? str(JSON.stringify(a.tags)) : null,
        context: a.context ? str(a.context) : null,
        attestationCreatedAt: str(a.createdAt),
        proofJson: str(JSON.stringify(a.proof)),
      })
    }
  }

  async getEntry(did: string): Promise<CachedGraphEntry | null> {
    const query = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphEntry')
        .selectAll()
        .where('did', '=', str(did))
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const rows = await this.evolu.loadQuery(query)
    if (rows.length === 0) return null
    return this.rowToEntry(rows[0])
  }

  async getEntries(dids: string[]): Promise<Map<string, CachedGraphEntry>> {
    const result = new Map<string, CachedGraphEntry>()
    // Evolu doesn't support IN queries, so we query all and filter
    const query = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphEntry')
        .selectAll()
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const rows = await this.evolu.loadQuery(query)
    const didSet = new Set(dids)
    for (const row of rows) {
      const rowDid = row.did as string
      if (didSet.has(rowDid)) {
        result.set(rowDid, this.rowToEntry(row))
      }
    }
    return result
  }

  async getCachedVerifications(did: string): Promise<Verification[]> {
    const query = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphVerification')
        .selectAll()
        .where('subjectDid', '=', str(did))
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const rows = await this.evolu.loadQuery(query)
    return rows.map(row => ({
      id: row.verificationId as string,
      from: row.fromDid as string,
      to: row.toDid as string,
      timestamp: row.timestamp as string,
      proof: JSON.parse(row.proofJson as string),
      ...(row.locationJson != null ? { location: JSON.parse(row.locationJson as string) } : {}),
    }))
  }

  async getCachedAttestations(did: string): Promise<Attestation[]> {
    const query = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphAttestation')
        .selectAll()
        .where('subjectDid', '=', str(did))
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const rows = await this.evolu.loadQuery(query)
    return rows.map(row => ({
      id: row.attestationId as string,
      from: row.fromDid as string,
      to: row.toDid as string,
      claim: row.claim as string,
      ...(row.tagsJson != null ? { tags: JSON.parse(row.tagsJson as string) } : {}),
      ...(row.context != null ? { context: row.context as string } : {}),
      createdAt: row.attestationCreatedAt as string,
      proof: JSON.parse(row.proofJson as string),
    }))
  }

  async resolveName(did: string): Promise<string | null> {
    const entry = await this.getEntry(did)
    return entry?.name ?? null
  }

  async resolveNames(dids: string[]): Promise<Map<string, string>> {
    const entries = await this.getEntries(dids)
    const result = new Map<string, string>()
    for (const [did, entry] of entries) {
      if (entry.name) result.set(did, entry.name)
    }
    return result
  }

  async findMutualContacts(targetDid: string, myContactDids: string[]): Promise<string[]> {
    const entry = await this.getEntry(targetDid)
    if (!entry) return []
    const verifierSet = new Set(entry.verifierDids)
    return myContactDids.filter(did => verifierSet.has(did))
  }

  async search(query: string): Promise<CachedGraphEntry[]> {
    const lower = query.toLowerCase()

    // Search in entries by name/bio
    const entryQuery = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphEntry')
        .selectAll()
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const entryRows = await this.evolu.loadQuery(entryQuery)

    // Search in attestations by claim
    const attQuery = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphAttestation')
        .selectAll()
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const attRows = await this.evolu.loadQuery(attQuery)
    const didsWithMatchingClaims = new Set<string>()
    for (const row of attRows) {
      if ((row.claim as string).toLowerCase().includes(lower)) {
        didsWithMatchingClaims.add(row.subjectDid as string)
      }
    }

    const results: CachedGraphEntry[] = []
    for (const row of entryRows) {
      const nameMatch = row.name != null && (row.name as string).toLowerCase().includes(lower)
      const bioMatch = row.bio != null && (row.bio as string).toLowerCase().includes(lower)
      const claimMatch = didsWithMatchingClaims.has(row.did as string)
      if (nameMatch || bioMatch || claimMatch) {
        results.push(this.rowToEntry(row))
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
    this.evolu.upsert('cachedGraphEntry', {
      id: createIdFromString<'CachedGraphEntry'>(`graph-${did}`),
      did: str(did),
      ...(name !== null ? { name: str(name) } : {}),
      verificationCount: str(String(verificationCount)),
      attestationCount: str(String(attestationCount)),
      fetchedAt: str(new Date().toISOString()),
    })
  }

  async evict(did: string): Promise<void> {
    // Soft-delete entry
    this.evolu.upsert('cachedGraphEntry', {
      id: createIdFromString<'CachedGraphEntry'>(`graph-${did}`),
      isDeleted: booleanToSqliteBoolean(true),
    } as any)

    await this.deleteDetailRows(did)
  }

  async clear(): Promise<void> {
    // Load all entries and soft-delete them
    const query = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphEntry')
        .selectAll()
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const rows = await this.evolu.loadQuery(query)
    for (const row of rows) {
      const did = row.did as string
      await this.evict(did)
    }
  }

  // --- Private ---

  private rowToEntry(row: any): CachedGraphEntry {
    const verifierDids = row.verifierDidsJson != null
      ? JSON.parse(row.verifierDidsJson as string) as string[]
      : []

    return {
      did: row.did as string,
      ...(row.name != null ? { name: row.name as string } : {}),
      ...(row.bio != null ? { bio: row.bio as string } : {}),
      ...(row.avatar != null ? { avatar: row.avatar as string } : {}),
      ...(row.encryptionPublicKey != null ? { encryptionPublicKey: row.encryptionPublicKey as string } : {}),
      verificationCount: parseInt(row.verificationCount as string, 10) || 0,
      attestationCount: parseInt(row.attestationCount as string, 10) || 0,
      verifierDids,
      fetchedAt: row.fetchedAt as string,
    }
  }

  private async deleteDetailRows(did: string): Promise<void> {
    // Soft-delete existing verifications for this subject
    const vQuery = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphVerification')
        .selectAll()
        .where('subjectDid', '=', str(did))
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const vRows = await this.evolu.loadQuery(vQuery)
    for (const row of vRows) {
      this.evolu.upsert('cachedGraphVerification', {
        id: row.id,
        isDeleted: booleanToSqliteBoolean(true),
      } as any)
    }

    // Soft-delete existing attestations for this subject
    const aQuery = this.evolu.createQuery((db) =>
      db.selectFrom('cachedGraphAttestation')
        .selectAll()
        .where('subjectDid', '=', str(did))
        .where('isDeleted', 'is not', booleanToSqliteBoolean(true))
    )
    const aRows = await this.evolu.loadQuery(aQuery)
    for (const row of aRows) {
      this.evolu.upsert('cachedGraphAttestation', {
        id: row.id,
        isDeleted: booleanToSqliteBoolean(true),
      } as any)
    }
  }
}
