import Database from 'better-sqlite3'
import { extractJwsPayload } from './jws-verify.js'

export interface StoredProfile {
  did: string
  jws: string
  updatedAt: string
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        did TEXT PRIMARY KEY,
        jws TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verifications (
        did TEXT PRIMARY KEY,
        jws TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attestations (
        did TEXT PRIMARY KEY,
        jws TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  put(did: string, jws: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO profiles (did, jws, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        jws = excluded.jws,
        updated_at = excluded.updated_at
    `).run(did, jws, now)
  }

  get(did: string): StoredProfile | null {
    const row = this.db.prepare(
      'SELECT did, jws, updated_at FROM profiles WHERE did = ?'
    ).get(did) as { did: string; jws: string; updated_at: string } | undefined

    if (!row) return null
    return { did: row.did, jws: row.jws, updatedAt: row.updated_at }
  }

  putVerifications(did: string, jws: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO verifications (did, jws, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        jws = excluded.jws,
        updated_at = excluded.updated_at
    `).run(did, jws, now)
  }

  getVerifications(did: string): StoredProfile | null {
    const row = this.db.prepare(
      'SELECT did, jws, updated_at FROM verifications WHERE did = ?'
    ).get(did) as { did: string; jws: string; updated_at: string } | undefined

    if (!row) return null
    return { did: row.did, jws: row.jws, updatedAt: row.updated_at }
  }

  putAttestations(did: string, jws: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO attestations (did, jws, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        jws = excluded.jws,
        updated_at = excluded.updated_at
    `).run(did, jws, now)
  }

  getAttestations(did: string): StoredProfile | null {
    const row = this.db.prepare(
      'SELECT did, jws, updated_at FROM attestations WHERE did = ?'
    ).get(did) as { did: string; jws: string; updated_at: string } | undefined

    if (!row) return null
    return { did: row.did, jws: row.jws, updatedAt: row.updated_at }
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
