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
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'

/**
 * #234 Automerge parity — a recovered / second device of the same member imports the
 * capability signing seed on restore and gets WRITE material (not just read).
 * Shared metadataStorage = the synced (owner-only) PersonalDoc; separate keyManagement =
 * a real second device's empty local key material until restore fills it.
 */
describe('#234 recovery capability signing seed (Automerge parity)', () => {
  let alice: PublicIdentitySession
  let broker: InProcessLogBroker
  let sharedMeta: InMemorySpaceMetadataStorage
  let km1: InMemoryKeyManagementAdapter
  let km2: InMemoryKeyManagementAdapter
  let device1: AutomergeReplicationAdapter
  let msg1: InMemoryMessagingAdapter

  async function makeDevice(
    messaging: InMemoryMessagingAdapter,
    keyManagement: InMemoryKeyManagementAdapter,
    deviceId: string,
  ): Promise<AutomergeReplicationAdapter> {
    const docLogStore = new InMemoryDocLogStore()
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
    return new AutomergeReplicationAdapter({
      identity: alice,
      messaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement,
      metadataStorage: sharedMeta,
      repoStorage: new InMemoryRepoStorageAdapter(),
      docLogStore,
      deviceId,
    })
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    alice = (await createTestIdentity('alice-234-am')).identity
    sharedMeta = new InMemorySpaceMetadataStorage()
    km1 = new InMemoryKeyManagementAdapter()
    km2 = new InMemoryKeyManagementAdapter()
    msg1 = new InMemoryMessagingAdapter({ broker, socketId: 'alice-1' })
    await msg1.connect(alice.getDid())
    device1 = await makeDevice(msg1, km1, 'device-1')
    await device1.start()
  })

  afterEach(async () => {
    await device1.stop().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch { /* ignore */ }
  })

  it('a recovery device imports the seed on restore → write material present', async () => {
    const space = await device1.createSpace('shared', { items: {} }, { name: 'S', members: [alice.getDid()] })

    // seed persisted into the (shared) PersonalDoc at create.
    expect(await sharedMeta.loadCapabilitySigningSeeds(space.id)).toHaveLength(1)

    const msg2 = new InMemoryMessagingAdapter({ broker, socketId: 'alice-2' })
    await msg2.connect(alice.getDid())
    const device2 = await makeDevice(msg2, km2, 'device-2')

    expect(await km2.getCapabilitySigningSeed(space.id, 0)).toBeNull() // the #234 bug
    await device2.start() // restore → import
    expect(await km2.getCapabilitySigningSeed(space.id, 0)).not.toBeNull()
    expect(await km2.getCapabilityVerificationKey(space.id, 0)).not.toBeNull()

    await device2.stop().catch(() => {})
  })

  it('never overwrites an existing local seed on import', async () => {
    const space = await device1.createSpace('shared', { items: {} }, { name: 'S', members: [alice.getDid()] })
    const divergent = new Uint8Array(32).fill(7)
    await km2.saveCapabilityKeyPair(space.id, 0, divergent, new Uint8Array(32).fill(9))

    const msg2 = new InMemoryMessagingAdapter({ broker, socketId: 'alice-2' })
    await msg2.connect(alice.getDid())
    const device2 = await makeDevice(msg2, km2, 'device-2')
    await device2.start()

    expect(Array.from((await km2.getCapabilitySigningSeed(space.id, 0))!)).toEqual(Array.from(divergent))
    await device2.stop().catch(() => {})
  })
})
