import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'
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
  SPACE_REGISTER_MESSAGE_TYPE,
  personalDocIdFromKey,
  LocalAppendFailedError,
  createSyncResponseMessage,
} from '@web_of_trust/core/protocol'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import { YjsPersonalLogSyncAdapter } from '../src/YjsPersonalLogSyncAdapter'

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const BROKER_URLS = ['wss://broker.example.com']

interface TestDoc {
  items: Record<string, { title: string }>
}

/** Tally outgoing envelope types on a messaging adapter (for VE-7 + LOOP-GUARD). */
function instrumentSentTypes(messaging: InMemoryMessagingAdapter): {
  types: string[]
  logEntries: number
  content: number
} {
  const tally = { types: [] as string[], logEntries: 0, content: 0 }
  const baseSend = messaging.send.bind(messaging)
  ;(messaging as unknown as { send: typeof messaging.send }).send = async (envelope: never) => {
    const type = (envelope as { type?: string }).type ?? 'unknown'
    tally.types.push(type)
    if (type === LOG_ENTRY_MESSAGE_TYPE) tally.logEntries += 1
    if (type === 'content') tally.content += 1
    return baseSend(envelope)
  }
  return tally
}

const DEVICE_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('YjsReplicationAdapter — Slice A Phase 3 (VE-5/6/7/10 + write-reject + join-register)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let broker: InProcessLogBroker
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

  // BLOCKER-1b: the deviceId is store-bound; seed the store with the desired id.
  async function makeAdapter(
    identity: PublicIdentitySession,
    messaging: InMemoryMessagingAdapter,
    deviceId: string,
    enableLogSync = true,
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
      docLogStore,
      enableLogSync,
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
    aliceAdapter = await makeAdapter(alice, aliceMessaging, DEVICE_ALICE)
    bobAdapter = await makeAdapter(bob, bobMessaging, DEVICE_BOB)
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

  async function createSharedSpace(): Promise<string> {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Log Space' })
    await wait()
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait(200)
    return space.id
  }

  // ── Group 4: VE-7 — content channel carries only log-entry under log sync ─────
  it('VE-7 — with enableLogSync=true, the content channel sends only log-entry/1.0 (NO content) in steady state', async () => {
    const spaceId = await createSharedSpace()
    const tally = instrumentSentTypes(aliceMessaging)

    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    handle.transact((doc) => { doc.items['t1'] = { title: 'first' } })
    handle.transact((doc) => { doc.items['t2'] = { title: 'second' } })
    await wait(150)

    // Steady-state: only log-entry envelopes were sent over the content channel.
    expect(tally.types).not.toContain('content')
    expect(tally.logEntries).toBeGreaterThanOrEqual(2)
    handle.close()
  })

  it('VE-7 — with enableLogSync=false, the legacy content path is unchanged (content IS sent)', async () => {
    // A separate non-log-sync pair (legacy content broadcast still the default).
    const legacyMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'legacy-socket' })
    await legacyMessaging.connect(alice.getDid())
    const legacy = await makeAdapter(alice, legacyMessaging, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', false)
    await legacy.start()
    try {
      const space = await legacy.createSpace<TestDoc>('private', { items: {} }, { name: 'Legacy' })
      await wait()
      const tally = instrumentSentTypes(legacyMessaging)
      const handle = await legacy.openSpace<TestDoc>(space.id)
      handle.transact((doc) => { doc.items['x'] = { title: 'legacy' } })
      await wait(120)
      // Legacy path: content envelope sent, NO log-entry.
      expect(tally.content).toBeGreaterThanOrEqual(1)
      expect(tally.logEntries).toBe(0)
      handle.close()
    } finally {
      await legacy.stop()
    }
  })

  // ── Durable Wiring / E1: createSpace propagates a non-transient seed-append failure ──
  it('E1 — createSpace REJECTS (does NOT swallow) when the seed log-append fails non-transiently', async () => {
    // The seed write (writeFullStateViaLog → writeLocalUpdate → appendLocalEntry) is
    // the durability boundary of createSpace. A non-transient append failure must
    // surface, not degrade to a console.debug-deferred "seed deferred" log line.
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const original = store.appendLocalEntry.bind(store)
    const cause = new Error('IDB quota exceeded')
    store.appendLocalEntry = async () => {
      throw cause
    }
    try {
      await expect(
        aliceAdapter.createSpace<TestDoc>('seed-fail', { items: {} }, { name: 'E1' }),
      ).rejects.toBeInstanceOf(LocalAppendFailedError)
    } finally {
      store.appendLocalEntry = original
    }
  })

  it('E1 — a non-transient append failure on a REGULAR local edit is SURFACED (console.error), not silently deferred', async () => {
    // The per-edit write path (update observer → writeLocalUpdateViaLog) is the most
    // common log-append edge; a non-transient failure there must not be swallowed to
    // console.debug. It is fire-and-forget (no caller), so the contract is: surface loud.
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    await wait()
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const original = store.appendLocalEntry.bind(store)
    store.appendLocalEntry = async () => {
      throw new Error('IDB quota exceeded')
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      handle.transact((doc) => {
        doc.items['e1'] = { title: 'fail' }
      })
      await wait(200)
      const surfaced = errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('non-transient local-append failure on log write'),
      )
      expect(surfaced).toBe(true)
    } finally {
      errorSpy.mockRestore()
      store.appendLocalEntry = original
      handle.close()
    }
  })

  // ── Group 1: VE-5 — blocked-by-key replay produces ZERO sends ─────────────────
  it('VE-5 — a remote entry under a not-yet-available key is buffered (no drop); after the key arrives the buffer replays and the replay sends NOTHING', async () => {
    const spaceId = await createSharedSpace()
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    // Reach into Bob's coordinator + key store to simulate a future-generation entry.
    const bobCoordinator = (bobAdapter as unknown as {
      coordinators: Map<string, { receiveLogEntry: (m: unknown) => Promise<{ disposition: string }>; blockedByKeyCount: () => number; replayBlockedByKey: () => Promise<number> }>
    }).coordinators.get(spaceId)!
    expect(bobCoordinator).toBeTruthy()

    // Alice writes an entry Bob CAN read first (gen 0), to establish the baseline.
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((doc) => { doc.items['base'] = { title: 'base' } })
    await wait(150)
    expect(bobHandle.getDoc().items['base']?.title).toBe('base')

    // Now craft a log-entry under gen 1 that Bob has NO key for, and feed it to Bob.
    // Use Alice's key store to make a gen-1 key Alice can encrypt with but Bob lacks.
    const aliceKeys = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    const gen1Key = crypto.getRandomValues(new Uint8Array(32))
    await aliceKeys.saveKey(spaceId, 1, gen1Key)
    // Alice writes under the new (gen 1) key — Bob does not have gen 1 yet.
    aliceHandle.transact((doc) => { doc.items['secret'] = { title: 'secret' } })
    await wait(150)

    // Bob could not apply the gen-1 entry → buffered, base item still the only one.
    expect(bobHandle.getDoc().items['secret']).toBeUndefined()
    expect(bobCoordinator.blockedByKeyCount()).toBeGreaterThanOrEqual(1)

    // Instrument Bob's sends, then import the gen-1 key into Bob and replay.
    const bobTally = instrumentSentTypes(bobMessaging)
    const bobKeys = (bobAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    await bobKeys.saveKey(spaceId, 1, gen1Key)
    const converged = await bobCoordinator.replayBlockedByKey()
    await wait(60)

    // The buffered entry converged...
    expect(converged).toBeGreaterThanOrEqual(1)
    expect(bobHandle.getDoc().items['secret']?.title).toBe('secret')
    // ...and the LOOP-GUARD held: the replay produced ZERO outgoing sends.
    expect(bobTally.logEntries).toBe(0)
    expect(bobTally.types.length).toBe(0)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Group 2: VE-5/VE-11 write-reject — a write-path SEQ_COLLISION is a HARD error ──
  it('VE-11 write-reject HARD — a SEQ_COLLISION on a WRITE we sent is a hard error (SeqCollisionError): NO restore-clone, deviceId UNCHANGED, no device-revoke; no loop', async () => {
    // VE-11 Trigger-2: a write-path reject of a log-entry WE sent means our seq is
    // ALREADY on the wire under that (deviceId,seq) — i.e. deterministic-nonce reuse.
    // A smooth re-clone would MASK an AES-GCM break, so handleWriteReject THROWS
    // SeqCollisionError and NEVER auto-recovers. The throw surfaces via the messaging
    // dispatch ("Message callback error: ...") and does NOT crash. Observable contract:
    // deviceId stays DEVICE_ALICE, no restore-clone, no device-revoke.
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)

    const deviceRevokes: unknown[] = []
    const baseControl = aliceMessaging.sendControlFrame!.bind(aliceMessaging)
    ;(aliceMessaging as unknown as { sendControlFrame: typeof aliceMessaging.sendControlFrame }).sendControlFrame =
      async (frame) => {
        if ((frame as { type?: string }).type === 'device-revoke') deviceRevokes.push(frame)
        return baseControl(frame)
      }
    const tally = instrumentSentTypes(aliceMessaging)

    // Arm a single SEQ_COLLISION on Alice's next log-entry write.
    broker.armRejection({ code: 'SEQ_COLLISION_DETECTED', target: 'log-entry', docId: spaceId })

    aliceHandle.transact((doc) => { doc.items['c'] = { title: 'collide' } })
    await wait(250)

    // HARD STOP: the deviceId is NOT re-bound (no restore-clone).
    const deviceIdAfter = (aliceAdapter as unknown as { deviceId: string }).deviceId
    expect(deviceIdAfter).toBe(DEVICE_ALICE)

    // No device-revoke was sent (no auto-recovery path ran).
    expect(deviceRevokes.length).toBe(0)

    // No re-write under any fresh deviceId at seq=0.
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const reWritten = await store.getEntry(spaceId, DEVICE_ALICE, 0)
    // (seq=0 is the seed under DEVICE_ALICE; it stays under DEVICE_ALICE, never re-minted.)
    expect(reWritten).not.toBeNull()

    // No endless loop: a bounded number of log-entry sends.
    expect(tally.logEntries).toBeLessThanOrEqual(4)

    aliceHandle.close()
  })

  // ── Group 5: VE-C1/VE-C3 — secure two-phase member removal ────────────────────
  // The Slice-A removeMember GUARD ("not yet supported") was REPLACED by the
  // two-phase broker-enforced flow. Its full test coverage (happy path,
  // staging != commit, pre-enforcement write, crash-recovery, multi-broker guard,
  // idempotency) lives in the dedicated suite YjsSecureRemoval.test.ts.

  // ── Group 6: Join-register — joining member publishes (incl. register) at join ─
  it('Join-register — the joining member runs the full publish (present-capability) at invite-accept, BEFORE any local write', async () => {
    // The P2-NIT-2 fix routes the join through ensurePublished() (space-register →
    // present-capability → sync-request), not only catchUp(). The observable
    // join-time signal common to every member is present-capability appearing for
    // the joiner's socket BEFORE the joiner ever writes to the doc.
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Join Space' })
    await wait()

    const bobControlBefore = broker.receivedControlFrames.filter((c) => c.socketId === 'bob-socket').length

    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait(300)

    // Bob presented a capability at JOIN time (before any local write by Bob).
    const bobPresents = broker.receivedControlFrames
      .filter((c) => c.socketId === 'bob-socket')
      .map((c) => c.frame.type)
    expect(bobPresents).toContain('present-capability')
    expect(broker.receivedControlFrames.filter((c) => c.socketId === 'bob-socket').length).toBeGreaterThan(
      bobControlBefore,
    )
  })

  it('Join-register — the space CREATOR (admin) sends an idempotent space-register at publish time; a re-publish does not error (first-writer-wins)', async () => {
    // The creator/admin sends space-register on first publication AND on a
    // reconnect re-publish — first-writer-wins makes the IDENTICAL re-register
    // folgenlos (no throw). This is the join-register idempotency the relay relies
    // on (a member re-sending the creator's identical registration).
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Idem Reg' })
    await wait(150)

    let aliceRegisters = 0
    const baseControl = aliceMessaging.sendControlFrame!.bind(aliceMessaging)
    ;(aliceMessaging as unknown as { sendControlFrame: typeof aliceMessaging.sendControlFrame }).sendControlFrame =
      async (frame) => {
        if ((frame as { type?: string }).type === SPACE_REGISTER_MESSAGE_TYPE) aliceRegisters += 1
        return baseControl(frame)
      }

    const aliceCoordinator = (aliceAdapter as unknown as {
      coordinators: Map<string, { resetForReconnect: () => void; ensurePublished: () => Promise<void> }>
    }).coordinators.get(space.id)!
    // A reconnect re-publish: the SAME admin set re-registers idempotently (no throw).
    aliceCoordinator.resetForReconnect()
    await expect(aliceCoordinator.ensurePublished()).resolves.toBeUndefined()
    await wait(60)

    // The idempotent re-register was sent (and first-writer-wins accepted it).
    expect(aliceRegisters).toBeGreaterThanOrEqual(1)
  })
})

// ── Group 3: VE-6 — Personal-Doc on the log core (multi-device, loop-free) ──────
describe('YjsPersonalLogSyncAdapter — Slice A VE-6 (Personal-Doc on the log core)', () => {
  let identity: PublicIdentitySession
  let broker: InProcessLogBroker
  let messaging1: InMemoryMessagingAdapter
  let messaging2: InMemoryMessagingAdapter
  let personalKey: Uint8Array
  let docId: string

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    identity = (await createTestIdentity('anton-pass')).identity
    // Two devices of the SAME identity (multi-device personal doc).
    messaging1 = new InMemoryMessagingAdapter({ broker, socketId: 'dev1-socket' })
    messaging2 = new InMemoryMessagingAdapter({ broker, socketId: 'dev2-socket' })
    await messaging1.connect(identity.getDid())
    await messaging2.connect(identity.getDid())
    personalKey = await identity.deriveFrameworkKey('personal-doc-v1')
    docId = personalDocIdFromKey(personalKey)
  })

  afterEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    try { await identity.deleteStoredIdentity() } catch {}
  })

  // BLOCKER-1b: the personal-doc deviceId is store-bound; seed the store so the
  // log authors under the desired id (broker arming scoped to it still matches).
  async function makePersonalAdapter(doc: Y.Doc, messaging: InMemoryMessagingAdapter, deviceId: string, mintDeviceId?: () => string) {
    const docLogStore = new InMemoryDocLogStore()
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
    return new YjsPersonalLogSyncAdapter({
      doc,
      messaging,
      identity,
      personalKey,
      docId,
      docLogStore,
      deviceId,
      mintDeviceId,
    })
  }

  it('VE-6 — a local Personal-Doc change produces exactly one log-entry; the other device applies it (origin=remote) with NO re-broadcast; multi-device converges loop-free', async () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    const sync2 = await makePersonalAdapter(doc2, messaging2, DEVICE_BOB)

    const tally1 = instrumentSentTypes(messaging1)
    const tally2 = instrumentSentTypes(messaging2)

    sync1.start()
    sync2.start()
    await wait(150)

    // Device 1 makes one local change → exactly one log-entry (the onPersonalDoc
    // change path, NOT useProfileSync / personal-sync).
    const baseline1 = tally1.logEntries
    doc1.getMap('profile').set('name', 'Anton')
    await wait(200)

    // Device 2 converged to the change.
    expect(doc2.getMap('profile').get('name')).toBe('Anton')

    // Exactly one new log-entry from device 1's single edit.
    expect(tally1.logEntries - baseline1).toBe(1)
    // LOOP-GUARD: device 2 applied the remote entry WITHOUT re-broadcasting a
    // log-entry (its log-entry count did not grow from receiving).
    const dev2LogEntriesAfterReceive = tally2.logEntries
    doc1.getMap('profile').set('bio', 'builder') // one more device-1 edit
    await wait(200)
    expect(doc2.getMap('profile').get('bio')).toBe('builder')
    // Device 2 still sent ZERO log-entries from purely receiving device 1's edits.
    expect(tally2.logEntries).toBe(dev2LogEntriesAfterReceive)

    // Bidirectional: device 2 edits, device 1 converges, still bounded.
    doc2.getMap('contacts').set('x', 'X')
    await wait(200)
    expect(doc1.getMap('contacts').get('x')).toBe('X')

    sync1.destroy()
    sync2.destroy()
    doc1.destroy()
    doc2.destroy()
  })

  it('VE-6 — content channel carries only log-entry (no personal-sync / content envelope)', async () => {
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    const tally1 = instrumentSentTypes(messaging1)
    sync1.start()
    await wait(120)
    doc1.getMap('profile').set('name', 'Anton')
    await wait(150)

    expect(tally1.types).not.toContain('personal-sync')
    expect(tally1.types).not.toContain('content')
    expect(tally1.logEntries).toBeGreaterThanOrEqual(1)

    sync1.destroy()
    doc1.destroy()
  })

  it('P0a Gate 3 — already-connected transport retries a failed initial catch-up without another connected event', async () => {
    // beforeEach connected messaging1 BEFORE sync.start(). Simulate the exact
    // readiness race: the first control-frame send still rejects, but no further
    // connection-state transition follows to rescue the deferred catch-up.
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    const baseControl = messaging1.sendControlFrame!.bind(messaging1)
    let controlAttempts = 0
    ;(messaging1 as unknown as { sendControlFrame: typeof messaging1.sendControlFrame }).sendControlFrame = async (frame) => {
      controlAttempts += 1
      if (controlAttempts === 1) throw new Error('must call connect() before sendControlFrame')
      return baseControl(frame)
    }

    sync1.start()
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 500
      const poll = () => {
        if (sync1.getCoordinator() || Date.now() >= deadline) return resolve()
        setTimeout(poll, 5)
      }
      poll()
    })
    const coordinator = sync1.getCoordinator()!
    const baseCatchUp = coordinator.catchUp.bind(coordinator)
    let completedRetry: Awaited<ReturnType<typeof coordinator.catchUp>> | null = null
    vi.spyOn(coordinator, 'catchUp').mockImplementation(async () => {
      const result = await baseCatchUp()
      completedRetry = result
      return result
    })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && completedRetry === null) await wait(25)

    // The recovery is a state re-check + backoff, not a synthetic reconnect;
    // assert the retry completed the real head reconciliation, not just that it
    // emitted a second control frame.
    expect(messaging1.getState()).toBe('connected')
    expect(controlAttempts).toBeGreaterThanOrEqual(2)
    expect(completedRetry).toMatchObject({ complete: true, pendingGaps: [] })

    sync1.destroy()
    doc1.destroy()
  })

  it('VE-6 — Personal-Doc restore (same deviceId, stale local seq) → CATCH-UP restore-clone → deviceId change (generation stays 0, full restore-clone strictness)', async () => {
    // VE-11 Trigger-1: the recoverable mid-session restore (the broker already
    // advanced PAST our local seq) is reached ONLY via the CATCH-UP path now, not a
    // write-reject. We seed the broker head for our deviceId ABOVE the local log
    // (brokerSeq>localSeq), then drive catchUp() → the head-abgleich computes
    // restoreCloneRequired and runs the restore-clone (mint new deviceId, re-write
    // full state from seq=0). Generation never resets — nonce uniqueness rests on seq
    // monotonicity per deviceId.
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE, () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    sync1.start()
    await wait(120)

    // Drive the restore via the CATCH-UP head-abgleich: a sync-response whose heads put
    // OUR deviceId at a seq HIGHER than our local log (brokerSeq>localSeq) → the
    // disposition computes restoreCloneRequired BEFORE any apply (BLOCKER-1b ordering).
    const coordinator = sync1.getCoordinator()!
    const response = createSyncResponseMessage({
      id: crypto.randomUUID(),
      from: identity.getDid(),
      to: [identity.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: crypto.randomUUID(),
      body: { docId, entries: [], heads: { [DEVICE_ALICE]: 5 }, truncated: false },
    })
    const result = await coordinator.applySyncResponse(response)
    expect(result.restoreCloneRequired).toBe(true)
    // Act on the disposition (mint new deviceId via the injected mint fn, re-write).
    await (coordinator as unknown as { actOnRestoreDisposition: (r: { restoreCloneRequired: boolean }) => Promise<void> })
      .actOnRestoreDisposition(result)
    await wait(120)

    // Restore-clone fired: the personal-doc deviceId was re-bound to the minted id.
    expect(sync1.getDeviceId()).not.toBe(DEVICE_ALICE)
    expect(sync1.getDeviceId()).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')

    sync1.destroy()
    doc1.destroy()
  })

  it('VE-6 — Personal-Doc restore via CATCH-UP (broker already advanced past local seq) re-writes the full state under the NEW deviceId so the second device CONVERGES (no silent edit loss)', async () => {
    // VE-11 Trigger-1: the real restore case — the broker already holds a divergent /
    // higher entry under our (deviceId,seq), so our local log is stale. This is now
    // reached via the CATCH-UP head-abgleich (brokerSeq>localSeq), not a write-reject.
    // Convergence here is ONLY possible if restore-clone re-writes the full state
    // under the freshly minted deviceId (onAfterRestoreClone). A fallback that just
    // resent the old stale entry would never re-publish the full state -> device 2
    // never sees the edit. This asserts CONVERGENCE, not merely the deviceId swap.
    const NEW_DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE, () => NEW_DEVICE)
    const sync2 = await makePersonalAdapter(doc2, messaging2, DEVICE_BOB)
    sync1.start()
    sync2.start()
    await wait(150)

    // Make a local edit FIRST (so the full-state re-write under NEW_DEVICE carries it).
    doc1.getMap('profile').set('name', 'Anton')
    await wait(120)

    // Drive the restore via the CATCH-UP head-abgleich: a sync-response whose heads put
    // DEVICE_ALICE at a seq HIGHER than our local log (brokerSeq>localSeq) — the
    // stale-local-seq restore case. restore-clone mints NEW_DEVICE and re-writes the
    // full state (including the edit) under the fresh namespace.
    const coordinator = sync1.getCoordinator()!
    const response = createSyncResponseMessage({
      id: crypto.randomUUID(),
      from: identity.getDid(),
      to: [identity.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: crypto.randomUUID(),
      body: { docId, entries: [], heads: { [DEVICE_ALICE]: 5 }, truncated: false },
    })
    const result = await coordinator.applySyncResponse(response)
    expect(result.restoreCloneRequired).toBe(true)
    await (coordinator as unknown as { actOnRestoreDisposition: (r: { restoreCloneRequired: boolean }) => Promise<void> })
      .actOnRestoreDisposition(result)
    await wait(300)

    // deviceId re-bound to the fresh namespace, generation unchanged (still 0).
    expect(sync1.getDeviceId()).toBe(NEW_DEVICE)
    // CONVERGENCE: the second device received the edit — only achievable via the
    // full-state re-write under NEW_DEVICE.
    expect(doc2.getMap('profile').get('name')).toBe('Anton')

    sync1.destroy()
    sync2.destroy()
    doc1.destroy()
    doc2.destroy()
  })

  // ── Slice B / VE-B: Personal-Doc MULTI-PAGE cold-reconstruction (festival-crit) ──
  it('VE-B Personal-Doc Multi-Page Cold-Reconstruction — device 1 writes >100 personal-doc entries; a cold device 2 (same identity+personalKey) reconstructs ALL via >=2 sync-request rounds', async () => {
    // Sync 002 requires Personal-Doc catch-up BEFORE Spaces (the Personal-Doc holds
    // the group keys). If the Personal-Doc pagination broke at >100, the whole Spaces
    // catch-up would start on an incomplete key basis — so this path MUST page too.
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    sync1.start()
    await wait(150)

    // Device 1 writes 130 personal-doc entries (each transact = one log-entry) → the
    // broker holds >100 entries → default page size 100 forces >=2 pages on catch-up.
    const WRITES = 130
    for (let i = 0; i < WRITES; i++) {
      doc1.getMap('profile').set(`k${i}`, `v${i}`)
      if (i % 25 === 0) await wait(15)
    }
    // Poll until ALL of device 1's entries have drained to the broker (not a fixed wait): the
    // cold device 2 must page a broker that already holds >100 entries, else its first catch-up
    // gets one page and the rest arrive live (no 2nd sync-request round) — masking pagination.
    const brokerEntriesForAlice = (): number => {
      let n = 0
      const docs = (broker as unknown as { docs: Map<string, { entries: Map<string, { deviceId: string }> }> }).docs
      for (const doc of docs.values()) for (const e of doc.entries.values()) if (e.deviceId === DEVICE_ALICE) n += 1
      return n
    }
    const drainDeadline = Date.now() + 5000
    while (Date.now() < drainDeadline && brokerEntriesForAlice() < WRITES) await wait(50)
    expect(brokerEntriesForAlice()).toBeGreaterThanOrEqual(WRITES)

    // Cold device 2: SAME identity + SAME personalKey, FRESH log store. Catches up the
    // whole personal log purely via a PAGINATED sync-response sequence.
    const doc2 = new Y.Doc()
    const sync2 = await makePersonalAdapter(doc2, messaging2, DEVICE_BOB)
    const reqTally: number[] = []
    const baseSend2 = messaging2.send.bind(messaging2)
    ;(messaging2 as unknown as { send: typeof messaging2.send }).send = async (env: never) => {
      if ((env as { type?: string }).type === SYNC_REQUEST_MESSAGE_TYPE) {
        reqTally.push(((env as { body?: { limit?: number } }).body?.limit) ?? -1)
      }
      return baseSend2(env)
    }
    sync2.start()
    // Poll to convergence (not a fixed wait): device 2 needs >=2 paginated rounds to drain 130
    // entries at limit 100. Wait until ALL keys are present AND >=2 sync-request rounds happened.
    const allKeysPresent = (): boolean => {
      for (let i = 0; i < WRITES; i++) if (doc2.getMap('profile').get(`k${i}`) !== `v${i}`) return false
      return true
    }
    const convergeDeadline = Date.now() + 6000
    while (Date.now() < convergeDeadline && !(allKeysPresent() && reqTally.length >= 2)) await wait(50)

    // ALL 130 keys reconstructed on the cold device (full multi-page convergence).
    for (let i = 0; i < WRITES; i++) {
      expect(doc2.getMap('profile').get(`k${i}`)).toBe(`v${i}`)
    }
    // MULTI-PAGE teeth: >=2 sync-request rounds, each carrying the explicit limit 100.
    expect(reqTally.length).toBeGreaterThanOrEqual(2)
    for (const limit of reqTally) expect(limit).toBe(100)

    sync1.destroy()
    sync2.destroy()
    doc1.destroy()
    doc2.destroy()
  })

  it('P0a Gate 3b — ein aufgelöster, aber unvollständiger Catch-up (timeout) wird im Backoff erneut versucht', async () => {
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    const target = await (sync1 as unknown as { ensureCoordinator(): Promise<{ catchUp(): Promise<unknown>; resendPending(): Promise<void> }> }).ensureCoordinator()
    expect(target, 'coordinator zugreifbar').toBeTruthy()
    const baseCatchUp = target.catchUp.bind(target)
    let calls = 0
    target.catchUp = async () => {
      calls += 1
      if (calls === 1) return { complete: false, incomplete: 'timeout' }
      return baseCatchUp()
    }
    ;(sync1 as unknown as { started: boolean }).started = true
    await (sync1 as unknown as { runInitialCatchUp(c: unknown): Promise<void> }).runInitialCatchUp(target)
    // Der Timeout-Lauf zählt als Fehlversuch → mindestens ein zweiter Versuch.
    expect(calls).toBeGreaterThanOrEqual(2)
    sync1.destroy()
    doc1.destroy()
  })

  it('P0a Gate 3c — destroy() während des Backoffs löst den Flight auf (kein pending-Leak)', async () => {
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    const target = await (sync1 as unknown as { ensureCoordinator(): Promise<{ catchUp(): Promise<unknown> }> }).ensureCoordinator()
    target.catchUp = async () => ({ complete: false, incomplete: 'timeout' })
    ;(sync1 as unknown as { started: boolean }).started = true
    const flight = (sync1 as unknown as { runInitialCatchUp(c: unknown): Promise<void> }).runInitialCatchUp(target)
    // destroy fällt mitten in den Backoff — der Flight muss trotzdem enden.
    await wait(5)
    ;(sync1 as unknown as { started: boolean }).started = false
    sync1.destroy()
    const resolved = await Promise.race([flight.then(() => true), wait(500).then(() => false)])
    expect(resolved, 'Flight endet nach destroy()').toBe(true)
    doc1.destroy()
  })

  it('P0a Gate 3d — destroy() → sofortiger start() startet einen frischen Catch-up, auch wenn der alte in catchUp() hängt', async () => {
    const doc1 = new Y.Doc()
    const sync1 = await makePersonalAdapter(doc1, messaging1, DEVICE_ALICE)
    const target = await (sync1 as unknown as { ensureCoordinator(): Promise<{ catchUp(): Promise<unknown> }> }).ensureCoordinator()
    let calls = 0
    let releaseHung: (() => void) | null = null
    target.catchUp = async () => {
      calls += 1
      if (calls === 1) await new Promise<void>((resolve) => { releaseHung = resolve })
      return { complete: true }
    }
    const shell = sync1 as unknown as { started: boolean; runInitialCatchUp(c: unknown): Promise<void>; requestInitialCatchUp(c: unknown, r: boolean): void; destroy(): void }
    shell.started = true
    shell.requestInitialCatchUp(target, false)
    await wait(5) // alter Flight hängt jetzt IN catchUp()
    shell.started = false
    shell.destroy()
    shell.started = true
    shell.requestInitialCatchUp(target, false) // Neustart derselben Instanz
    for (let i = 0; i < 100 && calls < 2; i += 1) await wait(10)
    expect(calls).toBeGreaterThanOrEqual(2)
    releaseHung?.()
    shell.started = false
    sync1.destroy()
    doc1.destroy()
  })
})

void SYNC_REQUEST_MESSAGE_TYPE
