import { describe, expect, it } from 'vitest'
import { openDB } from 'idb'
import { IndexedDBDocLogStore } from '../src/adapters/storage/IndexedDBDocLogStore'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import type { SeqLock } from '../src/adapters/storage/SeqLock'
import type { DocLogStore, PendingRemoval } from '../src/ports/DocLogStore'

// ── VE-S0: durable PendingRemoval staging store (Slice SR Phase 2) ───────────
// Contract tests for the two-phase member-removal staging area, exercised
// against BOTH DocLogStore implementations (in-memory + IndexedDB) where the
// invariant is engine-neutral, plus IDB-only tests for the two durable
// properties that only the persistent adapter can demonstrate: crash-recovery
// across instances (Group 5) and the v2→v3 migration without data loss (Group 6).

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

/** A distinct, recognisable byte pattern per field so a swap/truncation shows up. */
function makeRemoval(overrides: Partial<PendingRemoval> = {}): PendingRemoval {
  return {
    spaceId: overrides.spaceId ?? uuid(),
    removedDid: overrides.removedDid ?? `did:key:z6Mk-${uuid()}`,
    homeBrokerSet: overrides.homeBrokerSet ?? [
      'wss://broker-a.example',
      'wss://broker-b.example',
    ],
    confirmedBrokerUrls: overrides.confirmedBrokerUrls ?? [],
    newGeneration: overrides.newGeneration ?? 4,
    stagedKeyMaterial: overrides.stagedKeyMaterial ?? {
      contentKey: new Uint8Array(32).fill(0xa1),
      capSigningSeed: new Uint8Array(32).fill(0xb2),
      capVerificationKey: new Uint8Array(32).fill(0xc3),
    },
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
  }
}

/** Assert two removals are byte-for-byte equal (incl. the Uint8Array key material). */
function expectRemovalEquals(actual: PendingRemoval | null, expected: PendingRemoval): void {
  expect(actual).not.toBeNull()
  const a = actual as PendingRemoval
  expect(a.spaceId).toBe(expected.spaceId)
  expect(a.removedDid).toBe(expected.removedDid)
  expect(a.homeBrokerSet).toEqual(expected.homeBrokerSet)
  expect(a.confirmedBrokerUrls).toEqual(expected.confirmedBrokerUrls)
  expect(a.newGeneration).toBe(expected.newGeneration)
  expect(a.createdAt).toBe(expected.createdAt)
  expect(Array.from(a.stagedKeyMaterial.contentKey)).toEqual(
    Array.from(expected.stagedKeyMaterial.contentKey),
  )
  expect(Array.from(a.stagedKeyMaterial.capSigningSeed)).toEqual(
    Array.from(expected.stagedKeyMaterial.capSigningSeed),
  )
  expect(Array.from(a.stagedKeyMaterial.capVerificationKey)).toEqual(
    Array.from(expected.stagedKeyMaterial.capVerificationKey),
  )
}

type Factory = (dbName: string, lock?: SeqLock) => DocLogStore

const implementations: Array<{ name: string; create: Factory }> = [
  { name: 'InMemoryDocLogStore', create: (_dbName, lock) => new InMemoryDocLogStore(lock) },
  { name: 'IndexedDBDocLogStore', create: (dbName, lock) => new IndexedDBDocLogStore(dbName, lock) },
]

let dbCounter = 0
function freshDbName(): string {
  return `test-pending-removal-${Date.now()}-${++dbCounter}`
}

describe.each(implementations)('PendingRemoval store contract — $name', ({ create }) => {
  // ── Group 1: put/get roundtrip (incl. base64 roundtrip on IDB) ────────────
  describe('put/get roundtrip (Group 1)', () => {
    it('put then get returns a byte-identical PendingRemoval (key material + homeBrokerSet[2])', async () => {
      const store = create(freshDbName())
      await store.init()
      const removal = makeRemoval({
        homeBrokerSet: ['wss://home-1.example', 'wss://home-2.example'],
        // Non-uniform byte patterns so a base64 round-trip bug (truncation,
        // padding, +/- vs _/- confusion) would corrupt at least one byte.
        stagedKeyMaterial: {
          contentKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff),
          capSigningSeed: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 250) & 0xff),
          capVerificationKey: Uint8Array.from({ length: 32 }, (_, i) => (255 - i * 3) & 0xff),
        },
      })

      await store.putPendingRemoval(removal)
      const got = await store.getPendingRemoval(removal.spaceId, removal.removedDid)

      // For the IDB impl this asserts the base64url encode→decode round-trips
      // every byte; homeBrokerSet[2] is preserved as a string[].
      expectRemovalEquals(got, removal)
    })

    it('get returns null for an absent removal', async () => {
      const store = create(freshDbName())
      await store.init()
      expect(await store.getPendingRemoval(uuid(), uuid())).toBeNull()
    })

    it('putPendingRemoval is idempotent on (spaceId, removedDid) — a re-stage overwrites wholesale', async () => {
      const store = create(freshDbName())
      await store.init()
      const spaceId = uuid()
      const removedDid = uuid()
      const first = makeRemoval({
        spaceId,
        removedDid,
        newGeneration: 4,
        confirmedBrokerUrls: ['wss://stale.example'],
      })
      await store.putPendingRemoval(first)

      // Re-stage the SAME removal with fresh key material + a higher generation
      // (the retry path). The old record is replaced, not merged.
      const restaged = makeRemoval({
        spaceId,
        removedDid,
        newGeneration: 5,
        confirmedBrokerUrls: [],
        stagedKeyMaterial: {
          contentKey: new Uint8Array(32).fill(0x11),
          capSigningSeed: new Uint8Array(32).fill(0x22),
          capVerificationKey: new Uint8Array(32).fill(0x33),
        },
      })
      await store.putPendingRemoval(restaged)

      const got = await store.getPendingRemoval(spaceId, removedDid)
      expectRemovalEquals(got, restaged)
      // Exactly one record for this removal — no duplicate left behind.
      expect((await store.listPendingRemovals()).length).toBe(1)
    })

    it('stored copy is decoupled from the caller (mutating the input after put does not change storage)', async () => {
      const store = create(freshDbName())
      await store.init()
      const removal = makeRemoval()
      const snapshot = makeRemoval({
        spaceId: removal.spaceId,
        removedDid: removal.removedDid,
        homeBrokerSet: [...removal.homeBrokerSet],
        confirmedBrokerUrls: [...removal.confirmedBrokerUrls],
        newGeneration: removal.newGeneration,
        stagedKeyMaterial: {
          contentKey: Uint8Array.from(removal.stagedKeyMaterial.contentKey),
          capSigningSeed: Uint8Array.from(removal.stagedKeyMaterial.capSigningSeed),
          capVerificationKey: Uint8Array.from(removal.stagedKeyMaterial.capVerificationKey),
        },
        createdAt: removal.createdAt,
      })

      await store.putPendingRemoval(removal)
      // Mutate the caller's object + its inner arrays/bytes after persisting.
      removal.homeBrokerSet.push('wss://injected.example')
      removal.confirmedBrokerUrls.push('wss://injected.example')
      removal.stagedKeyMaterial.contentKey[0] = 0x00

      const got = await store.getPendingRemoval(snapshot.spaceId, snapshot.removedDid)
      expectRemovalEquals(got, snapshot)
    })

    it('composite key is INJECTIVE — adversarial (spaceId, removedDid) pairs never collide', async () => {
      const store = create(freshDbName())
      await store.init()
      // A naive "escape + single-separator join" scheme collided [a + SEP, b]
      // with [a, SEP + b]. removedDid is DID-agnostic (may carry arbitrary
      // characters), so a crafted separator must not forge a key collision.
      const SEP = '\\u0000' // the separator the rejected scheme used (6-char token)
      const a = makeRemoval({ spaceId: 'space-a' + SEP, removedDid: 'did:web:b' })
      const b = makeRemoval({ spaceId: 'space-a', removedDid: SEP + 'did:web:b' })
      await store.putPendingRemoval(a)
      await store.putPendingRemoval(b)

      // Two DISTINCT pairs → two DISTINCT records (a non-injective key would
      // silently overwrite and leave length 1).
      expect((await store.listPendingRemovals()).length).toBe(2)
      expectRemovalEquals(await store.getPendingRemoval(a.spaceId, a.removedDid), a)
      expectRemovalEquals(await store.getPendingRemoval(b.spaceId, b.removedDid), b)
    })
  })

  // ── Group 2: markBrokerConfirmed monotone + idempotent ────────────────────
  describe('markBrokerConfirmed (Group 2)', () => {
    it('adds confirmations monotonically and idempotently; same URL twice yields one entry', async () => {
      const store = create(freshDbName())
      await store.init()
      const removal = makeRemoval({
        homeBrokerSet: ['wss://b1.example', 'wss://b2.example'],
        confirmedBrokerUrls: [],
      })
      await store.putPendingRemoval(removal)

      await store.markBrokerConfirmed(removal.spaceId, removal.removedDid, 'wss://b1.example')
      await store.markBrokerConfirmed(removal.spaceId, removal.removedDid, 'wss://b1.example')
      await store.markBrokerConfirmed(removal.spaceId, removal.removedDid, 'wss://b2.example')

      const got = await store.getPendingRemoval(removal.spaceId, removal.removedDid)
      // Idempotent: b1 only once. Monotonic: both present, in arrival order.
      expect(got?.confirmedBrokerUrls).toEqual(['wss://b1.example', 'wss://b2.example'])
      // Nothing else on the record changed.
      expect(got?.homeBrokerSet).toEqual(removal.homeBrokerSet)
      expect(got?.newGeneration).toBe(removal.newGeneration)
    })

    it('is a no-op (no throw) when there is no staging record for (spaceId, removedDid)', async () => {
      const store = create(freshDbName())
      await store.init()
      await expect(
        store.markBrokerConfirmed(uuid(), uuid(), 'wss://nobody.example'),
      ).resolves.toBeUndefined()
      // And it did not conjure a record into existence.
      expect(await store.listPendingRemovals()).toEqual([])
    })

    it('ignores a confirm for a broker outside the (fixed) homeBrokerSet (subset invariant)', async () => {
      const store = create(freshDbName())
      await store.init()
      const removal = makeRemoval({
        homeBrokerSet: ['wss://home.example'],
        confirmedBrokerUrls: [],
      })
      await store.putPendingRemoval(removal)

      // A confirm for a broker NOT in the fixed home-broker set must be ignored —
      // otherwise a stray confirm could spoof enforcement completion.
      await store.markBrokerConfirmed(removal.spaceId, removal.removedDid, 'wss://stray.example')
      expect(
        (await store.getPendingRemoval(removal.spaceId, removal.removedDid))?.confirmedBrokerUrls,
      ).toEqual([])

      // A confirm for a home broker is recorded.
      await store.markBrokerConfirmed(removal.spaceId, removal.removedDid, 'wss://home.example')
      expect(
        (await store.getPendingRemoval(removal.spaceId, removal.removedDid))?.confirmedBrokerUrls,
      ).toEqual(['wss://home.example'])
    })
  })

  // ── Group 3: deletePendingRemoval is selective ────────────────────────────
  describe('deletePendingRemoval (Group 3)', () => {
    it('deletes only the targeted removal; other removals, the log, and meta/deviceId survive', async () => {
      const store = create(freshDbName())
      await store.init()

      // A log entry + a deviceId so we can prove they are untouched by the
      // selective removal delete.
      const logDevice = uuid()
      const logDoc = uuid()
      await store.appendLocalEntry({
        deviceId: logDevice,
        docId: logDoc,
        build: async (seq) => `jws-for-seq-${seq}`,
      })
      const deviceId = await store.getOrCreateDeviceId()

      const keep = makeRemoval()
      const drop = makeRemoval()
      await store.putPendingRemoval(keep)
      await store.putPendingRemoval(drop)

      await store.deletePendingRemoval(drop.spaceId, drop.removedDid)

      // Only `drop` is gone.
      expect(await store.getPendingRemoval(drop.spaceId, drop.removedDid)).toBeNull()
      expectRemovalEquals(await store.getPendingRemoval(keep.spaceId, keep.removedDid), keep)
      expect((await store.listPendingRemovals()).length).toBe(1)

      // The log entry + heads survive.
      const logEntry = await store.getEntry(logDoc, logDevice, 0)
      expect(logEntry?.entryJws).toBe('jws-for-seq-0')
      expect((await store.getKnownHeads(logDoc))[logDevice]).toBe(0)
      // The deviceId binding survives (same value returned).
      expect(await store.getOrCreateDeviceId()).toBe(deviceId)
    })

    it('deleting an absent removal is a no-op (no throw)', async () => {
      const store = create(freshDbName())
      await store.init()
      await expect(store.deletePendingRemoval(uuid(), uuid())).resolves.toBeUndefined()
    })
  })

  // ── Group 4: listPendingRemovals returns all open removals ────────────────
  describe('listPendingRemovals (Group 4)', () => {
    it('returns every open removal; empty store yields []', async () => {
      const store = create(freshDbName())
      await store.init()
      expect(await store.listPendingRemovals()).toEqual([])

      const r1 = makeRemoval()
      const r2 = makeRemoval()
      const r3 = makeRemoval()
      await store.putPendingRemoval(r1)
      await store.putPendingRemoval(r2)
      await store.putPendingRemoval(r3)

      const all = await store.listPendingRemovals()
      expect(all.length).toBe(3)
      // Order-independent: index by composite identity and compare byte-for-byte.
      const byKey = new Map(all.map((r) => [JSON.stringify([r.spaceId, r.removedDid]), r]))
      for (const expected of [r1, r2, r3]) {
        expectRemovalEquals(byKey.get(JSON.stringify([expected.spaceId, expected.removedDid])) ?? null, expected)
      }
    })
  })

  // ── Group 7: clear() empties pendingRemovals (and the rest) ────────────────
  describe('clear (Group 7)', () => {
    it('clear() removes staged removals along with the log and the deviceId binding', async () => {
      const store = create(freshDbName())
      await store.init()

      await store.appendLocalEntry({
        deviceId: uuid(),
        docId: uuid(),
        build: async (seq) => `jws-${seq}`,
      })
      const before = await store.getOrCreateDeviceId()
      await store.putPendingRemoval(makeRemoval())
      await store.putPendingRemoval(makeRemoval())
      expect((await store.listPendingRemovals()).length).toBe(2)

      await store.clear()

      // pendingRemovals emptied …
      expect(await store.listPendingRemovals()).toEqual([])
      // … and the existing wipe behaviour still holds: no pending log entries …
      expect(await store.getPending()).toEqual([])
      // … and a FRESH deviceId is minted (BLOCKER-1b), not the old one.
      expect(await store.getOrCreateDeviceId()).not.toBe(before)
    })
  })
})

// ── Group 5 (durable only): crash-recovery across instances ──────────────────
describe('IndexedDBDocLogStore — PendingRemoval crash-recovery (Group 5)', () => {
  it('a staged removal + confirmation survives a "crash"; a fresh instance on the SAME db recovers it byte-identically', async () => {
    const dbName = freshDbName()
    const removal = makeRemoval({
      confirmedBrokerUrls: [],
      stagedKeyMaterial: {
        contentKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 9 + 3) & 0xff),
        capSigningSeed: Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 200) & 0xff),
        capVerificationKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 17) & 0xff),
      },
    })

    // Instance A stages the removal and records ONE broker confirmation, then
    // "crashes" (we drop the ref; fake-IndexedDB keeps the data durable).
    const storeA = new IndexedDBDocLogStore(dbName)
    await storeA.init()
    await storeA.putPendingRemoval(removal)
    await storeA.markBrokerConfirmed(removal.spaceId, removal.removedDid, removal.homeBrokerSet[0])

    // Instance B opens the SAME database — the crash-recovery view at startup.
    const storeB = new IndexedDBDocLogStore(dbName)
    await storeB.init()

    // getPendingRemoval recovers the record incl. confirmedBrokerUrls=[broker1]
    // and byte-identical staged key material (proves durable, not in-memory).
    const recovered = await storeB.getPendingRemoval(removal.spaceId, removal.removedDid)
    expectRemovalEquals(recovered, { ...removal, confirmedBrokerUrls: [removal.homeBrokerSet[0]] })

    // listPendingRemovals (the actual startup recovery entrypoint) sees it too.
    const listed = await storeB.listPendingRemovals()
    expect(listed.length).toBe(1)
    expectRemovalEquals(listed[0], { ...removal, confirmedBrokerUrls: [removal.homeBrokerSet[0]] })
  })
})

// ── Group 6 (durable only): v2→v3 migration without data loss ─────────────────
describe('IndexedDBDocLogStore — v2→v3 migration (Group 6)', () => {
  it('a v2 db with existing entries + meta(deviceId) migrates to v3 with no data loss and gains pendingRemovals', async () => {
    const dbName = freshDbName()
    const docId = uuid()
    const deviceId = uuid()
    const KNOWN_DEVICE = 'pre-existing-device-id'

    // ── Build a realistic v2 database directly (the pre-migration schema):
    // `entries` (composite keyPath + byStatus index) + `meta` (key-value). ──
    const v2 = await openDB(dbName, 2, {
      upgrade(db) {
        const entries = db.createObjectStore('entries', {
          keyPath: ['docId', 'deviceId', 'seq'],
        })
        entries.createIndex('byStatus', 'status')
        db.createObjectStore('meta')
      },
    })
    // A durable log entry …
    await v2.put('entries', {
      docId,
      deviceId,
      seq: 0,
      entryJws: 'pre-migration-jws',
      status: 'pending',
      createdAt: 1_700_000_000_000,
    })
    // … and a bound deviceId in meta.
    await v2.put('meta', KNOWN_DEVICE, 'deviceId')
    expect([...v2.objectStoreNames].sort()).toEqual(['entries', 'meta'])
    v2.close()

    // ── Open through the adapter, which triggers the v2→v3 upgrade. ──
    const store = new IndexedDBDocLogStore(dbName)
    await store.init()

    // (a) The new pendingRemovals store exists and is usable.
    const removal = makeRemoval()
    await store.putPendingRemoval(removal)
    expectRemovalEquals(await store.getPendingRemoval(removal.spaceId, removal.removedDid), removal)

    // (b) Pre-existing log entries survived the migration untouched.
    const survivedEntry = await store.getEntry(docId, deviceId, 0)
    expect(survivedEntry?.entryJws).toBe('pre-migration-jws')
    expect(survivedEntry?.status).toBe('pending')
    expect((await store.getPending()).map((e) => e.entryJws)).toEqual(['pre-migration-jws'])

    // (c) The pre-existing deviceId binding survived (NOT re-minted).
    expect(await store.getOrCreateDeviceId()).toBe(KNOWN_DEVICE)

    // (d) The db is now at v3 with all three stores present.
    const inspect = await openDB(dbName)
    expect([...inspect.objectStoreNames].sort()).toEqual(['entries', 'meta', 'pendingRemovals'])
    expect(inspect.version).toBe(3)
    inspect.close()
  })
})
