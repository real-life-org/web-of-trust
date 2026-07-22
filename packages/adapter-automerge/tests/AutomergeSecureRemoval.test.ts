import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import { KEY_ROTATION_MESSAGE_TYPE, CapabilityKeysUnavailableError } from '@web_of_trust/core/protocol'
import type { WireMessage, PendingRemoval } from '@web_of_trust/core/ports'
import { stageRotateSpaceKey, createSpaceKey, rotateSpaceKey, buildKeyRotationBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

/**
 * Hold every `key-rotation/1.0` message addressed to this messaging adapter until
 * {@link MessageHold.release} — makes a still-active member a deterministic LEGITIME
 * LAGGER (VE-C2). Mirrors the Yjs adapter's secure-removal lagger test.
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
  return {
    get held() {
      return buffered.length
    },
    release: async () => {
      internal.deliverToSelf = original
      const toDeliver = buffered.splice(0)
      for (const m of toDeliver) await original(m)
    },
  }
}

// Slice SR / VE-C1 + VE-C3 — adapter-level wiring of the two-phase secure removal
// for the Automerge engine (parity with YjsSecureRemoval). The engine-neutral safety
// invariants live in wot-core's SecureRemovalWorkflow tests; this proves the Automerge
// adapter wires stage → space-rotate → commit to a real broker end-to-end.

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

/** Number of durable log entries the broker holds for a doc (B3 durability proof). */
function brokerEntryCount(broker: InProcessLogBroker, docId: string): number {
  return (broker as unknown as { docs: Map<string, { entries: Map<string, unknown> }> }).docs.get(docId)?.entries.size ?? 0
}

function adapterGeneration(adapter: AutomergeReplicationAdapter, spaceId: string): Promise<number> {
  return (adapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement.getCurrentGeneration(spaceId)
}

function pendingRemoval(adapter: AutomergeReplicationAdapter, spaceId: string, removedDid: string) {
  return (adapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore.getPendingRemoval(spaceId, removedDid)
}

describe('AutomergeReplicationAdapter — Slice SR secure removal (VE-C1 wiring)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let broker: InProcessLogBroker
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: AutomergeReplicationAdapter
  let bobAdapter: AutomergeReplicationAdapter

  async function makeAdapter(
    identity: PublicIdentitySession,
    messaging: InMemoryMessagingAdapter,
    deviceId: string,
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
    await wait(250)
    return space.id
  }

  it('SELF-LEAVE capability: rejects before staging because Automerge has no durable admin-remove capability', async () => {
    const spaceId = await createSharedSpace()
    await expect(aliceAdapter.removeMember(spaceId, alice.getDid()))
      .rejects.toThrow('secure self-leave is not supported by the Automerge adapter: durable admin-remove capability is unavailable')
    expect(await pendingRemoval(aliceAdapter, spaceId, alice.getDid())).toBeNull()
  })

  it('defers a keyless ghost capability source as blocked-by-key instead of validating generation -1', async () => {
    const source = (aliceAdapter as unknown as {
      spaceCapabilitySource: (spaceId: string) => { getCapabilityJws: () => Promise<string> }
    }).spaceCapabilitySource('keyless-reseed-ghost')

    await expect(source.getCapabilityJws()).rejects.toBeInstanceOf(CapabilityKeysUnavailableError)
  })

  it('WIRING (I-READ): a DUPLICATE key-rotation drives the coordinator blocked-by-key replay (ignore-stale-or-duplicate call-site)', async () => {
    // Automerge parity with the Yjs wiring test: exercise the actual ignore-stale-or-duplicate
    // CALL-SITE end-to-end so removing the replayBlockedByKeyForSpace wiring would be caught.
    const spaceId = await createSharedSpace()

    const port = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: alice.getDid() })
    const rotationBody = await buildKeyRotationBody({ keyPort: port, spaceId, newGeneration: 1, recipientDid: bob.getDid() })
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    const makeRotation = () => deliverInboxMessage({
      type: KEY_ROTATION_MESSAGE_TYPE,
      body: rotationBody as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: bobEncKey,
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    })

    await aliceMessaging.send(await makeRotation())
    await wait(200)
    expect(await adapterGeneration(bobAdapter, spaceId)).toBe(1)

    const coordinator = (bobAdapter as unknown as {
      coordinators: Map<string, { replayBlockedByKey: () => Promise<number> }>
    }).coordinators.get(spaceId)
    expect(coordinator).toBeTruthy()
    let replayCalls = 0
    const realReplay = coordinator!.replayBlockedByKey.bind(coordinator)
    coordinator!.replayBlockedByKey = async () => { replayCalls += 1; return realReplay() }

    await aliceMessaging.send(await makeRotation())
    await wait(200)
    expect(await adapterGeneration(bobAdapter, spaceId)).toBe(1)
    expect(replayCalls).toBeGreaterThanOrEqual(1)
  })

  it('I-CAP (parity): content-key overtakes the inbox → duplicate key-rotation still imports capability → bob is WRITE-capable at gen 1', async () => {
    const spaceId = await createSharedSpace()

    const port = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: alice.getDid() })
    const rotationBody = await buildKeyRotationBody({ keyPort: port, spaceId, newGeneration: 1, recipientDid: bob.getDid() })
    const gen1ContentKey = (await port.getKeyByGeneration(spaceId, 1))!

    const bobKeys = (bobAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    await bobKeys.saveKey(spaceId, 1, gen1ContentKey)
    expect(await bobKeys.getCurrentGeneration(spaceId)).toBe(1)
    expect(await bobKeys.getCapabilitySigningSeed(spaceId, 1)).toBeNull()

    await aliceMessaging.send(await deliverInboxMessage({
      type: KEY_ROTATION_MESSAGE_TYPE,
      body: rotationBody as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    }))
    await wait(200)

    expect(await bobKeys.getCapabilitySigningSeed(spaceId, 1)).not.toBeNull()
    expect(await bobKeys.getOwnCapability(spaceId, 1)).toBe(rotationBody.capability)
  })

  it('removeMember runs the two-phase flow end-to-end: broker rotated, generation advanced, member dropped, staging cleared', async () => {
    const spaceId = await createSharedSpace()
    expect((await aliceAdapter.getSpace(spaceId))!.members).toContain(bob.getDid())
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(0)
    expect(brokerGeneration(broker, spaceId) ?? 0).toBe(0)

    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait(250)

    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(1)
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    expect((await aliceAdapter.getSpace(spaceId))!.members).not.toContain(bob.getDid())
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).toBeNull()
  })

  it('GENERATION_GAP: catches up to the broker generation, restages its successor, and completes a foreign-member removal', async () => {
    const spaceId = await createSharedSpace()
    const remoteKeys = new InMemoryKeyManagementAdapter()

    // There is no direct broker-generation test control. An interrupted earlier
    // removal left a real stale stage for generation 2, while Alice and the broker
    // are both still at 0. The first space-rotate thus gets GENERATION_GAP with
    // body.currentGeneration=0. Recovery must call the real coordinator, then
    // discard that stale material and stage the broker successor (generation 1).
    await createSpaceKey({ crypto: protocolCrypto, keyPort: remoteKeys, spaceId, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: remoteKeys, spaceId, ownerDid: alice.getDid() })
    const staleStage = await stageRotateSpaceKey({ crypto: protocolCrypto, keyPort: remoteKeys, spaceId, ownerDid: alice.getDid() })
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    await store.putPendingRemoval({
      spaceId,
      removedDid: bob.getDid(),
      homeBrokerSet: BROKER_URLS,
      confirmedBrokerUrls: [],
      newGeneration: staleStage.newGeneration,
      stagedKeyMaterial: {
        contentKey: staleStage.contentKey,
        capSigningSeed: staleStage.capabilitySigningSeed,
        capVerificationKey: staleStage.capabilityVerificationKey,
      },
      createdAt: Date.now(),
    })
    expect(staleStage.newGeneration).toBe(2)
    expect(brokerGeneration(broker, spaceId) ?? 0).toBe(0)
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(0)

    const coordinator = (aliceAdapter as unknown as {
      coordinators: Map<string, { catchUp: () => Promise<{ complete: boolean }> }>
    }).coordinators.get(spaceId)!
    const realCatchUp = coordinator.catchUp.bind(coordinator)
    let catchUpCalls = 0
    coordinator.catchUp = async () => {
      catchUpCalls += 1
      return realCatchUp()
    }

    await (aliceAdapter as unknown as { recoverPendingRemovalsOnce: () => Promise<void> }).recoverPendingRemovalsOnce()
    await wait(300)

    expect(catchUpCalls).toBeGreaterThanOrEqual(1)
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(1)
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    expect((await aliceAdapter.getSpace(spaceId))!.members).not.toContain(bob.getDid())
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).toBeNull()
  })

  it('B3: if the durable membership-removal log append FAILS during commit, removeMember rejects and the PendingRemoval staging is PRESERVED (not deleted)', async () => {
    // B3 parity with Yjs: the canonical removed@newGeneration membership log entry MUST
    // be durable BEFORE the PendingRemoval staging is deleted. A durable append failure
    // AFTER broker enforcement leaves the removal pending for VE-C3 recovery — never
    // enforced + distributed with no membership-removal record.
    const spaceId = await createSharedSpace()
    expect((await aliceAdapter.getSpace(spaceId))!.members).toContain(bob.getDid())

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

    await expect(aliceAdapter.removeMember(spaceId, bob.getDid())).rejects.toThrow()
    await wait(150)

    // Enforcement precedes commit: the broker WAS rotated...
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    // ...but the staging is PRESERVED (durable membership record never written).
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).not.toBeNull()
    const brokerEntriesAfterFail = brokerEntryCount(broker, spaceId)

    // Restore + drive recovery → removal completes.
    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = realAppend
    await (aliceAdapter as unknown as { recoverPendingRemovalsOnce: () => Promise<void> }).recoverPendingRemovalsOnce()
    await wait(250)
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).toBeNull()
    // B3 retry-hole teeth: staging is cleared ONLY because a durable membership entry was
    // actually published — the broker's durable log GREW during recovery. The first
    // attempt applied the event locally before the append threw, so a naive `key in
    // _members` grow-only skip on retry would clear the staging WITHOUT a durable write
    // (broker count unchanged). It must grow.
    expect(brokerEntryCount(broker, spaceId)).toBeGreaterThan(brokerEntriesAfterFail)
  })

  it('SF: a recovery whose staged home broker differs from the adapter active broker does NOT confirm/commit — the removal stays pending (no wrong-broker confirmation)', async () => {
    // SF parity with Yjs: a durable record whose staged home broker is NOT the adapter
    // active broker must NOT be confirmed (the rotate would go over a different
    // transport). The removal stays pending for a correct retry.
    const spaceId = await createSharedSpace()
    const keyPort = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    const crypto = (aliceAdapter as unknown as { crypto: any }).crypto
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore

    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId, ownerDid: alice.getDid() })
    const STALE_BROKER = 'wss://old-broker.example.com'
    const record: PendingRemoval = {
      spaceId,
      removedDid: bob.getDid(),
      homeBrokerSet: [STALE_BROKER],
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

    await (aliceAdapter as unknown as { recoverPendingRemovalsOnce: () => Promise<void> }).recoverPendingRemovalsOnce()
    await wait(200)

    expect(brokerGeneration(broker, spaceId) ?? 0).toBe(0)
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(0)
    const still = await pendingRemoval(aliceAdapter, spaceId, bob.getDid())
    expect(still).not.toBeNull()
    expect(still!.confirmedBrokerUrls).toEqual([])
  })

  it('post-enforcement: a removed member can no longer land a write at the broker (its old-generation log-entry is gated out)', async () => {
    const spaceId = await createSharedSpace()
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)

    bobHandle.transact((doc) => { doc.items['pre'] = { title: 'pre-removal' } })
    await wait(250)
    expect(aliceHandle.getDoc().items['pre']?.title).toBe('pre-removal')

    await aliceAdapter.removeMember(spaceId, bob.getDid())
    await wait(250)
    expect(brokerGeneration(broker, spaceId)).toBe(1)

    bobHandle.transact((doc) => { doc.items['post'] = { title: 'post-removal-should-be-gated' } })
    await wait(300)
    expect(aliceHandle.getDoc().items['post']).toBeUndefined()

    bobHandle.close()
    aliceHandle.close()
  })

  it('VE-C2 legitimate lagger: a still-active member that missed the rotation gets KEY_GENERATION_STALE, catches up, re-emits, and converges (no SEQ_COLLISION, no double-effect)', async () => {
    // Parity with the Yjs lagger test. Three members: Alice (admin), Bob (the LAGGER,
    // stays active), Carol (removed). Alice removes Carol → rotation to gen 1. Bob is
    // HELD on the key-rotation, writes a stale gen-0 entry → broker rejects
    // KEY_GENERATION_STALE → the re-emit parks. Then Bob receives the rotation →
    // imports gen-1 → replayPendingReemits drains → re-emit under a NEW seq + gen 1 →
    // converges to Alice. Because VE-C2 lives in the engine-neutral coordinator, the
    // Automerge adapter inherits it once replayPendingReemits is wired on rotation-apply.
    const carol = (await createTestIdentity('carol-pass')).identity
    const carolMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'carol-socket' })
    await carolMessaging.connect(carol.getDid())
    const carolAdapter = await makeAdapter(carol, carolMessaging, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    await carolAdapter.start()

    try {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Lagger Space' })
      const spaceId = space.id
      await wait()
      await aliceAdapter.addMember(spaceId, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
      await wait(200)
      await aliceAdapter.addMember(spaceId, carol.getDid(), await carol.getEncryptionPublicKeyBytes())
      await wait(250)

      const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
      await wait(200)

      // Baseline: a pre-rotation write from Bob replicates to Alice (Bob is active).
      bobHandle.transact((doc) => { doc.items['pre'] = { title: 'pre-rotation' } })
      await wait(250)
      expect(aliceHandle.getDoc().items['pre']?.title).toBe('pre-rotation')
      expect(await adapterGeneration(bobAdapter, spaceId)).toBe(0)

      // HOLD Bob's key-rotation so he stays the lagger on gen 0.
      const hold = holdKeyRotations(bobMessaging)

      await aliceAdapter.removeMember(spaceId, carol.getDid())
      await wait(300)
      expect(brokerGeneration(broker, spaceId)).toBe(1)
      expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(1)
      expect(await adapterGeneration(bobAdapter, spaceId)).toBe(0)
      expect(hold.held).toBeGreaterThanOrEqual(1)

      // Bob writes under the stale gen-0 key → KEY_GENERATION_STALE → re-emit parks →
      // not yet at Alice.
      bobHandle.transact((doc) => { doc.items['lag'] = { title: 'written-while-lagging' } })
      await wait(300)
      expect(aliceHandle.getDoc().items['lag']).toBeUndefined()

      // The rotation arrives → Bob imports gen 1 → drains the parked re-emit → converges.
      await hold.release()
      await wait(500)

      expect(await adapterGeneration(bobAdapter, spaceId)).toBe(1)
      expect(aliceHandle.getDoc().items['lag']?.title).toBe('written-while-lagging')
      expect(Object.keys(aliceHandle.getDoc().items).filter((k) => k === 'lag')).toHaveLength(1)
      expect(aliceHandle.getDoc().items['pre']?.title).toBe('pre-rotation')

      bobHandle.close()
      aliceHandle.close()
    } finally {
      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    }
  })

  it('forgetSpaceLocally deletes key material and aborts this space\'s staged removal intent', async () => {
    const spaceId = await createSharedSpace()
    const keyPort = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    const crypto = (aliceAdapter as unknown as { crypto: any }).crypto
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId, ownerDid: alice.getDid() })
    await store.putPendingRemoval({
      spaceId, removedDid: bob.getDid(), homeBrokerSet: BROKER_URLS, confirmedBrokerUrls: [],
      newGeneration: staged.newGeneration,
      stagedKeyMaterial: { contentKey: staged.contentKey, capSigningSeed: staged.capabilitySigningSeed, capVerificationKey: staged.capabilityVerificationKey },
      createdAt: Date.now(),
    })

    await aliceAdapter.forgetSpaceLocally(spaceId)
    expect(await keyPort.getCurrentGeneration(spaceId)).toBe(-1)
    expect(await store.getPendingRemoval(spaceId, bob.getDid())).toBeNull()
  })
})
