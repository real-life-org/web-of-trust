import Database from 'better-sqlite3'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

const { bytesToHex, classifyBrokerSeqCollision, canonicalizeToBytes } = protocol
type SyncHeads = protocol.SyncHeads
type LogEntryPayload = protocol.LogEntryPayload

/**
 * Result of an ingest attempt (VE-3 seq-collision only).
 * The relay maps each disposition to a wire response; only `accept-new-entry`
 * stores + relays. Author-binding (Sync 003 §Log-Eintrag-Autor-Bindung) is no
 * longer enforced here — it is now anchored on the DURABLE device list
 * (didForDevice) in the relay, replacing the Slice-R VE-3a first-writer-wins
 * heuristic on (docId,deviceId).
 */
export type AppendResult =
  | { disposition: 'accept-new-entry' }
  | { disposition: 'idempotent-retransmission' }
  | { disposition: 'reject-seq-collision'; errorCode: 'SEQ_COLLISION_DETECTED'; clientHint: 'restore-clone-required' }
  // Slice SR / B2 (APPROVAL-GATED): the AUTHORITATIVE in-transaction generation gate.
  // A NEW entry whose `keyGeneration` is older than the space's CURRENT generation
  // (read inside the SAME SQLite transaction as the dedup/seq check + insert) is a
  // write under a rotated-out content key (e.g. a just-removed member after rotation)
  // → NOT stored, NOT relayed. This closes the race window where a concurrent
  // `rotateSpace` lands between the relay's fast-path pre-gate and the durable insert.
  // An ALREADY-stored identical (deviceId,seq,contentHash) stays idempotent (ACK)
  // even at an old generation — dedup is checked BEFORE this gate.
  | { disposition: 'reject-key-generation-stale' }

/**
 * Durable device-list disposition (Sync 003 §Device-Registrierung + §Race
 * Conditions). Returned by registerDevice after challenge-response succeeds.
 *  - 'registered'         → stored active (new) or already active for THIS DID.
 *  - 'device-id-conflict' → deviceId is registered for ANOTHER DID (active OR
 *    revoked tombstone) → DEVICE_ID_CONFLICT.
 *  - 'device-revoked'     → deviceId for THIS DID is a revoked tombstone →
 *    DEVICE_REVOKED.
 */
export type DeviceRegistrationDisposition =
  | { disposition: 'registered'; isNewDevice: boolean }
  | { disposition: 'device-id-conflict' }
  | { disposition: 'device-revoked' }

/**
 * Durable space-registry disposition (Sync 003 §Space-Registrierung). Returned by
 * registerSpace under TOFU first-writer-wins:
 *  - 'registered' → no prior entry for this spaceId; bound (generation 0) + admins.
 *  - 'idempotent' → a prior entry exists with the IDENTICAL verificationKey AND the
 *    identical adminDids set (order-independent) → idempotent recovery/re-register.
 *  - 'conflict'   → a prior entry exists but the verificationKey or admin set
 *    diverges → SPACE_ALREADY_REGISTERED (changes go via space-rotate/admin-*).
 */
export type SpaceRegistrationDisposition =
  | { disposition: 'registered' }
  | { disposition: 'idempotent' }
  | { disposition: 'conflict' }
  // A2 Teil B: the docId is already bound as a PERSONAL doc to a DID that is NOT among the
  // space-register's adminDids → a foreigner trying to hijack a personal doc by promoting it
  // to a space (PERSONAL_DOC_OWNER_MISMATCH). A legitimate owner upgrade (owner ∈ adminDids)
  // is allowed and clears the personal binding.
  | { disposition: 'personal-owner-conflict' }

/**
 * Personal-Doc Owner-Binding (TOFU, A2 Teil B). `claimed` = first owner bound;
 * `idempotent` = same DID re-claims (reconnect / another device of the SAME DID);
 * `conflict` = a DIFFERENT DID already owns the docId (the foreign-DID-with-leaked-docId
 * attack — rejected PERSONAL_DOC_OWNER_MISMATCH at the relay).
 */
export type PersonalDocOwnerClaimDisposition =
  | { disposition: 'claimed' }
  | { disposition: 'idempotent' }
  | { disposition: 'conflict' }

/** A durable space record (Sync 003 §Space-Registrierung). */
export interface SpaceRecord {
  verificationKey: string
  generation: number
}

/** A durable device record (Sync 003 §Device-Liste im Broker). */
export interface DeviceRecord {
  deviceId: string
  did: string
  firstSeenAt: string
  lastSeenAt: string
  status: 'active' | 'revoked'
  revokedAt: string | null
}

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
 * It also owns the DURABLE device list (Sync 003 §Device-Liste im Broker): one
 * row per globally-unique deviceId, carrying its owning DID, first/last-seen
 * timestamps, status (active|revoked) and an optional revokedAt. The relay's
 * registration + log-entry author-binding consult this table; a revoked row is
 * a TOMBSTONE that keeps the deviceId globally reserved.
 *
 * Schema:
 *   doc_log(doc_id, device_id, seq, content_hash, entry_jws, created_at,
 *           PRIMARY KEY(doc_id, device_id, seq))
 *   + index on (doc_id, device_id, seq)
 *   devices(did, device_id, first_seen_at, last_seen_at, status, revoked_at,
 *           PRIMARY KEY(device_id))   -- deviceId GLOBALLY unique
 *
 * It ALSO owns the DURABLE space registry (Sync 003 §Space-Registrierung): one row
 * per spaceId established TOFU first-writer-wins, plus its admin set. The relay's
 * space-register handler consults this; the capability gate (Phase 4) will use it
 * to decide whether a docId is a registered space (Space-Pfad) vs a Personal-Doc.
 *
 *   spaces(space_id, verification_key, generation, created_at,
 *           PRIMARY KEY(space_id))
 *   space_admins(space_id, admin_did, PRIMARY KEY(space_id, admin_did))
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
    // Durable device list (Sync 003 §Device-Liste im Broker). `device_id` is the
    // PRIMARY KEY because device IDs MUST be globally unique (§Erstregistrierung):
    // the PK enforces global uniqueness, so a revoked record stays a conflict
    // tombstone for ANY other DID. `status` is 'active' | 'revoked'; `revoked_at`
    // is set only for tombstones. This list anchors log-entry author-binding
    // (didForDevice) and replaces the Slice-R doc_device_author first-writer-wins
    // heuristic.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        did TEXT NOT NULL,
        device_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (device_id)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_devices_did ON devices (did)
    `)
    // Durable space registry (Sync 003 §Space-Registrierung). `space_id` is the
    // PRIMARY KEY: one binding per space, established TOFU first-writer-wins. The
    // `verification_key` is the registered `spaceCapabilityVerificationKey`;
    // `generation` starts at 0 at register-time (space-rotate bumps it in Phase 5).
    // The admin set lives in a separate `space_admins` table (one row per admin
    // DID) so membership comparison is a set, not a packed string. Both tables are
    // written in ONE transaction by registerSpace so a half-registered space can
    // never be observed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spaces (
        space_id TEXT NOT NULL,
        verification_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (space_id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS space_admins (
        space_id TEXT NOT NULL,
        admin_did TEXT NOT NULL,
        PRIMARY KEY (space_id, admin_did)
      )
    `)
    // Durable Personal-Doc owner registry (A2 Teil B, TOFU). `doc_id` PRIMARY KEY: one
    // owner binding per personal docId, established first-writer-wins on the first
    // successful `present-capability` (T-CLAIM). The seed-derived personalDocId is a
    // bearer secret; binding it to the first claimant DID stops a foreign DID that LEARNS
    // the docId from poisoning the log / reading metadata (PERSONAL_DOC_OWNER_MISMATCH).
    // DID-level (not device-level) so all of the owner's devices (shared seed) share it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_doc_owners (
        doc_id TEXT NOT NULL,
        owner_did TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (doc_id)
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
   * Ingest a VERIFIED log entry. This layer now performs ONLY seq-collision
   * classification (VE-3) + the durable insert, run together in ONE SQLite
   * transaction. better-sqlite3 is synchronous, so the callback runs atomically
   * with no intervening await; the transaction gives all-or-nothing durability
   * for the log insert and keeps the read-then-insert seq-collision check free of
   * a race window.
   *
   * Author-binding moved OUT of this layer: it is now enforced by the relay
   * against the DURABLE device list (didForDevice) BEFORE calling appendEntry
   * (Sync 003 §Log-Eintrag-Autor-Bindung), replacing the Slice-R first-writer-wins
   * heuristic on (docId,deviceId).
   *
   * Slice SR / B2: `keyGeneration` (from the VERIFIED JWS payload) is gated against
   * the space's CURRENT generation INSIDE this transaction, so a concurrent
   * `rotateSpace` (an atomic UPDATE on the SAME shared connection) cannot land
   * between a generation read and the durable insert. The dedup/seq check runs
   * BEFORE the gate so an already-stored identical entry stays idempotent even after
   * the space rotated past its generation.
   *
   * Dispositions:
   *  - reject-seq-collision → divergent content at an existing (docId,deviceId,seq)
   *    (deterministic-nonce reuse guard); not stored, not relayed.
   *  - idempotent-retransmission → exact (deviceId,seq,content) already present;
   *    no re-store (checked BEFORE the generation gate, so it ACKs even at an old gen).
   *  - reject-key-generation-stale → a NEW entry under a rotated-out generation; not
   *    stored, not relayed (the authoritative race-closing gate for B2).
   *  - accept-new-entry → entry appended.
   */
  appendEntry(params: {
    docId: string
    deviceId: string
    seq: number
    contentHash: string
    entryJws: string
    /**
     * The entry's `keyGeneration` (from the verified JWS payload), gated in-transaction
     * against the registered space generation (B2).
     *
     * SECURITY BOUNDARY: when OMITTED the generation gate is SKIPPED entirely (no-op),
     * NOT defaulted — there is no implicit "current generation" fallback. Omitting it is
     * only safe for docIds that are not registered spaces (e.g. a Personal-Doc), where
     * there is no `spaces.generation` row to gate against. Every registered-space
     * log-entry ingest MUST pass the verified `keyGeneration`, else a rotated-out (stale)
     * write would bypass the post-removal gate. The sole caller (handleLogEntry) always
     * passes it.
     */
    keyGeneration?: number
  }): AppendResult {
    const ingest = this.db.transaction((p: typeof params): AppendResult => {
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
        // Dedup wins BEFORE the generation gate: an already-stored identical entry is
        // an idempotent retransmission (ACK) even if the space rotated past its
        // generation since it was first accepted.
        return { disposition: 'idempotent-retransmission' }
      }

      // Slice SR / B2 — AUTHORITATIVE generation gate, ONLY on the accept-new-entry
      // branch and BEFORE the INSERT. Reads the current generation from the SAME db
      // inside this transaction (better-sqlite3 is synchronous, so this read + the
      // insert are atomic relative to a concurrent rotateSpace UPDATE on the shared
      // connection). null = unregistered docId (Personal-Doc) → no gate. A registered
      // space whose generation has advanced past this NEW entry's keyGeneration
      // rejects it: it is a write under a rotated-out content key.
      if (p.keyGeneration !== undefined) {
        const row = this.db
          .prepare('SELECT generation FROM spaces WHERE space_id = ?')
          .get(p.docId) as { generation: number } | undefined
        if (row !== undefined && p.keyGeneration < row.generation) {
          return { disposition: 'reject-key-generation-stale' }
        }
      }

      // accept-new-entry: append. INSERT OR IGNORE is a backstop against the PK.
      const now = new Date().toISOString()
      this.db
        .prepare(
          'INSERT OR IGNORE INTO doc_log (doc_id, device_id, seq, content_hash, entry_jws, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(p.docId, p.deviceId, p.seq, p.contentHash, p.entryJws, now)
      return { disposition: 'accept-new-entry' }
    })
    return ingest(params)
  }

  // --- durable device list (Sync 003 §Device-Liste im Broker) --------------

  /**
   * Erstregistrierung after challenge-response succeeds (Sync 003
   * §Erstregistrierung + §Race Conditions). The conflict checks + the active
   * insert run in ONE synchronous SQLite transaction so a registration cannot
   * race a concurrent revocation/registration of the same deviceId:
   *  - deviceId registered for ANOTHER DID (active OR revoked tombstone)
   *    → 'device-id-conflict' (deviceId is globally unique; tombstone reserved).
   *  - deviceId for THIS DID is a revoked tombstone → 'device-revoked'
   *    (revocation wins atomically on a race).
   *  - deviceId already active for THIS DID → 'registered' (isNewDevice:false),
   *    lastSeenAt refreshed.
   *  - otherwise store active → 'registered' (isNewDevice:true).
   */
  registerDevice(did: string, deviceId: string): DeviceRegistrationDisposition {
    const tx = this.db.transaction((): DeviceRegistrationDisposition => {
      const existing = this.db
        .prepare('SELECT did, status FROM devices WHERE device_id = ?')
        .get(deviceId) as { did: string; status: string } | undefined

      if (existing) {
        if (existing.did !== did) {
          // Globally-unique deviceId already owned by another DID (active or a
          // revoked tombstone) → DEVICE_ID_CONFLICT.
          return { disposition: 'device-id-conflict' }
        }
        if (existing.status === 'revoked') {
          // Revoked tombstone for this DID → DEVICE_REVOKED (revocation wins).
          return { disposition: 'device-revoked' }
        }
        // Known active device for this DID: refresh lastSeenAt only.
        this.db
          .prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?')
          .run(new Date().toISOString(), deviceId)
        return { disposition: 'registered', isNewDevice: false }
      }

      const now = new Date().toISOString()
      this.db
        .prepare(
          'INSERT INTO devices (did, device_id, first_seen_at, last_seen_at, status, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
        )
        .run(did, deviceId, now, now, 'active')
      return { disposition: 'registered', isNewDevice: true }
    })
    return tx()
  }

  /** The durable device record for a deviceId, or null. */
  getDevice(deviceId: string): DeviceRecord | null {
    const row = this.db
      .prepare(
        'SELECT did, device_id, first_seen_at, last_seen_at, status, revoked_at FROM devices WHERE device_id = ?',
      )
      .get(deviceId) as
      | {
          did: string
          device_id: string
          first_seen_at: string
          last_seen_at: string
          status: string
          revoked_at: string | null
        }
      | undefined
    if (!row) return null
    return {
      deviceId: row.device_id,
      did: row.did,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      status: row.status === 'revoked' ? 'revoked' : 'active',
      revokedAt: row.revoked_at,
    }
  }

  /**
   * The DID that OWNS a deviceId in the durable device list, or null if the
   * deviceId is not registered at all. Used for log-entry author-binding (Sync
   * 003 §Log-Eintrag-Autor-Bindung). A revoked tombstone still returns its owner
   * DID (the deviceId stays reserved), so author-binding holds across revocation;
   * the relay applies a separate live status==active check.
   */
  didForDevice(deviceId: string): string | null {
    const row = this.db
      .prepare('SELECT did FROM devices WHERE device_id = ?')
      .get(deviceId) as { did: string } | undefined
    return row ? row.did : null
  }

  /**
   * Mark (did, deviceId) as revoked (Sync 003 §Device-Deaktivierung). Idempotent:
   * the FIRST revocation's metadata stays authoritative — a re-revoke does NOT
   * overwrite revoked_at. A revocation for an unknown (did, deviceId) is stored as
   * a revoked TOMBSTONE (still globally reserved). The PRIMARY KEY on device_id
   * means a tombstone for one DID blocks any other DID re-registering it.
   * Returns the disposition for logging/observability.
   *
   * Authorization boundary (Sync 003 §Device-Deaktivierung — "Jede gültig mit dem
   * Identity Key der DID signierte device-revoke Nachricht DARF jedes Device
   * DERSELBEN DID deaktivieren"): a revocation may only revoke a device OWNED by
   * the signing `did`. If the deviceId already belongs to ANOTHER DID (active OR a
   * revoked tombstone), this is NOT the signer's device — NO state change, return
   * 'did-mismatch'. The relay maps that to AUTH_INVALID. Without this guard an
   * attacker could sign {did: attackerDid, deviceId: victimDeviceId} validly and
   * flip a victim's ACTIVE device to revoked (cross-DID revocation).
   */
  revokeDevice(
    did: string,
    deviceId: string,
    revokedAt: string,
  ): { disposition: 'revoked' | 'already-revoked' | 'tombstoned' | 'did-mismatch' } {
    const tx = this.db.transaction(
      (): { disposition: 'revoked' | 'already-revoked' | 'tombstoned' | 'did-mismatch' } => {
        const existing = this.db
          .prepare('SELECT did, status FROM devices WHERE device_id = ?')
          .get(deviceId) as { did: string; status: string } | undefined

        if (!existing) {
          // Unknown device: store a revoked tombstone (idempotent accept).
          const now = new Date().toISOString()
          this.db
            .prepare(
              'INSERT INTO devices (did, device_id, first_seen_at, last_seen_at, status, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(did, deviceId, now, now, 'revoked', revokedAt)
          return { disposition: 'tombstoned' }
        }
        if (existing.did !== did) {
          // The deviceId is owned by ANOTHER DID — a revocation signed by `did`
          // MUST NOT mutate it. No state change; the relay rejects AUTH_INVALID.
          return { disposition: 'did-mismatch' }
        }
        if (existing.status === 'revoked') {
          // Already revoked: first metadata is authoritative, do not overwrite.
          return { disposition: 'already-revoked' }
        }
        this.db
          .prepare('UPDATE devices SET status = ?, revoked_at = ?, last_seen_at = ? WHERE device_id = ?')
          .run('revoked', revokedAt, new Date().toISOString(), deviceId)
        return { disposition: 'revoked' }
      },
    )
    return tx()
  }

  /** True if (did, deviceId) is currently registered AND status==active. */
  isActive(did: string, deviceId: string): boolean {
    const row = this.db
      .prepare('SELECT did, status FROM devices WHERE device_id = ?')
      .get(deviceId) as { did: string; status: string } | undefined
    return row !== undefined && row.did === did && row.status === 'active'
  }

  /**
   * The deviceIds currently registered AND status==active for a DID (Sync 003
   * §Device-Liste im Broker). Source for the multi-device inbox fan-out
   * (recipientDevices) in the store-and-forward path. Revoked tombstones are
   * excluded; effective-active (last_seen) filtering for retention is applied
   * separately by the inbox GC.
   */
  activeDeviceIdsForDid(did: string): string[] {
    const rows = this.db
      .prepare("SELECT device_id FROM devices WHERE did = ? AND status = 'active'")
      .all(did) as Array<{ device_id: string }>
    return rows.map((row) => row.device_id)
  }

  /**
   * The EFFECTIVE-ACTIVE deviceIds for a DID (Sync 003 §Store-and-Forward Z.211): active
   * AND seen within `inactiveMs` of `nowMs`. This is the fan-out target set, kept
   * IDENTICAL to the inbox fully-delivered completeness check (which uses the same
   * predicate) so a fan-out target is always counted in completeness — a device merely
   * offline past the window is neither targeted nor blocks terminal, and picks the
   * message up on reconnect if it is still retained.
   */
  effectiveActiveDeviceIdsForDid(did: string, nowMs: number, inactiveMs: number): string[] {
    const threshold = new Date(nowMs - inactiveMs).toISOString()
    const rows = this.db
      .prepare("SELECT device_id FROM devices WHERE did = ? AND status = 'active' AND last_seen_at >= ?")
      .all(did, threshold) as Array<{ device_id: string }>
    return rows.map((row) => row.device_id)
  }

  // --- durable space registry (Sync 003 §Space-Registrierung) ---------------

  /**
   * Bind (spaceId → verificationKey, adminDids) TOFU first-writer-wins (Sync 003
   * §Space-Registrierung). The lookup, the divergence check, and the insert run in
   * ONE synchronous SQLite transaction so a concurrent second register of the same
   * spaceId cannot race the first-writer binding:
   *  - no prior entry → INSERT the space (generation 0) + INSERT every adminDid →
   *    'registered'.
   *  - prior entry with the IDENTICAL verificationKey AND the identical adminDids
   *    SET (order-independent, deduped) → 'idempotent' (idempotent recovery; no
   *    write).
   *  - prior entry whose verificationKey OR admin set diverges → 'conflict'
   *    (→ SPACE_ALREADY_REGISTERED). The frame already passed TOFU JWS verification
   *    in the relay; binding conflicts are decided here against durable state.
   *
   * The admin set is compared as a SET: the spec rule is "identical adminDids set",
   * and the inner-JWS payload parser already rejects duplicates, so dedup here is a
   * defensive backstop only.
   */
  registerSpace(params: {
    spaceId: string
    verificationKey: string
    adminDids: string[]
    /**
     * The authenticated signer DID of the `space-register` inner JWS (kid-DID, verified ∈
     * adminDids by {@link verifySpaceRegisterMessage}). Bound here so a Personal→Space upgrade
     * MUST be SIGNED BY the owner — not merely list the owner among adminDids (see below).
     */
    signerDid: string
  }): SpaceRegistrationDisposition {
    const incomingAdmins = new Set(params.adminDids)
    const tx = this.db.transaction((): SpaceRegistrationDisposition => {
      // A2 Teil B (atomic with the space insert below): a personalDocId already bound to an
      // owner can only be promoted to a space by THAT owner — i.e. the space-register MUST be
      // SIGNED BY the owner (signerDid == owner), NOT merely list the owner among adminDids.
      // adminDids is self-asserted and the inner JWS only proves the signer is SOME admin: a
      // foreigner who learned the bearer-secret personalDocId could otherwise list the owner as a
      // decoy co-admin, sign as themselves, pass an owner∈adminDids check, flip
      // isSpaceRegistered(docId)→true, disable the personal owner gate (keyed on
      // !isSpaceRegistered), drop the owner's cached scope (VE-8), then DoS/poison the owner via
      // the space path — defeating T-CHECK for an already-claimed personal doc. Binding on the
      // cryptographically-proven signer closes that decoy vector.
      const personalOwner = (
        this.db
          .prepare('SELECT owner_did FROM personal_doc_owners WHERE doc_id = ?')
          .get(params.spaceId) as { owner_did: string } | undefined
      )?.owner_did
      if (personalOwner !== undefined && personalOwner !== params.signerDid) {
        return { disposition: 'personal-owner-conflict' }
      }

      const existing = this.db
        .prepare('SELECT verification_key FROM spaces WHERE space_id = ?')
        .get(params.spaceId) as { verification_key: string } | undefined

      if (existing) {
        // First-writer-wins: any divergence in the verification key or the admin
        // set is a conflict; only a byte-identical re-register is idempotent.
        if (existing.verification_key !== params.verificationKey) {
          return { disposition: 'conflict' }
        }
        const existingAdmins = new Set(
          (
            this.db
              .prepare('SELECT admin_did FROM space_admins WHERE space_id = ?')
              .all(params.spaceId) as Array<{ admin_did: string }>
          ).map((row) => row.admin_did),
        )
        if (!sameStringSet(existingAdmins, incomingAdmins)) {
          return { disposition: 'conflict' }
        }
        return { disposition: 'idempotent' }
      }

      // First writer: bind the space at generation 0 plus its admin set.
      const now = new Date().toISOString()
      this.db
        .prepare(
          'INSERT INTO spaces (space_id, verification_key, generation, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(params.spaceId, params.verificationKey, 0, now)
      const insertAdmin = this.db.prepare(
        'INSERT INTO space_admins (space_id, admin_did) VALUES (?, ?)',
      )
      for (const adminDid of incomingAdmins) insertAdmin.run(params.spaceId, adminDid)
      // Legitimate Personal→Space upgrade by the owner (signerDid == owner, checked above): drop
      // the now-superseded personal owner binding so a docId is NEVER simultaneously space-
      // registered AND personal-owned (else personalDocCount over-reports + a stale row re-gates it).
      if (personalOwner !== undefined) {
        this.db.prepare('DELETE FROM personal_doc_owners WHERE doc_id = ?').run(params.spaceId)
      }
      return { disposition: 'registered' }
    })
    return tx()
  }

  /** True if a spaceId has a durable registry entry (TOFU binding exists). */
  isSpaceRegistered(spaceId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM spaces WHERE space_id = ?')
      .get(spaceId) as { 1: number } | undefined
    return row !== undefined
  }

  /** The durable space record (verificationKey + generation) for a spaceId, or null. */
  getSpace(spaceId: string): SpaceRecord | null {
    const row = this.db
      .prepare('SELECT verification_key, generation FROM spaces WHERE space_id = ?')
      .get(spaceId) as { verification_key: string; generation: number } | undefined
    if (!row) return null
    return { verificationKey: row.verification_key, generation: row.generation }
  }

  /** The registered admin DIDs for a spaceId (ascending, deterministic); [] if none. */
  getSpaceAdmins(spaceId: string): string[] {
    const rows = this.db
      .prepare('SELECT admin_did FROM space_admins WHERE space_id = ? ORDER BY admin_did ASC')
      .all(spaceId) as Array<{ admin_did: string }>
    return rows.map((row) => row.admin_did)
  }

  /**
   * TOFU claim of a personal docId's owner (A2 Teil B, T-CLAIM). Atomic SELECT+INSERT in
   * ONE transaction (better-sqlite3 is synchronous, so concurrent same-DID claims serialize
   * → no half-claim, no double-bind). First claimant DID wins; the SAME DID re-claiming
   * (reconnect / another device of the same shared-seed identity) is `idempotent`; a
   * DIFFERENT DID is a `conflict` (rejected at the relay — the foreign-leaked-docId attack).
   */
  claimPersonalDocOwner(docId: string, did: string): PersonalDocOwnerClaimDisposition {
    const tx = this.db.transaction((): PersonalDocOwnerClaimDisposition => {
      const existing = this.db
        .prepare('SELECT owner_did FROM personal_doc_owners WHERE doc_id = ?')
        .get(docId) as { owner_did: string } | undefined
      if (existing) {
        return existing.owner_did === did ? { disposition: 'idempotent' } : { disposition: 'conflict' }
      }
      this.db
        .prepare('INSERT INTO personal_doc_owners (doc_id, owner_did, claimed_at) VALUES (?, ?, ?)')
        .run(docId, did, new Date().toISOString())
      return { disposition: 'claimed' }
    })
    return tx()
  }

  /** The owner DID bound to a personal docId, or null if unclaimed (A2 Teil B, T-CHECK). */
  getPersonalDocOwner(docId: string): string | null {
    const row = this.db
      .prepare('SELECT owner_did FROM personal_doc_owners WHERE doc_id = ?')
      .get(docId) as { owner_did: string } | undefined
    return row ? row.owner_did : null
  }

  /** True if a personal docId has an owner binding (A2 Teil B). */
  isPersonalDocOwned(docId: string): boolean {
    return this.getPersonalDocOwner(docId) !== null
  }

  /** Number of personal docs with an owner binding (leak-free aggregate for /dashboard/data). */
  personalDocOwnerCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM personal_doc_owners').get() as { count: number }
    return row.count
  }

  /**
   * Rotate a space's capability key + generation (Sync 003 §Capability-Widerruf
   * über Rotation, VE-6). Atomically writes the new `verification_key` AND the new
   * `generation` for an EXISTING space row. The relay enforces the spec invariant
   * `newGeneration === getSpace(spaceId).generation + 1` BEFORE calling this; the
   * store just applies the verified rotation. `getSpace` remains the source of the
   * current generation, so a subsequent `present-capability` verifies against the
   * rotated key at the new generation and any older-generation capability is STALE.
   * A rotation for an unregistered spaceId is a no-op (UPDATE matches no row) — the
   * relay never reaches here for an unregistered space (it checks isSpaceRegistered
   * first), so this is a defensive backstop only.
   */
  rotateSpace(spaceId: string, newVerificationKey: string, newGeneration: number): void {
    this.db
      .prepare('UPDATE spaces SET verification_key = ?, generation = ? WHERE space_id = ?')
      .run(newVerificationKey, newGeneration, spaceId)
  }

  /**
   * Add an admin DID to a space (Sync 003 §Admin-Management, VE-7). Idempotent:
   * INSERT OR IGNORE against the (space_id, admin_did) PRIMARY KEY, so re-adding an
   * existing admin is a no-op. The relay verifies the frame is signed by an already
   * registered admin BEFORE calling this.
   */
  addAdmin(spaceId: string, adminDid: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO space_admins (space_id, admin_did) VALUES (?, ?)')
      .run(spaceId, adminDid)
  }

  /**
   * Remove an admin DID from a space (Sync 003 §Admin-Management, VE-7). Idempotent:
   * a DELETE that matches no row is a no-op. The relay verifies the frame is signed
   * by an already registered admin BEFORE calling this.
   *
   * No "last admin" guard: Sync 003 §Admin-Management constrains only the signer
   * (a registered admin, else AUTH_INVALID) and does NOT forbid removing the final
   * admin at the broker. Removing the last admin leaves a space with an empty admin
   * set, after which no further `space-rotate`/`admin-*` frame can be authorized
   * (every future signer would fail the registered-admin check) — but that is a
   * client-side governance concern, unspecified at the broker layer, so the store
   * applies the removal faithfully.
   */
  removeAdmin(spaceId: string, adminDid: string): void {
    this.db
      .prepare('DELETE FROM space_admins WHERE space_id = ? AND admin_did = ?')
      .run(spaceId, adminDid)
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

  /** Retained entries for one (docId, deviceId) — the durable trace a specific device left. */
  entryCountForDevice(docId: string, deviceId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM doc_log WHERE doc_id = ? AND device_id = ?')
      .get(docId, deviceId) as { count: number }
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

  /**
   * Entries per (docId, deviceId). The aggregate-map sibling of {@link entryCountForDevice}
   * (one GROUP BY instead of N point reads), mirroring {@link entriesByDoc}. Used by the
   * Dashboard / remote-observation path (D1 Spur-C): a removed member's deviceId MUST show
   * ZERO durable entries after rotation, observable from outside via /dashboard/data.
   */
  entriesByDocAndDevice(): Record<string, Record<string, number>> {
    const rows = this.db
      .prepare('SELECT doc_id, device_id, COUNT(*) as count FROM doc_log GROUP BY doc_id, device_id')
      .all() as Array<{ doc_id: string; device_id: string; count: number }>
    const result: Record<string, Record<string, number>> = {}
    for (const row of rows) (result[row.doc_id] ??= {})[row.device_id] = row.count
    return result
  }

  /**
   * Every registered space keyed by spaceId, with its current generation + admin set.
   * The aggregate-map sibling of {@link getSpace}/{@link getSpaceAdmins}/{@link isSpaceRegistered}
   * (one query instead of N), for the Dashboard / remote-observation path (D1 Spur-C).
   * `registered` is always true for a present key — absence of the key means "not registered"
   * for the reader. NOTE: the verificationKey is intentionally NOT exposed here (minimal
   * read-only stats); admins is mildly sensitive (see getStats auth note).
   */
  spacesByDoc(): Record<string, { registered: boolean; generation: number; admins: string[] }> {
    const spaces = this.db
      .prepare('SELECT space_id, generation FROM spaces')
      .all() as Array<{ space_id: string; generation: number }>
    const adminRows = this.db
      .prepare('SELECT space_id, admin_did FROM space_admins ORDER BY admin_did ASC')
      .all() as Array<{ space_id: string; admin_did: string }>
    const adminsBySpace: Record<string, string[]> = {}
    for (const row of adminRows) (adminsBySpace[row.space_id] ??= []).push(row.admin_did)
    const result: Record<string, { registered: boolean; generation: number; admins: string[] }> = {}
    for (const s of spaces) {
      result[s.space_id] = { registered: true, generation: s.generation, admins: adminsBySpace[s.space_id] ?? [] }
    }
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

/** True iff two string sets contain exactly the same members (order-independent). */
function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}
