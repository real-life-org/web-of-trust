/**
 * SqliteCompactStore — CRDT snapshot storage backed by SQLite.
 *
 * Same interface as InMemoryCompactStore / CompactStorageManager,
 * but persists to disk via better-sqlite3.
 */

import Database from 'better-sqlite3'

export class SqliteCompactStore {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compact_store (
        doc_id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  async open(): Promise<void> {
    // Already opened in constructor
  }

  async save(docId: string, binary: Uint8Array): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO compact_store (doc_id, data, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(docId, Buffer.from(binary), new Date().toISOString())
  }

  async load(docId: string): Promise<Uint8Array | null> {
    const row = this.db
      .prepare('SELECT data FROM compact_store WHERE doc_id = ?')
      .get(docId) as { data: Buffer } | undefined

    return row ? new Uint8Array(row.data) : null
  }

  async delete(docId: string): Promise<void> {
    this.db.prepare('DELETE FROM compact_store WHERE doc_id = ?').run(docId)
  }

  async list(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT doc_id FROM compact_store')
      .all() as { doc_id: string }[]
    return rows.map((r) => r.doc_id)
  }

  close(): void {
    this.db.close()
  }

  has(docId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM compact_store WHERE doc_id = ? LIMIT 1')
      .get(docId)
    return row !== undefined
  }

  size(docId: string): number {
    const row = this.db
      .prepare('SELECT length(data) as len FROM compact_store WHERE doc_id = ?')
      .get(docId) as { len: number } | undefined
    return row?.len ?? 0
  }
}
