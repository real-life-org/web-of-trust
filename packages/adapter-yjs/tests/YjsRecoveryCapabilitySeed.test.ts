import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemorySpaceMetadataStorage, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

/**
 * #234 — a recovered / second device of the same member can WRITE to a space it can
 * already read. The capability signing seed travels with the content key via the
 * (owner-only) PersonalDoc, so restore imports both.
 *
 * We simulate the synced PersonalDoc with a SHARED metadataStorage between the two
 * devices (that is exactly what the A2 PersonalDoc log-sync gives them), and give each
 * device its OWN keyManagement (a real second device has empty local key material
 * until restore fills it).
 */
const TestDoc = () => ({ items: {} as Record<string, { title: string }> })

function createAdapter(
  identity: PublicIdentitySession,
  messaging: InMemoryMessagingAdapter,
  metadataStorage: InMemorySpaceMetadataStorage,
  keyManagement: InMemoryKeyManagementAdapter,
) {
  return new YjsReplicationAdapter({
    identity,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement,
    metadataStorage,
  })
}

describe('#234 recovery capability signing seed', () => {
  let alice: PublicIdentitySession
  let sharedMeta: InMemorySpaceMetadataStorage // the synced PersonalDoc both devices see
  let km1: InMemoryKeyManagementAdapter
  let km2: InMemoryKeyManagementAdapter
  let device1: YjsReplicationAdapter
  let msg1: InMemoryMessagingAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-234')).identity
    sharedMeta = new InMemorySpaceMetadataStorage()
    km1 = new InMemoryKeyManagementAdapter()
    km2 = new InMemoryKeyManagementAdapter()
    msg1 = new InMemoryMessagingAdapter()
    await msg1.connect(alice.getDid())
    device1 = createAdapter(alice, msg1, sharedMeta, km1)
    await device1.start()
  })

  afterEach(async () => {
    await device1.stop().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch { /* ignore */ }
  })

  it('persists the signing seed into the PersonalDoc when a space is created (gen 0)', async () => {
    const space = await device1.createSpace('shared', TestDoc(), { name: 'S', members: [alice.getDid()] })
    const seeds = await sharedMeta.loadCapabilitySigningSeeds(space.id)
    expect(seeds).toHaveLength(1)
    expect(seeds[0].generation).toBe(0)
    expect(seeds[0].seed.length).toBeGreaterThan(0)
    // sanity: device 1 can of course sign (it created the space).
    expect(await km1.getCapabilitySigningSeed(space.id, 0)).not.toBeNull()
  })

  it('a recovery device (fresh keyManagement) imports the seed on restore → can WRITE', async () => {
    const space = await device1.createSpace('shared', TestDoc(), { name: 'S', members: [alice.getDid()] })

    // Device 2: fresh key material, but sees the same (synced) PersonalDoc.
    const msg2 = new InMemoryMessagingAdapter()
    await msg2.connect(alice.getDid())
    const device2 = createAdapter(alice, msg2, sharedMeta, km2)

    // Before restore, device 2 has NO signing seed (this is the #234 bug).
    expect(await km2.getCapabilitySigningSeed(space.id, 0)).toBeNull()

    await device2.start() // → restoreSpacesFromMetadata → _reloadCapabilitySeeds

    // After restore, device 2 has the seed (content-bound import) AND the derived VK →
    // the write path (spaceCapabilitySource) no longer throws "No capability signing seed".
    const importedSeed = await km2.getCapabilitySigningSeed(space.id, 0)
    expect(importedSeed).not.toBeNull()
    expect(await km2.getCapabilityVerificationKey(space.id, 0)).not.toBeNull()
    // Both devices ended up with the same shared seed material.
    expect(Array.from(importedSeed!)).toEqual(Array.from((await km1.getCapabilitySigningSeed(space.id, 0))!))

    await device2.stop().catch(() => {})
  })

  it('never overwrites an existing local seed on import', async () => {
    const space = await device1.createSpace('shared', TestDoc(), { name: 'S', members: [alice.getDid()] })

    // Device 2 already has a (divergent) seed locally for this gen — import must not clobber it.
    const divergent = new Uint8Array(32).fill(7)
    const divergentVk = new Uint8Array(32).fill(9)
    await km2.saveCapabilityKeyPair(space.id, 0, divergent, divergentVk)

    const msg2 = new InMemoryMessagingAdapter()
    await msg2.connect(alice.getDid())
    const device2 = createAdapter(alice, msg2, sharedMeta, km2)
    await device2.start()

    expect(Array.from((await km2.getCapabilitySigningSeed(space.id, 0))!)).toEqual(Array.from(divergent))
    await device2.stop().catch(() => {})
  })

  it('does NOT import a seed for a generation without a matching content key (content-bound)', async () => {
    const space = await device1.createSpace('shared', TestDoc(), { name: 'S', members: [alice.getDid()] })

    // The shared doc carries a stray seed for gen 1 — but NO content key for gen 1
    // exists (no rotation happened). Content-binding must refuse to import it.
    const straySeed = new Uint8Array(32).fill(3)
    await sharedMeta.saveCapabilitySigningSeed({ spaceId: space.id, generation: 1, seed: straySeed })

    const msg2 = new InMemoryMessagingAdapter()
    await msg2.connect(alice.getDid())
    const device2 = createAdapter(alice, msg2, sharedMeta, km2)
    await device2.start()

    // gen 0 (has content key) imported; gen 1 (no content key) NOT imported.
    expect(await km2.getCapabilitySigningSeed(space.id, 0)).not.toBeNull()
    expect(await km2.getCapabilitySigningSeed(space.id, 1)).toBeNull()
    await device2.stop().catch(() => {})
  })
})
