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

  it('ignores a stale-or-duplicate rotation (<= local) without persisting', async () => {
    const sender = await senderPortAtGen(1)
    const body = await buildKeyRotationBody({ keyPort: sender, spaceId: SPACE, newGeneration: 1, recipientDid: RECIPIENT })
    const receiver = await receiverPortAtGen(1) // local gen 1, incoming 1 <= 1
    const result = await applyKeyRotationBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN, knownAdminDids: [ADMIN] })
    expect(result.decision).toBe('ignore-stale-or-duplicate')
    expect(await receiver.getCapabilitySigningSeed(SPACE, 1)).toBeNull() // capability not persisted
  })
})
