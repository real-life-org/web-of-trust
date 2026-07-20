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
import { KEY_ROTATION_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, resolveDidKey, x25519PublicKeyToMultibase } from '@web_of_trust/core/protocol'
import type { WireMessage, PendingRemoval } from '@web_of_trust/core/ports'
import { stageRotateSpaceKey, createSpaceKey, rotateSpaceKey, buildKeyRotationBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import { getYjsPersonalDoc, initYjsPersonalDoc, resetYjsPersonalDoc } from '../src/YjsPersonalDocManager'

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

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

/** Number of durable log entries the broker holds for a doc (B3 durability proof). */
function brokerEntryCount(broker: InProcessLogBroker, docId: string): number {
  return (broker as unknown as { docs: Map<string, { entries: Map<string, unknown> }> }).docs.get(docId)?.entries.size ?? 0
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
    overrides: Partial<{
      docLogStore: InMemoryDocLogStore
      keyManagement: InMemoryKeyManagementAdapter
      metadataStorage: InMemorySpaceMetadataStorage
      compactStore: InMemoryCompactStore
      flushPersonalDoc: () => Promise<void>
    }> = {},
  ): Promise<YjsReplicationAdapter> {
    const docLogStore = overrides.docLogStore ?? new InMemoryDocLogStore()
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
    return new YjsReplicationAdapter({
      identity,
      messaging,
      brokerUrls: BROKER_URLS,
      keyManagement: overrides.keyManagement ?? new InMemoryKeyManagementAdapter(),
      metadataStorage: overrides.metadataStorage ?? new InMemorySpaceMetadataStorage(),
      compactStore: overrides.compactStore ?? new InMemoryCompactStore(),
      docLogStore,
      enableLogSync: true,
      deviceId,
      flushPersonalDoc: overrides.flushPersonalDoc ?? (async () => {}),
      // Mirrors Sync-004 discovery: an invitee starts with an empty local
      // member-key cache, then resolves remaining recipients from DID keyAgreement.
      didResolver: {
        resolve: async (did) => {
          const known = did === alice.getDid() ? alice : did === bob.getDid() ? bob : undefined
          if (!known) return resolveDidKey(did)
          return resolveDidKey(did, {
            keyAgreement: [{
              id: `${did}#enc-0`, type: 'X25519KeyAgreementKey2020', controller: did,
              publicKeyMultibase: x25519PublicKeyToMultibase(await known.getEncryptionPublicKeyBytes()),
            }],
          })
        },
      },
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

  it('WIRING (I-READ): a DUPLICATE key-rotation drives the coordinator blocked-by-key replay (ignore-stale-or-duplicate call-site)', async () => {
    // The guard tests validate the guard MECHANICS in isolation (fake coordinator). This test
    // exercises the actual ignore-stale-or-duplicate CALL-SITE end-to-end so that removing the
    // replayBlockedByKeyForSpace wiring from that branch would be caught (the model's
    // deterministic ordering test, at the wiring level).
    const spaceId = await createSharedSpace()

    // Fabricate a valid gen-1 rotation from alice (admin) to bob (real inner-JWS + capability).
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

    // First delivery: bob APPLIES gen 1 (apply branch).
    await aliceMessaging.send(await makeRotation())
    await wait(200)
    expect(await adapterGeneration(bobAdapter, spaceId)).toBe(1)

    // Spy on bob's coordinator's blocked-by-key replay (set up AFTER the apply so only the
    // duplicate's replay is counted).
    const coordinator = (bobAdapter as unknown as {
      coordinators: Map<string, { replayBlockedByKey: () => Promise<number> }>
    }).coordinators.get(spaceId)
    expect(coordinator).toBeTruthy()
    let replayCalls = 0
    const realReplay = coordinator!.replayBlockedByKey.bind(coordinator)
    coordinator!.replayBlockedByKey = async () => { replayCalls += 1; return realReplay() }

    // Second delivery of a fresh envelope carrying the SAME gen-1 body → bob is already at
    // gen 1 → ignore-stale-or-duplicate branch → the wiring MUST call replayBlockedByKeyForSpace
    // → coordinator.replayBlockedByKey. A removed call-site would leave replayCalls at 0.
    await aliceMessaging.send(await makeRotation())
    await wait(200)
    expect(await adapterGeneration(bobAdapter, spaceId)).toBe(1) // still gen 1 (duplicate, no re-apply)
    expect(replayCalls).toBeGreaterThanOrEqual(1)
  })

  it('I-CAP: content-key overtakes the inbox → duplicate key-rotation still imports capability → bob is WRITE-capable at gen 1', async () => {
    // The runtime bug as a regression: the gen-1 CONTENT key reaches Device 2 first (fast
    // PersonalDoc/Vault sync), so the arriving key-rotation classifies as a duplicate. Before
    // I-CAP the capability signing seed was discarded → Device 2 could read but not write.
    const spaceId = await createSharedSpace()

    const port = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: alice.getDid() })
    const rotationBody = await buildKeyRotationBody({ keyPort: port, spaceId, newGeneration: 1, recipientDid: bob.getDid() })
    const gen1ContentKey = (await port.getKeyByGeneration(spaceId, 1))!

    // Simulate the content-key OVERTAKE: bob has the gen-1 content key (byte-identical to the
    // body) but NO capability material yet → the arriving rotation will be a duplicate.
    const bobKeys = (bobAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    await bobKeys.saveKey(spaceId, 1, gen1ContentKey)
    expect(await bobKeys.getCurrentGeneration(spaceId)).toBe(1)
    expect(await bobKeys.getCapabilitySigningSeed(spaceId, 1)).toBeNull() // read-only so far

    // Deliver the gen-1 key-rotation → bob is already at gen 1 → ignore-stale-or-duplicate →
    // I-CAP imports the capability signing material (content-bound).
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

    // WRITE-capable now: the capability signing seed + own capability for gen 1 are present.
    expect(await bobKeys.getCapabilitySigningSeed(spaceId, 1)).not.toBeNull()
    expect(await bobKeys.getOwnCapability(spaceId, 1)).toBe(rotationBody.capability)
  })

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

  it('non-admin self-leave commits and publishes removed@next-generation without sending space-rotate', async () => {
    // Alice created the space and is its only registered admin; Bob is merely an
    // active member. This is deliberately the real log-sync harness (durable
    // DocLogStore + control frames + broker), not the legacy content path.
    const spaceId = await createSharedSpace()
    await initYjsPersonalDoc(bob)
    // The real invite path deliberately leaves this cache empty.  Delivery must
    // resolve Alice through DID keyAgreement and get Bob's own key from Identity.
    const bobState = (bobAdapter as unknown as { spaces: Map<string, { memberEncryptionKeys: Map<string, Uint8Array> }> }).spaces.get(spaceId)!
    expect(bobState.memberEncryptionKeys.size).toBe(0)
    const entriesBefore = brokerEntryCount(broker, spaceId)
    const sentMemberUpdates: WireMessage[] = []
    const sentKeyRotations: WireMessage[] = []
    const controlFrames: unknown[] = []
    const baseSend = bobMessaging.send.bind(bobMessaging)
    const baseControl = bobMessaging.sendControlFrame!.bind(bobMessaging)
    ;(bobMessaging as unknown as { send: typeof bobMessaging.send }).send = async (message) => {
      if ((message as { type?: unknown }).type === MEMBER_UPDATE_MESSAGE_TYPE) sentMemberUpdates.push(message)
      return baseSend(message)
    }
    ;(bobMessaging as unknown as { sendControlFrame: NonNullable<typeof bobMessaging.sendControlFrame> }).sendControlFrame = async (frame) => {
      controlFrames.push(frame)
      // A real broker would reject this with AUTH_INVALID because Bob is not an
      // admin. The assertion below proves the new path never attempts it.
      if ((frame as { type?: unknown }).type === 'space-rotate') throw new Error('AUTH_INVALID: non-admin rotate')
      return baseControl(frame)
    }
    const aliceBaseSend = aliceMessaging.send.bind(aliceMessaging)
    ;(aliceMessaging as unknown as { send: typeof aliceMessaging.send }).send = async (message) => {
      if ((message as { type?: unknown }).type === KEY_ROTATION_MESSAGE_TYPE) sentKeyRotations.push(message)
      return aliceBaseSend(message)
    }

    await bobAdapter.leaveSpace(spaceId)

    expect(controlFrames.filter(frame => (frame as { type?: unknown }).type === 'space-rotate')).toHaveLength(0)
    expect(sentMemberUpdates).toHaveLength(2) // own DID (sibling devices) + remaining admin
    expect(brokerEntryCount(broker, spaceId)).toBeGreaterThan(entriesBefore)
    expect(await adapterGeneration(bobAdapter, spaceId)).toBe(-1) // cleanup wipes all departed-space key material
    expect(await pendingRemoval(bobAdapter, spaceId, bob.getDid())).toBeNull()
    expect(await bobAdapter.getSpace(spaceId)).toBeNull() // post-flush local cleanup

    // #298: Alice observes the canonical (not merely pending) self-removal and
    // performs the pure enforcement flow once.  Bob itself remains non-admin and
    // never sent a rotate or minted the follow-up key material.
    await wait(250)
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    expect(await adapterGeneration(aliceAdapter, spaceId)).toBe(1)
    expect(sentKeyRotations).toHaveLength(1)
    // A repeated observer pass sees generation >= declaration and is a no-op.
    const aliceState = (aliceAdapter as unknown as { spaces: Map<string, { doc: any }> }).spaces.get(spaceId)!
    await (aliceAdapter as unknown as { enforceCanonicalSelfRemovalRotation: (state: unknown, events: unknown[]) => Promise<void>, readMembershipEvents: (doc: unknown) => unknown[] })
      .enforceCanonicalSelfRemovalRotation(aliceState, (aliceAdapter as unknown as { readMembershipEvents: (doc: unknown) => unknown[] }).readMembershipEvents(aliceState.doc))
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    expect(sentKeyRotations).toHaveLength(1)

    const removals = Object.values(getYjsPersonalDoc().membershipRemovals ?? {})
      .filter(removal => removal.spaceId === spaceId)
    expect(removals).toHaveLength(1)
    expect(removals[0]).toMatchObject({
      removedDid: bob.getDid(),
      generation: 1,
      byDid: bob.getDid(),
    })
    await resetYjsPersonalDoc()
  })

  it('B1: non-admin self-leave retries an applied-but-unlogged removal before cleanup', async () => {
    const spaceId = await createSharedSpace()
    await initYjsPersonalDoc(bob)
    const store = (bobAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const realAppend = store.appendLocalEntry.bind(store)
    let failOnce = true
    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = (async (params: any) => {
      if (failOnce) {
        failOnce = false
        throw new Error('simulated self-leave append failure')
      }
      return realAppend(params)
    }) as typeof store.appendLocalEntry

    await expect(bobAdapter.leaveSpace(spaceId)).rejects.toThrow('simulated self-leave append failure')
    expect(await bobAdapter.getSpace(spaceId)).not.toBeNull()
    expect(Object.values(getYjsPersonalDoc().membershipRemovals ?? {}).filter((entry) => entry.spaceId === spaceId)).toHaveLength(0)

    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = realAppend
    const beforeRetry = brokerEntryCount(broker, spaceId)
    await bobAdapter.leaveSpace(spaceId)
    await wait(200)

    expect(brokerEntryCount(broker, spaceId)).toBeGreaterThan(beforeRetry)
    expect(await bobAdapter.getSpace(spaceId)).toBeNull()
    const removals = Object.values(getYjsPersonalDoc().membershipRemovals ?? {})
      .filter((entry) => entry.spaceId === spaceId)
    expect(removals).toHaveLength(1)
    expect(removals[0]).toMatchObject({ removedDid: bob.getDid(), generation: 1 })
    await resetYjsPersonalDoc()
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
    // The membership-removal entry never reached the broker (the append threw).
    const brokerEntriesAfterFail = brokerEntryCount(broker, spaceId)

    // Restore + drive recovery: with the store healthy, recovery completes the removal.
    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = realAppend
    await (aliceAdapter as unknown as { recoverPendingRemovalsOnce: () => Promise<void> }).recoverPendingRemovalsOnce()
    await wait(200)
    expect(await pendingRemoval(aliceAdapter, spaceId, bob.getDid())).toBeNull()
    // B3 retry-hole teeth: the staging is cleared ONLY because a durable membership
    // entry was now actually published — the broker's durable log GREW during recovery.
    // The first attempt applied the membership event locally before the append threw, so
    // a naive `map.has(key)` grow-only skip on retry would clear the staging WITHOUT
    // writing any durable entry — the broker count would NOT grow. It must.
    expect(brokerEntryCount(broker, spaceId)).toBeGreaterThan(brokerEntriesAfterFail)
  })

  it('B2: admin self-leave resumes its confirmed pending removal before cleanup and wipes all follow-up key material', async () => {
    const spaceId = await createSharedSpace()
    await initYjsPersonalDoc(alice)
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const keyPort = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    const sentKeyRotations: WireMessage[] = []
    const baseSend = aliceMessaging.send.bind(aliceMessaging)
    ;(aliceMessaging as unknown as { send: typeof aliceMessaging.send }).send = async (message) => {
      if ((message as { type?: unknown }).type === KEY_ROTATION_MESSAGE_TYPE) sentKeyRotations.push(message)
      return baseSend(message)
    }
    const realAppend = store.appendLocalEntry.bind(store)
    let failOnce = true
    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = (async (params: any) => {
      if (failOnce) {
        failOnce = false
        throw new Error('simulated admin self-leave append failure')
      }
      return realAppend(params)
    }) as typeof store.appendLocalEntry

    await expect(aliceAdapter.leaveSpace(spaceId)).rejects.toThrow('simulated admin self-leave append failure')
    expect(brokerGeneration(broker, spaceId)).toBe(1)
    expect(await pendingRemoval(aliceAdapter, spaceId, alice.getDid())).not.toBeNull()
    expect(await aliceAdapter.getSpace(spaceId)).not.toBeNull()

    ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = realAppend
    await aliceAdapter.leaveSpace(spaceId)
    await wait(200)

    expect(await pendingRemoval(aliceAdapter, spaceId, alice.getDid())).toBeNull()
    expect(await aliceAdapter.getSpace(spaceId)).toBeNull()
    expect(await keyPort.getCurrentGeneration(spaceId)).toBe(-1)
    expect(await keyPort.getKeyByGeneration(spaceId, 1)).toBeNull()
    expect(await keyPort.getCapabilitySigningSeed(spaceId, 1)).toBeNull()
    expect(await keyPort.getOwnCapability(spaceId, 1)).toBeNull()
    expect(sentKeyRotations).toHaveLength(1) // Bob only; never Alice / own devices
    const removals = Object.values(getYjsPersonalDoc().membershipRemovals ?? {})
      .filter((entry) => entry.spaceId === spaceId)
    expect(removals).toHaveLength(1)
    await resetYjsPersonalDoc()
  })

  it('REVIEW-REPRO self-leave: a flush failure after confirmed admin-remove keeps admin-removed; a fresh unloaded adapter recovers exactly one PersonalDoc entry and cleanup', async () => {
    const spaceId = await createSharedSpace()
    await initYjsPersonalDoc(alice)
    const store = (aliceAdapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const keyManagement = (aliceAdapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    let failFlushOnce = true
    ;(aliceAdapter as unknown as { flushPersonalDoc: () => Promise<void> }).flushPersonalDoc = async () => {
      if (failFlushOnce) {
        failFlushOnce = false
        throw new Error('injected flush failure after admin-remove')
      }
    }

    await expect(aliceAdapter.leaveSpace(spaceId)).rejects.toThrow('injected flush failure after admin-remove')
    expect((await pendingRemoval(aliceAdapter, spaceId, alice.getDid()))?.phase).toBe('admin-removed')
    expect(await aliceAdapter.getSpace(spaceId)).not.toBeNull()
    expect(Object.values(getYjsPersonalDoc().membershipRemovals ?? {}).filter((entry) => entry.spaceId === spaceId)).toHaveLength(1)

    // Restart simulation: the durable store and keys survive, but metadata is
    // intentionally absent, so no Yjs space is loaded. Terminal cleanup must not
    // depend on restoring the old CRDT document.
    await aliceAdapter.stop()
    const restarted = await makeAdapter(alice, aliceMessaging, DEVICE_ALICE, {
      docLogStore: store,
      keyManagement,
      metadataStorage: new InMemorySpaceMetadataStorage(),
      flushPersonalDoc: async () => {},
    })
    await restarted.start()
    await wait(200)

    expect(await restarted.getSpace(spaceId)).toBeNull()
    expect(await store.getPendingRemoval(spaceId, alice.getDid())).toBeNull()
    expect(await keyManagement.getCurrentGeneration(spaceId)).toBe(-1)
    expect(Object.values(getYjsPersonalDoc().membershipRemovals ?? {}).filter((entry) => entry.spaceId === spaceId)).toHaveLength(1)
    await restarted.stop()
    await resetYjsPersonalDoc()
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
