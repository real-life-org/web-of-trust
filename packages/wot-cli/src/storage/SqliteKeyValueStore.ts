/**
 * SqliteKeyValueStore — Generic key-value store backed by SQLite.
 *
 * Node.js equivalent of the browser's LocalCacheStore (IndexedDB).
 * Used for outbox, graph cache, publish state, etc.
 */

import Database from 'better-sqlite3'

export class SqliteKeyValueStore {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.db
      .prepare('SELECT value FROM kv_store WHERE key = ?')
      .get(key) as { value: string } | undefined

    return row ? JSON.parse(row.value) as T : null
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value))
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key)
  }

  async getByPrefix<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const rows = this.db
      .prepare('SELECT key, value FROM kv_store WHERE key LIKE ?')
      .all(`${prefix}%`) as { key: string; value: string }[]

    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }))
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    this.db.prepare('DELETE FROM kv_store WHERE key LIKE ?').run(`${prefix}%`)
  }

  async has(key: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM kv_store WHERE key = ? LIMIT 1')
      .get(key)
    return row !== undefined
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM kv_store')
  }

  close(): void {
    this.db.close()
  }
}
