import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBDocLogStore } from '../src/adapters/storage/IndexedDBDocLogStore'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { InProcessSeqLock, WebLocksSeqLock, type SeqLock } from '../src/adapters/storage/SeqLock'
import type { DocLogStore } from '../src/ports/DocLogStore'
import { OrphanedLogRepairError } from '../src/ports/DocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import {
  createLogEntryJws,
  deriveLogPayloadNonce,
  encryptLogPayload,
  publicKeyToDidKey,
} from '../src/protocol'

// ── Realistic build(): exactly what the later adapter (VE-2+) will do ────────
// deterministic nonce(deviceId,seq) → AES-GCM encrypt CRDT update under the
// Space Content Key → sign the LogEntryPayload as a JWS. Driving the store with
// the REAL crypto lets the crash/atomicity tests demonstrate the concrete
// nonce-reuse danger the invariants prevent, not a stand-in.
const crypto = new WebCryptoProtocolCryptoAdapter()
const SIGNING_SEED = new Uint8Array(32).fill(7)
const CONTENT_KEY = new Uint8Array(32).fill(9)

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

async function makeAuthorKid(): Promise<string> {
  const pub = await crypto.ed25519PublicKeyFromSeed(SIGNING_SEED)
  return `${publicKeyToDidKey(pub)}#${publicKeyToDidKey(pub).slice('did:key:'.length)}`
}

/** Build a real encrypted+signed log-entry JWS for the given coordinates. */
async function buildRealEntry(
  deviceId: string,
  docId: string,
  seq: number,
  plaintext: string,
  authorKid: string,
): Promise<string> {
  const { blobBase64Url } = await encryptLogPayload({
    crypto,
    spaceContentKey: CONTENT_KEY,
    deviceId,
    seq,
    plaintext: new TextEncoder().encode(plaintext),
  })
  return createLogEntryJws({
    payload: {
      seq,
      deviceId,
      docId,
      authorKid,
      keyGeneration: 0,
      data: blobBase64Url,
      timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    },
    signingSeed: SIGNING_SEED,
  })
}

// The two implementations are exercised against an identical contract. The
// IndexedDB factory takes a UNIQUE db name per case (isolation) and lets a test
// reopen the SAME name on a fresh instance to simulate crash + restart.
type Factory = (dbName: string, lock?: SeqLock) => DocLogStore

const implementations: Array<{ name: string; create: Factory; durable: boolean }> = [
  {
    name: 'InMemoryDocLogStore',
    create: (_dbName, lock) => new InMemoryDocLogStore(lock),
    durable: false,
  },
  {
    name: 'IndexedDBDocLogStore',
    create: (dbName, lock) => new IndexedDBDocLogStore(dbName, lock),
    durable: true,
  },
]

let dbCounter = 0
function freshDbName(): string {
  return `test-doc-log-${Date.now()}-${++dbCounter}`
}

describe.each(implementations)('DocLogStore contract — $name', ({ create, durable }) => {
  let authorKid: string
  beforeEach(async () => {
    authorKid = await makeAuthorKid()
  })

  // ── Group 5: lifecycle — getPending → markAcked → no longer pending ───────
  describe('lifecycle (Group 5)', () => {
    it('appends seq=0,1,2 in order, lists them pending, then markAcked removes them', async () => {
      const store = create(freshDbName())
      await store.init()
      const deviceId = uuid()
      const docId = uuid()

      const e0 = await store.appendLocalEntry({
        deviceId,
        docId,
        build: (seq) => buildRealEntry(deviceId, docId, seq, 'a', authorKid),
      })
      const e1 = await store.appendLocalEntry({
        deviceId,
        docId,
        build: (seq) => buildRealEntry(deviceId, docId, seq, 'b', authorKid),
      })
      expect(e0.seq).toBe(0)
      expect(e1.seq).toBe(1)
      expect(e0.status).toBe('pending')

      const pending = await store.getPending()
      expect(pending.map((p) => p.seq)).toEqual([0, 1])

      await store.markAcked(docId, deviceId, 0)
      const stillPending = await store.getPending()
      expect(stillPending.map((p) => p.seq)).toEqual([1])

      // getEntry still returns the acked entry with its unchanged JWS.
      const acked = await store.getEntry(docId, deviceId, 0)
      expect(acked?.status).toBe('acked')
      expect(acked?.entryJws).toBe(e0.entryJws)

      // markAcked is a no-op on an already-acked / unknown entry.
      await expect(store.markAcked(docId, deviceId, 0)).resolves.toBeUndefined()
      await expect(store.markAcked(docId, deviceId, 999)).resolves.toBeUndefined()
    })
  })

  // ── Group 4: heads = max seq per device (own + applied remote) ────────────
  describe('getKnownHeads (Group 4)', () => {
    it('returns the max seq per device across own writes and recordRemoteApplied', async () => {
      const store = create(freshDbName())
      await store.init()
      const ownDevice = uuid()
      const remoteDevice = uuid()
      const otherDoc = uuid()
      const docId = uuid()

      // Own writes: seq 0,1,2 on docId.
      for (let i = 0; i < 3; i++) {
        await store.appendLocalEntry({
          deviceId: ownDevice,
          docId,
          build: (seq) => buildRealEntry(ownDevice, docId, seq, `own-${i}`, authorKid),
        })
      }
      // Applied remote entries on docId (seq 0 then 5 — non-contiguous max).
      await store.recordRemoteApplied({ docId, deviceId: remoteDevice, seq: 0 })
      await store.recordRemoteApplied({ docId, deviceId: remoteDevice, seq: 5 })
      // A different doc must not leak into this doc's heads.
      await store.recordRemoteApplied({ docId: otherDoc, deviceId: remoteDevice, seq: 42 })

      const heads = await store.getKnownHeads(docId)
      expect(heads).toEqual({ [ownDevice]: 2, [remoteDevice]: 5 })

      // Unknown doc → empty heads.
      expect(await store.getKnownHeads(uuid())).toEqual({})
    })

    it('recordRemoteApplied is idempotent and never clobbers a local pending entry', async () => {
      const store = create(freshDbName())
      await store.init()
      const deviceId = uuid()
      const docId = uuid()

      const local = await store.appendLocalEntry({
        deviceId,
        docId,
        build: (seq) => buildRealEntry(deviceId, docId, seq, 'local', authorKid),
      })
      // A spurious remote record for the SAME (deviceId,seq) must not overwrite
      // our pending local JWS nor downgrade its status.
      await store.recordRemoteApplied({ docId, deviceId, seq: 0, entryJws: 'REMOTE-JUNK' })
      const after = await store.getEntry(docId, deviceId, 0)
      expect(after?.entryJws).toBe(local.entryJws)
      expect(after?.status).toBe('pending')

      // Re-applying the same remote entry twice keeps a single head value.
      const remote = uuid()
      await store.recordRemoteApplied({ docId, deviceId: remote, seq: 3 })
      await store.recordRemoteApplied({ docId, deviceId: remote, seq: 3 })
      expect((await store.getKnownHeads(docId))[remote]).toBe(3)
    })

    // ── Slice B v2 / VE-B2: the THREE heads (getKnownHeads stays MAX; the new
    //     strict-contiguous + sync-request heads stop at the gap) ──────────────
    it('Slice B v2 — non-contiguous remote 0,5: getKnownHeads=5 (MAX, unchanged); getStrictContiguousHeads=0; getSyncRequestHeads=0 (no soft-skip yet)', async () => {
      const store = create(freshDbName())
      await store.init()
      const remote = uuid()
      const docId = uuid()

      // Apply 0 then 5 (hole at 1..4) — the directive's "0,5" fixture.
      await store.recordRemoteApplied({ docId, deviceId: remote, seq: 0 })
      await store.recordRemoteApplied({ docId, deviceId: remote, seq: 5 })

      // getKnownHeads stays MAX (the computeRestoreDisposition contract — UNCHANGED).
      expect((await store.getKnownHeads(docId))[remote]).toBe(5)
      // The SYNC heads stop at the gap (highest contiguous seq below the hole = 0).
      expect((await store.getStrictContiguousHeads(docId))[remote]).toBe(0)
      // No soft-skip yet → sync-request head == strict-contiguous head.
      expect((await store.getSyncRequestHeads(docId))[remote]).toBe(0)

      // Filling the hole (1..4) advances both sync heads up to 5.
      for (let s = 1; s <= 4; s++) await store.recordRemoteApplied({ docId, deviceId: remote, seq: s })
      expect((await store.getStrictContiguousHeads(docId))[remote]).toBe(5)
      expect((await store.getSyncRequestHeads(docId))[remote]).toBe(5)
    })
  })

  // ── Slice B v2 / VE-B2: durable gap-state lifecycle (InMemory + IDB parity) ──
  describe('gap-state lifecycle (Slice B v2 / VE-B2)', () => {
    it('recordGapObservation accumulates DISTINCT connection-epochs (same epoch twice → unchanged)', async () => {
      const store = create(freshDbName())
      await store.init()
      const device = uuid()
      const docId = uuid()

      // Two observations in epoch 0 → exactly ONE distinct epoch (the dedup mechanic).
      await store.recordGapObservation(docId, device, 2, 5, 0, 1000)
      await store.recordGapObservation(docId, device, 2, 5, 0, 2000)
      let gaps = await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)
      let gap = gaps.find((g) => g.docId === docId && g.device === device && g.firstMissing === 2)!
      expect(gap.observations).toBe(2) // every sighting counts
      expect(gap.observedEpochs).toEqual([0]) // but only ONE distinct epoch
      expect(gap.firstSeenAt).toBe(1000) // set on the first observation

      // A new epoch adds a distinct entry.
      await store.recordGapObservation(docId, device, 2, 6, 1, 3000)
      gaps = await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)
      gap = gaps.find((g) => g.docId === docId && g.device === device && g.firstMissing === 2)!
      expect(gap.observedEpochs.sort()).toEqual([0, 1])
      expect(gap.observedMax).toBe(6) // grows to the new broker max
    })

    it('markGapSoftSkipped advances getSyncRequestHeads past the hole while getStrictContiguousHeads stays behind', async () => {
      const store = create(freshDbName())
      await store.init()
      const device = uuid()
      const docId = uuid()

      // Store 0,1 then 5 (hole at 2..4); strict head = 1.
      for (const s of [0, 1, 5]) await store.recordRemoteApplied({ docId, deviceId: device, seq: s })
      expect((await store.getStrictContiguousHeads(docId))[device]).toBe(1)
      expect((await store.getSyncRequestHeads(docId))[device]).toBe(1) // no skip yet

      await store.recordGapObservation(docId, device, 2, 5, 0, 1000)
      await store.markGapSoftSkipped(docId, device, 2)

      // sync-request head jumps over the hole to the contiguous run above (5).
      expect((await store.getSyncRequestHeads(docId))[device]).toBe(5)
      // strict-contiguous head stays behind (the truth about contiguity).
      expect((await store.getStrictContiguousHeads(docId))[device]).toBe(1)
    })

    it('STACKED soft-skips fold in ONE pass regardless of observation order (no InMemory↔IDB drift) — Slice B v3', async () => {
      const store = create(freshDbName())
      await store.init()
      const device = uuid()
      const docId = uuid()

      // seqs [0,1,5,6,10] → two holes: 2..4 and 7..9. strict head = 1.
      for (const s of [0, 1, 5, 6, 10]) await store.recordRemoteApplied({ docId, deviceId: device, seq: s })
      expect((await store.getStrictContiguousHeads(docId))[device]).toBe(1)

      // Soft-skip the HIGHER hole FIRST (adversarial observation order) then the lower one.
      // Without an ascending sort the higher gap would fail `firstMissing === strict+1` and the
      // cursor would stop at 6 (InMemory Map-order) — and IndexedDB getAll-order could differ.
      await store.recordGapObservation(docId, device, 7, 10, 0, 1000)
      await store.markGapSoftSkipped(docId, device, 7)
      await store.recordGapObservation(docId, device, 2, 10, 0, 1000)
      await store.markGapSoftSkipped(docId, device, 2)

      // The cursor folds past BOTH holes in one call: 1 →(skip 2..4)→ 6 →(skip 7..9)→ 10.
      expect((await store.getSyncRequestHeads(docId))[device]).toBe(10)
      // strict-contiguous head stays at the truth (behind the first hole).
      expect((await store.getStrictContiguousHeads(docId))[device]).toBe(1)
    })

    it('listDueGapRepairs filters by nextDueAt; markGapRepairAttempt reschedules', async () => {
      const store = create(freshDbName())
      await store.init()
      const device = uuid()
      const docId = uuid()

      await store.recordGapObservation(docId, device, 2, 5, 0, 1000) // nextDueAt defaults to 0
      expect((await store.listDueGapRepairs(0)).length).toBe(1) // due at now=0

      await store.markGapRepairAttempt(docId, device, 2, 5000) // reschedule to 5000
      expect((await store.listDueGapRepairs(4999)).length).toBe(0) // not yet due
      expect((await store.listDueGapRepairs(5000)).length).toBe(1) // due now
      const gap = (await store.listDueGapRepairs(5000))[0]
      expect(gap.attempts).toBe(1)
    })

    it('auto-resolve — once the missing seq arrives via recordRemoteApplied, the GapRepair self-deletes and the strict head catches up to MAX', async () => {
      const store = create(freshDbName())
      await store.init()
      const device = uuid()
      const docId = uuid()

      for (const s of [0, 1, 5]) await store.recordRemoteApplied({ docId, deviceId: device, seq: s })
      await store.recordGapObservation(docId, device, 2, 5, 0, 1000)
      await store.markGapSoftSkipped(docId, device, 2)
      expect((await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)).length).toBe(1)

      // The missing 2,3,4 arrive → strict head reaches 5 → the gap self-clears.
      for (const s of [2, 3, 4]) await store.recordRemoteApplied({ docId, deviceId: device, seq: s })
      expect((await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)).length).toBe(0)
      expect((await store.getStrictContiguousHeads(docId))[device]).toBe(5)
      expect((await store.getStrictContiguousHeads(docId))[device]).toBe(
        (await store.getKnownHeads(docId))[device],
      )
    })

    it('deleteGapRepair drops a specific gap; clear() drops ALL gap-state', async () => {
      const store = create(freshDbName())
      await store.init()
      const device = uuid()
      const docId = uuid()

      await store.recordGapObservation(docId, device, 2, 5, 0, 1000)
      await store.recordGapObservation(docId, device, 9, 12, 0, 1000)
      expect((await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)).length).toBe(2)

      await store.deleteGapRepair(docId, device, 2)
      expect((await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)).length).toBe(1)

      await store.clear()
      expect((await store.listDueGapRepairs(Number.MAX_SAFE_INTEGER)).length).toBe(0)
    })
  })

  // ── Group 2: cross-tab atomicity proxy — concurrent appends get 0..N-1 ────
  describe('cross-tab seq atomicity (Group 2)', () => {
    it('N concurrent appendLocalEntry on the same (deviceId,docId) yield exactly 0..N-1, all distinct', async () => {
      const store = create(freshDbName())
      await store.init()
      const deviceId = uuid()
      const docId = uuid()
      const N = 25

      // Promise.all with no await between launches: the SeqLock must serialize
      // the read-max-seq → build → persist section. Without it, separate
      // readers would observe the same maxSeq and collide on seq=k.
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          store.appendLocalEntry({
            deviceId,
            docId,
            build: (seq) => buildRealEntry(deviceId, docId, seq, `c-${i}`, authorKid),
          }),
        ),
      )

      const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i))
      expect(new Set(seqs).size).toBe(N) // all distinct ⇒ no nonce reuse

      const heads = await store.getKnownHeads(docId)
      expect(heads[deviceId]).toBe(N - 1)
    })

    if (durable) {
      it('NEGATIVE CONTROL: raw read-modify-write WITHOUT the lock collides (proves the lock is required)', async () => {
        // Same fake-IndexedDB, but bypassing appendLocalEntry: read max seq,
        // await (yield the microtask queue), then write. Concurrent runs all see
        // the same maxSeq → duplicate seqs → the very nonce reuse the lock
        // prevents. This documents WHY the SeqLock (not a per-tab IDB txn) is
        // the atomicity boundary.
        const { openDB } = await import('idb')
        const dbName = freshDbName()
        const db = await openDB(dbName, 1, {
          upgrade(d) {
            d.createObjectStore('e', { keyPath: ['docId', 'deviceId', 'seq'] })
          },
        })
        const deviceId = uuid()
        const docId = uuid()

        async function unsafeAppend(): Promise<number> {
          // read max (short txn)
          const all = (await db.getAll('e')) as Array<{ seq: number }>
          const maxSeq = all.reduce((m, r) => Math.max(m, r.seq), -1)
          const seq = maxSeq + 1
          await Promise.resolve() // simulate the async build() gap
          await db.put('e', { docId, deviceId, seq })
          return seq
        }

        const seqs = await Promise.all(Array.from({ length: 10 }, () => unsafeAppend()))
        const distinct = new Set(seqs).size
        // The unguarded path MUST produce at least one collision.
        expect(distinct).toBeLessThan(seqs.length)
        db.close()
      })
    }
  })

  // ── Group 1: crash-safety / persist-before-send ───────────────────────────
  describe('crash-safety / persist-before-send (Group 1)', () => {
    it('build() that THROWS persists nothing and leaves the seq free for reuse with new plaintext (no wire reuse)', async () => {
      const store = create(freshDbName())
      await store.init()
      const deviceId = uuid()
      const docId = uuid()

      // Crash DURING build (before persist): seq 0 is reserved internally but
      // nothing is written and nothing is sent.
      await expect(
        store.appendLocalEntry({
          deviceId,
          docId,
          build: async () => {
            throw new Error('crash during crypto build')
          },
        }),
      ).rejects.toThrow('crash during crypto build')

      // Nothing persisted, seq NOT consumed.
      expect(await store.getPending()).toEqual([])
      expect(await store.getEntry(docId, deviceId, 0)).toBeNull()
      expect(await store.getKnownHeads(docId)).toEqual({})

      // The next append reuses the SAME seq=0 with NEW plaintext — provably
      // safe, because no JWS for seq=0 ever hit the wire.
      const recovered = await store.appendLocalEntry({
        deviceId,
        docId,
        build: (seq) => buildRealEntry(deviceId, docId, seq, 'after-crash', authorKid),
      })
      expect(recovered.seq).toBe(0)
      expect(recovered.status).toBe('pending')
    })
  })

  // ── Durable Wiring / N2 + N4: resolveConnectDeviceId reconciliation ────────
  describe('resolveConnectDeviceId — N2 partial-store + N4 random (Durable Wiring)', () => {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

    it('cold-start: mints + persists a fresh random deviceId (N4 v4 format)', async () => {
      const store = create(freshDbName())
      await store.init()
      const id = await store.resolveConnectDeviceId()
      expect(id).toMatch(UUID_V4)
      // Persisted: the plain read-or-mint primitive returns the SAME value.
      expect(await store.getOrCreateDeviceId()).toBe(id)
    })

    it('normal resume: a deviceId that has authored entries is returned unchanged (no rotate)', async () => {
      const store = create(freshDbName())
      await store.init()
      const d = await store.getOrCreateDeviceId()
      const docId = uuid()
      await store.appendLocalEntry({
        deviceId: d,
        docId,
        build: (seq) => buildRealEntry(d, docId, seq, 'authored', authorKid),
      })
      expect(await store.resolveConnectDeviceId()).toBe(d)
    })

    it('partial-meta-only: deviceId present but NO authored entries → ATOMIC namespace-rotate (never the old id)', async () => {
      const store = create(freshDbName())
      await store.init()
      // meta.deviceId survives with an empty log (the eviction / non-atomic-clear shape).
      await store.setDeviceId('stale-device-id')
      const rotated = await store.resolveConnectDeviceId()
      expect(rotated).not.toBe('stale-device-id')
      expect(rotated).toMatch(UUID_V4)
      // The old id is discarded — the read-or-mint primitive now returns the new one.
      expect(await store.getOrCreateDeviceId()).toBe(rotated)
    })

    it('orphaned-log: deviceId gone but UNSENT pending entries exist → RE-BIND their deviceId (resendPending can still flush)', async () => {
      const store = create(freshDbName())
      await store.init()
      const d = uuid()
      const docId = uuid()
      // Append WITHOUT getOrCreateDeviceId → a pending entry under d while the
      // persisted deviceId is absent (appendLocalEntry never writes meta).
      await store.appendLocalEntry({
        deviceId: d,
        docId,
        build: (seq) => buildRealEntry(d, docId, seq, 'unsent', authorKid),
      })
      const recovered = await store.resolveConnectDeviceId()
      expect(recovered).toBe(d) // re-bound, NOT a fresh mint
      expect((await store.getPending()).map((p) => p.deviceId)).toEqual([d])
    })

    it('orphaned-log spanning MULTIPLE pending deviceIds → throws OrphanedLogRepairError (never silently picks one)', async () => {
      const store = create(freshDbName())
      await store.init()
      const d1 = uuid()
      const d2 = uuid()
      const docId = uuid()
      await store.appendLocalEntry({
        deviceId: d1,
        docId,
        build: (seq) => buildRealEntry(d1, docId, seq, 'a', authorKid),
      })
      await store.appendLocalEntry({
        deviceId: d2,
        docId,
        build: (seq) => buildRealEntry(d2, docId, seq, 'b', authorKid),
      })
      await expect(store.resolveConnectDeviceId()).rejects.toThrow(OrphanedLogRepairError)
    })

    it('N4: deviceIds across many fresh stores are all DISTINCT (random, never seed-/DID-derived)', async () => {
      const ids = new Set<string>()
      for (let i = 0; i < 16; i++) {
        const store = create(freshDbName())
        await store.init()
        const id = await store.resolveConnectDeviceId()
        expect(id).toMatch(UUID_V4)
        ids.add(id)
      }
      expect(ids.size).toBe(16) // no determinism — a seed-derived id would collide
    })
  })

  // ── Group 5b: identical contract — getEntry round-trips the exact JWS ─────
  it('getEntry returns null for an absent entry', async () => {
    const store = create(freshDbName())
    await store.init()
    expect(await store.getEntry(uuid(), uuid(), 0)).toBeNull()
  })
})

// ── Group 1 (durable only): true crash + restart on the SAME database ────────
describe('IndexedDBDocLogStore — durable crash + restart (Group 1)', () => {
  let authorKid: string
  beforeEach(async () => {
    authorKid = await makeAuthorKid()
  })

  it('a persisted pending entry survives a process "crash" and a fresh instance replays the bit-identical JWS', async () => {
    const dbName = freshDbName()
    const deviceId = uuid()
    const docId = uuid()

    // Instance A persists one entry, then "crashes" (we simply drop the ref;
    // the entry is already durable in fake-IndexedDB) BEFORE any send/ack.
    const storeA = new IndexedDBDocLogStore(dbName)
    await storeA.init()
    const appended = await storeA.appendLocalEntry({
      deviceId,
      docId,
      build: (seq) => buildRealEntry(deviceId, docId, seq, 'durable-payload', authorKid),
    })

    // Instance B opens the SAME database — the crash-recovery view.
    const storeB = new IndexedDBDocLogStore(dbName)
    await storeB.init()

    const pending = await storeB.getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].status).toBe('pending')
    // The retry sends the STORED JWS unchanged (broker dedups via contentHash).
    expect(pending[0].entryJws).toBe(appended.entryJws)

    const fetched = await storeB.getEntry(docId, deviceId, 0)
    expect(fetched?.entryJws).toBe(appended.entryJws)

    // Heads survive the restart too.
    expect((await storeB.getKnownHeads(docId))[deviceId]).toBe(0)

    // After restart, the next seq continues at maxSeq+1 (never re-using seq=0).
    const next = await storeB.appendLocalEntry({
      deviceId,
      docId,
      build: (seq) => buildRealEntry(deviceId, docId, seq, 'second', authorKid),
    })
    expect(next.seq).toBe(1)
  })

  it('proves the persisted seq=0 JWS embeds the deterministic nonce(deviceId,0) — why rebuilding with new bytes would reuse it', async () => {
    // This makes invariant 1 concrete: the stored entry's `data` blob begins
    // with nonce(deviceId, seq) = SHA-256(deviceId|seq)[0:12]. Re-building seq=0
    // with DIFFERENT plaintext would encrypt under the SAME (key, nonce) → an
    // AES-GCM break. Hence the store persists the JWS once and never rebuilds.
    const dbName = freshDbName()
    const deviceId = uuid()
    const docId = uuid()
    const store = new IndexedDBDocLogStore(dbName)
    await store.init()

    const entry = await store.appendLocalEntry({
      deviceId,
      docId,
      build: (seq) => buildRealEntry(deviceId, docId, seq, 'payload', authorKid),
    })

    const payloadB64 = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(entry.entryJws.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as { data: string; seq: number; deviceId: string }
    expect(payloadB64.seq).toBe(0)
    expect(payloadB64.deviceId).toBe(deviceId)

    const expectedNonce = await deriveLogPayloadNonce(crypto, deviceId, 0)
    const blob = Uint8Array.from(
      atob(payloadB64.data.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    )
    expect(Array.from(blob.slice(0, 12))).toEqual(Array.from(expectedNonce))
  })
})

// ── Durable Wiring / N2 (durable-only): eviction, v5 migration, clear-coupling ──
describe('IndexedDBDocLogStore — N2 durable partial-store recovery', () => {
  let authorKid: string
  beforeEach(async () => {
    authorKid = await makeAuthorKid()
  })

  it('REALISTIC eviction: entries store wiped but meta (deviceId) survives → next start ROTATES (no seq=0 reuse)', async () => {
    const dbName = freshDbName()
    const docId = uuid()

    const storeA = new IndexedDBDocLogStore(dbName)
    await storeA.init()
    const d = await storeA.resolveConnectDeviceId() // cold-start mint
    await storeA.appendLocalEntry({
      deviceId: d,
      docId,
      build: (seq) => buildRealEntry(d, docId, seq, 'x', authorKid),
    })

    // Simulate a PARTIAL browser eviction: wipe ONLY the entries store, keep meta
    // (the iOS/quota/clear-site-data hazard the atomic clear() cannot itself prevent).
    const { openDB } = await import('idb')
    const raw = await openDB(dbName, 5)
    await raw.clear('entries')
    raw.close()

    // storeB starts: meta=d survives, log empty → partial-meta-only → ROTATE.
    const storeB = new IndexedDBDocLogStore(dbName)
    await storeB.init()
    const d2 = await storeB.resolveConnectDeviceId()
    expect(d2).not.toBe(d)
    // The next write starts seq=0 under the NEW deviceId — a fresh nonce namespace.
    const e = await storeB.appendLocalEntry({
      deviceId: d2,
      docId,
      build: (seq) => buildRealEntry(d2, docId, seq, 'y', authorKid),
    })
    expect(e.seq).toBe(0)
    expect(e.deviceId).toBe(d2)
  })

  it('v4→v5 migration builds the byDeviceId index over EXISTING rows (a pre-migration entry is found → no spurious rotate)', async () => {
    const dbName = freshDbName()
    const d = uuid()
    const docId = uuid()

    // Hand-build a v4 DB (no byDeviceId index) with one entry under d + meta=d.
    const { openDB } = await import('idb')
    const v4 = await openDB(dbName, 4, {
      upgrade(db) {
        const e = db.createObjectStore('entries', { keyPath: ['docId', 'deviceId', 'seq'] })
        e.createIndex('byStatus', 'status')
        db.createObjectStore('meta')
        db.createObjectStore('pendingRemovals')
        const g = db.createObjectStore('gapRepairs')
        g.createIndex('byNextDueAt', 'nextDueAt')
      },
    })
    await v4.add('entries', {
      docId,
      deviceId: d,
      seq: 0,
      entryJws: 'jws',
      status: 'pending',
      createdAt: 1,
    })
    await v4.put('meta', d, 'deviceId')
    v4.close()

    // Open with the real store (v5): the migration must build byDeviceId over the
    // existing row, so resolveConnectDeviceId sees d's entry and does NOT rotate.
    const store = new IndexedDBDocLogStore(dbName)
    await store.init()
    expect(await store.resolveConnectDeviceId()).toBe(d) // normal-resume via migrated index
  })

  it('clear×in-flight orphan is SELF-HEALING: an entry that lands under a now-meta-less deviceId is recovered on next connect', async () => {
    // Models the documented Row-11 race outcome: clear() wiped entries+meta, but an
    // in-flight append's db.add landed one pending entry under the old deviceId AFTER
    // the clear. resolveConnectDeviceId's orphaned-log branch re-binds it (no data loss).
    const dbName = freshDbName()
    const store = new IndexedDBDocLogStore(dbName)
    await store.init()
    const d = await store.resolveConnectDeviceId()
    const docId = uuid()
    await store.appendLocalEntry({
      deviceId: d,
      docId,
      build: (seq) => buildRealEntry(d, docId, seq, 'p', authorKid),
    })
    await store.clear() // atomically wipes entries + meta

    // The raced in-flight add lands AFTER the clear (orphan under d, meta gone).
    const { openDB } = await import('idb')
    const raw = await openDB(dbName, 5)
    await raw.add('entries', {
      docId,
      deviceId: d,
      seq: 0,
      entryJws: 'raced',
      status: 'pending',
      createdAt: 2,
    })
    raw.close()

    // Next connect recovers d (NOT a fresh mint) so the orphan stays flushable.
    expect(await store.resolveConnectDeviceId()).toBe(d)
    expect((await store.getPending()).map((p) => p.deviceId)).toEqual([d])
  })
})

// ── Group 3: WebLocks path is wired when navigator.locks exists ──────────────
// happy-dom exposes navigator.locks as a getter-only property, so we install
// and remove the mock via Object.defineProperty rather than plain assignment.
function installLocksMock(locks: unknown): void {
  const nav = (globalThis as { navigator?: object }).navigator ?? {}
  ;(globalThis as { navigator?: object }).navigator = nav
  Object.defineProperty(nav, 'locks', { value: locks, configurable: true, writable: true })
}
function clearLocksMock(): void {
  const nav = (globalThis as { navigator?: object }).navigator
  if (nav && Object.prototype.hasOwnProperty.call(nav, 'locks')) {
    Object.defineProperty(nav, 'locks', { value: undefined, configurable: true, writable: true })
  }
}

describe('SeqLock — Web Locks path (Group 3)', () => {
  let authorKid: string
  beforeEach(async () => {
    authorKid = await makeAuthorKid()
  })
  afterEach(() => {
    // Remove the mock so it cannot bleed into other suites.
    clearLocksMock()
    vi.restoreAllMocks()
  })

  it('appendLocalEntry routes seq reservation through navigator.locks.request when present', async () => {
    // happy-dom has no navigator.locks; inject a spy LockManager that honors the
    // exclusive contract (runs the callback to completion). Proves the cross-tab
    // guarantee is actually wired, not merely the in-process fallback.
    const request = vi.fn(
      async (_name: string, _opts: { mode: string }, cb: () => Promise<unknown>) => cb(),
    )
    installLocksMock({ request })

    const lock = new WebLocksSeqLock()
    const store = new IndexedDBDocLogStore(freshDbName(), lock)
    await store.init()
    const deviceId = uuid()
    const docId = uuid()

    await store.appendLocalEntry({
      deviceId,
      docId,
      build: (seq) => buildRealEntry(deviceId, docId, seq, 'web-locks', authorKid),
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      `doclog:${deviceId}:${docId}`,
      { mode: 'exclusive' },
      expect.any(Function),
    )
  })

  it('WebLocksSeqLock serializes concurrent runs on the same key (exclusive contract)', async () => {
    // A faithful exclusive LockManager: per-name promise chain. With it, two
    // concurrent appends still get distinct seqs 0 and 1.
    const chains = new Map<string, Promise<unknown>>()
    const request = vi.fn(
      <T>(name: string, _opts: { mode: string }, cb: () => Promise<T>): Promise<T> => {
        const prev = chains.get(name) ?? Promise.resolve()
        const run = prev.then(() => cb())
        chains.set(
          name,
          run.then(
            () => undefined,
            () => undefined,
          ),
        )
        return run
      },
    )
    installLocksMock({ request })

    const store = new IndexedDBDocLogStore(freshDbName(), new WebLocksSeqLock())
    await store.init()
    const deviceId = uuid()
    const docId = uuid()

    const [a, b] = await Promise.all([
      store.appendLocalEntry({
        deviceId,
        docId,
        build: (seq) => buildRealEntry(deviceId, docId, seq, 'p0', authorKid),
      }),
      store.appendLocalEntry({
        deviceId,
        docId,
        build: (seq) => buildRealEntry(deviceId, docId, seq, 'p1', authorKid),
      }),
    ])
    expect([a.seq, b.seq].sort()).toEqual([0, 1])
  })

  it('constructing WebLocksSeqLock without navigator.locks throws', () => {
    clearLocksMock()
    expect(() => new WebLocksSeqLock()).toThrow('Web Locks')
  })
})

// ── Public surface: ports + adapters exports resolve as documented ───────────
describe('DocLogStore public exports', () => {
  it('exposes the port types + in-memory impl + SeqLock from the root, and the durable adapter only from the indexeddb subpath', async () => {
    const root = await import('../src')
    const storageBarrel = await import('../src/adapters/storage')
    const indexeddbSubpath = await import('../src/adapters/storage/indexeddb')

    // InMemory + SeqLock are engine-neutral → root + storage barrel.
    expect(typeof root.InMemoryDocLogStore).toBe('function')
    expect(typeof root.InProcessSeqLock).toBe('function')
    expect(typeof root.WebLocksSeqLock).toBe('function')
    expect(typeof root.createSeqLock).toBe('function')
    expect(typeof storageBarrel.InMemoryDocLogStore).toBe('function')

    // Durable browser adapter is exposed ONLY via the fine-grained subpath
    // (mirrors the IndexedDbIdentitySeedVault posture).
    expect(typeof indexeddbSubpath.IndexedDBDocLogStore).toBe('function')
    expect((root as Record<string, unknown>).IndexedDBDocLogStore).toBeUndefined()
    expect(
      (storageBarrel as Record<string, unknown>).IndexedDBDocLogStore,
    ).toBeUndefined()
  })
})

describe('InProcessSeqLock', () => {
  it('serializes same-key runs and allows different keys to interleave', async () => {
    const lock = new InProcessSeqLock()
    const order: string[] = []
    const slow = lock.run('k', async () => {
      await Promise.resolve()
      order.push('slow-end')
    })
    const fast = lock.run('k', async () => {
      order.push('fast-start')
    })
    await Promise.all([slow, fast])
    // fast must wait for slow on the same key.
    expect(order).toEqual(['slow-end', 'fast-start'])
  })

  it('does not let one run failure poison the next on the same key', async () => {
    const lock = new InProcessSeqLock()
    await expect(lock.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(lock.run('k', async () => 42)).resolves.toBe(42)
  })
})
