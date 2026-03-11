import Database from 'better-sqlite3'

/**
 * DocStore — SQLite-backed storage for encrypted Automerge doc changes.
 *
 * Stores an append-only log of encrypted changes per document,
 * plus optional compacted snapshots. The server never sees plaintext —
 * all data is opaque encrypted blobs.
 */
export class DocStore {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        author_did TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(doc_id, seq)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_changes_lookup
      ON doc_changes (doc_id, seq)
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_snapshots (
        doc_id TEXT NOT NULL PRIMARY KEY,
        data BLOB NOT NULL,
        up_to_seq INTEGER NOT NULL,
        author_did TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
  }

  /**
   * Append an encrypted change to a document's log.
   * Returns the assigned sequence number.
   */
  appendChange(docId: string, data: Buffer, authorDid: string): number {
    const nextSeq = this.getNextSeq(docId)

    this.db
      .prepare(
        `INSERT INTO doc_changes (doc_id, seq, data, author_did, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(docId, nextSeq, data, authorDid, new Date().toISOString())

    return nextSeq
  }

  /**
   * Get changes since a given sequence number.
   * If a snapshot exists and covers part of the requested range,
   * it is included in the result.
   */
  getChanges(
    docId: string,
    sinceSeq: number = 0,
  ): {
    snapshot: { data: Buffer; upToSeq: number } | null
    changes: Array<{
      seq: number
      data: Buffer
      authorDid: string
      createdAt: string
    }>
  } {
    let snapshot: { data: Buffer; upToSeq: number } | null = null
    let effectiveSince = sinceSeq

    // Check for snapshot if requesting from beginning
    if (sinceSeq === 0) {
      const row = this.db
        .prepare('SELECT data, up_to_seq FROM doc_snapshots WHERE doc_id = ?')
        .get(docId) as { data: Buffer; up_to_seq: number } | undefined

      if (row) {
        snapshot = { data: row.data, upToSeq: row.up_to_seq }
        effectiveSince = row.up_to_seq
      }
    }

    const changes = this.db
      .prepare(
        `SELECT seq, data, author_did, created_at
         FROM doc_changes
         WHERE doc_id = ? AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(docId, effectiveSince) as Array<{
      seq: number
      data: Buffer
      author_did: string
      created_at: string
    }>

    return {
      snapshot,
      changes: changes.map((c) => ({
        seq: c.seq,
        data: c.data,
        authorDid: c.author_did,
        createdAt: c.created_at,
      })),
    }
  }

  /**
   * Store a compacted snapshot. Deletes all changes up to upToSeq.
   */
  putSnapshot(
    docId: string,
    data: Buffer,
    upToSeq: number,
    authorDid: string,
  ): void {
    const tx = this.db.transaction(() => {
      // Upsert snapshot
      this.db
        .prepare(
          `INSERT INTO doc_snapshots (doc_id, data, up_to_seq, author_did, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(doc_id) DO UPDATE SET
             data = excluded.data,
             up_to_seq = excluded.up_to_seq,
             author_did = excluded.author_did,
             created_at = excluded.created_at`,
        )
        .run(docId, data, upToSeq, authorDid, new Date().toISOString())

      // Delete changes covered by snapshot
      this.db
        .prepare('DELETE FROM doc_changes WHERE doc_id = ? AND seq <= ?')
        .run(docId, upToSeq)
    })
    tx()
  }

  /**
   * Get document info (latest sequence, snapshot coverage, total size).
   */
  getInfo(docId: string): {
    latestSeq: number
    snapshotSeq: number | null
    changeCount: number
  } | null {
    const latestChange = this.db
      .prepare('SELECT MAX(seq) as max_seq FROM doc_changes WHERE doc_id = ?')
      .get(docId) as { max_seq: number | null } | undefined

    const snapshot = this.db
      .prepare('SELECT up_to_seq FROM doc_snapshots WHERE doc_id = ?')
      .get(docId) as { up_to_seq: number } | undefined

    const changeCount = this.db
      .prepare('SELECT COUNT(*) as cnt FROM doc_changes WHERE doc_id = ?')
      .get(docId) as { cnt: number }

    const snapshotSeq = snapshot?.up_to_seq ?? null
    const latestSeq = latestChange?.max_seq ?? snapshotSeq ?? null

    if (latestSeq === null && snapshotSeq === null) return null

    return {
      latestSeq: latestSeq ?? snapshotSeq ?? 0,
      snapshotSeq,
      changeCount: changeCount.cnt,
    }
  }

  /**
   * Delete a document and all its changes/snapshots.
   */
  deleteDoc(docId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM doc_changes WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM doc_snapshots WHERE doc_id = ?').run(docId)
    })
    tx()
  }

  /** Get next sequence number for a document. */
  private getNextSeq(docId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) as max_seq FROM doc_changes WHERE doc_id = ?')
      .get(docId) as { max_seq: number | null } | undefined

    const snapshot = this.db
      .prepare('SELECT up_to_seq FROM doc_snapshots WHERE doc_id = ?')
      .get(docId) as { up_to_seq: number } | undefined

    const maxChange = row?.max_seq ?? 0
    const maxSnapshot = snapshot?.up_to_seq ?? 0

    return Math.max(maxChange, maxSnapshot) + 1
  }

  close(): void {
    this.db.close()
  }
}
