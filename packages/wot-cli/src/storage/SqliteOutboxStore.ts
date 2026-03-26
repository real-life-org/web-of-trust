/**
 * SqliteOutboxStore — Persistent outbox backed by SQLite.
 *
 * Implements the OutboxStore interface. Messages survive process restarts.
 */

import Database from 'better-sqlite3'
import type { OutboxStore, OutboxEntry } from '@web.of.trust/core'
import type { MessageEnvelope } from '@web.of.trust/core'

export class SqliteOutboxStore implements OutboxStore {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        envelope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0
      )
    `)
  }

  async enqueue(envelope: MessageEnvelope): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, envelope, created_at, retry_count)
         VALUES (?, ?, ?, 0)`,
      )
      .run(envelope.id, JSON.stringify(envelope), new Date().toISOString())
  }

  async dequeue(envelopeId: string): Promise<void> {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(envelopeId)
  }

  async getPending(): Promise<OutboxEntry[]> {
    const rows = this.db
      .prepare('SELECT envelope, created_at, retry_count FROM outbox ORDER BY created_at ASC')
      .all() as { envelope: string; created_at: string; retry_count: number }[]

    return rows.map((r) => ({
      envelope: JSON.parse(r.envelope) as MessageEnvelope,
      createdAt: r.created_at,
      retryCount: r.retry_count,
    }))
  }

  async has(envelopeId: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM outbox WHERE id = ? LIMIT 1')
      .get(envelopeId)
    return row !== undefined
  }

  async incrementRetry(envelopeId: string): Promise<void> {
    this.db
      .prepare('UPDATE outbox SET retry_count = retry_count + 1 WHERE id = ?')
      .run(envelopeId)
  }

  async count(): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM outbox')
      .get() as { cnt: number }
    return row.cnt
  }

  close(): void {
    this.db.close()
  }
}
