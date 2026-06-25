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
import { KEY_ROTATION_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import type { WireMessage, PendingRemoval } from '@web_of_trust/core/ports'
import { stageRotateSpaceKey } from '@web_of_trust/core/application'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

/**
 * Hold every `key-rotation/1.0` message addressed to this messaging adapter in an
 * in-memory buffer instead of delivering it, until {@link MessageHold.release} is
 * called. This makes a still-active member a deterministic LEGITIME LAGGER: it never
 * imports the missed rotation while it authors a stale-generation write. Patches the
 * adapter's private `deliverToSelf` (the single delivery funnel).
 */
interface MessageHold {
  release: () => Promise<void>
  held: number
}
function holdKeyRotations(messaging: InMemoryMessagingAdapter): MessageHold {
  const buffered: WireMessage[] = []
  const internal = messaging as unknown as { deliverToSelf: (m: WireMessage) => Promise<void> }
  const original = internal.deliverToSelf.bind(messaging)
  internal.deliverToSelf = async (envelope: WireMessage) => {
    if ((envelope as { type?: unknown }).type === KEY_ROTATION_MESSAGE_TYPE) {
      buffered.push(envelope)
      return
    }
    return original(envelope)
  }
  const hold: MessageHold = {
    get held() {
      return buffered.length
    },
    release: async () => {
      internal.deliverToSelf = original
      const toDeliver = buffered.splice(0)
      for (const m of toDeliver) await original(m)
    },
  }
  return hold
}

// Slice SR / VE-C1 + VE-C3 — adapter-level wiring of the two-phase secure removal
// over the log-sync path: removeMember now actually runs stage → space-rotate to the
// home broker (through the real coordinator) → commit, instead of the Slice-A guard.
// The engine-neutral safety invariants live in wot-core's SecureRemovalWorkflow tests;
// this proves the Yjs adapter wires them to a real broker end-to-end.

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))
const BROKER_URLS = ['wss://broker.example.com']
const DEVICE_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface TestDoc {
  items: Record<string, { title: string }>
}

function brokerGeneration(broker: InProcessLogBroker, docId: string): number | undefined {
  return (broker as unknown as { docs: Map<string, { generation: number }> }).docs.get(docId)?.generation
}

function adapterGeneration(adapter: YjsReplicationAdapter, spaceId: string): Promise<number> {
  return (adapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement.getCurrentGeneration(spaceId)
}

function pendingRemoval(adapter: YjsReplicationAdapter, spaceId: string, removedDid: string) {
  return (adapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore.getPendingRemoval(spaceId, removedDid)
}

describe('YjsReplicationAdapter — Slice SR secure removal (VE-C1 wiring)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let broker: InProcessLogBroker
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

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
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Removal Space' })
    await wait()
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait(200)
    return space.id
  }

  it('removeMember runs the two-phase flow end-to-end: broker rotated, generation advanced, member dropped, staging cleared', async () => {
    const spaceId = await createSharedSpace()
    expect((await aliceAdapter.getSpace(spaceId))!.members).toContain(bob.getDid())
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(0)
    expect(brokerGeneration(broker, spaceId) ?? 0).toBe(0)

    // The Slice-A guard is gone: this resolves instead of throwing "not yet supported".
    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait(200)

    // commit activated the staged generation locally...
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(1)
    // ...the space-rotate reached the broker through the real coordinator (enforcement)...
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    // ...Bob is no longer a member...
    expect((await aliceAdapter.getSpace(spaceId))!.members).not.toContain(bob.getDid())
    // ...and the durable staging record was cleaned up (removal complete, not pending).
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).toBeNull()
  })

  it('B3: if the durable membership-removal log append FAILS during commit, removeMember rejects and the PendingRemoval staging is PRESERVED (not deleted)', async () => {
    // B3 invariant: the canonical removed@newGeneration membership log entry MUST be
    // durable BEFORE the PendingRemoval staging is deleted. If the durable append
    // throws AFTER broker enforcement, the removal stays pending for VE-C3 recovery —
    // it must NEVER end up enforced + distributed with no membership-removal record.
    const spaceId = await createSharedSpace()
    expect((await aliceAdapter.getSpace(spaceId))!.members).toContain(bob.getDid())

    // Arm the durable store to throw on the NEXT local append (the membership-removal
    // entry written during commit). The space-rotate enforcement uses a control frame,
    // not appendLocalEntry, so the broker still rotates first — only the durable
    // membership write fails, exactly the B3 crash/append-failure window.
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const realAppend = store.appendLocalEntry.bind(store)
    let armed = true
    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = (async (params: any) => {
      if (armed) {
        armed = false
        throw new Error('simulated durable append failure (B3)')
      }
      return realAppend(params)
    }) as typeof store.appendLocalEntry

    // removeMember MUST reject because the durable membership append failed.
    await expect(aliceAdapter.removeMember(spaceId, bob.getDid())).rejects.toThrow()
    await wait(150)

    // The broker WAS enforced (space-rotate confirmed) — enforcement precedes commit...
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    // ...but the PendingRemoval staging is PRESERVED (the durable membership record was
    // never written, so the workflow did NOT delete the staging — VE-C3 will retry).
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).not.toBeNull()

    // Restore + drive recovery: with the store healthy, recovery completes the removal
    // (durable membership record now written, staging cleared).
    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = realAppend
    await (aliceAdapter as unknown as { recoverPendingRemovalsOnce: () => Promise<void> }).recoverPendingRemovalsOnce()
    await wait(200)
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).toBeNull()
  })

  it('SF: a recovery whose staged home broker differs from the adapter active broker does NOT confirm/commit — the removal stays pending (no wrong-broker confirmation)', async () => {
    // SF invariant: the adapter sends the space-rotate over the ACTIVE broker
    // connection. If a durable record's staged home broker is NOT the active broker
    // (e.g. the broker config changed between stage and enforce), the adapter must NOT
    // mark that staged broker confirmed — otherwise a rotate sent over a DIFFERENT
    // transport would falsely count as enforced against the stale broker.
    const spaceId = await createSharedSpace()
    const keyPort = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    const crypto = (aliceAdapter as unknown as { crypto: any }).crypto
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore

    // Stage real next-generation material (gen 0 → 1) WITHOUT activating it, and place a
    // durable PendingRemoval whose homeBrokerSet points at a DIFFERENT (stale) broker.
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId, ownerDid: alice.getDid() })
    const STALE_BROKER = 'wss://old-broker.example.com'
    const record: PendingRemoval = {
      spaceId,
      removedDid: bob.getDid(),
      homeBrokerSet: [STALE_BROKER], // NOT the adapter's active broker (BROKER_URLS[0])
      confirmedBrokerUrls: [],
      newGeneration: staged.newGeneration,
      stagedKeyMaterial: {
        contentKey: staged.contentKey,
        capSigningSeed: staged.capabilitySigningSeed,
        capVerificationKey: staged.capabilityVerificationKey,
      },
      createdAt: Date.now(),
    }
    await store.putPendingRemoval(record)
    expect(brokerGeneration(broker, spaceId) ?? 0).toBe(0)

    // Recovery: the adapter active broker is BROKER_URLS[0] ('wss://broker.example.com'),
    // which differs from the staged STALE_BROKER → sendSpaceRotate throws (generic) →
    // the removal routes to pending, NOT confirmed/committed.
    await (aliceAdapter as unknown as { recoverPendingRemovalsOnce: () => Promise<void> }).recoverPendingRemovalsOnce()
    await wait(150)

    // The broker was NOT rotated (no confirmation over the wrong-broker record)...
    expect(brokerGeneration(broker, spaceId) ?? 0).toBe(0)
    // ...the generation was NOT advanced (no commit)...
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(0)
    // ...and the record persists with NO broker confirmed (stays pending for a correct retry).
    const still = await pendingRemoval(aliceAdapter, spaceId, bob.getDid())
    expect(still).not.toBeNull()
    expect(still!.confirmedBrokerUrls).toEqual([])
  })

  it('post-enforcement: a removed member can no longer land a write at the broker (its old-generation log-entry is gated out)', async () => {
    const spaceId = await createSharedSpace()
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)

    // baseline: a pre-removal write from Bob replicates to Alice (Bob is canonical)
    bobHandle.transact((doc) => { doc.items['pre'] = { title: 'pre-removal' } })
    await wait(200)
    expect(aliceHandle.getDoc().items['pre']?.title).toBe('pre-removal')

    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait(200)
    expect(brokerGeneration(broker, spaceId)).toBe(1)

    // Bob's adapter is still on generation 0 (it has not rotated). Any write it now
    // makes is a stale-generation log-entry the broker MUST reject (KEY_GENERATION_STALE),
    // so it never reaches Alice.
    bobHandle.transact((doc) => { doc.items['post'] = { title: 'post-removal-should-be-gated' } })
    await wait(250)
    expect(aliceHandle.getDoc().items['post']).toBeUndefined()

    bobHandle.close()
    aliceHandle.close()
  })

  it('VE-C2 legitimate lagger: a still-active member that missed the rotation gets KEY_GENERATION_STALE, catches up, re-emits, and converges (no SEQ_COLLISION, no double-effect)', async () => {
    // Three members: Alice (admin), Bob (the LAGGER, stays active), Carol (removed).
    // Alice removes Carol → rotation to gen 1. Bob is HELD on the key-rotation, so he
    // writes a stale gen-0 entry → broker rejects KEY_GENERATION_STALE → the re-emit
    // PARKS. Then Bob receives the rotation → imports gen-1 → replayPendingReemits
    // drains → Bob re-emits the SAME update under a NEW seq + gen 1 → it lands at the
    // broker and converges to Alice. This is the legitimate lagger, NOT the removed
    // member (whose gen-0 write must stay gated, covered by the post-enforcement test).
    const carol = (await createTestIdentity('carol-pass')).identity
    const carolMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'carol-socket' })
    await carolMessaging.connect(carol.getDid())
    const carolAdapter = await makeAdapter(carol, carolMessaging, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    await carolAdapter.start()

    try {
      // Build the 3-member space.
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Lagger Space' })
      const spaceId = space.id
      await wait()
      await aliceAdapter.addMember(spaceId, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
      await wait(150)
      await aliceAdapter.addMember(spaceId, carol.getDid(), await carol.getEncryptionPublicKeyBytes())
      await wait(200)

      const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
      await wait(150)

      // Baseline: a pre-rotation write from Bob replicates to Alice (Bob is active).
      bobHandle.transact((doc) => { doc.items['pre'] = { title: 'pre-rotation' } })
      await wait(200)
      expect(aliceHandle.getDoc().items['pre']?.title).toBe('pre-rotation')
      expect(await adapterGeneration(bobAdapter, spaceId)).toBe(0)

      // HOLD Bob's key-rotation so he stays on gen 0 (the lagger condition).
      const hold = holdKeyRotations(bobMessaging)

      // Alice removes Carol → rotation to gen 1 (broker enforced).
      await aliceAdapter.removeMember(spaceId, carol.getDid())
      await wait(250)
      expect(brokerGeneration(broker, spaceId)).toBe(1)
      expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(1)
      // Bob is the lagger: still gen 0, the rotation is held.
      expect(await adapterGeneration(bobAdapter, spaceId)).toBe(0)
      expect(hold.held).toBeGreaterThanOrEqual(1)

      // Bob writes under the stale gen-0 key → broker rejects KEY_GENERATION_STALE →
      // the re-emit parks (rotation not imported yet), so it has NOT reached Alice.
      bobHandle.transact((doc) => { doc.items['lag'] = { title: 'written-while-lagging' } })
      await wait(250)
      expect(aliceHandle.getDoc().items['lag']).toBeUndefined()

      // The missed rotation now arrives at Bob → imports gen 1 → drains the parked
      // re-emit → re-emits the SAME update under a NEW seq + gen 1.
      await hold.release()
      await wait(400)

      // Bob caught up to gen 1...
      expect(await adapterGeneration(bobAdapter, spaceId)).toBe(1)
      // ...and his lagging write CONVERGED to Alice (the legitimate lagger is not lost).
      expect(aliceHandle.getDoc().items['lag']?.title).toBe('written-while-lagging')
      // No double-effect: exactly one 'lag' item.
      expect(Object.keys(aliceHandle.getDoc().items).filter((k) => k === 'lag')).toHaveLength(1)
      // The earlier write survives too (no state loss across the re-emit).
      expect(aliceHandle.getDoc().items['pre']?.title).toBe('pre-rotation')

      bobHandle.close()
      aliceHandle.close()
    } finally {
      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    }
  })
})
