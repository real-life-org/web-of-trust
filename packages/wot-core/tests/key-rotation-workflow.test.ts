import { describe, expect, it } from 'vitest'
import { createSpaceKey, rotateSpaceKey } from '../src/application/sync/group-key-workflow'
import { buildKeyRotationBody, applyKeyRotationBody } from '../src/application/sync/key-rotation-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { assertKeyRotationBody, verifySpaceCapabilityJws } from '../src/protocol'
import type { KeyRotationBody } from '../src/protocol'

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE = '11111111-1111-4111-8111-111111111111'
const OWNER = 'did:key:z6MkOwnerOwnerOwner'
const ADMIN = 'did:key:z6MkAdminAdminAdmin'
const RECIPIENT = 'did:key:z6MkRecipientRecipient'
const OTHER = 'did:key:z6MkOtherOtherOther'

/** Sender port with content key + capability material at generations 0..n. */
async function senderPortAtGen(n: number): Promise<InMemoryKeyManagementAdapter> {
  const port = new InMemoryKeyManagementAdapter()
  await createSpaceKey({ crypto, keyPort: port, spaceId: SPACE, ownerDid: OWNER })
  for (let g = 0; g < n; g++) await rotateSpaceKey({ crypto, keyPort: port, spaceId: SPACE, ownerDid: OWNER })
  return port
}
/** Receiver port with plain content keys at generations 0..n (no capability material yet). */
async function receiverPortAtGen(n: number): Promise<InMemoryKeyManagementAdapter> {
  const port = new InMemoryKeyManagementAdapter()
  for (let g = 0; g <= n; g++) await port.saveKey(SPACE, g, new Uint8Array(32).fill(g + 1))
  return port
}

describe('key-rotation-workflow', () => {
  it('buildKeyRotationBody produces a schema-valid body whose capability verifies', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    expect(() => assertKeyRotationBody(body)).not.toThrow()
    expect(body.generation).toBe(1)
    const verificationKey = await crypto.ed25519PublicKeyFromSeed(
      (await sender.getCapabilitySigningSeed(SPACE, 1))!,
    )
    const payload = await verifySpaceCapabilityJws(body.capability, {
      crypto, publicKey: verificationKey, expectedSpaceId: SPACE, expectedAudience: RECIPIENT, expectedGeneration: 1,
    })
    expect(payload.audience).toBe(RECIPIENT)
  })

  it('buildKeyRotationBody rejects an invalid validityDurationMs', async () => {
    const sender = await senderPortAtGen(1)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT, validityDurationMs: bad }),
      ).rejects.toThrow(/validityDurationMs/)
    }
  })

  it('buildKeyRotationBody throws when the content key is missing', async () => {
    const sender = await senderPortAtGen(0)
    await expect(buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 5, recipientDid: RECIPIENT })).rejects.toThrow()
  })

  it('buildKeyRotationBody throws when the capability signing seed is missing', async () => {
    const sender = new InMemoryKeyManagementAdapter()
    await sender.saveKey(SPACE, 0, new Uint8Array(32).fill(1)) // content key but no capability seed
    await expect(buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 0, recipientDid: RECIPIENT })).rejects.toThrow()
  })

  it('applyKeyRotationBody applies a valid admin-signed rotation and persists all material', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(0)
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(result.decision).toBe('apply')
    expect(await receiver.getCurrentGeneration(SPACE)).toBe(1)
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).not.toBeNull()
    expect(await receiver.getCapabilityVerificationKey(SPACE, 1)).not.toBeNull()
    expect(await receiver.getOwnCapability(SPACE, 1)).toBe(body.capability)
  })

  it('C5: rejects a valid body from a non-admin sender without touching the port', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(0)
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: OTHER, knownAdminDids: [ADMIN] })
    expect(result).toEqual({ decision: 'reject', reason: 'unauthorized-sender' })
    expect(await receiver.getCurrentGeneration(SPACE)).toBe(0) // unchanged
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).toBeNull()
  })

  it('rejects a capability whose audience does not match the recipient', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(0)
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: OTHER, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(result).toEqual({ decision: 'reject', reason: 'invalid-capability' })
  })

  it('rejects when capability.generation does not match body.generation', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const tampered: KeyRotationBody = { ...body, generation: 2 } // capability still says gen 1
    const receiver = await receiverPortAtGen(0)
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body: tampered, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(result).toEqual({ decision: 'reject', reason: 'invalid-capability' })
  })

  it('throws on a malformed body (schema assertion outside the try/catch)', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const malformed = { ...body } as Partial<KeyRotationBody>
    delete malformed.spaceContentKey
    const receiver = await receiverPortAtGen(0)
    await expect(applyKeyRotationBody({ crypto, keyPort: receiver, body: malformed as KeyRotationBody, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })).rejects.toThrow()
  })

  it('buffers a future-generation rotation (> local+1) without persisting', async () => {
    const sender = await senderPortAtGen(2)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 2, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(0) // local gen 0, incoming 2 > 0+1
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(result.decision).toBe('future-buffer')
    expect(await receiver.getCurrentGeneration(SPACE)).toBe(0) // unchanged
    expect(await receiver.getCapabilitySigningSeed(SPACE, 2)).toBeNull()
  })

  it('ignores a stale-or-duplicate rotation (<= local) whose content key DIVERGES — no capability import (conflict)', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(1) // local gen 1 with a DIFFERENT content key than the body
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(result).toEqual({ decision: 'ignore-stale-or-duplicate', capabilityImport: 'conflict' })
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).toBeNull() // capability NOT persisted (poison-resistant)
  })

  // ── I-CAP: content-bound capability import on the duplicate path ──────────────────
  // (the content key legitimately overtakes the key-rotation message on a 2nd device)

  /** A receiver whose gen-1 CONTENT key already matches the body (PersonalDoc overtook the inbox),
   *  but with NO capability material yet — exactly the runtime bug scenario. */
  async function receiverWithOvertakenContentKey(body: KeyRotationBody, sender: InMemoryKeyManagementAdapter): Promise<InMemoryKeyManagementAdapter> {
    const receiver = new InMemoryKeyManagementAdapter()
    await receiver.saveKey(SPACE, 0, new Uint8Array(32).fill(7))
    await receiver.saveKey(SPACE, 1, (await sender.getKeyByGeneration(SPACE, 1))!) // byte-identical to body.spaceContentKey
    return receiver
  }

  it('I-CAP: imports the capability seed on a duplicate when the content key is byte-identical (current gen)', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverWithOvertakenContentKey(body, sender)

    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })

    expect(result).toEqual({ decision: 'ignore-stale-or-duplicate', capabilityImport: 'imported' })
    // The device can now WRITE: the capability signing seed + own-capability are present + correct.
    const importedSeed = await receiver.getCapabilitySigningSeed(SPACE, 1)
    expect(importedSeed).not.toBeNull()
    expect(importedSeed).toEqual(await sender.getCapabilitySigningSeed(SPACE, 1))
    expect(await receiver.getOwnCapability(SPACE, 1)).toBe(body.capability)
  })

  it('I-CAP: content-binding negative — a DIVERGENT spaceContentKey does not import (conflict, existing material untouched)', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    // Receiver at gen 1 but with a content key that is NOT the body's (a forged / divergent rotation).
    const receiver = new InMemoryKeyManagementAdapter()
    await receiver.saveKey(SPACE, 0, new Uint8Array(32).fill(7))
    await receiver.saveKey(SPACE, 1, new Uint8Array(32).fill(42)) // divergent

    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })

    expect(result).toEqual({ decision: 'ignore-stale-or-duplicate', capabilityImport: 'conflict' })
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).toBeNull()
  })

  it('I-CAP: never overwrites — identical existing seed → already-present (no store write), divergent → conflict', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const senderSeed = (await sender.getCapabilitySigningSeed(SPACE, 1))!
    const senderVk = (await sender.getCapabilityVerificationKey(SPACE, 1))!

    // (a) identical material already present → already-present, no re-write.
    const receiverSame = await receiverWithOvertakenContentKey(body, sender)
    await receiverSame.saveCapabilityKeyPair(SPACE, 1, senderSeed, senderVk)
    const same = await applyKeyRotationBody({ crypto, keyPort: receiverSame, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(same).toEqual({ decision: 'ignore-stale-or-duplicate', capabilityImport: 'already-present' })
    expect(await receiverSame.getCapabilitySigningSeed(SPACE, 1)).toEqual(senderSeed)

    // (b) DIVERGENT existing capability material → conflict, never overwritten.
    const receiverDiff = await receiverWithOvertakenContentKey(body, sender)
    const foreignSeed = new Uint8Array(32).fill(200)
    const foreignVk = await crypto.ed25519PublicKeyFromSeed(foreignSeed)
    await receiverDiff.saveCapabilityKeyPair(SPACE, 1, foreignSeed, foreignVk)
    const diff = await applyKeyRotationBody({ crypto, keyPort: receiverDiff, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(diff).toEqual({ decision: 'ignore-stale-or-duplicate', capabilityImport: 'conflict' })
    expect(await receiverDiff.getCapabilitySigningSeed(SPACE, 1)).toEqual(foreignSeed) // untouched
  })

  it('I-CAP: stale (incomingGen < currentGen) is not-applicable — no import (SF1)', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(2) // local gen 2, incoming 1 < current

    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })

    expect(result).toEqual({ decision: 'ignore-stale-or-duplicate', capabilityImport: 'not-applicable' })
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).toBeNull()
  })

  it('I-CAP: authority negative — a non-admin duplicate imports NOTHING (rejected before the gate)', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverWithOvertakenContentKey(body, sender)
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: OTHER, knownAdminDids: [ADMIN] })
    expect(result).toEqual({ decision: 'reject', reason: 'unauthorized-sender' })
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).toBeNull()
  })
})
