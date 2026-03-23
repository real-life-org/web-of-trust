import Database from 'better-sqlite3'

/**
 * SQLite-backed message queue with delivery acknowledgment.
 *
 * Messages go through these states:
 *   queued → delivered → (ACK received) → deleted
 *
 * - 'queued': Recipient was offline when message arrived
 * - 'delivered': Message was sent to recipient (online or dequeued on connect)
 * - After ACK: Row is deleted
 *
 * On reconnect, both 'queued' AND 'delivered' (unACKed) messages are sent.
 */
export class OfflineQueue {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  /** Migrate from old schema (no message_id) to new ACK schema. */
  private migrate(): void {
    // Check if old schema exists (table without message_id column)
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_queue'")
      .get()

    if (tableExists) {
      const columns = this.db.prepare('PRAGMA table_info(offline_queue)').all() as Array<{ name: string }>
      const hasMessageId = columns.some(c => c.name === 'message_id')
      if (!hasMessageId) {
        // Old schema — drop and recreate (queue data is transient)
        this.db.exec('DROP TABLE offline_queue')
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS offline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        to_did TEXT NOT NULL,
        envelope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        delivered_at TEXT
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_to_did ON offline_queue (to_did)
    `)
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_id ON offline_queue (message_id)
    `)
  }

  /** Store a message for a recipient. Extracts message_id from envelope.id. */
  enqueue(toDid: string, envelope: Record<string, unknown>): void {
    const messageId = (envelope.id as string) ?? `unknown-${Date.now()}`
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO offline_queue (message_id, to_did, envelope, status, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    stmt.run(messageId, toDid, JSON.stringify(envelope), 'queued', new Date().toISOString())
  }

  /**
   * Get all 'queued' messages for a DID and mark them as 'delivered'.
   * Called when recipient connects.
   */
  dequeue(toDid: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT id, envelope FROM offline_queue WHERE to_did = ? AND status = 'queued' ORDER BY id")
      .all(toDid) as Array<{ id: number; envelope: string }>

    if (rows.length === 0) return []

    // Mark as delivered (not deleted — wait for ACK)
    const now = new Date().toISOString()
    this.db
      .prepare("UPDATE offline_queue SET status = 'delivered', delivered_at = ? WHERE to_did = ? AND status = 'queued'")
      .run(now, toDid)

    return rows.map((row) => JSON.parse(row.envelope) as Record<string, unknown>)
  }

  /** Get all 'delivered' (unACKed) messages for a DID. For redelivery on reconnect. */
  getUnacked(toDid: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT envelope FROM offline_queue WHERE to_did = ? AND status = 'delivered' ORDER BY id")
      .all(toDid) as Array<{ envelope: string }>

    return rows.map((row) => JSON.parse(row.envelope) as Record<string, unknown>)
  }

  /** Mark a message as 'delivered'. Used for online-delivered messages. */
  markDelivered(messageId: string): void {
    this.db
      .prepare("UPDATE offline_queue SET status = 'delivered', delivered_at = ? WHERE message_id = ?")
      .run(new Date().toISOString(), messageId)
  }

  /** Delete a message after ACK from recipient. */
  ack(messageId: string): void {
    this.db
      .prepare('DELETE FROM offline_queue WHERE message_id = ?')
      .run(messageId)
  }

  count(toDid?: string): number {
    if (toDid) {
      const row = this.db
        .prepare('SELECT COUNT(*) as count FROM offline_queue WHERE to_did = ?')
        .get(toDid) as { count: number }
      return row.count
    }
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM offline_queue')
      .get() as { count: number }
    return row.count
  }

  countByDid(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT to_did, COUNT(*) as count FROM offline_queue GROUP BY to_did')
      .all() as Array<{ to_did: string; count: number }>
    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.to_did] = row.count
    }
    return result
  }

  close(): void {
    this.db.close()
  }
}
