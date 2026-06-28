import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { OfflineQueue } from '../src/queue.js'
import { DocLog } from '../src/log-store.js'

// Adversarial unit tests for the multi-device inbox store-and-forward model
// (Sync 003 §Store-and-Forward pro Device). The durable ACK / terminal / GC logic
// is pure SQL on the SAME handle that backs `devices` (DocLog), so these tests
// construct both on one ':memory:' DB and drive the queue methods directly with an
// injected clock — deterministic, no timers.

const BOB = 'did:key:z6MkBobInbox'
const D1 = 'd1d1d1d1-1111-4111-8111-111111111111'
const D2 = 'd2d2d2d2-2222-4222-8222-222222222222'
const D3 = 'd3d3d3d3-3333-4333-8333-333333333333'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 0, 1) // fixed epoch ms; clock is injected, never read from Date.now()

function makeStore() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  const docLog = new DocLog(db)
  const queue = new OfflineQueue(db)
  return { db, docLog, queue }
}

function envelope(id: string): Record<string, unknown> {
  return { id, typ: 'application/didcomm-plain+json', type: 'https://web-of-trust.de/protocols/inbox/1.0', to: [BOB], body: { ciphertext: 'YQ' } }
}

/** Force a device's last_seen_at (devices is owned by DocLog; tests may age it). */
function setLastSeen(db: Database.Database, deviceId: string, ms: number): void {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(new Date(ms).toISOString(), deviceId)
}

describe('Multi-device inbox store-and-forward', () => {
  it('THE BUG: Device A ack does not delete Device B\'s entry — B stays pending (R1+R3+Z.206)', () => {
    const { docLog, queue } = makeStore()
    docLog.registerDevice(BOB, D1)
    docLog.registerDevice(BOB, D2)

    const env = envelope('msg-1')
    queue.enqueueFanout({ messageId: 'msg-1', toDid: BOB, envelope: env, deliveryTargetDeviceIds: [D1, D2], nowMs: T0 })
    expect(queue.count(BOB)).toBe(2) // one delivery slot per device

    const ackD1 = queue.ackDevice('msg-1', D1, { nowMs: T0 })
    expect(ackD1.applied).toBe(true)
    // NOT terminal — D2 still pending. A's ack must not have touched B's entry.
    expect(queue.messageCount(BOB)).toBe(1)
    expect(queue.deliverOnConnect(BOB, D2)).toEqual([env])

    // Once D2 also acks, every effective-active device is covered → terminal.
    expect(queue.ackDevice('msg-1', D2, { nowMs: T0 }).applied).toBe(true)
    expect(queue.messageCount(BOB)).toBe(0)
    expect(queue.count(BOB)).toBe(0)
  })

  it('ackDevice is a strict rowcount no-op for sender-excluded / already-acked / missing entries', () => {
    const { docLog, queue } = makeStore()
    docLog.registerDevice(BOB, D1)
    docLog.registerDevice(BOB, D2)

    // self-addressed: D1 is the sender (sender-excluded), D2 is a real target.
    const env = envelope('msg-2')
    queue.enqueueFanout({
      messageId: 'msg-2', toDid: BOB, envelope: env,
      deliveryTargetDeviceIds: [D2], excludedSenderDeviceId: D1, nowMs: T0,
    })

    // sender-excluded entry → not pending → no-op, and not a delivery proof.
    expect(queue.ackDevice('msg-2', D1, { nowMs: T0 }).applied).toBe(false)
    expect(queue.messageCount(BOB)).toBe(1)
    // missing entry → no-op.
    expect(queue.ackDevice('msg-2', D3, { nowMs: T0 }).applied).toBe(false)

    // real recipient acks → applied; second ack of the same entry → no-op.
    expect(queue.ackDevice('msg-2', D2, { nowMs: T0 }).applied).toBe(true)
    // After D2's ack: ≥1 acked AND every effective-active device (D1 sender-excluded,
    // D2 acked) is covered → terminal.
    expect(queue.messageCount(BOB)).toBe(0)
    expect(queue.ackDevice('msg-2', D2, { nowMs: T0 }).applied).toBe(false)
  })

  it('self-addressed (Z.204) is durable: the sender device never gets the echo, a sibling still does', () => {
    const { docLog, queue } = makeStore()
    docLog.registerDevice(BOB, D1)
    docLog.registerDevice(BOB, D2)

    const env = envelope('msg-3')
    queue.enqueueFanout({
      messageId: 'msg-3', toDid: BOB, envelope: env,
      deliveryTargetDeviceIds: [D2], excludedSenderDeviceId: D1, nowMs: T0,
    })

    // The sender device, even reconnecting, is never delivered its own echo.
    expect(queue.deliverOnConnect(BOB, D1)).toEqual([])
    // The sibling gets it, and it is NOT terminal before the sibling acks (≥1 acked guard).
    expect(queue.deliverOnConnect(BOB, D2)).toEqual([env])
    expect(queue.messageCount(BOB)).toBe(1)
  })

  it('cold-start: a message to a DID with no active device is retained (0 entries) until pick-up', () => {
    const { docLog, queue } = makeStore()
    const env = envelope('msg-4')
    // No device registered yet → 0 delivery targets.
    queue.enqueueFanout({ messageId: 'msg-4', toDid: BOB, envelope: env, deliveryTargetDeviceIds: [], nowMs: T0 })
    expect(queue.messageCount(BOB)).toBe(1)
    expect(queue.count(BOB)).toBe(0)

    // First device to register picks it up (and a redelivery on the same device repeats it).
    docLog.registerDevice(BOB, D1)
    expect(queue.deliverOnConnect(BOB, D1)).toEqual([env])
    expect(queue.deliverOnConnect(BOB, D1)).toEqual([env]) // retained until ack
  })

  it('device-revoke makes a pending message terminal when the revoked device was the last laggard (TC6/R5)', () => {
    const { db, docLog, queue } = makeStore()
    docLog.registerDevice(BOB, D1)
    docLog.registerDevice(BOB, D2)
    queue.enqueueFanout({ messageId: 'msg-5', toDid: BOB, envelope: envelope('msg-5'), deliveryTargetDeviceIds: [D1, D2], nowMs: T0 })

    queue.ackDevice('msg-5', D1, { nowMs: T0 })
    expect(queue.messageCount(BOB)).toBe(1) // D2 still pending → retained

    // Revoke D2 in the durable device list, then run the inbox cleanup: D2's entry
    // is dropped and, since D2 no longer counts, the message is now fully delivered.
    docLog.revokeDevice(BOB, D2, new Date(T0).toISOString())
    queue.deleteForDevice(D2, { nowMs: T0 })

    expect(docLog.activeDeviceIdsForDid(BOB)).toEqual([D1]) // D2 out of the fan-out
    expect(queue.messageCount(BOB)).toBe(0) // terminal
    expect(db.prepare("SELECT COUNT(*) AS c FROM inbox_entry WHERE device_id = ?").get(D2)).toEqual({ c: 0 })
  })

  it('GC: TTL prunes by inbox_message.created_at; a cold-start orphan is NOT GC\'d before TTL', () => {
    const { docLog, queue } = makeStore()
    queue.enqueueFanout({ messageId: 'old', toDid: BOB, envelope: envelope('old'), deliveryTargetDeviceIds: [], nowMs: T0 })

    // Just before TTL: retained (no active device → not fully-delivered, not expired).
    const beforeTtl = queue.collectGarbage(T0 + 29 * DAY, { ttlMs: 30 * DAY, inactiveMs: 90 * DAY })
    expect(beforeTtl).toEqual({ removedFullyDelivered: 0, removedExpired: 0, removedInactiveEntries: 0 })
    expect(queue.messageCount(BOB)).toBe(1)

    // After TTL: pruned by created_at.
    const afterTtl = queue.collectGarbage(T0 + 31 * DAY, { ttlMs: 30 * DAY, inactiveMs: 90 * DAY })
    expect(afterTtl.removedExpired).toBe(1)
    expect(queue.messageCount(BOB)).toBe(0)
    void docLog
  })

  it('GC: a long-inactive device does not block terminal GC (effective-active) and its entries are reaped', () => {
    const { db, docLog, queue } = makeStore()
    docLog.registerDevice(BOB, D1)
    docLog.registerDevice(BOB, D2)
    queue.enqueueFanout({ messageId: 'msg-6', toDid: BOB, envelope: envelope('msg-6'), deliveryTargetDeviceIds: [D1, D2], nowMs: T0 })

    queue.ackDevice('msg-6', D1, { nowMs: T0 })
    // D2 acked nothing and is now long-inactive (last_seen far in the past).
    setLastSeen(db, D1, T0)
    setLastSeen(db, D2, T0 - 200 * DAY)

    // At now=T0 with inactiveMs=90d, D2 is NOT effective-active → message is fully
    // delivered (D1 acked, only effective-active) → (a) removes it; D2's stale entry
    // is reaped by (c).
    const gc = queue.collectGarbage(T0, { ttlMs: 365 * DAY, inactiveMs: 90 * DAY })
    expect(gc.removedFullyDelivered).toBe(1)
    expect(queue.messageCount(BOB)).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS c FROM inbox_entry').get()).toEqual({ c: 0 })
  })

  it('migration (TC9): legacy per-DID offline_queue rows (queued + delivered) become retained inbox_message', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const docLog = new DocLog(db)

    // Seed the legacy schema + rows BEFORE constructing OfflineQueue (its
    // constructor runs the one-shot migration).
    db.exec(`
      CREATE TABLE offline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        to_did TEXT NOT NULL,
        envelope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        delivered_at TEXT
      )
    `)
    const legacyCreated = new Date(T0).toISOString()
    db.prepare('INSERT INTO offline_queue (message_id, to_did, envelope, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-queued', BOB, JSON.stringify(envelope('legacy-queued')), 'queued', legacyCreated)
    db.prepare('INSERT INTO offline_queue (message_id, to_did, envelope, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-delivered', BOB, JSON.stringify(envelope('legacy-delivered')), 'delivered', legacyCreated)

    const queue = new OfflineQueue(db)

    // Both legacy rows (queued AND delivered = still un-acked) survive as messages;
    // the old table is gone.
    expect(queue.messageCount(BOB)).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_queue'").get()).toBeUndefined()

    // A device connecting now picks up both (entries minted per device at pick-up).
    docLog.registerDevice(BOB, D1)
    const delivered = queue.deliverOnConnect(BOB, D1).map((e) => e.id).sort()
    expect(delivered).toEqual(['legacy-delivered', 'legacy-queued'])
  })
})
