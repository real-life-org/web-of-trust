import Database from 'better-sqlite3'
import { extractJwsPayload } from './jws-verify.js'

export interface StoredProfile {
  did: string
  jws: string
  updatedAt: string
  /**
   * The monotonic resource version (VE-4). `null` for legacy rows written before
   * the `version` column existed — in that case the version lives in the stored
   * JWS payload and is read lazily via `extractVersionFromStoredJws`.
   */
  version: number | null
}

type ResourceTable = 'profiles' | 'verifications' | 'attestations'

/**
 * Lazily read the resource `version` out of a stored JWS payload (VE-4 Schärfung).
 *
 * A NULL version column does NOT automatically mean "no baseline": legacy `/p`
 * rows (and pre-migration `/v`/`/a` rows) carry their `version` inside the signed
 * JWS payload. Only when neither the column nor the stored JWS yields a parsable
 * non-negative safe integer does the row count as "unversioned" (first versioned
 * PUT wins). No dual-format shim — this is a one-way read of existing state.
 */
export function extractVersionFromStoredJws(jws: string): number | undefined {
  const payload = extractJwsPayload(jws)
  const version = payload?.version
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
    ? version
    : undefined
}

export interface ProfileSummary {
  did: string
  name: string | null
  verificationCount: number
  attestationCount: number
}

export class ProfileStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    for (const table of ['profiles', 'verifications', 'attestations'] as const) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          did TEXT PRIMARY KEY,
          jws TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER
        )
      `)
      // Migration for DBs created before the version column existed (VE-4):
      // add a nullable `version` column. Existing rows keep NULL and fall back to
      // the JWS-embedded version on the next monotonicity check (lazy read).
      this.ensureVersionColumn(table)
    }
  }

  private ensureVersionColumn(table: ResourceTable): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'version')) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER`)
    }
  }

  private putResource(table: ResourceTable, did: string, jws: string, version?: number): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO ${table} (did, jws, updated_at, version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        jws = excluded.jws,
        updated_at = excluded.updated_at,
        version = excluded.version
    `).run(did, jws, now, version ?? null)
  }

  private getResource(table: ResourceTable, did: string): StoredProfile | null {
    const row = this.db.prepare(
      `SELECT did, jws, updated_at, version FROM ${table} WHERE did = ?`
    ).get(did) as { did: string; jws: string; updated_at: string; version: number | null } | undefined

    if (!row) return null
    return { did: row.did, jws: row.jws, updatedAt: row.updated_at, version: row.version }
  }

  put(did: string, jws: string, version?: number): void {
    this.putResource('profiles', did, jws, version)
  }

  get(did: string): StoredProfile | null {
    return this.getResource('profiles', did)
  }

  putVerifications(did: string, jws: string, version?: number): void {
    this.putResource('verifications', did, jws, version)
  }

  getVerifications(did: string): StoredProfile | null {
    return this.getResource('verifications', did)
  }

  putAttestations(did: string, jws: string, version?: number): void {
    this.putResource('attestations', did, jws, version)
  }

  getAttestations(did: string): StoredProfile | null {
    return this.getResource('attestations', did)
  }

  /**
   * Resolve the monotonicity baseline for a stored resource (VE-4 lazy read):
   * the version column if present, otherwise the version embedded in the stored
   * JWS payload, otherwise `undefined` (legacy unversioned row).
   */
  storedVersion(stored: StoredProfile): number | undefined {
    if (stored.version !== null && Number.isSafeInteger(stored.version) && stored.version >= 0) {
      return stored.version
    }
    return extractVersionFromStoredJws(stored.jws)
  }

  /** Test helper (VE-4 migration test): force a row's version column back to NULL. */
  __nullifyVersionForTest(table: ResourceTable, did: string): void {
    this.db.prepare(`UPDATE ${table} SET version = NULL WHERE did = ?`).run(did)
  }

  getSummaries(dids: string[]): ProfileSummary[] {
    if (dids.length === 0) return []

    const placeholders = dids.map(() => '?').join(',')

    // Batch query all three tables
    const profileRows = this.db.prepare(
      `SELECT did, jws FROM profiles WHERE did IN (${placeholders})`
    ).all(...dids) as { did: string; jws: string }[]

    const verificationRows = this.db.prepare(
      `SELECT did, jws FROM verifications WHERE did IN (${placeholders})`
    ).all(...dids) as { did: string; jws: string }[]

    const attestationRows = this.db.prepare(
      `SELECT did, jws FROM attestations WHERE did IN (${placeholders})`
    ).all(...dids) as { did: string; jws: string }[]

    // Build lookup maps
    const profileMap = new Map(profileRows.map(r => [r.did, r.jws]))
    const verificationMap = new Map(verificationRows.map(r => [r.did, r.jws]))
    const attestationMap = new Map(attestationRows.map(r => [r.did, r.jws]))

    return dids.map(did => {
      let name: string | null = null
      let verificationCount = 0
      let attestationCount = 0

      const profileJws = profileMap.get(did)
      if (profileJws) {
        const payload = extractJwsPayload(profileJws)
        if (payload?.profile && typeof payload.profile === 'object' && !Array.isArray(payload.profile)
          && 'name' in payload.profile && typeof payload.profile.name === 'string') {
          name = payload.profile.name
        } else if (payload?.name && typeof payload.name === 'string') {
          name = payload.name
        }
      }

      const vJws = verificationMap.get(did)
      if (vJws) {
        const payload = extractJwsPayload(vJws)
        if (Array.isArray(payload?.verifications)) {
          verificationCount = payload.verifications.length
        }
      }

      const aJws = attestationMap.get(did)
      if (aJws) {
        const payload = extractJwsPayload(aJws)
        if (Array.isArray(payload?.attestations)) {
          attestationCount = payload.attestations.length
        }
      }

      return { did, name, verificationCount, attestationCount }
    })
  }

  getStats(): Record<string, unknown> {
    const profileCount = (this.db
      .prepare('SELECT COUNT(*) as count FROM profiles')
      .get() as { count: number }).count

    const verificationCount = (this.db
      .prepare('SELECT COUNT(*) as count FROM verifications')
      .get() as { count: number }).count

    const attestationCount = (this.db
      .prepare('SELECT COUNT(*) as count FROM attestations')
      .get() as { count: number }).count

    const recentProfiles = this.db
      .prepare('SELECT did, updated_at FROM profiles ORDER BY updated_at DESC LIMIT 10')
      .all() as Array<{ did: string; updated_at: string }>

    return {
      profileCount,
      verificationCount,
      attestationCount,
      recentProfiles,
      memoryMB: process.memoryUsage().rss / (1024 * 1024),
    }
  }

  close(): void {
    this.db.close()
  }
}
