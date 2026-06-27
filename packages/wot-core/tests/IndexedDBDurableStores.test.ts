import { describe, it, expect } from 'vitest'
import { openDB } from 'idb'
import { IndexedDBKeyManagementAdapter } from '../src/adapters/key-management/IndexedDBKeyManagementAdapter'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { IndexedDBMessageIdHistory } from '../src/adapters/message-id-history/IndexedDBMessageIdHistory'
import { IndexedDBMemberUpdatePendingStore } from '../src/adapters/member-update/IndexedDBMemberUpdatePendingStore'
import type { SeenMemberUpdateSignal } from '../src/protocol/sync/member-update-disposition'
import { decodeBase64Url } from '../src/protocol'

let counter = 0
function freshDbName(prefix: string): string {
  return `test-${prefix}-${Date.now()}-${++counter}`
}
const uuid = (): string => globalThis.crypto.randomUUID()

// ── Durable Wiring / D1 + K1: KeyManagement survives a reload (a Space stays decryptable) ──
describe('IndexedDBKeyManagementAdapter — D1/K1 durability', () => {
  it('content keys round-trip + SURVIVE a reload (the reload-can-decrypt property)', async () => {
    const dbName = freshDbName('km')
    const spaceId = uuid()
    const key0 = crypto.getRandomValues(new Uint8Array(32))
    const key1 = crypto.getRandomValues(new Uint8Array(32))

    const a = new IndexedDBKeyManagementAdapter(dbName)
    await a.init()
    await a.saveKey(spaceId, 0, key0)
    await a.saveKey(spaceId, 1, key1)

    // Reload: a fresh instance on the SAME db restores the group keys.
    const b = new IndexedDBKeyManagementAdapter(dbName)
    await b.init()
    expect(Array.from((await b.getCurrentKey(spaceId))!)).toEqual(Array.from(key1))
    expect(await b.getCurrentGeneration(spaceId)).toBe(1)
    expect(Array.from((await b.getKeyByGeneration(spaceId, 0))!)).toEqual(Array.from(key0))

    // CONTROL: the in-memory default loses everything on a fresh instance.
    const mem = new InMemoryKeyManagementAdapter()
    await mem.saveKey(spaceId, 0, key0)
    const memFresh = new InMemoryKeyManagementAdapter()
    expect(await memFresh.getCurrentKey(spaceId)).toBeNull()
  })

  it('a generation gap reads back as a gap (getCurrentGeneration = max saved, missing gen = null)', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName('km'))
    await km.init()
    const spaceId = uuid()
    await km.saveKey(spaceId, 0, crypto.getRandomValues(new Uint8Array(32)))
    await km.saveKey(spaceId, 2, crypto.getRandomValues(new Uint8Array(32)))
    expect(await km.getCurrentGeneration(spaceId)).toBe(2)
    expect(await km.getKeyByGeneration(spaceId, 1)).toBeNull()
    expect(await km.getCurrentGeneration(uuid())).toBe(-1) // unknown space
  })

  it('capability key pair + own-capability JWS round-trip + survive a reload', async () => {
    const dbName = freshDbName('km')
    const spaceId = uuid()
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const vk = crypto.getRandomValues(new Uint8Array(32))

    const a = new IndexedDBKeyManagementAdapter(dbName)
    await a.init()
    await a.saveCapabilityKeyPair(spaceId, 3, seed, vk)
    await a.saveOwnCapability(spaceId, 3, 'jws.header.payload.sig')

    const b = new IndexedDBKeyManagementAdapter(dbName)
    await b.init()
    expect(Array.from((await b.getCapabilitySigningSeed(spaceId, 3))!)).toEqual(Array.from(seed))
    expect(Array.from((await b.getCapabilityVerificationKey(spaceId, 3))!)).toEqual(Array.from(vk))
    expect(await b.getOwnCapability(spaceId, 3)).toBe('jws.header.payload.sig')
  })

  it('K1: raw key material is stored at-rest as base64url, never as raw bytes', async () => {
    const dbName = freshDbName('km')
    const spaceId = uuid()
    const key = crypto.getRandomValues(new Uint8Array(32))
    const km = new IndexedDBKeyManagementAdapter(dbName)
    await km.init()
    await km.saveKey(spaceId, 0, key)

    const raw = await openDB(dbName, 1)
    const record = (await raw.get('contentKeys', [spaceId, 0])) as { key: unknown }
    raw.close()
    expect(typeof record.key).toBe('string') // base64url string, not a Uint8Array/ArrayBuffer
    expect(Array.from(decodeBase64Url(record.key as string))).toEqual(Array.from(key))
  })

  it('returns defensive copies of key material — distinct buffers; a mutated read never corrupts the store', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName('km'))
    await km.init()
    const spaceId = uuid()
    await km.saveKey(spaceId, 0, crypto.getRandomValues(new Uint8Array(32)))
    const a = (await km.getCurrentKey(spaceId))!
    const b = (await km.getCurrentKey(spaceId))!
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a).not.toBe(b) // distinct buffers (parity with InMemoryKeyManagementAdapter)
    a.fill(0) // mutating one read must NOT affect the stored key / a later read
    const c = (await km.getCurrentKey(spaceId))!
    expect(c.some((byte) => byte !== 0)).toBe(true)
  })

  it('rejects malformed key material (32-byte invariant) and invalid generations', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName('km'))
    await km.init()
    const spaceId = uuid()
    await expect(km.saveKey(spaceId, 0, new Uint8Array(16))).rejects.toThrow('32 bytes')
    await expect(km.saveKey(spaceId, -1, new Uint8Array(32))).rejects.toThrow('non-negative')
    await expect(
      km.saveCapabilityKeyPair(spaceId, 0, new Uint8Array(31), new Uint8Array(32)),
    ).rejects.toThrow('signing seed must be 32 bytes')
  })
})

// ── Durable Wiring / D1: replay-protection survives a reload ──────────────────
describe('IndexedDBMessageIdHistory — D1 durability', () => {
  it('checkAndRecord is idempotent, SURVIVES a reload, and never refreshes first-seen', async () => {
    const dbName = freshDbName('mid')
    const now = '2026-06-27T10:00:00.000Z'
    const a = new IndexedDBMessageIdHistory(dbName)
    await a.init()
    expect(await a.checkAndRecord('msg-1', now)).toBe(false) // new
    expect(await a.checkAndRecord('msg-1', now)).toBe(true) // duplicate

    // Reload: a fresh instance still knows msg-1 (replay protection persists).
    const b = new IndexedDBMessageIdHistory(dbName)
    await b.init()
    expect(await b.has('msg-1', now)).toBe(true)
    expect(await b.checkAndRecord('msg-1', now)).toBe(true) // still a duplicate after reload
  })

  it('has() respects the retention window and prune() drops aged entries', async () => {
    const dbName = freshDbName('mid')
    const store = new IndexedDBMessageIdHistory(dbName, { retentionMs: 1000 })
    await store.init()
    await store.checkAndRecord('m', '2026-06-27T10:00:00.000Z') // seen at t0
    // 0.5s later: still within retention.
    expect(await store.has('m', '2026-06-27T10:00:00.500Z')).toBe(true)
    // 2s later: outside the 1s retention window → not a replay.
    expect(await store.has('m', '2026-06-27T10:00:02.000Z')).toBe(false)
    // prune at a cutoff past first-seen removes the row entirely.
    await store.prune('2026-06-27T10:00:05.000Z')
    const raw = await openDB(dbName, 1)
    expect(await raw.count('messageIds')).toBe(0)
    raw.close()
  })
})

// ── Durable Wiring / D1: pending member-update signals survive a reload ───────
describe('IndexedDBMemberUpdatePendingStore — D1 durability', () => {
  const seen = (over: Partial<SeenMemberUpdateSignal>): SeenMemberUpdateSignal => ({
    spaceId: 'space-1',
    action: 'added',
    memberDid: 'did:key:member',
    effectiveKeyGeneration: 0,
    signerDid: 'did:key:signerA',
    storedDisposition: 'store-pending-and-sync',
    ...over,
  })

  it('savePending dedups per tuple (preserves first signer), upgradePending lifts disposition, SURVIVES reload', async () => {
    const dbName = freshDbName('mu')
    const a = new IndexedDBMemberUpdatePendingStore(dbName)
    await a.init()
    await a.savePending(seen({ storedDisposition: 'store-unverified-pending-and-sync' }))
    // Same tuple, different signer → ignored (first signer provenance preserved).
    await a.savePending(seen({ signerDid: 'did:key:signerB' }))
    let list = await a.listSeenForSpace('space-1')
    expect(list).toHaveLength(1)
    expect(list[0].signerDid).toBe('did:key:signerA')
    expect(list[0].storedDisposition).toBe('store-unverified-pending-and-sync')

    // Upgrade the disposition in place.
    await a.upgradePending(seen({ storedDisposition: 'store-pending-and-sync' }))

    // Reload: the upgraded record survives.
    const b = new IndexedDBMemberUpdatePendingStore(dbName)
    await b.init()
    list = await b.listSeenForSpace('space-1')
    expect(list).toHaveLength(1)
    expect(list[0].storedDisposition).toBe('store-pending-and-sync')

    await b.resolvePending('space-1', seen({}))
    expect(await b.listSeenForSpace('space-1')).toHaveLength(0)
  })

  it('future buffer dedups on tuple+signer; resolveFuture drops EVERY signer of a tuple', async () => {
    const store = new IndexedDBMemberUpdatePendingStore(freshDbName('mu'))
    await store.init()
    await store.bufferFuture(seen({ effectiveKeyGeneration: 5, signerDid: 'did:key:s1' }))
    await store.bufferFuture(seen({ effectiveKeyGeneration: 5, signerDid: 'did:key:s1' })) // dup
    await store.bufferFuture(seen({ effectiveKeyGeneration: 5, signerDid: 'did:key:s2' }))
    expect(await store.listFutureForSpace('space-1')).toHaveLength(2) // two distinct signers

    // resolveFuture matches on the tuple only → removes BOTH signer rows.
    await store.resolveFuture('space-1', seen({ effectiveKeyGeneration: 5 }))
    expect(await store.listFutureForSpace('space-1')).toHaveLength(0)
  })

  it('returns defensive copies — mutating a returned record/list does not affect a later read', async () => {
    const store = new IndexedDBMemberUpdatePendingStore(freshDbName('mu'))
    await store.init()
    await store.savePending(seen({}))
    const list = await store.listSeenForSpace('space-1')
    ;(list as SeenMemberUpdateSignal[]).push(seen({ memberDid: 'did:key:other' })) // mutate the array
    list[0].storedDisposition = 'store-unverified-pending-and-sync' // mutate a record
    const fresh = await store.listSeenForSpace('space-1')
    expect(fresh).toHaveLength(1) // the pushed entry did not persist
    expect(fresh[0].storedDisposition).toBe('store-pending-and-sync') // the mutation did not persist
  })
})
