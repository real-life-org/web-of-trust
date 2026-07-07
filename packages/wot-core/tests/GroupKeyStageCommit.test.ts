import { describe, expect, it } from 'vitest'
import {
  commitStagedRotation,
  createSpaceKey,
  rotateSpaceKey,
  stageRotateSpaceKey,
} from '../src/application/sync/group-key-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { verifySpaceCapabilityJws } from '../src/protocol'

// Slice SR / VE-C1 — the stage/commit split of group-key rotation. STAGE generates
// the next-generation material WITHOUT persisting or advancing the live generation;
// COMMIT activates exactly that material. stage→commit MUST be byte-identical to the
// pre-split single-shot rotateSpaceKey, and a stage on its own MUST be a no-op for
// getCurrentGeneration (that is the whole point of staging != commit).

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE = '11111111-1111-4111-8111-111111111111'
const OWNER = 'did:key:z6MkOwnerStageCommit'

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

async function seedGen0(): Promise<InMemoryKeyManagementAdapter> {
  const keyPort = new InMemoryKeyManagementAdapter()
  await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
  return keyPort
}

describe('group-key stage/commit split (Slice SR / VE-C1)', () => {
  it('stageRotateSpaceKey generates next-gen material WITHOUT advancing the live generation or persisting anything', async () => {
    const keyPort = await seedGen0()
    const g0Key = (await keyPort.getCurrentKey(SPACE))!

    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })

    // staged material is for generation 1, 32-byte keys
    expect(staged.newGeneration).toBe(1)
    expect(staged.contentKey.length).toBe(32)
    expect(staged.capabilitySigningSeed.length).toBe(32)
    expect(staged.capabilityVerificationKey.length).toBe(32)
    // ...but NOTHING is persisted: live generation is still 0, gen-0 key unchanged,
    // and no key / capability material exists at generation 1.
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(0)
    expect(hex((await keyPort.getCurrentKey(SPACE))!)).toBe(hex(g0Key))
    expect(await keyPort.getKeyByGeneration(SPACE, 1)).toBeNull()
    expect(await keyPort.getCapabilityVerificationKey(SPACE, 1)).toBeNull()
    expect(await keyPort.getOwnCapability(SPACE, 1)).toBeNull()
  })

  it('a second stage without an intervening commit re-targets generation 1 with FRESH material (no generation drift)', async () => {
    const keyPort = await seedGen0()
    const a = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    const b = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    // Both target gen 1 (the live generation never moved) but the material differs.
    expect(a.newGeneration).toBe(1)
    expect(b.newGeneration).toBe(1)
    expect(hex(a.contentKey)).not.toBe(hex(b.contentKey))
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(0)
  })

  it('commitStagedRotation activates EXACTLY the staged material and advances the generation', async () => {
    const keyPort = await seedGen0()
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })

    const r = await commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged })

    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)
    // the activated content key + capability verification key are byte-identical to
    // the staged material (so the space-rotate frame's key matches what is activated)
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(hex(staged.contentKey))
    expect(hex((await keyPort.getCapabilityVerificationKey(SPACE, 1))!)).toBe(hex(staged.capabilityVerificationKey))
    expect(hex(r.contentKey)).toBe(hex(staged.contentKey))
    expect(hex(r.capabilityVerificationKey)).toBe(hex(staged.capabilityVerificationKey))
    // the owner self-capability verifies against the staged verification key at gen 1
    const payload = await verifySpaceCapabilityJws(r.ownCapabilityJws, {
      crypto,
      publicKey: staged.capabilityVerificationKey,
      expectedSpaceId: SPACE,
      expectedAudience: OWNER,
      expectedGeneration: 1,
    })
    expect(payload.audience).toBe(OWNER)
    expect(await keyPort.getOwnCapability(SPACE, 1)).toBe(r.ownCapabilityJws)
  })

  it('rotateSpaceKey == stage immediately followed by commit (generation 0 key survives either way)', async () => {
    // single-shot path
    const kpSingle = await seedGen0()
    const g0Single = (await kpSingle.getKeyByGeneration(SPACE, 0))!
    await rotateSpaceKey({ crypto, keyPort: kpSingle, spaceId: SPACE, ownerDid: OWNER })

    // explicit stage→commit path
    const kpSplit = await seedGen0()
    const g0Split = (await kpSplit.getKeyByGeneration(SPACE, 0))!
    const staged = await stageRotateSpaceKey({ crypto, keyPort: kpSplit, spaceId: SPACE, ownerDid: OWNER })
    await commitStagedRotation({ crypto, keyPort: kpSplit, spaceId: SPACE, ownerDid: OWNER, staged })

    // both advanced to gen 1 and kept gen 0 retrievable (Sync 005 Z.285)
    expect(await kpSingle.getCurrentGeneration(SPACE)).toBe(1)
    expect(await kpSplit.getCurrentGeneration(SPACE)).toBe(1)
    expect(hex((await kpSingle.getKeyByGeneration(SPACE, 0))!)).toBe(hex(g0Single))
    expect(hex((await kpSplit.getKeyByGeneration(SPACE, 0))!)).toBe(hex(g0Split))
  })

  // --- B4: generation-drift guard on commitStagedRotation -------------------

  it('B4 idempotent re-commit: committing the SAME staged material twice is a no-op on the second call (identical material, no re-write, no throw)', async () => {
    const keyPort = await seedGen0()
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })

    const first = await commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged })
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)

    // A second commit of the SAME staged material (e.g. a re-commit after a crash
    // between activation and deletePendingRemoval) must be an idempotent no-op: same
    // generation, byte-identical material, the original own-capability preserved.
    const second = await commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged })
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(hex(staged.contentKey))
    expect(hex(second.contentKey)).toBe(hex(first.contentKey))
    // The own-capability JWS is the ORIGINAL (read from the store), not a fresh re-sign.
    expect(second.ownCapabilityJws).toBe(await keyPort.getOwnCapability(SPACE, 1))
    expect(second.ownCapabilityJws).toBe(first.ownCapabilityJws)
  })

  it('B4 DRIFT: a stale stage whose generation was overtaken by a DIVERGENT rotation MUST throw and must NOT overwrite the live key material', async () => {
    // A removal staged a rotation to generation 1, but before it committed, ANOTHER
    // rotation advanced the live generation to 1 with DIFFERENT material. Activating
    // the stale stage would silently overwrite the active key → corrupt the space.
    const keyPort = await seedGen0()
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })

    // An intervening real rotation lands generation 1 with FRESH (divergent) material.
    await rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)
    const liveGen1 = hex((await keyPort.getKeyByGeneration(SPACE, 1))!)
    expect(liveGen1).not.toBe(hex(staged.contentKey)) // the stage and the live key diverge

    // Committing the stale stage at generation 1 with DIVERGENT material is a drift
    // hazard → hard throw.
    await expect(
      commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged }),
    ).rejects.toThrow(/stale staged generation drift/)

    // The live generation-1 material is UNTOUCHED (the stale stage did not overwrite it).
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(liveGen1)
  })

  it('B4 DRIFT: a stale stage whose target generation the live generation has already moved PAST throws', async () => {
    // staged@gen1, but the live generation jumped to 2 via intervening rotations →
    // current (2) is neither newGen-1 (0) nor newGen (1) → hard throw.
    const keyPort = await seedGen0()
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    await rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER }) // → gen 1
    await rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER }) // → gen 2
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(2)
    const liveGen2 = hex((await keyPort.getKeyByGeneration(SPACE, 2))!)

    await expect(
      commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged }),
    ).rejects.toThrow(/stale staged generation drift/)
    // No collateral damage to the live generation.
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(2)
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 2))!)).toBe(liveGen2)
  })

  it('B4/SR-4 PARTIAL-CRASH REPAIR: content key persisted but capability chain missing (crash between writes) → commit COMPLETES the activation, does not wedge', async () => {
    // commitStagedRotation activation is non-atomic (saveKey → saveCapabilityKeyPair →
    // saveOwnCapability are separate writes). A crash after saveKey leaves the content
    // key at generation 1 but NO capability material. On retry the live generation is
    // already 1, so the old "drift" guard threw — wedging the removal forever. The
    // repair must instead finish the activation from the SAME staged material.
    const keyPort = await seedGen0()
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })

    // Simulate the partial crash: ONLY the content key was persisted.
    await keyPort.saveKey(SPACE, staged.newGeneration, staged.contentKey)
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(await keyPort.getCapabilityVerificationKey(SPACE, 1)).toBeNull() // capability missing

    // Retry: must NOT throw drift — it repairs by provisioning the capability chain.
    const r = await commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged })

    expect(hex((await keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(hex(staged.contentKey))
    expect(hex((await keyPort.getCapabilityVerificationKey(SPACE, 1))!)).toBe(hex(staged.capabilityVerificationKey))
    expect(await keyPort.getOwnCapability(SPACE, 1)).toBe(r.ownCapabilityJws)
    const payload = await verifySpaceCapabilityJws(r.ownCapabilityJws, {
      crypto,
      publicKey: staged.capabilityVerificationKey,
      expectedSpaceId: SPACE,
      expectedAudience: OWNER,
      expectedGeneration: 1,
    })
    expect(payload.audience).toBe(OWNER)
  })

  it('B4/SR-4 PARTIAL-CRASH REPAIR: capability key pair persisted but own-capability JWS missing → commit completes (re-mints the own-capability)', async () => {
    const keyPort = await seedGen0()
    const staged = await stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })

    // Simulate the later partial-crash window: content key + capability key pair saved,
    // but the own-capability JWS write did not land.
    await keyPort.saveKey(SPACE, staged.newGeneration, staged.contentKey)
    await keyPort.saveCapabilityKeyPair(SPACE, staged.newGeneration, staged.capabilitySigningSeed, staged.capabilityVerificationKey)
    expect(await keyPort.getOwnCapability(SPACE, 1)).toBeNull() // own-capability missing

    const r = await commitStagedRotation({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, staged })
    expect(await keyPort.getOwnCapability(SPACE, 1)).toBe(r.ownCapabilityJws)
    expect(hex(r.capabilityVerificationKey)).toBe(hex(staged.capabilityVerificationKey))
  })

  it('stageRotateSpaceKey fails fast on an invalid validityDurationMs and on an unknown space, persisting nothing', async () => {
    const keyPort = await seedGen0()
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        stageRotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER, validityDurationMs: bad }),
      ).rejects.toThrow(/validityDurationMs/)
    }
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(0) // nothing changed

    const empty = new InMemoryKeyManagementAdapter()
    await expect(
      stageRotateSpaceKey({ crypto, keyPort: empty, spaceId: SPACE, ownerDid: OWNER }),
    ).rejects.toThrow()
    expect(await empty.getCurrentGeneration(SPACE)).toBe(-1)
  })
})
