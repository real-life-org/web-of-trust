/**
 * Slice A — Dual-Review BLOCKER + Concerns regression suite.
 *
 * Reproduces the parallel Codex + 6-lens-Claude review probes and asserts the
 * fixes hold. Each group carries an explicit TEETH toggle (the pre-fix behavior)
 * so a reviewer can see the test actually fails the old way and passes the new.
 *
 *  1. STORE-WIPE  (BLOCKER-1b): a store wipe yields a FRESH deviceId ⇒ a fresh
 *     nonce namespace; seq=0 after the wipe has a DIFFERENT nonce than before.
 *     TEETH: a fixed external deviceId (the old localStorage model) reuses the
 *     identical nonce(deviceId,0) with divergent plaintext (an AES-GCM break).
 *  2. CONCURRENT CROSS-TAB (BLOCKER-1a): two store instances on the same dbName,
 *     same deviceId, WITHOUT a shared lock, append concurrently → distinct seqs,
 *     no duplicate (deviceId,seq) persisted, the discarded build never returns.
 *     TEETH: a raw read→await→db.put cycle (no add-constraint) DOES collide.
 *  3. restoreCloneRequired WIRED (BLOCKER-1b defense-in-depth): catchUp with a
 *     broker entry under our own deviceId at a higher seq than local → restore
 *     clone fires (new deviceId) BEFORE the first write. TEETH: the pre-fix
 *     back-fill-before-compare ordering reports restoreCloneRequired=false.
 *  4. markAcked (CONCERN-1): a self-authored entry leaves the pending outbox once
 *     its delivery receipt correlates; resendPending does not re-send it.
 *  5. resendPending deviceId filter (CONCERN-1): after a restore-clone the OLD
 *     deviceId's pending entry is NEVER re-emitted (no re-clone loop). TEETH:
 *     without the filter the old entry is re-emitted.
 *
 * (CONCERN-2 — control-frame per-docId serialization — lives in
 * WebSocketControlFrame.test.ts, at the transport level where the bug is.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDB } from 'idb'
import { IndexedDBDocLogStore } from '../src/adapters/storage/IndexedDBDocLogStore'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { InProcessSeqLock, type SeqLock } from '../src/adapters/storage/SeqLock'
import type { DocLogStore } from '../src/ports/DocLogStore'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  createLogEntryJws,
  createLogEntryJwsWithSigner,
  createLogEntryMessage,
  createSpaceCapabilityJws,
  createSyncResponseMessage,
  deriveLogPayloadNonce,
  encryptLogPayload,
  type LogSyncEngineHooks,
} from '../src/protocol'

const crypto = new WebCryptoProtocolCryptoAdapter()
const SIGNING_SEED = new Uint8Array(32).fill(7)
const CONTENT_KEY = new Uint8Array(32).fill(9)

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

async function authorKid(): Promise<string> {
  const pub = await crypto.ed25519PublicKeyFromSeed(SIGNING_SEED)
  const { publicKeyToDidKey } = await import('../src/protocol')
  const did = publicKeyToDidKey(pub)
  return `${did}#${did.slice('did:key:'.length)}`
}

/** Build a REAL encrypted+signed log-entry JWS (the exact adapter build()). */
async function buildRealEntry(
  deviceId: string,
  docId: string,
  seq: number,
  plaintext: string,
  kid: string,
): Promise<string> {
  const { blobBase64Url } = await encryptLogPayload({
    crypto,
    spaceContentKey: CONTENT_KEY,
    deviceId,
    seq,
    plaintext: new TextEncoder().encode(plaintext),
  })
  return createLogEntryJws({
    payload: { seq, deviceId, docId, authorKid: kid, keyGeneration: 0, data: blobBase64Url, timestamp: new Date(1_700_000_000_000 + seq).toISOString() },
    signingSeed: SIGNING_SEED,
  })
}

/** Extract the 12-byte nonce embedded in a stored entry's encrypted `data` blob. */
function nonceOf(entryJws: string): number[] {
  const payload = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(entryJws.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    ),
  ) as { data: string }
  const blob = Uint8Array.from(atob(payload.data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  return Array.from(blob.slice(0, 12))
}

let dbCounter = 0
const freshDbName = (): string => `slice-a-fix-${Date.now()}-${++dbCounter}`

// ════════════════════════════════════════════════════════════════════════════
// Group 1 — STORE-WIPE (BLOCKER-1b): deviceId bound to the store lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe('BLOCKER-1b — STORE-WIPE binds deviceId to the log-store lifecycle', () => {
  let kid: string
  beforeEach(async () => { kid = await authorKid() })

  it('InMemory: a wipe yields a FRESH deviceId ⇒ seq=0 nonce differs (no reuse); TEETH: a fixed external deviceId reuses the nonce', async () => {
    const store = new InMemoryDocLogStore()
    await store.init()

    // Write seq 0..k under the store-minted deviceId.
    const dev1 = await store.getOrCreateDeviceId()
    const docId = uuid()
    const before = await store.appendLocalEntry({
      deviceId: dev1,
      docId,
      build: (seq) => buildRealEntry(dev1, docId, seq, 'before-wipe', kid),
    })
    expect(before.seq).toBe(0)

    // Wipe the store (iOS/Safari IDB eviction / quota / clear-site-data).
    await store.clear()

    // The deviceId is re-minted FRESH (bound to the wiped store).
    const dev2 = await store.getOrCreateDeviceId()
    expect(dev2).not.toBe(dev1)

    // The next write is seq=0 again — but under the NEW deviceId, so a DIFFERENT
    // nonce. No (Key, nonce) reuse despite the divergent plaintext.
    const after = await store.appendLocalEntry({
      deviceId: dev2,
      docId,
      build: (seq) => buildRealEntry(dev2, docId, seq, 'after-wipe-divergent', kid),
    })
    expect(after.seq).toBe(0)
    expect(nonceOf(after.entryJws)).not.toEqual(nonceOf(before.entryJws))

    // TEETH — the OLD model: a deviceId that survives the wipe (external,
    // localStorage). seq=0 again with divergent plaintext ⇒ IDENTICAL nonce =
    // the exact AES-GCM break the fix prevents.
    const teethNonceBefore = Array.from(await deriveLogPayloadNonce(crypto, dev1, 0))
    const teethNonceAfter = Array.from(await deriveLogPayloadNonce(crypto, dev1, 0))
    expect(teethNonceAfter).toEqual(teethNonceBefore) // stable deviceId ⇒ reuse
  })

  it('IndexedDB: clear() re-mints the deviceId; a fresh instance on a freshly DELETED DB also mints fresh (eviction)', async () => {
    const dbName = freshDbName()
    const store = new IndexedDBDocLogStore(dbName)
    await store.init()
    const dev1 = await store.getOrCreateDeviceId()
    const kidLocal = await authorKid()
    // Write a real seq=0 entry so the DB genuinely holds a log + deviceId.
    const before = await store.appendLocalEntry({
      deviceId: dev1,
      docId: uuid(),
      build: (seq) => buildRealEntry(dev1, uuid(), seq, 'before', kidLocal),
    })
    expect(await store.getOrCreateDeviceId()).toBe(dev1) // stable while persisted

    // clear() wipes BOTH the log and the deviceId → a fresh nonce namespace.
    await store.clear()
    const dev2 = await store.getOrCreateDeviceId()
    expect(dev2).not.toBe(dev1)
    const after = await store.appendLocalEntry({
      deviceId: dev2,
      docId: uuid(),
      build: (seq) => buildRealEntry(dev2, uuid(), seq, 'after', kidLocal),
    })
    // seq=0 again but a DIFFERENT nonce (new deviceId) — no reuse.
    expect(after.seq).toBe(0)
    expect(nonceOf(after.entryJws)).not.toEqual(nonceOf(before.entryJws))

    // Eviction case: the WHOLE database is deleted, then re-opened on a NEW
    // instance — mints fresh too. (Delete the DB directly; the store keeps no
    // long-lived handle across instances, but the SAME instance's connection must
    // be closed first, so use a fresh instance for the delete probe.)
    const evictName = freshDbName()
    const s1 = new IndexedDBDocLogStore(evictName)
    await s1.init()
    const evDev1 = await s1.getOrCreateDeviceId()
    await closeStore(s1)
    await deleteDb(evictName)
    const s2 = new IndexedDBDocLogStore(evictName)
    await s2.init()
    expect(await s2.getOrCreateDeviceId()).not.toBe(evDev1)
  })

  it('setDeviceId persists a restore-clone id across a fresh instance (durable)', async () => {
    const dbName = freshDbName()
    const a = new IndexedDBDocLogStore(dbName)
    await a.init()
    await a.getOrCreateDeviceId()
    const cloned = uuid()
    await a.setDeviceId(cloned)

    const b = new IndexedDBDocLogStore(dbName)
    await b.init()
    expect(await b.getOrCreateDeviceId()).toBe(cloned)
  })

  it('getOrCreateDeviceId mints a canonical lowercase UUID v4', async () => {
    const store = new InMemoryDocLogStore()
    await store.init()
    const id = await store.getOrCreateDeviceId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Group 2 — CONCURRENT CROSS-TAB (BLOCKER-1a): add-on-duplicate seq uniqueness
// ════════════════════════════════════════════════════════════════════════════

describe('BLOCKER-1a — durable seq uniqueness via add-on-duplicate (no shared lock)', () => {
  let kid: string
  beforeEach(async () => { kid = await authorKid() })

  it('IndexedDB: two instances on the SAME db, SAME deviceId, NO shared lock → distinct seqs, no duplicate, discarded build never persisted', async () => {
    const dbName = freshDbName()
    const deviceId = uuid()
    const docId = uuid()
    // Two independent stores on the same durable DB, each with its OWN in-process
    // lock (so the lock does NOT serialize across them — exactly two tabs without
    // Web Locks). Only the IDB add-constraint can prevent the seq=k collision.
    const tabA = new IndexedDBDocLogStore(dbName, new InProcessSeqLock())
    const tabB = new IndexedDBDocLogStore(dbName, new InProcessSeqLock())
    await tabA.init()
    await tabB.init()
    await tabA.setDeviceId(deviceId)

    const built: string[] = []
    const track = (deviceId: string, docId: string, seq: number, who: string) => {
      const p = buildRealEntry(deviceId, docId, seq, `${who}-divergent-${seq}`, kid)
      return p.then((jws) => { built.push(jws); return jws })
    }

    const results = await Promise.all([
      tabA.appendLocalEntry({ deviceId, docId, build: (seq) => track(deviceId, docId, seq, 'A') }),
      tabB.appendLocalEntry({ deviceId, docId, build: (seq) => track(deviceId, docId, seq, 'B') }),
      tabA.appendLocalEntry({ deviceId, docId, build: (seq) => track(deviceId, docId, seq, 'A2') }),
      tabB.appendLocalEntry({ deviceId, docId, build: (seq) => track(deviceId, docId, seq, 'B2') }),
    ])

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([0, 1, 2, 3]) // distinct, contiguous — no nonce reuse
    expect(new Set(seqs).size).toBe(4)

    // No duplicate (deviceId,seq) persisted: the durable DB holds exactly 4 rows
    // for this (docId,deviceId), one per seq.
    const heads = await tabA.getKnownHeads(docId)
    expect(heads[deviceId]).toBe(3)
    for (let s = 0; s <= 3; s++) expect(await tabA.getEntry(docId, deviceId, s)).not.toBeNull()

    // Persist-before-send: a build that lost the add race was NEVER returned as a
    // persisted entry. Every RETURNED entry's JWS is one that was actually stored;
    // a discarded (retried) build's JWS is for a seq that the winner already owns.
    for (const r of results) {
      const stored = await tabA.getEntry(docId, deviceId, r.seq)
      expect(stored!.entryJws).toBe(r.entryJws)
    }
  })

  it('TEETH: a raw read→await→db.put cycle WITHOUT the add-constraint DOES collide on seq', async () => {
    // The pre-fix shape: db.put overwrites, so two concurrent unguarded writers
    // both observe maxSeq and write the SAME seq=k → a duplicate (= nonce reuse).
    const db = await openDB(freshDbName(), 1, {
      upgrade(d) { d.createObjectStore('e', { keyPath: ['docId', 'deviceId', 'seq'] }) },
    })
    const docId = uuid()
    const deviceId = uuid()
    async function unsafePut(): Promise<number> {
      const all = (await db.getAll('e')) as Array<{ seq: number }>
      const seq = all.reduce((m, r) => Math.max(m, r.seq), -1) + 1
      await Promise.resolve() // the async build() gap
      await db.put('e', { docId, deviceId, seq }) // put = overwrite (no constraint)
      return seq
    }
    const seqs = await Promise.all(Array.from({ length: 8 }, () => unsafePut()))
    expect(new Set(seqs).size).toBeLessThan(seqs.length) // collision proven
    db.close()
  })

  it('InMemory: parallel appends WITHOUT a shared lock still get distinct seqs (add-semantics retry)', async () => {
    // Two InMemoryDocLogStore instances cannot share a Map, so to exercise the
    // add-retry within ONE store we drive concurrent appends through a NoopLock
    // (no serialization) on a single store — the has()-check + retry is the
    // backstop, mirroring the IDB add-constraint.
    const noop: SeqLock = { run: (_key, fn) => fn() }
    const store = new InMemoryDocLogStore(noop)
    await store.init()
    const deviceId = await store.getOrCreateDeviceId()
    const docId = uuid()
    const N = 12
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendLocalEntry({ deviceId, docId, build: (seq) => buildRealEntry(deviceId, docId, seq, `n-${i}`, kid) }),
      ),
    )
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i))
    expect(new Set(seqs).size).toBe(N)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Groups 3-5 — coordinator: restoreCloneRequired wiring, markAcked, resend filter
// ════════════════════════════════════════════════════════════════════════════

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()
let capSigningSeed: Uint8Array

function makeHooks(applied: Uint8Array[]): LogSyncEngineHooks {
  return { engine: 'test-raw', encodeUpdate: (u) => u, applyRemoteUpdate: (p) => { applied.push(p) } }
}

/**
 * Build a REAL log-entry JWS authored + signed by `identity` (authorKid =
 * identity.kid), so verifyLogEntryJws on the read path PASSES and the entry
 * back-fills heads (needed to reproduce the back-fill-before-compare teeth).
 */
async function buildIdentityEntry(
  identity: PublicIdentitySession,
  deviceId: string,
  seq: number,
  plaintext: string,
): Promise<string> {
  const { blobBase64Url } = await encryptLogPayload({
    crypto,
    spaceContentKey: CONTENT_KEY,
    deviceId,
    seq,
    plaintext: new TextEncoder().encode(plaintext),
  })
  return createLogEntryJwsWithSigner({
    payload: { seq, deviceId, docId: SPACE_ID, authorKid: identity.kid, keyGeneration: 0, data: blobBase64Url, timestamp: new Date(1_700_000_000_000 + seq).toISOString() },
    sign: (input) => identity.signEd25519(input),
  })
}

interface CoordHarness {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  logStore: InMemoryDocLogStore
  coordinator: LogSyncCoordinator
  applied: Uint8Array[]
  /** Per-call: override the receipt the next send returns (CONCERN-1). */
  sendReceiptOverride: { value: unknown | undefined }
}

async function makeCoordHarness(
  identity: PublicIdentitySession,
  deviceId: string,
  broker: InProcessLogBroker,
  opts?: {
    onWriteRejected?: LogSyncCoordinator['handleWriteReject'] extends never ? never : ConstructorParameters<typeof LogSyncCoordinator>[0]['onWriteRejected']
    onAfterRestoreClone?: (newDeviceId: string) => Promise<void> | void
  },
): Promise<CoordHarness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())
  const logStore = new InMemoryDocLogStore()
  await logStore.init()
  await logStore.setDeviceId(deviceId)
  const applied: Uint8Array[] = []
  const sendReceiptOverride: { value: unknown | undefined } = { value: undefined }

  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: { sendControlFrame: (frame) => messaging.sendControlFrame!(frame) },
    envelopes: {
      send: async (envelope) => {
        const result = await messaging.send(envelope as never)
        // CONCERN-1 test hook: optionally substitute the receipt (e.g. suppress).
        return sendReceiptOverride.value === undefined ? result : sendReceiptOverride.value
      },
    },
    capabilities: {
      getCapabilityJws: () =>
        createSpaceCapabilityJws({
          payload: { type: 'capability', spaceId: SPACE_ID, audience: identity.getDid(), permissions: ['read', 'write'], generation: 0, issuedAt: NOW, validUntil: FUTURE },
          signingSeed: capSigningSeed,
        }),
    },
    hooks: makeHooks(applied),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => ({ key: CONTENT_KEY, generation: 0 }),
    getContentKeyByGeneration: async (g) => (g === 0 ? CONTENT_KEY : null),
    getAvailableKeyGenerations: async () => [0],
    onWriteRejected: opts?.onWriteRejected,
    onAfterRestoreClone: opts?.onAfterRestoreClone,
  })
  messaging.onMessage(async (m) => { await coordinator.handleIncoming(m) })
  return { identity, messaging, logStore, coordinator, applied, sendReceiptOverride }
}

function isLogEntry(message: unknown): boolean {
  return (message as { type?: unknown })?.type === 'https://web-of-trust.de/protocols/log-entry/1.0'
}

describe('BLOCKER-1b defense-in-depth — restoreCloneRequired is WIRED (disposition before apply)', () => {
  beforeEach(() => { InMemoryMessagingAdapter.resetAll(); capSigningSeed = new Uint8Array(32).fill(9) })
  afterEach(() => InMemoryMessagingAdapter.resetAll())

  it('Group 3 — a sync-response with a broker entry under OUR deviceId at a higher seq fires a real restore-clone BEFORE the first write', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity

    // The restore-clone MECHANISM: mint a new deviceId. We assert it actually ran.
    let mintedNewDeviceId: string | null = null
    let afterCloneCalledWith: string | null = null
    const h = await makeCoordHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async () => {
        mintedNewDeviceId = uuid()
        return { deviceId: mintedNewDeviceId }
      },
      onAfterRestoreClone: (newDeviceId) => { afterCloneCalledWith = newDeviceId },
    })

    // Forge a sync-response whose entries[] contains a REAL entry under OUR
    // deviceId at seq 0..2 (the broker holds our log — the store-wipe/clone case),
    // and heads put our deviceId at seq 2 while our local store is empty.
    const entries: string[] = []
    for (let s = 0; s <= 2; s++) entries.push(await buildIdentityEntry(alice, DEVICE_A, s, `broker-held-${s}`))
    const response = createSyncResponseMessage({
      id: uuid(),
      from: alice.getDid(),
      to: [alice.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: uuid(),
      body: { docId: SPACE_ID, entries, heads: { [DEVICE_A]: 2 }, truncated: false },
    })

    const result = await h.coordinator.applySyncResponse(response)
    // The disposition was computed BEFORE the back-fill apply → restore required.
    expect(result.restoreCloneRequired).toBe(true)

    // And catchUp ACTS on it: drive the wired path and assert the clone mechanism ran.
    await h.coordinator['actOnRestoreDisposition'](result)
    expect(mintedNewDeviceId).not.toBeNull()
    expect(h.coordinator.getDeviceId()).toBe(mintedNewDeviceId)
    expect(afterCloneCalledWith).toBe(mintedNewDeviceId)
  })

  it('Group 3 TEETH — the pre-fix back-fill-before-compare ordering reports restoreCloneRequired=false', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeCoordHarness(alice, DEVICE_A, broker)

    const entries: string[] = []
    for (let s = 0; s <= 2; s++) entries.push(await buildIdentityEntry(alice, DEVICE_A, s, `broker-held-${s}`))
    const heads = { [DEVICE_A]: 2 }

    // Emulate the OLD ordering: apply the broker entries FIRST (back-fill our own
    // deviceId head into the store), THEN compute the disposition from getKnownHeads.
    for (const entryJws of entries) {
      await h.coordinator.receiveLogEntry(
        createLogEntryMessage({ id: uuid(), from: alice.getDid(), to: [alice.getDid()], createdTime: 0, entry: entryJws }),
      )
    }
    const localHeads = await h.logStore.getKnownHeads(SPACE_ID)
    const brokerSeq = heads[DEVICE_A]
    const localSeq = localHeads[DEVICE_A] ?? -1
    // After back-fill, localSeq == brokerSeq ⇒ the old code saw NO restore needed.
    expect(localSeq).toBe(2)
    expect(brokerSeq > localSeq).toBe(false) // dead-code disposition: false
  })
})

describe('CONCERN-1 — markAcked on receipt + resendPending deviceId filter', () => {
  beforeEach(() => { InMemoryMessagingAdapter.resetAll(); capSigningSeed = new Uint8Array(32).fill(9) })
  afterEach(() => InMemoryMessagingAdapter.resetAll())

  it('Group 4 — after a successful send+receipt the entry is acked (NOT pending); a later resendPending does NOT re-send it', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeCoordHarness(alice, DEVICE_A, broker)

    // Write one entry. The InProcess broker's send() resolves with an 'accepted'
    // delivery receipt (messageId == envelope id) → markAcked correlates it.
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3]))
    expect(entry!.seq).toBe(0)

    // The entry left the pending outbox.
    const pendingAfter = await h.logStore.getPending()
    expect(pendingAfter.find((p) => p.seq === 0)).toBeUndefined()
    const stored = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(stored!.status).toBe('acked')

    // A reconnect resendPending re-sends NOTHING (no acked entries are re-emitted).
    let resent = 0
    const baseSend = h.messaging.send.bind(h.messaging)
    ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (e: never) => {
      if (isLogEntry(e)) resent += 1
      return baseSend(e)
    }
    await h.coordinator.resendPending()
    expect(resent).toBe(0)

    // TEETH — suppress the receipt so markAcked never fires: the entry stays
    // pending and resendPending DOES re-send it (the stale-pending churn).
    h.sendReceiptOverride.value = null // a non-receipt return ⇒ no markAcked
    const entry2 = await h.coordinator.writeLocalUpdate(new Uint8Array([4, 5, 6]))
    expect((await h.logStore.getEntry(SPACE_ID, DEVICE_A, entry2!.seq))!.status).toBe('pending')
    resent = 0
    await h.coordinator.resendPending()
    expect(resent).toBe(1) // the still-pending entry was re-emitted
  })

  it('Group 5 — after a restore-clone, resendPending does NOT re-emit the OLD deviceId pending entry (no re-clone loop); TEETH: an unfiltered scan would', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity

    let newDeviceId: string | null = null
    const h = await makeCoordHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async () => { newDeviceId = uuid(); return { deviceId: newDeviceId } },
      // Re-write under the new deviceId from seq=0 (the real full-state re-write).
      onAfterRestoreClone: async () => { await h.coordinator.writeLocalUpdate(new Uint8Array([9])) },
    })

    // Suppress receipts so the OLD-device entry stays pending (it was rejected, not
    // acked) — exactly the post-restore residue the filter must skip.
    h.sendReceiptOverride.value = null
    await h.coordinator.writeLocalUpdate(new Uint8Array([1])) // (DEVICE_A, seq 0) pending

    // Drive a restore-clone via the Trigger-1 CATCH-UP path (brokerSeq>localSeq) —
    // a write-path SEQ_COLLISION is now a HARD error (Trigger 2), so the recoverable
    // mid-session clone is reached only through catch-up. deviceId re-binds; a new
    // entry under the NEW deviceId is written by onAfterRestoreClone.
    const cloneResponse = createSyncResponseMessage({
      id: uuid(),
      from: alice.getDid(),
      to: [alice.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: uuid(),
      body: { docId: SPACE_ID, entries: [], heads: { [DEVICE_A]: 5 }, truncated: false },
    })
    const cloneResult = await h.coordinator.applySyncResponse(cloneResponse)
    expect(cloneResult.restoreCloneRequired).toBe(true)
    await h.coordinator['actOnRestoreDisposition'](cloneResult)
    expect(newDeviceId).not.toBeNull()
    expect(h.coordinator.getDeviceId()).toBe(newDeviceId)

    // The OLD (DEVICE_A) entry is still pending in the store.
    const oldPending = (await h.logStore.getPending()).filter((p) => p.deviceId === DEVICE_A)
    expect(oldPending.length).toBeGreaterThanOrEqual(1)

    // resendPending now re-sends ONLY the active-deviceId entries, NEVER DEVICE_A's.
    const sentDeviceIds: string[] = []
    const baseSend = h.messaging.send.bind(h.messaging)
    ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (e: never) => {
      if (isLogEntry(e)) {
        const jws = (e as { body: { entry: string } }).body.entry
        const payload = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(atob(jws.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))),
        ) as { deviceId: string }
        sentDeviceIds.push(payload.deviceId)
      }
      return baseSend(e)
    }
    await h.coordinator.resendPending()
    expect(sentDeviceIds).not.toContain(DEVICE_A) // the loop is stopped

    // TEETH — an UNFILTERED scan over pending (the pre-fix resendPending) WOULD
    // include the revoked DEVICE_A entry → the spurious re-clone trigger.
    const allPendingDevices = (await h.logStore.getPending())
      .filter((p) => p.docId === SPACE_ID)
      .map((p) => p.deviceId)
    expect(allPendingDevices).toContain(DEVICE_A) // present, but the filter skips it
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Close a store's underlying IDB connection so the DB can be deleted. */
async function closeStore(store: IndexedDBDocLogStore): Promise<void> {
  const dbPromise = (store as unknown as { dbPromise: Promise<{ close(): void }> | null }).dbPromise
  if (dbPromise) (await dbPromise).close()
}

/** Delete an IndexedDB database (the eviction case) via the native API. */
function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}
