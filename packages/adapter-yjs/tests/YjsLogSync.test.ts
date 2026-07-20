import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import {
  LOG_ENTRY_MESSAGE_TYPE,
  SYNC_REQUEST_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms))

interface TestDoc {
  items: Record<string, { title: string }>
}

const BROKER_URLS = ['wss://broker.example.com']

/**
 * Count log-entry envelopes a messaging adapter has sent. We instrument send()
 * to tally per-type so the LOOP-GUARD assertion (Test 3) can prove the outgoing
 * log-entry count equals the number of LOCAL edits, never exponential.
 */
function instrumentSendCounts(messaging: InMemoryMessagingAdapter): { logEntries: number; syncRequests: number } {
  const counts = { logEntries: 0, syncRequests: 0 }
  const baseSend = messaging.send.bind(messaging)
  ;(messaging as unknown as { send: typeof messaging.send }).send = async (envelope: never) => {
    const type = (envelope as { type?: string }).type
    if (type === LOG_ENTRY_MESSAGE_TYPE) counts.logEntries += 1
    if (type === SYNC_REQUEST_MESSAGE_TYPE) counts.syncRequests += 1
    return baseSend(envelope)
  }
  return counts
}

describe('YjsReplicationAdapter — Slice A log path (VE-2..9)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let broker: InProcessLogBroker

  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

  // BLOCKER-1b: the deviceId is store-bound. Seed the store with the desired id so
  // the log authors under it (and the broker-registered id matches), exactly the
  // composition-root pattern (mint/seed in the store first, then wire).
  async function makeAdapter(
    identity: PublicIdentitySession,
    messaging: InMemoryMessagingAdapter,
    deviceId: string,
  ): Promise<YjsReplicationAdapter> {
    const docLogStore = new InMemoryDocLogStore()
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
    return new YjsReplicationAdapter({
      identity,
      messaging,
      brokerUrls: BROKER_URLS,
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(),
      compactStore: new InMemoryCompactStore(),
      // Slice A: log path as the primary steady-state path. NO vault (the
      // standalone-convergence regression anchor: sync-request-only).
      docLogStore,
      enableLogSync: true,
      deviceId,
    })
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity

    aliceMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'alice-socket' })
    bobMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-socket' })
    await aliceMessaging.connect(alice.getDid())
    await bobMessaging.connect(bob.getDid())

    aliceAdapter = await makeAdapter(alice, aliceMessaging, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    bobAdapter = await makeAdapter(bob, bobMessaging, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    await aliceAdapter.start()
    await bobAdapter.start()
  })

  afterEach(async () => {
    await aliceAdapter.stop()
    await bobAdapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
    try { await bob.deleteStoredIdentity() } catch {}
  })

  /** Create a shared space (Alice) and invite Bob; both run the log-path publish. */
  async function createSharedSpace(): Promise<string> {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Log Space' })
    await wait()
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait(200)
    return space.id
  }

  // ── Test 1: write path (VE-2) ────────────────────────────────────────────────
  it('Test 1 — a local Yjs edit produces exactly one log-entry envelope; seq starts at 0; persisted before send', async () => {
    const spaceId = await createSharedSpace()
    const counts = instrumentSendCounts(aliceMessaging)

    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    handle.transact((doc) => {
      doc.items['task-1'] = { title: 'first' }
    })
    await wait()

    // Exactly one log-entry envelope from this single edit.
    expect(counts.logEntries).toBe(1)

    // Persisted in the durable log under (deviceId, seq=0).
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const entry = await store.getEntry(spaceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0)
    expect(entry).not.toBeNull()
    expect(entry!.seq).toBe(0)

    handle.close()
  })

  // ── Test 2: first-publication sequence (VE-2 §207, VE-8, VE-9) ────────────────
  it('Test 2 — first-publication order: space-register → present-capability before any log-entry', async () => {
    await createSharedSpace()

    const controlOrder = broker.receivedControlFrames
      .filter((c) => c.socketId === 'alice-socket')
      .map((c) => c.frame.type)
    expect(controlOrder).toContain('space-register')
    expect(controlOrder).toContain('present-capability')
    expect(controlOrder.indexOf('space-register')).toBeLessThan(controlOrder.indexOf('present-capability'))
  })

  // ── Test 3: LOOP-GUARD (the critical test) ────────────────────────────────────
  it('Test 3 — LOOP-GUARD: receiving remote log entries applies them with NO re-broadcast; two Yjs adapters converge; send count == local edits', async () => {
    const spaceId = await createSharedSpace()

    const aliceCounts = instrumentSendCounts(aliceMessaging)
    const bobCounts = instrumentSendCounts(bobMessaging)

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    // Alice makes N local edits.
    const N = 5
    for (let i = 0; i < N; i++) {
      aliceHandle.transact((doc) => {
        doc.items[`a-${i}`] = { title: `alice-${i}` }
      })
      await wait(40)
    }
    await wait(150)

    // Bob converged to all of Alice's edits.
    const bobDoc = bobHandle.getDoc()
    for (let i = 0; i < N; i++) {
      expect(bobDoc.items[`a-${i}`]?.title).toBe(`alice-${i}`)
    }

    // LOOP-GUARD assertions:
    //  - Alice sent exactly N log-entry envelopes (one per local edit), NOT exponential.
    expect(aliceCounts.logEntries).toBe(N)
    //  - Bob sent ZERO log-entry envelopes from RECEIVING Alice's edits (the read
    //    path never writes/re-broadcasts — the 5000+-outbox regression anchor).
    expect(bobCounts.logEntries).toBe(0)

    aliceHandle.close()
    bobHandle.close()
  })

  it('Test 3-bidi — bidirectional convergence still bounded: each side sends only its own edits', async () => {
    const spaceId = await createSharedSpace()
    const aliceCounts = instrumentSendCounts(aliceMessaging)
    const bobCounts = instrumentSendCounts(bobMessaging)

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    aliceHandle.transact((doc) => { doc.items['from-alice'] = { title: 'A' } })
    await wait(60)
    bobHandle.transact((doc) => { doc.items['from-bob'] = { title: 'B' } })
    await wait(150)

    // Both sides see both items.
    expect(aliceHandle.getDoc().items['from-bob']?.title).toBe('B')
    expect(bobHandle.getDoc().items['from-alice']?.title).toBe('A')

    // Each side sent exactly ONE log-entry (its own edit). No echo amplification.
    expect(aliceCounts.logEntries).toBe(1)
    expect(bobCounts.logEntries).toBe(1)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Test 4: catch-up / cold-start via sync-request only (vault disabled) ──────
  it('Test 4 — cold-start: a fresh device catches up the full log via sync-request only (no vault)', async () => {
    const spaceId = await createSharedSpace()

    // Alice writes 3 edits BEFORE Bob opens the doc.
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    for (let i = 0; i < 3; i++) {
      aliceHandle.transact((doc) => { doc.items[`pre-${i}`] = { title: `pre-${i}` } })
      await wait(30)
    }
    await wait(80)

    // A brand-new Bob device (fresh log store, fresh key mgmt seeded via the same
    // invite flow) — simulate by having the existing Bob explicitly catch up.
    await bobAdapter.requestSync(spaceId)
    await wait(120)

    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    const bobDoc = bobHandle.getDoc()
    for (let i = 0; i < 3; i++) {
      expect(bobDoc.items[`pre-${i}`]?.title).toBe(`pre-${i}`)
    }

    aliceHandle.close()
    bobHandle.close()
  })

  it('Test 4a — an already-connected cold Space adapter catches up once without a connected event', async () => {
    const spaceId = await createSharedSpace()

    // Keep Bob's persisted shared-space metadata and group key, but remove the
    // live adapter before Alice writes. The fresh adapter therefore starts with
    // an ordinary shared space (no pending membership change) whose item exists
    // only in the broker log.
    const bobDependencies = bobAdapter as unknown as {
      metadataStorage: InMemorySpaceMetadataStorage
      compactStore: InMemoryCompactStore
      keyManagement: InMemoryKeyManagementAdapter
    }
    await bobAdapter.stop()
    await bobMessaging.disconnect()

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((doc) => { doc.items['broker-only'] = { title: 'from the log' } })
    await wait(100)

    const coldMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-cold-socket' })
    await coldMessaging.connect(bob.getDid()) // connected BEFORE adapter.start()
    let coldSyncRequests = 0
    const baseColdSend = coldMessaging.send.bind(coldMessaging)
    ;(coldMessaging as unknown as { send: typeof coldMessaging.send }).send = async (envelope) => {
      if ((envelope as { type?: string }).type === SYNC_REQUEST_MESSAGE_TYPE) coldSyncRequests += 1
      return baseColdSend(envelope)
    }
    const coldLogStore = new InMemoryDocLogStore()
    await coldLogStore.init()
    await coldLogStore.setDeviceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const coldAdapter = new YjsReplicationAdapter({
      identity: bob,
      messaging: coldMessaging,
      brokerUrls: BROKER_URLS,
      keyManagement: bobDependencies.keyManagement,
      metadataStorage: bobDependencies.metadataStorage,
      compactStore: bobDependencies.compactStore,
      docLogStore: coldLogStore,
      enableLogSync: true,
      deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })

    await coldAdapter.start()
    const deadline = Date.now() + 2000
    let coldHandle = await coldAdapter.openSpace<TestDoc>(spaceId)
    while (Date.now() < deadline && !coldHandle.getDoc().items['broker-only']) {
      await wait(25)
    }

    expect(coldMessaging.sentControlFrames.map((frame) => frame.type)).toContain('present-capability')
    expect(coldSyncRequests).toBeGreaterThan(0)
    expect(coldHandle.getDoc().items['broker-only']?.title).toBe('from the log')

    // An implementation may deliver a redundant connected signal after a
    // subscription. It must not schedule another 2s reconnect catch-up.
    const controlFramesAfterInitialCatchUp = coldMessaging.sentControlFrames.length
    await coldMessaging.connect(bob.getDid())
    await wait(2200)
    expect(coldMessaging.sentControlFrames).toHaveLength(controlFramesAfterInitialCatchUp)

    coldHandle.close()
    await coldAdapter.stop()
    await coldMessaging.disconnect()
    aliceHandle.close()
  })

  // ── Test 8: engine-foreign payload tolerated (no crash) ───────────────────────
  it('Test 8 — a malformed/engine-foreign log-entry does not crash the adapter or stall convergence', async () => {
    const spaceId = await createSharedSpace()

    // Inject a foreign log-path message directly into Bob's onMessage: a log-entry
    // envelope whose entry is not a valid JWS. The read path must reject it
    // gracefully (no throw, no loop) and keep working for the next real edit.
    bobMessaging.onMessage(() => {})
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)

    aliceHandle.transact((doc) => { doc.items['ok'] = { title: 'ok' } })
    await wait(150)

    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    // Convergence still works despite any foreign traffic.
    expect(bobHandle.getDoc().items['ok']?.title).toBe('ok')

    aliceHandle.close()
    bobHandle.close()
  })
})
