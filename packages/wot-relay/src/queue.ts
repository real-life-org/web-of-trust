import Database from 'better-sqlite3'

/**
 * SQLite-backed multi-device inbox with per-device store-and-forward
 * (Sync 003 §Store-and-Forward pro Device, Z.192-214).
 *
 * Two tables replace the old per-DID `offline_queue`:
 *
 *   inbox_message(id, message_id UNIQUE, to_did, envelope, created_at)
 *     The envelope, stored ONCE, retained until it is fully delivered (terminal,
 *     deleted in the ACK path) or aged out (TTL). `id` is the stable delivery
 *     order (all delivery is `ORDER BY inbox_message.id`).
 *
 *   inbox_entry(message_id, device_id, status, PRIMARY KEY(message_id, device_id))
 *     Per-device delivery state. 3-state `status`:
 *       - 'pending'         : to be delivered to this device
 *       - 'acked'           : this recipient device sent ack/1.0 (a delivery proof)
 *       - 'sender-excluded' : the self-addressed sender device (Z.204) — never
 *                             delivered, and NOT a delivery proof, but it does not
 *                             block the fully-delivered check.
 *
 * The durable ACK / terminal truth is pure SQL here (rowcount-gated UPDATE +
 * the fully-delivered query), NOT the wot-core helper `applyBrokerInboxAck` —
 * that helper would count a `sender-excluded` self-ACK as a delivery proof. The
 * helper is used ONLY for the fan-out target computation (in relay.ts).
 *
 * Atomicity (Sync 003 §Store-and-Forward): every mutation runs as a
 * `db.transaction` on the SAME better-sqlite3 handle that backs `devices`
 * (DocLog). better-sqlite3 is synchronous, so the transaction callbacks
 * serialise without interleaving — there is no TORN-STATE race between
 * GC/ACK terminal-delete and a device registering. (The ordering OUTCOME still
 * holds: if an ack fully commits and terminal-deletes a message before a brand-new
 * device's register+deliverOnConnect commits, that late device gets no history —
 * the intended "fully-delivered is terminal" semantics, not a torn read.) No
 * WebSocket sends happen inside a transaction: the methods persist and RETURN the
 * envelopes to send; the relay sends after commit.
 */

/** Sync 003 Z.210-211 default retention windows. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30d hard TTL on inbox_message.created_at
/**
 * 90d device-inactivity window. EXPORTED so the relay fan-out and this module's
 * fully-delivered completeness check use the SAME effective-active definition — a device
 * that is a fan-out target MUST also be counted in completeness, else its pending entry
 * could be terminal-deleted while it is merely offline (lost message).
 */
export const DEFAULT_INACTIVE_MS = 90 * 24 * 60 * 60 * 1000

type InboxEntryStatus = 'pending' | 'acked' | 'sender-excluded'

export interface InboxFanoutInput {
  messageId: string
  toDid: string
  envelope: Record<string, unknown>
  /** Active, non-sender recipient devices that get a 'pending' entry (from the helper). */
  deliveryTargetDeviceIds: readonly string[]
  /** The self-addressed sender device (Z.204), if any → durable 'sender-excluded' entry. */
  excludedSenderDeviceId?: string
  /** epoch ms for created_at; injectable clock. Defaults to Date.now(). */
  nowMs?: number
}

export interface RetentionOptions {
  /** epoch ms; injectable clock (no timer magic). Defaults to Date.now(). */
  nowMs?: number
  ttlMs?: number
  inactiveMs?: number
}

export interface GarbageCollectionResult {
  removedFullyDelivered: number
  removedExpired: number
  removedInactiveEntries: number
}

export class OfflineQueue {
  private db: Database.Database

  /**
   * REQUIRES the better-sqlite3 handle SHARED with DocLog. The inbox completeness /
   * GC methods (`isFullyDelivered`, `collectGarbage`) JOIN the `devices` table owned by
   * DocLog, so a standalone connection without `devices` would throw at runtime — the
   * constructor therefore takes the handle explicitly rather than a path (no misleading
   * standalone `new OfflineQueue()`). The owner (RelayServer / the test that created the
   * handle) closes it; `close()` here is a borrow no-op. Callers MUST construct DocLog on
   * the same handle.
   */
  constructor(db: Database.Database) {
    this.db = db
    this.migrate()
  }

  /**
   * Create the per-device inbox schema and migrate any legacy per-DID
   * `offline_queue` rows into it (TC9, verlustfrei).
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_message (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        to_did TEXT NOT NULL,
        envelope TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_message_to_did ON inbox_message (to_did)`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_entry (
        message_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (message_id, device_id)
      )
    `)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_entry_device ON inbox_entry (device_id)`)

    this.migrateLegacyOfflineQueue()
  }

  /**
   * TC9 — one-shot, loss-free upgrade from the legacy per-DID `offline_queue`.
   *
   * Invariant (why this is loss-free): in the old model an ACK *deleted* the row
   * globally, so EVERY surviving legacy row is by definition still un-acked
   * (whether its `status` was 'queued' or 'delivered'). We copy each into
   * `inbox_message` (carrying `created_at` → TTL stays correct); per-device
   * entries are NOT pre-created — they are minted per device on TC5 pick-up.
   * Re-delivery is idempotent (the client dedups by message_id) and bounded (the
   * legacy row was provably un-acked). Legacy self-addressed rows carry no
   * senderDeviceId, so their `sender-excluded` entry cannot be reconstructed;
   * such rows are at most idempotently redelivered to all devices (accepted /
   * bounded by client-dedup + TTL). The old table is dropped afterwards.
   */
  private migrateLegacyOfflineQueue(): void {
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_queue'")
      .get()
    if (!legacy) return

    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT id, message_id, to_did, envelope, created_at FROM offline_queue')
        .all() as Array<{ id: number; message_id: string; to_did: string; envelope: string; created_at: string }>
      const lookup = this.db.prepare('SELECT to_did, envelope FROM inbox_message WHERE message_id = ?')
      const insert = this.db.prepare(
        'INSERT INTO inbox_message (message_id, to_did, envelope, created_at) VALUES (?, ?, ?, ?)',
      )
      for (const row of rows) {
        const existing = lookup.get(row.message_id) as { to_did: string; envelope: string } | undefined
        if (!existing) {
          insert.run(row.message_id, row.to_did, row.envelope, row.created_at)
        } else if (existing.to_did !== row.to_did || existing.envelope !== row.envelope) {
          // Divergent message_id collision (the legacy table had UNIQUE(message_id),
          // so this is structurally unexpected — but NEVER silently drop a legacy row).
          // Preserve it under a synthetic, collision-free key; it is retained until TTL
          // (it can't be acked under the synthetic key, but no data is lost).
          insert.run(`${row.message_id}#legacy-${row.id}`, row.to_did, row.envelope, row.created_at)
        }
        // else identical content already present → idempotent, skip.
      }
      this.db.exec('DROP TABLE offline_queue')
    })
    tx()
  }

  // ── ISO helpers ────────────────────────────────────────────────────────────
  // last_seen_at / created_at are stored as `new Date().toISOString()` (UTC `Z`,
  // fixed width), so lexicographic string comparison is a valid time comparison.
  private isoAt(ms: number): string {
    return new Date(ms).toISOString()
  }

  // ── TC2/TC3 — enqueue + fan-out (atomic) ─────────────────────────────────────

  /**
   * Persist a message once and fan out per-device delivery state (R1 + Z.204).
   * In ONE transaction: insert `inbox_message`, a 'pending' entry per delivery
   * target, and — for a self-addressed sender — a durable 'sender-excluded' entry.
   *
   * Idempotency is content-bound (Sync 003): a re-enqueue of the same `messageId`
   * is treated as idempotent ONLY when the already-stored row carries the SAME
   * `to_did` AND the SAME envelope bytes. A `messageId` reused with a DIFFERENT
   * recipient or payload is a `'collision'` — NO write happens and the caller MUST
   * reject the send (else live-delivery of the new envelope would diverge from the
   * old durable row, and later catch-up would serve stale content). The
   * `INSERT OR IGNORE` on entries never resets an already-'acked' entry to 'pending'.
   * The relay does the live WebSocket delivery + sender receipt AFTER this returns
   * (post-commit) — and only when the disposition is not `'collision'`.
   *
   * Cold-Start: with zero delivery targets the `inbox_message` is still written
   * and retained — the first device to register picks it up via TC5.
   */
  enqueueFanout(input: InboxFanoutInput): { disposition: 'inserted' | 'idempotent' | 'collision' } {
    const createdAt = this.isoAt(input.nowMs ?? Date.now())
    const envelopeJson = JSON.stringify(input.envelope)
    const tx = this.db.transaction((): { disposition: 'inserted' | 'idempotent' | 'collision' } => {
      const existing = this.db
        .prepare('SELECT to_did, envelope FROM inbox_message WHERE message_id = ?')
        .get(input.messageId) as { to_did: string; envelope: string } | undefined

      if (existing && (existing.to_did !== input.toDid || existing.envelope !== envelopeJson)) {
        // Same id, different recipient or payload → divergent collision. Leave the
        // stored row untouched, mint NO entries (they would point at the wrong
        // envelope), and signal the caller to reject. No durable mutation.
        return { disposition: 'collision' }
      }

      if (!existing) {
        this.db
          .prepare('INSERT INTO inbox_message (message_id, to_did, envelope, created_at) VALUES (?, ?, ?, ?)')
          .run(input.messageId, input.toDid, envelopeJson, createdAt)
      }

      const insertEntry = this.db.prepare(
        'INSERT OR IGNORE INTO inbox_entry (message_id, device_id, status) VALUES (?, ?, ?)',
      )
      for (const deviceId of input.deliveryTargetDeviceIds) {
        insertEntry.run(input.messageId, deviceId, 'pending' satisfies InboxEntryStatus)
      }
      if (input.excludedSenderDeviceId) {
        insertEntry.run(input.messageId, input.excludedSenderDeviceId, 'sender-excluded' satisfies InboxEntryStatus)
      }
      return { disposition: existing ? 'idempotent' : 'inserted' }
    })
    return tx()
  }

  // ── TC5 — on-connect delivery (Cold-Start + Late-Joiner + Redelivery) ────────

  /**
   * For the connecting (toDid, deviceId): mint a 'pending' entry for every
   * retained `inbox_message` to this DID that has no entry yet for this device
   * (Cold-Start / Late-Joiner), then return ALL of this device's 'pending'
   * envelopes in `inbox_message.id` order for redelivery. Status is NOT advanced
   * — entries stay 'pending' until the device's own ack/1.0 (retained-until-ack).
   * Terminal (fully-delivered) messages were already deleted in the ACK path, so
   * a device registering after a complete ACK finds nothing. The sender's
   * 'sender-excluded' entry blocks a self-addressed echo (no entry minted here).
   */
  deliverOnConnect(toDid: string, deviceId: string): Record<string, unknown>[] {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO inbox_entry (message_id, device_id, status)
           SELECT m.message_id, ?, 'pending' FROM inbox_message m
           WHERE m.to_did = ?
             AND NOT EXISTS (
               SELECT 1 FROM inbox_entry e WHERE e.message_id = m.message_id AND e.device_id = ?
             )`,
        )
        .run(deviceId, toDid, deviceId)

      return this.db
        .prepare(
          `SELECT m.envelope FROM inbox_entry e
           JOIN inbox_message m ON e.message_id = m.message_id
           WHERE e.device_id = ? AND e.status = 'pending' AND m.to_did = ?
           ORDER BY m.id`,
        )
        .all(deviceId, toDid) as Array<{ envelope: string }>
    })
    const rows = tx()
    return rows.map((row) => JSON.parse(row.envelope) as Record<string, unknown>)
  }

  // ── TC4 — per-device ACK + terminal (atomic, durable rowcount) ───────────────

  /**
   * Apply a recipient device's ack/1.0 to ITS entry only and, iff that flipped a
   * real 'pending'→'acked' (rowcount === 1), terminally delete the message when it
   * is now fully delivered — atomically, before a concurrently-registering device
   * (TC5) can mint a late entry. A `sender-excluded` / already-'acked' / missing
   * entry yields rowcount 0 → strict no-op (no status change, no terminal delete).
   * Returns whether the ACK applied (the relay sends its ack receipt regardless).
   */
  ackDevice(messageId: string, deviceId: string, opts: RetentionOptions = {}): { applied: boolean } {
    const nowMs = opts.nowMs ?? Date.now()
    const inactiveMs = opts.inactiveMs ?? DEFAULT_INACTIVE_MS
    const tx = this.db.transaction((): { applied: boolean } => {
      const res = this.db
        .prepare("UPDATE inbox_entry SET status = 'acked' WHERE message_id = ? AND device_id = ? AND status = 'pending'")
        .run(messageId, deviceId)
      if (res.changes !== 1) return { applied: false }
      if (this.isFullyDelivered(messageId, nowMs, inactiveMs)) {
        this.deleteMessage(messageId)
      }
      return { applied: true }
    })
    return tx()
  }

  // ── TC6 — device-revoke cleanup + terminal re-check (atomic) ─────────────────

  /**
   * Drop all of a revoked device's inbox entries (R5) and then terminal-delete any
   * message that is now fully delivered because the revoked device no longer
   * counts (e.g. A acked, B pending, B revoked → the message is complete and MUST
   * become terminal, else TC5 would hand it to a later device). One transaction.
   */
  deleteForDevice(deviceId: string, opts: RetentionOptions = {}): void {
    const nowMs = opts.nowMs ?? Date.now()
    const inactiveMs = opts.inactiveMs ?? DEFAULT_INACTIVE_MS
    const tx = this.db.transaction(() => {
      const affected = this.db
        .prepare('SELECT DISTINCT message_id FROM inbox_entry WHERE device_id = ?')
        .all(deviceId) as Array<{ message_id: string }>
      this.db.prepare('DELETE FROM inbox_entry WHERE device_id = ?').run(deviceId)
      for (const { message_id } of affected) {
        if (this.isFullyDelivered(message_id, nowMs, inactiveMs)) {
          this.deleteMessage(message_id)
        }
      }
    })
    tx()
  }

  // ── TC7 — retention / GC (deterministic, effective-active) ───────────────────

  /**
   * Deterministic retention sweep (Z.210-211). In one transaction:
   *  (a) delete fully-delivered messages (≥1 acked AND every effective-active
   *      device acked/sender-excluded) — the terminal-completeness backstop;
   *  (b) delete messages older than `ttlMs` by `inbox_message.created_at` (hard TTL,
   *      covers Cold-Start / no-active-device messages that have 0 entries);
   *  (c) delete entries of devices inactive longer than `inactiveMs` (bloat,
   *      consistent with the effective-active definition).
   * `now` is injected (epoch ms) — no timer magic. There is intentionally NO
   * "orphan message without entries" GC: a Cold-Start message has 0 entries on
   * purpose and MUST stay retained until a device picks it up or TTL prunes it.
   */
  collectGarbage(nowMs: number, opts: { ttlMs?: number; inactiveMs?: number } = {}): GarbageCollectionResult {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    const inactiveMs = opts.inactiveMs ?? DEFAULT_INACTIVE_MS
    const tx = this.db.transaction((): GarbageCollectionResult => {
      // (a) fully-delivered
      let removedFullyDelivered = 0
      const allMessages = this.db
        .prepare('SELECT message_id FROM inbox_message')
        .all() as Array<{ message_id: string }>
      for (const { message_id } of allMessages) {
        if (this.isFullyDelivered(message_id, nowMs, inactiveMs)) {
          this.deleteMessage(message_id)
          removedFullyDelivered += 1
        }
      }
      // (b) hard TTL on created_at
      const ttlThreshold = this.isoAt(nowMs - ttlMs)
      const expired = this.db
        .prepare('SELECT message_id FROM inbox_message WHERE created_at < ?')
        .all(ttlThreshold) as Array<{ message_id: string }>
      for (const { message_id } of expired) this.deleteMessage(message_id)
      // (c) inactive-device entry bloat — entries whose device is inactive past inactiveMs.
      const inactiveThreshold = this.isoAt(nowMs - inactiveMs)
      const inactiveRes = this.db
        .prepare(
          `DELETE FROM inbox_entry WHERE device_id IN (
             SELECT device_id FROM devices WHERE last_seen_at < ?
           )`,
        )
        .run(inactiveThreshold)
      return {
        removedFullyDelivered,
        removedExpired: expired.length,
        removedInactiveEntries: inactiveRes.changes,
      }
    })
    return tx()
  }

  /**
   * fully-delivered(messageId, now): (≥1 entry 'acked') AND (every effective-active
   * device of the message's to_did has an entry with status IN ('acked',
   * 'sender-excluded')). The `≥1 acked` guard blocks vacuous-true at 0
   * effective-active devices (Cold-Start retained) and stops a `sender-excluded`-only
   * self-addressed message from going terminal before a sibling acks. Reads the
   * shared `devices` table (DocLog) by the SAME db handle.
   */
  private isFullyDelivered(messageId: string, nowMs: number, inactiveMs: number): boolean {
    const message = this.db
      .prepare('SELECT to_did FROM inbox_message WHERE message_id = ?')
      .get(messageId) as { to_did: string } | undefined
    if (!message) return false

    const ackedCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM inbox_entry WHERE message_id = ? AND status = 'acked'")
        .get(messageId) as { c: number }
    ).c
    if (ackedCount < 1) return false

    const activeThreshold = this.isoAt(nowMs - inactiveMs)
    const effectiveActive = this.db
      .prepare(
        "SELECT device_id FROM devices WHERE did = ? AND status = 'active' AND last_seen_at >= ?",
      )
      .all(message.to_did, activeThreshold) as Array<{ device_id: string }>

    for (const { device_id } of effectiveActive) {
      const entry = this.db
        .prepare('SELECT status FROM inbox_entry WHERE message_id = ? AND device_id = ?')
        .get(messageId, device_id) as { status: InboxEntryStatus } | undefined
      if (!entry || (entry.status !== 'acked' && entry.status !== 'sender-excluded')) return false
    }
    return true
  }

  /** Terminal delete: the message row + all its per-device entries. */
  private deleteMessage(messageId: string): void {
    this.db.prepare('DELETE FROM inbox_entry WHERE message_id = ?').run(messageId)
    this.db.prepare('DELETE FROM inbox_message WHERE message_id = ?').run(messageId)
  }

  // ── ack-path introspection (kept) ────────────────────────────────────────────

  /**
   * Look up a retained message for the ack/1.0 runtime check (Sync 003 §ack/1.0):
   * recipient DID + envelope, while the message row exists. After terminal delete
   * the content is no longer reconstructable for the relay.
   */
  getByMessageId(messageId: string): { toDid: string; envelope: Record<string, unknown> } | null {
    const row = this.db
      .prepare('SELECT to_did, envelope FROM inbox_message WHERE message_id = ?')
      .get(messageId) as { to_did: string; envelope: string } | undefined
    if (!row) return null
    return { toDid: row.to_did, envelope: JSON.parse(row.envelope) as Record<string, unknown> }
  }

  // ── counts (semantics changed — see PR/dashboard note) ───────────────────────

  /**
   * Number of per-device delivery SLOTS (`inbox_entry` rows), optionally scoped to
   * a recipient DID. NOTE: this counts delivery slots `(message_id, device_id)`,
   * NOT distinct messages — a message fanned out to N devices counts as N. Use
   * {@link messageCount} for distinct retained messages.
   */
  count(toDid?: string): number {
    if (toDid) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM inbox_entry e
           JOIN inbox_message m ON e.message_id = m.message_id
           WHERE m.to_did = ?`,
        )
        .get(toDid) as { count: number }
      return row.count
    }
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM inbox_entry').get() as { count: number }
    return row.count
  }

  /** Per-DID delivery-slot counts (`inbox_entry` rows grouped by recipient DID). */
  countByDid(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT m.to_did AS to_did, COUNT(*) AS count FROM inbox_entry e
         JOIN inbox_message m ON e.message_id = m.message_id
         GROUP BY m.to_did`,
      )
      .all() as Array<{ to_did: string; count: number }>
    const result: Record<string, number> = {}
    for (const row of rows) result[row.to_did] = row.count
    return result
  }

  /** Distinct retained messages (`inbox_message` rows), optionally scoped to a DID. */
  messageCount(toDid?: string): number {
    if (toDid) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM inbox_message WHERE to_did = ?')
        .get(toDid) as { count: number }
      return row.count
    }
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM inbox_message').get() as { count: number }
    return row.count
  }

  /** No-op: the SQLite handle is borrowed (shared with DocLog); the owner closes it. */
  close(): void {}
}
