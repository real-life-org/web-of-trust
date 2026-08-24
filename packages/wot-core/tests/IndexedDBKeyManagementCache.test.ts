import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IndexedDBKeyManagementAdapter } from '../src/adapters/key-management/IndexedDBKeyManagementAdapter'

/**
 * Cold-Start PR1 (#353) — in-memory key-MATERIAL cache of the durable key store.
 *
 * The issue's measurement (one restore of ~2.400 entries): 6.569 openCursor:contentKeys,
 * 3.968 get:contentKeys, 3.036 get:capKeyPairs. This suite instruments the SAME IDB
 * primitives (per object-store `get` / `openCursor` counts on the fake-indexeddb
 * prototypes) and proves:
 *  - repeated reads of one (spaceId, generation) cost ONE IDB access (O(1), not O(N));
 *  - the cache is invalidated on EVERY write + lifecycle path: key rotation (new
 *    generation), saveKey overwrite, saveCapabilityKeyPair, deleteSpaceKeys, clear,
 *    close, and the identity-switch / logout wipe (close + deleteDatabase);
 *  - the cache holds bytes only and hands out defensive copies.
 */

let counter = 0
const freshDbName = (): string => `test-kmcache-${Date.now()}-${++counter}`
const uuid = (): string => globalThis.crypto.randomUUID()
const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))
const bytes = (k: Uint8Array | null): number[] => Array.from(k ?? [])

/** Per-object-store IDB access counters — the same shape as the #353 measurement probe. */
interface IdbProbe {
  get: Record<string, number>
  openCursor: Record<string, number>
  reset(): void
}

function instrumentIdb(): IdbProbe {
  const probe: IdbProbe = {
    get: {},
    openCursor: {},
    reset() {
      probe.get = {}
      probe.openCursor = {}
    },
  }
  const proto = globalThis.IDBObjectStore.prototype
  const originalGet = proto.get
  const originalOpenCursor = proto.openCursor
  vi.spyOn(proto, 'get').mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    probe.get[this.name] = (probe.get[this.name] ?? 0) + 1
    return (originalGet as (...a: unknown[]) => IDBRequest).apply(this, args)
  })
  vi.spyOn(proto, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    probe.openCursor[this.name] = (probe.openCursor[this.name] ?? 0) + 1
    return (originalOpenCursor as (...a: unknown[]) => IDBRequest).apply(this, args)
  })
  return probe
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error(`deleteDatabase(${name}) blocked`))
  })
}

let probe: IdbProbe

beforeEach(() => {
  probe = instrumentIdb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IndexedDBKeyManagementAdapter — #353 PR1 key-material cache: O(1) reads', () => {
  it('N reads of the same (spaceId, generation) content key cost exactly ONE get:contentKeys', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    const key = randomKey()
    await km.saveKey(spaceId, 0, key)
    probe.reset()

    const N = 200
    for (let i = 0; i < N; i++) {
      expect(bytes(await km.getKeyByGeneration(spaceId, 0))).toEqual(bytes(key))
    }
    expect(probe.get.contentKeys ?? 0).toBe(1)
    expect(probe.openCursor.contentKeys ?? 0).toBe(0)
  })

  it('N reads of the same capability key pair cost exactly ONE get:capKeyPairs', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    const seed = randomKey()
    const vk = randomKey()
    await km.saveCapabilityKeyPair(spaceId, 2, seed, vk)
    probe.reset()

    for (let i = 0; i < 100; i++) {
      expect(bytes(await km.getCapabilitySigningSeed(spaceId, 2))).toEqual(bytes(seed))
      expect(bytes(await km.getCapabilityVerificationKey(spaceId, 2))).toEqual(bytes(vk))
    }
    expect(probe.get.capKeyPairs ?? 0).toBe(1)
  })

  it('getCurrentKey/getCurrentGeneration are NEVER cached (each read hits the store), but seed the exact-gen slot', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    const key1 = randomKey()
    await km.saveKey(spaceId, 0, randomKey())
    await km.saveKey(spaceId, 1, key1)
    probe.reset()

    for (let i = 0; i < 10; i++) {
      expect(await km.getCurrentGeneration(spaceId)).toBe(1)
      expect(bytes(await km.getCurrentKey(spaceId))).toEqual(bytes(key1))
    }
    // "Current" changes on a space-rotate — possibly from another tab — so every
    // read pays its own cursor. 10 iterations × 2 calls = 20.
    expect(probe.openCursor.contentKeys ?? 0).toBe(20)
    // The current read still answers the exact lookup of that generation for free.
    expect(bytes(await km.getKeyByGeneration(spaceId, 1))).toEqual(bytes(key1))
    expect(probe.get.contentKeys ?? 0).toBe(0)
  })

  it('a space-rotate through ANOTHER connection is observed by the next getCurrentKey (no stale "current")', async () => {
    const dbName = freshDbName()
    const a = new IndexedDBKeyManagementAdapter(dbName)
    await a.init()
    const spaceId = uuid()
    const key0 = randomKey()
    await a.saveKey(spaceId, 0, key0)
    expect(await a.getCurrentGeneration(spaceId)).toBe(0)

    // Another tab on the SAME DB rotates the space (e.g. member removal).
    const b = new IndexedDBKeyManagementAdapter(dbName)
    await b.init()
    const key1 = randomKey()
    await b.saveKey(spaceId, 1, key1)

    // `a` must see the new generation immediately — the encryption path derives
    // its groupKey from getCurrentKey, and encrypting under the pre-removal
    // generation would leak to the removed member.
    expect(await a.getCurrentGeneration(spaceId)).toBe(1)
    expect(bytes(await a.getCurrentKey(spaceId))).toEqual(bytes(key1))
  })

  it('a MISS (unknown generation) is never cached: the key becomes visible once written through ANOTHER connection', async () => {
    const dbName = freshDbName()
    const a = new IndexedDBKeyManagementAdapter(dbName)
    await a.init()
    const spaceId = uuid()
    expect(await a.getKeyByGeneration(spaceId, 3)).toBeNull()

    // A different connection on the SAME DB (another tab / fresh adapter) imports gen 3.
    const b = new IndexedDBKeyManagementAdapter(dbName)
    await b.init()
    const key3 = randomKey()
    await b.saveKey(spaceId, 3, key3)

    // `a` did NOT see that write, but a null was never cached → next read hits IDB.
    expect(bytes(await a.getKeyByGeneration(spaceId, 3))).toEqual(bytes(key3))
  })

  it('cached hits are defensive copies: mutating a returned key never corrupts the cached material', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    const key = randomKey()
    await km.saveKey(spaceId, 0, key)
    const first = (await km.getKeyByGeneration(spaceId, 0))! // populates the cache
    const second = (await km.getKeyByGeneration(spaceId, 0))! // cached hit
    expect(first).not.toBe(second)
    second.fill(0)
    expect(bytes(await km.getKeyByGeneration(spaceId, 0))).toEqual(bytes(key))
    // Same for the current-record path + capability material.
    const cur = (await km.getCurrentKey(spaceId))!
    cur.fill(0)
    expect(bytes(await km.getCurrentKey(spaceId))).toEqual(bytes(key))
    const seed = randomKey()
    await km.saveCapabilityKeyPair(spaceId, 0, seed, randomKey())
    await km.getCapabilitySigningSeed(spaceId, 0)
    ;(await km.getCapabilitySigningSeed(spaceId, 0))!.fill(0)
    expect(bytes(await km.getCapabilitySigningSeed(spaceId, 0))).toEqual(bytes(seed))
  })
})

describe('IndexedDBKeyManagementAdapter — #353 PR1 cache invalidation (one test per path)', () => {
  it('key rotation (saveKey under a NEW generation) invalidates the current-generation record', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    const key0 = randomKey()
    await km.saveKey(spaceId, 0, key0)
    expect(await km.getCurrentGeneration(spaceId)).toBe(0) // cached
    expect(bytes(await km.getCurrentKey(spaceId))).toEqual(bytes(key0))

    const key1 = randomKey()
    await km.saveKey(spaceId, 1, key1) // space-rotate → new generation
    expect(await km.getCurrentGeneration(spaceId)).toBe(1)
    expect(bytes(await km.getCurrentKey(spaceId))).toEqual(bytes(key1))
    expect(bytes(await km.getKeyByGeneration(spaceId, 1))).toEqual(bytes(key1))
    // The historical generation stays readable (never evicted by a rotation).
    expect(bytes(await km.getKeyByGeneration(spaceId, 0))).toEqual(bytes(key0))
  })

  it('saveKey OVERWRITE of a cached (spaceId, generation) invalidates that slot', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    await km.saveKey(spaceId, 0, randomKey())
    await km.getKeyByGeneration(spaceId, 0) // cached
    await km.getCurrentKey(spaceId) // cached current record

    const replacement = randomKey()
    await km.saveKey(spaceId, 0, replacement)
    expect(bytes(await km.getKeyByGeneration(spaceId, 0))).toEqual(bytes(replacement))
    expect(bytes(await km.getCurrentKey(spaceId))).toEqual(bytes(replacement))
  })

  it('saveCapabilityKeyPair invalidates the cached capability key pair', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const spaceId = uuid()
    await km.saveCapabilityKeyPair(spaceId, 0, randomKey(), randomKey())
    await km.getCapabilitySigningSeed(spaceId, 0) // cached

    const seed = randomKey()
    const vk = randomKey()
    await km.saveCapabilityKeyPair(spaceId, 0, seed, vk)
    expect(bytes(await km.getCapabilitySigningSeed(spaceId, 0))).toEqual(bytes(seed))
    expect(bytes(await km.getCapabilityVerificationKey(spaceId, 0))).toEqual(bytes(vk))
  })

  it('deleteSpaceKeys invalidates every cached slot of THAT space only', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const gone = uuid()
    const kept = uuid()
    const keptKey = randomKey()
    await km.saveKey(gone, 0, randomKey())
    await km.saveKey(gone, 1, randomKey())
    await km.saveCapabilityKeyPair(gone, 1, randomKey(), randomKey())
    await km.saveKey(kept, 0, keptKey)
    // Populate every cache for both spaces.
    await km.getKeyByGeneration(gone, 0)
    await km.getKeyByGeneration(gone, 1)
    await km.getCurrentKey(gone)
    await km.getCapabilitySigningSeed(gone, 1)
    await km.getKeyByGeneration(kept, 0)
    await km.getCurrentKey(kept)

    await km.deleteSpaceKeys(gone)
    expect(await km.getKeyByGeneration(gone, 0)).toBeNull()
    expect(await km.getKeyByGeneration(gone, 1)).toBeNull()
    expect(await km.getCurrentKey(gone)).toBeNull()
    expect(await km.getCurrentGeneration(gone)).toBe(-1)
    expect(await km.getCapabilitySigningSeed(gone, 1)).toBeNull()
    // The other space is untouched — and still served from cache (no extra IDB get).
    probe.reset()
    expect(bytes(await km.getKeyByGeneration(kept, 0))).toEqual(bytes(keptKey))
    expect(probe.get.contentKeys ?? 0).toBe(0)
  })

  it('clear() invalidates ALL cached material', async () => {
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    const s1 = uuid()
    const s2 = uuid()
    await km.saveKey(s1, 0, randomKey())
    await km.saveKey(s2, 0, randomKey())
    await km.saveCapabilityKeyPair(s1, 0, randomKey(), randomKey())
    await km.getKeyByGeneration(s1, 0)
    await km.getKeyByGeneration(s2, 0)
    await km.getCurrentKey(s1)
    await km.getCapabilitySigningSeed(s1, 0)

    await km.clear()
    expect(await km.getKeyByGeneration(s1, 0)).toBeNull()
    expect(await km.getKeyByGeneration(s2, 0)).toBeNull()
    expect(await km.getCurrentKey(s1)).toBeNull()
    expect(await km.getCurrentGeneration(s1)).toBe(-1)
    expect(await km.getCapabilitySigningSeed(s1, 0)).toBeNull()
  })

  it('close() invalidates the cache: a re-opened adapter reads what was written through another connection meanwhile', async () => {
    const dbName = freshDbName()
    const a = new IndexedDBKeyManagementAdapter(dbName)
    await a.init()
    const spaceId = uuid()
    await a.saveKey(spaceId, 0, randomKey())
    await a.saveCapabilityKeyPair(spaceId, 0, randomKey(), randomKey())
    await a.getKeyByGeneration(spaceId, 0) // cached
    await a.getCurrentKey(spaceId) // cached
    await a.getCapabilitySigningSeed(spaceId, 0) // cached

    await a.close()

    // While `a` is closed, another connection OVERWRITES the same slots.
    const b = new IndexedDBKeyManagementAdapter(dbName)
    await b.init()
    const key = randomKey()
    const seed = randomKey()
    await b.saveKey(spaceId, 0, key)
    await b.saveCapabilityKeyPair(spaceId, 0, seed, randomKey())
    await b.close()

    // `a` lazily re-opens; a stale cache would still serve the OLD bytes.
    expect(bytes(await a.getKeyByGeneration(spaceId, 0))).toEqual(bytes(key))
    expect(bytes(await a.getCurrentKey(spaceId))).toEqual(bytes(key))
    expect(bytes(await a.getCapabilitySigningSeed(spaceId, 0))).toEqual(bytes(seed))
    await a.close()
  })

  it('identity switch / logout wipe (close + deleteDatabase): NO key survives in the cache', async () => {
    const dbName = freshDbName()
    const km = new IndexedDBKeyManagementAdapter(dbName)
    await km.init()
    const spaceId = uuid()
    await km.saveKey(spaceId, 0, randomKey())
    await km.saveCapabilityKeyPair(spaceId, 0, randomKey(), randomKey())
    await km.getKeyByGeneration(spaceId, 0)
    await km.getCurrentKey(spaceId)
    await km.getCapabilitySigningSeed(spaceId, 0)

    // The established wipe: close the connection, then drop the DID-aware DB.
    await km.close()
    await deleteDatabase(dbName)

    // A subsequent read on the same instance must NOT resurrect the old identity's keys.
    expect(await km.getKeyByGeneration(spaceId, 0)).toBeNull()
    expect(await km.getCurrentKey(spaceId)).toBeNull()
    expect(await km.getCurrentGeneration(spaceId)).toBe(-1)
    expect(await km.getCapabilitySigningSeed(spaceId, 0)).toBeNull()
    await km.close()
  })
})
