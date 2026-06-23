import Database from 'better-sqlite3'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

const { bytesToHex, classifyBrokerSeqCollision, canonicalizeToBytes } = protocol
type SyncHeads = protocol.SyncHeads
type LogEntryPayload = protocol.LogEntryPayload

/**
 * Result of an ingest attempt (VE-3 seq-collision + VE-3a author-binding).
 * The relay maps each disposition to a wire response; only `accept-new-entry`
 * stores + relays.
 */
export type AppendResult =
  | { disposition: 'accept-new-entry' }
  | { disposition: 'idempotent-retransmission' }
  | { disposition: 'reject-seq-collision'; errorCode: 'SEQ_COLLISION_DETECTED'; clientHint: 'restore-clone-required' }
  | { disposition: 'reject-author-mismatch'; errorCode: 'AUTHOR_MISMATCH' }

const logStoreCrypto = new WebCryptoProtocolCryptoAdapter()

/**
 * Durable, append-only per-doc log store (Slice R, Sync 002 "durable-log").
 *
 * The relay keeps a RETAINED append-only log keyed by (docId, deviceId, seq).
 * Unlike the OfflineQueue (queued → delivered → ACK → DELETED), entries here are
 * NEVER deleted on ACK: the log IS the source of truth, so a fresh device can
 * reconstruct the full document via a sync-request after every producer has gone
 * offline (cold reconstruction). Pruning/snapshots are out of scope (Slice C).
 *
 * The store treats `entry_jws` as opaque: it never decrypts the `data` payload.
 * For collision/dedup it hashes the JCS-canonicalized log-entry PAYLOAD (Sync 003
 * §Broker — `hashPayload`), not the JWS envelope, so re-encodings of the same
 * payload dedup correctly. Keeping all crypto in this layer leaves the relay.ts
 * source guard intact (no inline crypto in relay.ts).
 *
 * Schema:
 *   doc_log(doc_id, device_id, seq, content_hash, entry_jws, created_at,
 *           PRIMARY KEY(doc_id, device_id, seq))
 *   + index on (doc_id, device_id, seq)
 */
export class DocLog {
  private db: Database.Database

  /**
   * Accepts a path (creates/owns a connection) or an existing better-sqlite3
   * Database handle (shared with OfflineQueue so prod uses a single file and
   * tests avoid the ':memory:' split-DB problem). When a handle is shared, this
   * class does not own its lifecycle and `close()` is a no-op.
   */
  private ownsDb: boolean

  constructor(db: string | Database.Database = ':memory:') {
    if (typeof db === 'string') {
      this.db = new Database(db)
      this.db.pragma('journal_mode = WAL')
      this.ownsDb = true
    } else {
      this.db = db
      this.ownsDb = false
    }
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_log (
        doc_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        entry_jws TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, device_id, seq)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_log_coords ON doc_log (doc_id, device_id, seq)
    `)
    // VE-3a author-binding (INTERIM first-writer-wins): a (docId,deviceId)
    // seq/nonce namespace is owned by the FIRST authorKid that writes it; later
    // writes under that namespace MUST carry the same authorKid, else reject. This
    // prevents TAKEOVER of an already-bound namespace (and squatting a future seq
    // of an owned namespace). It does NOT prevent PRE-SQUATTING an unbound
    // (docId,deviceId): a malicious co-member who knows a victim's stable deviceId
    // can write first and lock them out — `deviceId` is not yet cryptographically
    // bound to the device key. Closing that needs membership/capability-gated
    // ingest (non-members; next Sync-003 slice) + deviceId↔device-key binding
    // (Identity-004 / Phase 2). See SLICE-R.md.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_device_author (
        doc_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        author_kid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, device_id)
      )
    `)
  }

  /**
   * Content hash (hex) of a log entry, per Sync 003 §Broker: SHA-256 over the
   * **JCS-canonicalized log-entry payload** (NOT the compact-JWS string), indexed
   * by (docId,deviceId,seq). Hashing the canonical payload — not the JWS envelope
   * — means two semantically-identical entries (same payload, different JWS header
   * serialization / re-encoding) dedup as idempotent retransmissions instead of
   * being mis-flagged SEQ_COLLISION_DETECTED. Computed in this layer so relay.ts
   * stays crypto-free (source guard). `canonicalizeToBytes` is the same JCS RFC
   * 8785 serializer the author signs over (createLogEntryJws), so the broker hash
   * is byte-aligned with the signed payload.
   */
  async hashPayload(payload: LogEntryPayload): Promise<string> {
    return bytesToHex(await logStoreCrypto.sha256(canonicalizeToBytes(payload as unknown as protocol.JsonValue)))
  }

  /**
   * Ingest a VERIFIED log entry. Author-binding (VE-3a), seq-collision
   * classification (VE-3) and the durable insert run together in ONE SQLite
   * transaction so the first-writer-wins check on (docId,deviceId) cannot race a
   * concurrent first write. better-sqlite3 is synchronous, so the callback runs
   * atomically with no intervening await; the transaction additionally gives
   * all-or-nothing durability for the binding + log inserts. The caller passes
   * the already-verified authorKid + the precomputed content hash and reacts to
   * the returned disposition — it must NOT pre-check then append separately, or
   * the race window returns.
   *
   * Dispositions:
   *  - reject-author-mismatch → a different authorKid already owns this
   *    (docId,deviceId); not stored, not relayed.
   *  - reject-seq-collision → divergent content at an existing (docId,deviceId,seq)
   *    (deterministic-nonce reuse guard); not stored, not relayed.
   *  - idempotent-retransmission → exact (deviceId,seq,content) already present;
   *    no re-store.
   *  - accept-new-entry → owner bound on first write, entry appended.
   */
  appendEntry(params: {
    docId: string
    deviceId: string
    seq: number
    authorKid: string
    contentHash: string
    entryJws: string
  }): AppendResult {
    const ingest = this.db.transaction((p: typeof params): AppendResult => {
      const owner = this.db
        .prepare('SELECT author_kid FROM doc_device_author WHERE doc_id = ? AND device_id = ?')
        .get(p.docId, p.deviceId) as { author_kid: string } | undefined

      // VE-3a: namespace owned by the first authorKid; a different author is
      // rejected before the seq check, the store and the relay.
      if (owner && owner.author_kid !== p.authorKid) {
        return { disposition: 'reject-author-mismatch', errorCode: 'AUTHOR_MISMATCH' }
      }

      // VE-3 (unchanged contract): divergent content at an existing coordinate is a
      // deterministic-nonce reuse hazard and must never enter the log.
      const existingContentHash =
        (
          this.db
            .prepare('SELECT content_hash FROM doc_log WHERE doc_id = ? AND device_id = ? AND seq = ?')
            .get(p.docId, p.deviceId, p.seq) as { content_hash: string } | undefined
        )?.content_hash ?? null

      const decision = classifyBrokerSeqCollision({
        docId: p.docId,
        deviceId: p.deviceId,
        seq: p.seq,
        existingContentHash,
        incomingContentHash: p.contentHash,
      })
      if (decision.disposition === 'reject-seq-collision') {
        return {
          disposition: 'reject-seq-collision',
          errorCode: decision.errorCode,
          clientHint: decision.clientHint,
        }
      }
      if (decision.disposition === 'idempotent-retransmission') {
        return { disposition: 'idempotent-retransmission' }
      }

      // accept-new-entry: bind the owner on the first write for this namespace,
      // then append. INSERT OR IGNORE is a backstop against the PK.
      const now = new Date().toISOString()
      if (!owner) {
        this.db
          .prepare(
            'INSERT INTO doc_device_author (doc_id, device_id, author_kid, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(p.docId, p.deviceId, p.authorKid, now)
      }
      this.db
        .prepare(
          'INSERT OR IGNORE INTO doc_log (doc_id, device_id, seq, content_hash, entry_jws, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(p.docId, p.deviceId, p.seq, p.contentHash, p.entryJws, now)
      return { disposition: 'accept-new-entry' }
    })
    return ingest(params)
  }

  /** Bound owner authorKid for a (docId,deviceId), or null (introspection/tests). */
  getAuthor(docId: string, deviceId: string): string | null {
    const row = this.db
      .prepare('SELECT author_kid FROM doc_device_author WHERE doc_id = ? AND device_id = ?')
      .get(docId, deviceId) as { author_kid: string } | undefined
    return row ? row.author_kid : null
  }

  /** content_hash recorded at (docId,deviceId,seq), or null if none. */
  getContentHash(docId: string, deviceId: string, seq: number): string | null {
    const row = this.db
      .prepare('SELECT content_hash FROM doc_log WHERE doc_id = ? AND device_id = ? AND seq = ?')
      .get(docId, deviceId, seq) as { content_hash: string } | undefined
    return row ? row.content_hash : null
  }

  /**
   * Catch-up page: every retained entry with seq > heads[deviceId] (or from 0 if
   * the device is absent in heads), per device, ascending and deterministic
   * (ordered by device_id, then seq). Empty heads ⇒ full log from seq 0 (cold
   * reconstruction). With `limit`, returns at most `limit` entries; the caller
   * learns truncation via `getSinceWithTruncation`.
   */
  getSince(docId: string, heads: SyncHeads, limit?: number): string[] {
    return this.getSinceWithTruncation(docId, heads, limit).entries
  }

  /**
   * Like getSince but also reports whether more entries remain beyond `limit`.
   */
  getSinceWithTruncation(
    docId: string,
    heads: SyncHeads,
    limit?: number,
  ): { entries: string[]; truncated: boolean } {
    const rows = this.db
      .prepare(
        'SELECT device_id, seq, entry_jws FROM doc_log WHERE doc_id = ? ORDER BY device_id ASC, seq ASC',
      )
      .all(docId) as Array<{ device_id: string; seq: number; entry_jws: string }>

    const missing = rows.filter((row) => {
      const head = Object.prototype.hasOwnProperty.call(heads, row.device_id)
        ? heads[row.device_id]
        : -1
      return row.seq > head
    })

    if (typeof limit === 'number' && missing.length > limit) {
      return { entries: missing.slice(0, limit).map((row) => row.entry_jws), truncated: true }
    }
    return { entries: missing.map((row) => row.entry_jws), truncated: false }
  }

  /** Broker heads for a doc: max seq per deviceId. */
  getHeads(docId: string): SyncHeads {
    const rows = this.db
      .prepare('SELECT device_id, MAX(seq) as max_seq FROM doc_log WHERE doc_id = ? GROUP BY device_id')
      .all(docId) as Array<{ device_id: string; max_seq: number }>
    const heads: Record<string, number> = {}
    for (const row of rows) heads[row.device_id] = row.max_seq
    return heads
  }

  // --- stats helpers (dashboard) -------------------------------------------

  /** Total retained entries (optionally for one doc). */
  entryCount(docId?: string): number {
    if (docId) {
      const row = this.db
        .prepare('SELECT COUNT(*) as count FROM doc_log WHERE doc_id = ?')
        .get(docId) as { count: number }
      return row.count
    }
    const row = this.db.prepare('SELECT COUNT(*) as count FROM doc_log').get() as { count: number }
    return row.count
  }

  /** Number of distinct docs with at least one entry. */
  docCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT doc_id) as count FROM doc_log')
      .get() as { count: number }
    return row.count
  }

  /** entries per docId. */
  entriesByDoc(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT doc_id, COUNT(*) as count FROM doc_log GROUP BY doc_id')
      .all() as Array<{ doc_id: string; count: number }>
    const result: Record<string, number> = {}
    for (const row of rows) result[row.doc_id] = row.count
    return result
  }

  /** distinct devices per docId. */
  devicesByDoc(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT doc_id, COUNT(DISTINCT device_id) as count FROM doc_log GROUP BY doc_id')
      .all() as Array<{ doc_id: string; count: number }>
    const result: Record<string, number> = {}
    for (const row of rows) result[row.doc_id] = row.count
    return result
  }

  /** Total bytes of all retained JWS strings (UTF-8 length sum). */
  totalLogBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(entry_jws)), 0) as bytes FROM doc_log')
      .get() as { bytes: number }
    return row.bytes
  }

  close(): void {
    if (this.ownsDb) this.db.close()
  }
}
