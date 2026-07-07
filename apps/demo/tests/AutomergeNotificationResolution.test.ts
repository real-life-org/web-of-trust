/**
 * Generic dialog lifecycle (TC1/TC9, Automerge engine — demo adapter surface):
 * markNotificationResolved / watchNotificationResolution /
 * collectResolvedNotificationGarbage on AutomergeStorageAdapter.
 *
 * The @web_of_trust/adapter-automerge module is replaced by an in-memory
 * personal-doc double (same change/get/onChange contract) — the engine-level
 * schema + migration behavior is covered in the adapter-automerge package
 * tests (PersonalDocSchemaMigration).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PersonalDoc } from '../src/personalDocManager'

let doc: Pick<PersonalDoc, 'dismissedNotifications'> & Record<string, unknown>
const listeners = new Set<() => void>()

vi.mock('@web_of_trust/adapter-automerge', () => ({
  getPersonalDoc: () => doc,
  changePersonalDoc: (fn: (d: typeof doc) => void) => {
    const next = structuredClone(doc)
    fn(next)
    doc = next
    for (const cb of listeners) cb()
    return doc
  },
  onPersonalDocChange: (cb: () => void) => {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  },
}))

const { AutomergeStorageAdapter, DISMISSED_NOTIFICATION_TTL_MS } = await import('../src/adapters/AutomergeStorageAdapter')

describe('Automerge notification resolution (demo adapter surface)', () => {
  let adapter: InstanceType<typeof AutomergeStorageAdapter>

  beforeEach(() => {
    doc = { contacts: {}, attestations: {}, attestationMetadata: {}, dismissedNotifications: {} }
    listeners.clear()
    adapter = new AutomergeStorageAdapter('did:key:z6MkTestUser')
  })

  it('markNotificationResolved writes a { resolvedAt } entry', async () => {
    await adapter.markNotificationResolved('att-urn:uuid:abc')
    expect(doc.dismissedNotifications['att-urn:uuid:abc']).toBeDefined()
    expect(Number.isNaN(Date.parse(doc.dismissedNotifications['att-urn:uuid:abc'].resolvedAt))).toBe(false)
  })

  it('markNotificationResolved initializes the map on a not-yet-sanitized legacy doc', async () => {
    delete (doc as Record<string, unknown>).dismissedNotifications
    await adapter.markNotificationResolved('ver-urn:uuid:v1')
    expect(doc.dismissedNotifications['ver-urn:uuid:v1']).toBeDefined()
  })

  it('watchNotificationResolution().getValue() reads the current snapshot synchronously (OPEN-gate contract)', async () => {
    const sub = adapter.watchNotificationResolution()
    expect('att-1' in sub.getValue()).toBe(false)
    await adapter.markNotificationResolved('att-1')
    expect('att-1' in sub.getValue()).toBe(true)
  })

  it('watchNotificationResolution() notifies subscribers on resolve and dedups unrelated changes', async () => {
    const sub = adapter.watchNotificationResolution()
    const seen: unknown[] = []
    const unsub = sub.subscribe(next => { seen.push(next) })

    await adapter.markNotificationResolved('space-urn:uuid:invite-1')
    expect(seen).toHaveLength(1)

    // Unrelated doc change → no resolution callback.
    await adapter.setAttestationAccepted('urn:uuid:a1', true)
    expect(seen).toHaveLength(1)
    unsub()
  })

  it('TTL-GC collects entries older than the retention window, keeps younger ones, and is idempotent', async () => {
    const now = new Date('2026-07-04T12:00:00.000Z')
    doc.dismissedNotifications = {
      'att-old': { resolvedAt: new Date(now.getTime() - DISMISSED_NOTIFICATION_TTL_MS - 60_000).toISOString() },
      'ver-young': { resolvedAt: new Date(now.getTime() - DISMISSED_NOTIFICATION_TTL_MS + 60_000).toISOString() },
    }

    expect(await adapter.collectResolvedNotificationGarbage(now)).toBe(1)
    expect('att-old' in doc.dismissedNotifications).toBe(false)
    expect('ver-young' in doc.dismissedNotifications).toBe(true)
    expect(await adapter.collectResolvedNotificationGarbage(now)).toBe(0)
  })

  it('retention window stays ABOVE the 30d inbox replay window (TC9 invariant)', () => {
    expect(DISMISSED_NOTIFICATION_TTL_MS).toBeGreaterThan(30 * 24 * 60 * 60 * 1000)
  })
})
