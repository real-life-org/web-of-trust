import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import {
  LOG_ENTRY_MESSAGE_TYPE,
  SYNC_REQUEST_MESSAGE_TYPE,
  SPACE_REGISTER_MESSAGE_TYPE,
  PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
  decodeBase64Url,
  personalDocIdFromKey,
  createLogEntryMessage,
  createSyncResponseMessage,
} from '@web_of_trust/core/protocol'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { AutomergePersonalLogSyncAdapter } from '../src/AutomergePersonalLogSyncAdapter'
import {
  spaceIdToDocumentId,
  documentIdToSpaceId,
  isCanonicalUuidV4,
} from '../src/automerge-doc-id'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))
const BROKER_URLS = ['wss://broker.example.com']

interface TestDoc {
  items: Record<string, { title: string }>
}

const DEVICE_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Tally outgoing envelope types on a messaging adapter (LOOP-GUARD + VE-7). */
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

/** Decode (NOT verify) the docId from a log-entry JWS payload (VE-9 assertions). */
function logEntryDocId(entryJws: string): string {
  const payloadSegment = entryJws.split('.')[1]
  const json = new TextDecoder().decode(decodeBase64Url(payloadSegment))
  return (JSON.parse(json) as { docId: string }).docId
}

/** Decode the full log-entry payload from a stored JWS. */
function logEntryPayload(entryJws: string): { docId: string; deviceId: string; seq: number; authorKid: string; timestamp: string } {
  const payloadSegment = entryJws.split('.')[1]
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadSegment)))
}

describe('AutomergeReplicationAdapter — Slice A Phase 4 (VE-2..10 log path + VE-9 UUID-docId)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let broker: InProcessLogBroker
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: AutomergeReplicationAdapter
  let bobAdapter: AutomergeReplicationAdapter

  // BLOCKER-1b: the deviceId is store-bound; seed the store with the desired id.
  async function makeAdapter(
    identity: PublicIdentitySession,
    messaging: InMemoryMessagingAdapter,
    deviceId: string,
    enableLogSync = true,
  ): Promise<AutomergeReplicationAdapter> {
    const docLogStore = new InMemoryDocLogStore()
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
    return new AutomergeReplicationAdapter({
      identity,
      messaging,
      brokerUrls: BROKER_URLS,
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(),
      repoStorage: new InMemoryRepoStorageAdapter(),
      // Slice A: log path as the primary steady-state path. NO vault, NO
      // CompactStore (the standalone-convergence regression anchor: convergence
      // rides sync-request + log-entry only).
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

  /** Create a shared space (Alice) and invite Bob; both run the log-path publish. */
  async function createSharedSpace(): Promise<string> {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Log Space' })
    await wait()
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait(250)
    return space.id
  }

  // ── Group 1 (Test 1): VE-2/VE-9 write path ──────────────────────────────────
  it('Test 1 (VE-2/VE-9) — a local Automerge change produces exactly one log-entry; payload docId is the canonical lowercase UUID v4 (=spaceId), NOT base58; the log is 0-based (seed=seq 0), timestamp + authorKid present; persisted before send', async () => {
    // A SOLO space (no addMember) → deterministic seqs: seed=0, first edit=1.
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Solo' })
    await wait(150)
    const spaceId = space.id
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore

    // VE-4 self-contained log: the creator's initial seed is the seq=0 entry (so a
    // cold-start device with NO snapshot can reconstruct purely from the log). Its
    // wire docId is the canonical UUID, NOT base58.
    const seedEntry = await store.getEntry(spaceId, DEVICE_ALICE, 0)
    expect(seedEntry).not.toBeNull()
    expect(seedEntry!.seq).toBe(0)
    const seedPayload = logEntryPayload(seedEntry!.entryJws)
    expect(seedPayload.docId).toBe(spaceId)
    expect(isCanonicalUuidV4(seedPayload.docId)).toBe(true)
    expect(seedPayload.docId).not.toBe(spaceIdToDocumentId(spaceId)) // not the base58 id

    const counts = instrumentSentTypes(aliceMessaging)
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    handle.transact((doc) => {
      doc.items['task-1'] = { title: 'first' }
    })
    await wait()

    // Exactly one NEW log-entry envelope from this single local edit (VE-2).
    expect(counts.logEntries).toBe(1)

    // Persisted (before send) under (deviceId, seq=1) with the right fields — seq
    // is monotonic per (deviceId,docId) over all generations (seed was 0 → edit 1).
    const editEntry = await store.getEntry(spaceId, DEVICE_ALICE, 1)
    expect(editEntry).not.toBeNull()
    const payload = logEntryPayload(editEntry!.entryJws)
    expect(payload.docId).toBe(spaceId) // VE-9 UUID, never base58
    expect(isCanonicalUuidV4(payload.docId)).toBe(true)
    expect(payload.seq).toBe(1)
    expect(payload.deviceId).toBe(DEVICE_ALICE)
    expect(payload.authorKid).toBe(`${alice.getDid()}#sig-0`)
    expect(typeof payload.timestamp).toBe('string')
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false)

    handle.close()
  })

  // ── Group 2 (Test 2): VE-3 LOOP-GUARD ───────────────────────────────────────
  it('Test 2 (VE-3 LOOP-GUARD) — two networked Automerge adapters, edit storm → receiver sends 0 outgoing envelopes; converges without explosion; idempotent re-receive', async () => {
    const spaceId = await createSharedSpace()

    const aliceCounts = instrumentSentTypes(aliceMessaging)
    const bobCounts = instrumentSentTypes(bobMessaging)

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    // Alice makes N local edits (the edit storm).
    const N = 5
    for (let i = 0; i < N; i++) {
      aliceHandle.transact((doc) => {
        doc.items[`a-${i}`] = { title: `alice-${i}` }
      })
      await wait(50)
    }
    await wait(200)

    // Bob converged to all of Alice's edits.
    const bobDoc = bobHandle.getDoc()
    for (let i = 0; i < N; i++) {
      expect(bobDoc.items[`a-${i}`]?.title).toBe(`alice-${i}`)
    }

    // LOOP-GUARD:
    //  - Alice sent exactly N log-entry envelopes (one per local edit).
    expect(aliceCounts.logEntries).toBe(N)
    //  - Bob sent ZERO outgoing envelopes from RECEIVING Alice's edits (the read
    //    path never writes/re-broadcasts — the 5000+-outbox regression anchor).
    expect(bobCounts.logEntries).toBe(0)
    expect(bobCounts.types.length).toBe(0)

    // Idempotent re-receive: feed Alice's last log-entry to Bob's coordinator
    // again — no new outgoing send, no state change.
    const bobCoordinator = (bobAdapter as unknown as {
      coordinators: Map<string, { receiveLogEntry: (m: unknown) => Promise<{ disposition: string }> }>
    }).coordinators.get(spaceId)!
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const lastEntry = await store.getEntry(spaceId, DEVICE_ALICE, N - 1)
    const reReceive = await bobCoordinator.receiveLogEntry(
      createLogEntryMessage({
        id: crypto.randomUUID(),
        from: alice.getDid(),
        to: [bob.getDid()],
        createdTime: Math.floor(Date.now() / 1000),
        entry: lastEntry!.entryJws,
      }),
    )
    expect(reReceive.disposition).toBe('idempotent-skip')
    expect(bobCounts.logEntries).toBe(0)

    aliceHandle.close()
    bobHandle.close()
  })

  it('Test 2-bidi — bidirectional convergence stays bounded: each side sends only its own edits', async () => {
    const spaceId = await createSharedSpace()
    const aliceCounts = instrumentSentTypes(aliceMessaging)
    const bobCounts = instrumentSentTypes(bobMessaging)

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    aliceHandle.transact((doc) => { doc.items['from-alice'] = { title: 'A' } })
    await wait(80)
    bobHandle.transact((doc) => { doc.items['from-bob'] = { title: 'B' } })
    await wait(220)

    expect(aliceHandle.getDoc().items['from-bob']?.title).toBe('B')
    expect(bobHandle.getDoc().items['from-alice']?.title).toBe('A')

    // Each side sent exactly ONE log-entry (its own edit). No echo amplification.
    expect(aliceCounts.logEntries).toBe(1)
    expect(bobCounts.logEntries).toBe(1)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Group 3 (Test 9): VE-9 docId conformity + cold-start re-map ──────────────
  it('Test 9 (VE-9) — (a) wire docId is canonical lowercase UUID v4; (b) a second Automerge client converges; (c) present-capability + sync-request carry the same UUID; (d) a fresh START with NO CompactStore re-maps to the same UUID docId', async () => {
    const spaceId = await createSharedSpace()

    // (a) docId is a canonical lowercase UUID v4.
    expect(isCanonicalUuidV4(spaceId)).toBe(true)
    expect(spaceId).toBe(spaceId.toLowerCase())

    // The base58 documentId is derivable both ways from the UUID (the cold-start
    // re-map function) — proven reversible.
    const base58 = spaceIdToDocumentId(spaceId)
    expect(base58).not.toBe(spaceId)
    expect(documentIdToSpaceId(base58)).toBe(spaceId)

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((doc) => { doc.items['shared'] = { title: 'shared-item' } })
    await wait(220)

    // (b) the second Automerge client (Bob, same space) converged.
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    expect(bobHandle.getDoc().items['shared']?.title).toBe('shared-item')

    // (c) present-capability + sync-request carry the SAME UUID docId.
    //  - present-capability: decode the inner capability JWS payload spaceId.
    const { parsePresentCapabilityControlFrame } = await import('@web_of_trust/core/protocol')
    const presentSpaceIds = broker.receivedControlFrames
      .filter((c) => c.frame.type === PRESENT_CAPABILITY_CONTROL_FRAME_TYPE)
      .map((c) => parsePresentCapabilityControlFrame(c.frame).payload.spaceId)
    expect(presentSpaceIds.length).toBeGreaterThanOrEqual(1)
    for (const sid of presentSpaceIds) expect(sid).toBe(spaceId)
    //  - log-entry: payload docId == UUID.
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const entry = await store.getEntry(spaceId, DEVICE_ALICE, 0)
    expect(logEntryDocId(entry!.entryJws)).toBe(spaceId)
    //  - sync-request: Bob sends one with body.docId == UUID (capture it).
    let syncRequestDocId: string | undefined
    const baseSend = bobMessaging.send.bind(bobMessaging)
    ;(bobMessaging as unknown as { send: typeof bobMessaging.send }).send = async (envelope: never) => {
      if ((envelope as { type?: string }).type === SYNC_REQUEST_MESSAGE_TYPE) {
        syncRequestDocId = (envelope as { body?: { docId?: string } }).body?.docId
      }
      return baseSend(envelope)
    }
    await bobAdapter.requestSync(spaceId)
    await wait(120)
    expect(syncRequestDocId).toBe(spaceId)

    aliceHandle.close()
    bobHandle.close()

    // (d) a fresh Bob START with NO CompactStore must re-map to the SAME UUID
    // docId from the canonical spaceId — cold-start base58<->UUID re-mapping. We
    // re-create Bob's adapter on the SAME metadata + key store (multi-device cold
    // restart), with NO compactStore. The restored doc handle must live under the
    // derived base58 id, and its coordinator's wire docId stays the UUID.
    const bobMeta = (bobAdapter as unknown as { metadataStorage: InMemorySpaceMetadataStorage }).metadataStorage
    const bobKeys = (bobAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    await bobAdapter.stop()

    const bobColdMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-cold-socket' })
    await bobColdMessaging.connect(bob.getDid())
    // BLOCKER-1b: a cold restart of the SAME logical device seeds its store with
    // the same DEVICE_BOB id (so the relay author-binding keeps recognizing it).
    const bobColdLogStore = new InMemoryDocLogStore()
    await bobColdLogStore.init()
    await bobColdLogStore.setDeviceId(DEVICE_BOB)
    const bobCold = new AutomergeReplicationAdapter({
      identity: bob,
      messaging: bobColdMessaging,
      brokerUrls: BROKER_URLS,
      keyManagement: bobKeys,
      metadataStorage: bobMeta,
      repoStorage: new InMemoryRepoStorageAdapter(),
      // NO compactStore — the doc is NOT locally cached; the docId must be
      // re-derived from the canonical UUID spaceId.
      docLogStore: bobColdLogStore,
      enableLogSync: true,
      deviceId: DEVICE_BOB,
    })
    await bobCold.start()
    await wait(250)

    // The cold-restarted adapter mapped the space onto the UUID-derived base58
    // docId (the repo knows the derived id; the wire identity is the UUID).
    const coldSpaceState = (bobCold as unknown as {
      spaces: Map<string, { documentId: string }>
    }).spaces.get(spaceId)
    expect(coldSpaceState).toBeTruthy()
    expect(coldSpaceState!.documentId).toBe(spaceIdToDocumentId(spaceId))
    // And it converges the existing log via cold-start catch-up.
    const coldHandle = await bobCold.openSpace<TestDoc>(spaceId)
    expect(coldHandle.getDoc().items['shared']?.title).toBe('shared-item')

    coldHandle.close()
    bobAdapter = bobCold // hand off so afterEach stops the live instance
  })

  // ── Group 4 (Test 4): VE-4 catch-up / cold-start via sync-request only ───────
  it('Test 4 (VE-4) — cold-start: empty heads → complete log → reconstructed; sync-request-only convergence with the Vault DISABLED', async () => {
    const spaceId = await createSharedSpace()

    // Alice writes 3 edits BEFORE Bob catches up.
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    for (let i = 0; i < 3; i++) {
      aliceHandle.transact((doc) => { doc.items[`pre-${i}`] = { title: `pre-${i}` } })
      await wait(40)
    }
    await wait(120)

    // Bob catches up purely via sync-request (NO vault is wired in makeAdapter).
    await bobAdapter.requestSync(spaceId)
    await wait(180)

    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    const bobDoc = bobHandle.getDoc()
    for (let i = 0; i < 3; i++) {
      expect(bobDoc.items[`pre-${i}`]?.title).toBe(`pre-${i}`)
    }

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Group 5 (Test 5): VE-5 blocked-by-key + write-reject-restore ─────────────
  it('Test 5a (VE-5) — a remote entry under a not-yet-available key is buffered (no drop); after the key arrives the replay converges and sends NOTHING', async () => {
    const spaceId = await createSharedSpace()
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    const bobCoordinator = (bobAdapter as unknown as {
      coordinators: Map<string, { blockedByKeyCount: () => number; replayBlockedByKey: () => Promise<number> }>
    }).coordinators.get(spaceId)!
    expect(bobCoordinator).toBeTruthy()

    // Establish a baseline gen-0 edit Bob CAN read.
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((doc) => { doc.items['base'] = { title: 'base' } })
    await wait(200)
    expect(bobHandle.getDoc().items['base']?.title).toBe('base')

    // Alice writes under a gen-1 key Bob does NOT have yet.
    const aliceKeys = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    const gen1Key = crypto.getRandomValues(new Uint8Array(32))
    await aliceKeys.saveKey(spaceId, 1, gen1Key)
    aliceHandle.transact((doc) => { doc.items['secret'] = { title: 'secret' } })
    await wait(200)

    // Bob could not apply the gen-1 entry → buffered, base item still the only one.
    expect(bobHandle.getDoc().items['secret']).toBeUndefined()
    expect(bobCoordinator.blockedByKeyCount()).toBeGreaterThanOrEqual(1)

    // Import the gen-1 key into Bob and replay; the replay must send NOTHING.
    const bobTally = instrumentSentTypes(bobMessaging)
    const bobKeys = (bobAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    await bobKeys.saveKey(spaceId, 1, gen1Key)
    const converged = await bobCoordinator.replayBlockedByKey()
    await wait(80)

    expect(converged).toBeGreaterThanOrEqual(1)
    expect(bobHandle.getDoc().items['secret']?.title).toBe('secret')
    // LOOP-GUARD held: the replay produced ZERO outgoing sends.
    expect(bobTally.logEntries).toBe(0)
    expect(bobTally.types.length).toBe(0)

    aliceHandle.close()
    bobHandle.close()
  })

  it('Test 5b (VE-6/VE-11 catch-up restore) — the broker already advanced past Alice\'s local seq → CATCH-UP restore-clone: mint NEW deviceId, device-revoke old, re-write full-state from seq=0; the second device CONVERGES; bounded sends', async () => {
    // VE-11 Trigger-1: the recoverable restore (the broker already holds a divergent /
    // higher entry under our (deviceId,seq)) is reached via the CATCH-UP head-abgleich
    // now, NOT a write-reject (a write-path SEQ_COLLISION is the HARD Trigger-2 case).
    // The MECHANISM is identical (mint NEW deviceId, device-revoke old, re-write the
    // full state under it from seq=0). Convergence is ONLY possible via that re-write.
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    const deviceRevokes: unknown[] = []
    const baseControl = aliceMessaging.sendControlFrame!.bind(aliceMessaging)
    ;(aliceMessaging as unknown as { sendControlFrame: typeof aliceMessaging.sendControlFrame }).sendControlFrame =
      async (frame) => {
        if ((frame as { type?: string }).type === 'device-revoke') deviceRevokes.push(frame)
        return baseControl(frame)
      }
    const tally = instrumentSentTypes(aliceMessaging)

    // Make the local edit FIRST so the full-state re-write under the new deviceId
    // carries it (convergence proof).
    aliceHandle.transact((doc) => { doc.items['collide'] = { title: 'collide' } })
    await wait(150)

    // Drive the restore via the CATCH-UP head-abgleich on Alice's space coordinator:
    // a sync-response whose heads put DEVICE_ALICE at a seq HIGHER than the local log
    // (brokerSeq>localSeq — the stale local-seq restore case). The disposition is
    // computed BEFORE any apply (BLOCKER-1b); acting on it runs the restore-clone (mint
    // NEW deviceId via the adapter's process-wide handler, device-revoke old, re-write
    // the full state from seq=0).
    const aliceCoordinator = (aliceAdapter as unknown as {
      coordinators: Map<string, {
        applySyncResponse: (r: unknown) => Promise<{ restoreCloneRequired: boolean }>
        actOnRestoreDisposition: (r: { restoreCloneRequired: boolean }) => Promise<void>
      }>
    }).coordinators.get(spaceId)!
    const response = createSyncResponseMessage({
      id: crypto.randomUUID(),
      from: alice.getDid(),
      to: [alice.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: crypto.randomUUID(),
      body: { docId: spaceId, entries: [], heads: { [DEVICE_ALICE]: 50 }, truncated: false },
    })
    const result = await aliceCoordinator.applySyncResponse(response)
    expect(result.restoreCloneRequired).toBe(true)
    await aliceCoordinator.actOnRestoreDisposition(result)
    await wait(350)

    // The active deviceId was re-bound to a fresh (non-DEVICE_ALICE) id.
    const newDeviceId = (aliceAdapter as unknown as { deviceId: string }).deviceId
    expect(newDeviceId).not.toBe(DEVICE_ALICE)
    // A device-revoke was sent for the old device.
    expect(deviceRevokes.length).toBeGreaterThanOrEqual(1)

    // The re-write landed under the NEW deviceId at seq=0 (fresh nonce namespace).
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const reWritten = await store.getEntry(spaceId, newDeviceId, 0)
    expect(reWritten).not.toBeNull()
    expect(logEntryDocId(reWritten!.entryJws)).toBe(spaceId) // VE-9 still holds

    // CONVERGENCE: Bob received the edit (only possible via the full-state re-write
    // under the new deviceId).
    expect(bobHandle.getDoc().items['collide']?.title).toBe('collide')

    // No endless loop: a bounded number of log-entry sends.
    expect(tally.logEntries).toBeLessThanOrEqual(6)

    aliceHandle.close()
    bobHandle.close()
  })

  it('Test 5c (VE-4) — AUTHOR_MISMATCH on a write is a HARD STOP (no restore-clone, no retry loop)', async () => {
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)

    const tally = instrumentSentTypes(aliceMessaging)
    broker.armRejection({ code: 'AUTHOR_MISMATCH', target: 'log-entry', docId: spaceId })

    aliceHandle.transact((doc) => { doc.items['x'] = { title: 'x' } })
    await wait(250)

    // Hard stop: the deviceId is NOT re-bound (no restore-clone), and sends stay
    // bounded (no retry storm).
    expect((aliceAdapter as unknown as { deviceId: string }).deviceId).toBe(DEVICE_ALICE)
    expect(tally.logEntries).toBeLessThanOrEqual(2)

    aliceHandle.close()
  })

  // ── Group 7 (Test 7): VE-7 content-off + VE-8 register + VE-10 rotate ────────
  it('Test 7a (VE-7) — with enableLogSync=true, the content channel sends only log-entry (NO content) in steady state', async () => {
    const spaceId = await createSharedSpace()
    const tally = instrumentSentTypes(aliceMessaging)

    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    handle.transact((doc) => { doc.items['t1'] = { title: 'first' } })
    handle.transact((doc) => { doc.items['t2'] = { title: 'second' } })
    await wait(220)

    expect(tally.types).not.toContain('content')
    expect(tally.logEntries).toBeGreaterThanOrEqual(2)
    handle.close()
  })

  it('Test 7a (VE-7) — with enableLogSync=false, the legacy content path is unchanged (content IS sent, no log-entry)', async () => {
    const legacyMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'legacy-socket' })
    await legacyMessaging.connect(alice.getDid())
    const legacy = await makeAdapter(alice, legacyMessaging, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', false)
    await legacy.start()
    try {
      const space = await legacy.createSpace<TestDoc>('personal', { items: {} }, { name: 'Legacy' })
      await wait()
      const tally = instrumentSentTypes(legacyMessaging)
      const handle = await legacy.openSpace<TestDoc>(space.id)
      handle.transact((doc) => { doc.items['x'] = { title: 'legacy' } })
      await wait(180)
      // Legacy path: content envelope sent (automerge-repo native sync), NO log-entry.
      expect(tally.content).toBeGreaterThanOrEqual(1)
      expect(tally.logEntries).toBe(0)
      handle.close()
    } finally {
      await legacy.stop()
    }
  })

  it('Test 7b (VE-8) — first-publication order: space-register → present-capability before any log-entry', async () => {
    await createSharedSpace()
    const controlOrder = broker.receivedControlFrames
      .filter((c) => c.socketId === 'alice-socket')
      .map((c) => c.frame.type)
    expect(controlOrder).toContain(SPACE_REGISTER_MESSAGE_TYPE)
    expect(controlOrder).toContain(PRESENT_CAPABILITY_CONTROL_FRAME_TYPE)
    expect(controlOrder.indexOf(SPACE_REGISTER_MESSAGE_TYPE)).toBeLessThan(
      controlOrder.indexOf(PRESENT_CAPABILITY_CONTROL_FRAME_TYPE),
    )
  })

  // Test 7c — the Slice-A removeMember GUARD ("not yet supported") was REPLACED by
  // the two-phase broker-enforced flow (Slice SR / VE-C1/VE-C3). Its full coverage
  // (happy path, staging != commit, pre-enforcement write, crash-recovery,
  // multi-broker guard, idempotency) lives in AutomergeSecureRemoval.test.ts.

  // ── VE-3 engine-foreign skip (a non-Automerge payload must not crash/loop) ───
  it('VE-3 engine-foreign — an invalid/engine-foreign log-entry is rejected gracefully (no throw, no loop) and convergence still works for the next real edit', async () => {
    const spaceId = await createSharedSpace()

    // Drive Bob's coordinator read path with a foreign log-entry directly (a
    // 3-segment string that passes the message-shape assertion but fails JWS
    // verification — the engine-foreign / corrupt case). It must be rejected
    // gracefully with NO throw and NO outgoing send (LOOP-GUARD), then the next
    // real edit must still converge.
    const bobCoordinator = (bobAdapter as unknown as {
      coordinators: Map<string, { receiveLogEntry: (m: unknown) => Promise<{ disposition: string }> }>
    }).coordinators.get(spaceId)!
    const bobTally = instrumentSentTypes(bobMessaging)
    const result = await bobCoordinator.receiveLogEntry(
      createLogEntryMessage({
        id: crypto.randomUUID(),
        from: alice.getDid(),
        to: [bob.getDid()],
        createdTime: Math.floor(Date.now() / 1000),
        entry: 'eyJhbGciOiJFZERTQSJ9.eyJmb3JlaWduIjp0cnVlfQ.AAAA',
      }),
    )
    expect(result.disposition).toBe('rejected')
    expect(bobTally.types.length).toBe(0) // no re-broadcast from a rejected entry

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((doc) => { doc.items['ok'] = { title: 'ok' } })
    await wait(220)

    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    expect(bobHandle.getDoc().items['ok']?.title).toBe('ok')

    aliceHandle.close()
    bobHandle.close()
  })
})

// ── Group 6 (Test 6): VE-6 — Personal-Doc on the log core ───────────────────────
describe('AutomergePersonalLogSyncAdapter — Slice A VE-6 (Personal-Doc on the log core)', () => {
  let identity: PublicIdentitySession
  let broker: InProcessLogBroker
  let messaging1: InMemoryMessagingAdapter
  let messaging2: InMemoryMessagingAdapter
  let personalKey: Uint8Array
  let docId: string
  let repo1: Repo
  let repo2: Repo

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    identity = (await createTestIdentity('anton-pass')).identity
    messaging1 = new InMemoryMessagingAdapter({ broker, socketId: 'dev1-socket' })
    messaging2 = new InMemoryMessagingAdapter({ broker, socketId: 'dev2-socket' })
    await messaging1.connect(identity.getDid())
    await messaging2.connect(identity.getDid())
    personalKey = await identity.deriveFrameworkKey('personal-doc-v1')
    docId = personalDocIdFromKey(personalKey)
    repo1 = new Repo({ network: [], sharePolicy: async () => true })
    repo2 = new Repo({ network: [], sharePolicy: async () => true })
  })

  afterEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    try { await identity.deleteStoredIdentity() } catch {}
  })

  /** Create a Personal-Doc handle under the UUID-derived base58 docId (VE-9). */
  function makePersonalDoc(repo: Repo) {
    const handle = repo.import<{ profile?: Record<string, unknown>; contacts?: Record<string, unknown> }>(
      Automerge.save(Automerge.init({ actor: '0'.repeat(32) })),
      { docId: spaceIdToDocumentId(docId) },
    )
    if (!handle.isReady()) handle.doneLoading()
    return handle
  }

  // BLOCKER-1b: the personal-doc deviceId is store-bound; seed the store so the
  // log authors under the desired id (broker arming scoped to it still matches).
  async function makePersonalAdapter(
    handle: ReturnType<typeof makePersonalDoc>,
    messaging: InMemoryMessagingAdapter,
    deviceId: string,
    mintDeviceId?: () => string,
  ) {
    const docLogStore = new InMemoryDocLogStore()
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
    return new AutomergePersonalLogSyncAdapter({
      docHandle: handle as never,
      messaging,
      identity,
      personalKey,
      docId,
      docLogStore,
      deviceId,
      mintDeviceId,
    })
  }

  it('Test 6a (VE-6) — a local Personal-Doc change → exactly one log-entry (docId = canonical UUID); the other device applies it loop-free; multi-device converges', async () => {
    const handle1 = makePersonalDoc(repo1)
    const handle2 = makePersonalDoc(repo2)
    const sync1 = await makePersonalAdapter(handle1, messaging1, DEVICE_ALICE)
    const sync2 = await makePersonalAdapter(handle2, messaging2, DEVICE_BOB)

    const tally1 = instrumentSentTypes(messaging1)
    const tally2 = instrumentSentTypes(messaging2)

    sync1.start()
    sync2.start()
    await wait(200)

    const baseline1 = tally1.logEntries
    handle1.change((d) => { d.profile = { name: 'Anton' } })
    await wait(250)

    // Device 2 converged.
    expect((handle2.doc() as { profile?: { name?: string } }).profile?.name).toBe('Anton')
    // Exactly one new log-entry from device 1's single edit.
    expect(tally1.logEntries - baseline1).toBe(1)

    // LOOP-GUARD: device 2 applied the remote entry WITHOUT re-broadcasting.
    const dev2AfterReceive = tally2.logEntries
    handle1.change((d) => { (d.profile as Record<string, unknown>).bio = 'builder' })
    await wait(250)
    expect((handle2.doc() as { profile?: { bio?: string } }).profile?.bio).toBe('builder')
    expect(tally2.logEntries).toBe(dev2AfterReceive)

    // Bidirectional: device 2 edits, device 1 converges.
    handle2.change((d) => { d.contacts = { x: 'X' } })
    await wait(250)
    expect((handle1.doc() as { contacts?: { x?: string } }).contacts?.x).toBe('X')

    sync1.destroy()
    sync2.destroy()
  })

  it('Test 6b (VE-7) — content channel carries only log-entry (no personal-sync / content envelope)', async () => {
    const handle1 = makePersonalDoc(repo1)
    const sync1 = await makePersonalAdapter(handle1, messaging1, DEVICE_ALICE)
    const tally1 = instrumentSentTypes(messaging1)
    sync1.start()
    await wait(160)
    handle1.change((d) => { d.profile = { name: 'Anton' } })
    await wait(200)

    expect(tally1.types).not.toContain('personal-sync')
    expect(tally1.types).not.toContain('content')
    expect(tally1.logEntries).toBeGreaterThanOrEqual(1)

    sync1.destroy()
  })

  it('Test 6c (VE-6/VE-11 catch-up restore) — the broker already advanced past the old deviceId\'s seq → CATCH-UP restore-clone re-writes the full Personal-Doc state under the NEW deviceId so the second device CONVERGES (generation stays 0)', async () => {
    // VE-11 Trigger-1: the real restore case — the broker already holds a divergent /
    // higher entry under our (deviceId,seq), so our local log is stale. Reached via the
    // CATCH-UP head-abgleich (brokerSeq>localSeq) now, NOT a write-reject. Convergence is
    // ONLY possible via the full-state re-write under the freshly minted deviceId.
    const NEW_DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const handle1 = makePersonalDoc(repo1)
    const handle2 = makePersonalDoc(repo2)
    const sync1 = await makePersonalAdapter(handle1, messaging1, DEVICE_ALICE, () => NEW_DEVICE)
    const sync2 = await makePersonalAdapter(handle2, messaging2, DEVICE_BOB)
    sync1.start()
    sync2.start()
    await wait(200)

    // Make the local edit FIRST so the full-state re-write under NEW_DEVICE carries it.
    handle1.change((d) => { d.profile = { name: 'Anton' } })
    await wait(150)

    // Drive the restore via the CATCH-UP head-abgleich: a sync-response whose heads put
    // DEVICE_ALICE at a seq HIGHER than the local log (brokerSeq>localSeq — the stale
    // local-seq restore case). restore-clone mints NEW_DEVICE and re-writes the full
    // state (including the edit) under the fresh namespace.
    const coordinator = sync1.getCoordinator()!
    const response = createSyncResponseMessage({
      id: crypto.randomUUID(),
      from: identity.getDid(),
      to: [identity.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: crypto.randomUUID(),
      body: { docId, entries: [], heads: { [DEVICE_ALICE]: 50 }, truncated: false },
    })
    const result = await coordinator.applySyncResponse(response)
    expect(result.restoreCloneRequired).toBe(true)
    await (coordinator as unknown as { actOnRestoreDisposition: (r: { restoreCloneRequired: boolean }) => Promise<void> })
      .actOnRestoreDisposition(result)
    await wait(350)

    // deviceId re-bound to the fresh namespace, generation unchanged (still 0).
    expect(sync1.getDeviceId()).toBe(NEW_DEVICE)
    // CONVERGENCE: only achievable via the full-state re-write under NEW_DEVICE.
    expect((handle2.doc() as { profile?: { name?: string } }).profile?.name).toBe('Anton')

    sync1.destroy()
    sync2.destroy()
  })

  it('Test 6d (VE-6) — the personal-doc log-entry docId is the canonical lowercase UUID v4 (=personalDocId), NOT base58', async () => {
    const logStore = new InMemoryDocLogStore()
    await logStore.init()
    await logStore.setDeviceId(DEVICE_ALICE) // BLOCKER-1b: store-bound deviceId
    const handle1 = makePersonalDoc(repo1)
    const sync1 = new AutomergePersonalLogSyncAdapter({
      docHandle: handle1 as never,
      messaging: messaging1,
      identity,
      personalKey,
      docId,
      docLogStore: logStore,
      deviceId: DEVICE_ALICE,
    })
    sync1.start()
    await wait(160)
    handle1.change((d) => { d.profile = { name: 'Anton' } })
    await wait(200)

    const entry = await logStore.getEntry(docId, DEVICE_ALICE, 0)
    expect(entry).not.toBeNull()
    const payload = logEntryPayload(entry!.entryJws)
    expect(payload.docId).toBe(docId)
    expect(isCanonicalUuidV4(payload.docId)).toBe(true)
    expect(payload.docId).not.toBe(spaceIdToDocumentId(docId))
    // Personal-Doc capability is self-issued under the Identity key.
    expect(payload.authorKid).toBe(`${identity.getDid()}#sig-0`)

    sync1.destroy()
  })
})
