import { openDB, type IDBPDatabase } from 'idb'
import type { MessageIdHistoryPort } from '../../ports/MessageIdHistory'
import { MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS } from './InMemoryMessageIdHistory'

const DB_NAME = 'wot-message-id-history'
const DB_VERSION = 1
const STORE = 'messageIds'
const BY_SEEN_AT = 'bySeenAt'

export interface IndexedDBMessageIdHistoryOptions {
  /** Retention window in ms; default 24h + clock-skew (Sync 003 Z.465). */
  retentionMs?: number
}

function parseIsoMs(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO timestamp for ${field}: ${iso}`)
  return ms
}

/**
 * Durable IndexedDB {@link MessageIdHistoryPort} (Durable Wiring / D1) — replay
 * protection (Sync 003 Z.466) that SURVIVES a reload, so the inbox cannot be
 * replayed across a restart. Mirrors {@link InMemoryMessageIdHistory}: id →
 * first-seen ms (replays do NOT refresh it); each checkAndRecord self-prunes
 * entries outside the retention window via the `bySeenAt` index.
 *
 * The DB name is constructor-injected so the composition root can make it DID-
 * aware; an identity switch wipes it together with the log + keys.
 */
export class IndexedDBMessageIdHistory implements MessageIdHistoryPort {
  private dbPromise: Promise<IDBPDatabase> | null = null
  private readonly dbName: string
  private readonly retentionMs: number

  constructor(dbName: string = DB_NAME, options: IndexedDBMessageIdHistoryOptions = {}) {
    this.dbName = dbName
    this.retentionMs = options.retentionMs ?? MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS
  }

  async init(): Promise<void> {
    await this.db()
  }

  async has(id: string, nowIso: string): Promise<boolean> {
    const nowMs = parseIsoMs(nowIso, 'nowIso')
    const db = await this.db()
    const record = (await db.get(STORE, id)) as StoredMessageId | undefined
    // Reading does NOT record and does NOT prune (mirrors the in-memory default).
    return record !== undefined && record.seenAtMs >= nowMs - this.retentionMs
  }

  async checkAndRecord(id: string, nowIso: string): Promise<boolean> {
    const nowMs = parseIsoMs(nowIso, 'nowIso')
    const db = await this.db()
    // ONE readwrite txn so check-then-record is atomic (no await on external work
    // between get and put), plus self-cleaning of entries past the retention window.
    const tx = db.transaction(STORE, 'readwrite')
    // Self-clean entries past the retention window (seenAtMs strictly < cutoff).
    let pruneCursor = await tx.store
      .index(BY_SEEN_AT)
      .openCursor(IDBKeyRange.upperBound(nowMs - this.retentionMs, true))
    while (pruneCursor) {
      await pruneCursor.delete()
      pruneCursor = await pruneCursor.continue()
    }
    const existing = (await tx.store.get(id)) as StoredMessageId | undefined
    if (existing !== undefined) {
      await tx.done
      return true // duplicate record — first-seen timestamp is NOT refreshed
    }
    await tx.store.put({ id, seenAtMs: nowMs })
    await tx.done
    return false
  }

  async prune(cutoffIso: string): Promise<void> {
    const cutoffMs = parseIsoMs(cutoffIso, 'cutoffIso')
    const db = await this.db()
    const tx = db.transaction(STORE, 'readwrite')
    let cursor = await tx.store.index(BY_SEEN_AT).openCursor(IDBKeyRange.upperBound(cutoffMs, true))
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
    await tx.done
  }

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(this.dbName, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'id' })
            store.createIndex(BY_SEEN_AT, 'seenAtMs')
          }
        },
      })
    }
    return this.dbPromise
  }
}

interface StoredMessageId {
  id: string
  seenAtMs: number
}
