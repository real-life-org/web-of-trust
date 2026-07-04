/**
 * Generic dialog lifecycle (TC1/TC9, Yjs engine): the synced
 * dismissedNotifications map is the single source of truth for "resolved".
 *
 * Covers:
 * - markNotificationResolved writes { resolvedAt } into the personal doc
 * - watchNotificationResolution: getValue() reads the CURRENT snapshot
 *   synchronously (OPEN-gate contract) + subscribe() fires reactively
 * - deterministic TTL-GC (entries older than the retention window are
 *   collected, younger ones survive; idempotent)
 * - the legacy-map migration rebuild KEEPS the map (mapsToKeep regression:
 *   a missing entry would silently drop every synced resolve marker)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { YjsStorageAdapter, DISMISSED_NOTIFICATION_TTL_MS } from '../src/YjsStorageAdapter'
import {
  initYjsPersonalDoc,
  getYjsPersonalDoc,
  changeYjsPersonalDoc,
  flushYjsPersonalDoc,
  resetYjsPersonalDoc,
} from '../src/YjsPersonalDocManager'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'

const TEST_DID = 'did:key:z6MkTestUser'

describe('Yjs notification resolution (generic dialog lifecycle)', () => {
  let adapter: YjsStorageAdapter
  let identity: PublicIdentitySession

  beforeEach(async () => {
    identity = (await createTestIdentity('notification-resolution')).identity
    await initYjsPersonalDoc(identity)
    adapter = new YjsStorageAdapter(TEST_DID)
  })

  afterEach(async () => {
    await resetYjsPersonalDoc()
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (db.name?.startsWith('wot-yjs')) indexedDB.deleteDatabase(db.name)
      }
    } catch { /* indexedDB.databases() may not be available in all envs */ }
  })

  it('markNotificationResolved writes a { resolvedAt } entry into the personal doc', async () => {
    await adapter.markNotificationResolved('att-urn:uuid:abc')

    const doc = getYjsPersonalDoc()
    expect(doc.dismissedNotifications['att-urn:uuid:abc']).toBeDefined()
    expect(Number.isNaN(Date.parse(doc.dismissedNotifications['att-urn:uuid:abc'].resolvedAt))).toBe(false)
  })

  it('watchNotificationResolution().getValue() reads the current snapshot synchronously (OPEN-gate contract)', async () => {
    const sub = adapter.watchNotificationResolution()
    expect('att-1' in sub.getValue()).toBe(false)

    // No subscription active — getValue must STILL see the write immediately,
    // otherwise the enqueue-time gate races the reactive close (flicker).
    await adapter.markNotificationResolved('att-1')
    expect('att-1' in sub.getValue()).toBe(true)
  })

  it('watchNotificationResolution() notifies subscribers on resolve and dedups unrelated changes', async () => {
    const sub = adapter.watchNotificationResolution()
    const seen: Array<Record<string, { resolvedAt: string }>> = []
    const unsub = sub.subscribe(next => { seen.push(next) })

    await adapter.markNotificationResolved('ver-urn:uuid:v1')
    expect(seen).toHaveLength(1)
    expect('ver-urn:uuid:v1' in seen[0]).toBe(true)

    // Unrelated personal-doc change → no resolution callback.
    changeYjsPersonalDoc(doc => {
      doc.contacts['did:key:bob'] = {
        did: 'did:key:bob', publicKey: 'pk', name: 'Bob', avatar: null, bio: null,
        status: 'active', verifiedAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
    })
    expect(seen).toHaveLength(1)
    unsub()
  })

  it('per-event ids: resolving one event never blocks a later event of the same peer (distinct keys)', async () => {
    await adapter.markNotificationResolved('ver-urn:uuid:first')

    const resolved = adapter.watchNotificationResolution().getValue()
    expect('ver-urn:uuid:first' in resolved).toBe(true)
    expect('ver-urn:uuid:second' in resolved).toBe(false)
  })

  it('TTL-GC collects entries older than the retention window, keeps younger ones, and is idempotent', async () => {
    const now = new Date('2026-07-04T12:00:00.000Z')
    const oldStamp = new Date(now.getTime() - DISMISSED_NOTIFICATION_TTL_MS - 60_000).toISOString()
    const youngStamp = new Date(now.getTime() - DISMISSED_NOTIFICATION_TTL_MS + 60_000).toISOString()

    changeYjsPersonalDoc(doc => {
      doc.dismissedNotifications['att-old'] = { resolvedAt: oldStamp }
      doc.dismissedNotifications['space-old'] = { resolvedAt: oldStamp }
      doc.dismissedNotifications['ver-young'] = { resolvedAt: youngStamp }
    })

    expect(await adapter.collectResolvedNotificationGarbage(now)).toBe(2)
    const after = getYjsPersonalDoc().dismissedNotifications
    expect('att-old' in after).toBe(false)
    expect('space-old' in after).toBe(false)
    expect('ver-young' in after).toBe(true)

    // Deterministic + idempotent: same now → nothing further to collect.
    expect(await adapter.collectResolvedNotificationGarbage(now)).toBe(0)
  })

  it('retention window stays ABOVE the 30d inbox replay window (TC9 invariant)', () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    expect(DISMISSED_NOTIFICATION_TTL_MS).toBeGreaterThan(THIRTY_DAYS_MS)
  })

  it('legacy-map migration rebuild KEEPS dismissedNotifications (mapsToKeep regression)', async () => {
    // Arrange: a resolved marker + a legacy outbox entry (rebuild trigger).
    await adapter.markNotificationResolved('att-survives-rebuild')
    changeYjsPersonalDoc(doc => {
      doc.outbox['legacy-1'] = { envelopeJson: '{}', createdAt: new Date().toISOString(), retryCount: 0 }
    })
    await flushYjsPersonalDoc()
    await resetYjsPersonalDoc()

    // Act: re-init loads the snapshot, sees the legacy outbox and rebuilds the
    // doc from scratch (rebuildPersonalDocWithoutLegacyMaps).
    const doc = await initYjsPersonalDoc(identity)

    // Assert: the rebuild dropped the legacy map but kept the resolve marker.
    expect(doc.outbox).toEqual({})
    expect(doc.dismissedNotifications['att-survives-rebuild']).toBeDefined()
  })
})
