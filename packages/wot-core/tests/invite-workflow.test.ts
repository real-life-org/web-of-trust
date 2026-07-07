import { describe, expect, it } from 'vitest'
import { createSpaceKey, rotateSpaceKey } from '../src/application/sync/group-key-workflow'
import { buildSpaceInviteBody, applySpaceInviteBody } from '../src/application/spaces/invite-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { assertSpaceInviteBody, verifySpaceCapabilityJws, encodeBase64Url } from '../src/protocol'
import type { SpaceInviteBody } from '../src/protocol'

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE = '11111111-1111-4111-8111-111111111111'
const OWNER = 'did:key:z6MkOwnerOwnerOwner'
const ADMIN = 'did:key:z6MkAdminAdminAdmin'
const RECIPIENT = 'did:key:z6MkRecipientRecipient'
const OTHER = 'did:key:z6MkOtherOtherOther'
const BROKERS = ['wss://broker.example.com']

async function senderPortAtGen(n: number): Promise<InMemoryKeyManagementAdapter> {
  const port = new InMemoryKeyManagementAdapter()
  await createSpaceKey({ crypto, keyPort: port, spaceId: SPACE, ownerDid: OWNER })
  for (let g = 0; g < n; g++) await rotateSpaceKey({ crypto, keyPort: port, spaceId: SPACE, ownerDid: OWNER })
  return port
}
function build(sender: InMemoryKeyManagementAdapter, recipientDid = RECIPIENT, brokerUrls = BROKERS): Promise<SpaceInviteBody> {
  return buildSpaceInviteBody({ keyPort: sender, spaceId: SPACE, recipientDid, brokerUrls, adminDids: [ADMIN] })
}

describe('invite-workflow', () => {
  it('buildSpaceInviteBody is schema-valid, lists all generations, and the capability verifies', async () => {
    const sender = await senderPortAtGen(1) // gens 0 + 1
    const body = await build(sender)
    expect(() => assertSpaceInviteBody(body)).not.toThrow()
    expect(body.currentKeyGeneration).toBe(1)
    expect(body.spaceContentKeys.map((k) => k.generation)).toEqual([0, 1])
    const verificationKey = await crypto.ed25519PublicKeyFromSeed(
      (await sender.getCapabilitySigningSeed(SPACE, 1))!,
    )
    const payload = await verifySpaceCapabilityJws(body.capability, {
      crypto, publicKey: verificationKey, expectedSpaceId: SPACE, expectedAudience: RECIPIENT, expectedGeneration: 1,
    })
    expect(payload.audience).toBe(RECIPIENT)
  })

  it('buildSpaceInviteBody rejects an invalid validityDurationMs', async () => {
    const sender = await senderPortAtGen(0)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        buildSpaceInviteBody({ keyPort: sender, spaceId: SPACE, recipientDid: RECIPIENT, brokerUrls: BROKERS, adminDids: [ADMIN], validityDurationMs: bad }),
      ).rejects.toThrow(/validityDurationMs/)
    }
  })

  it('buildSpaceInviteBody throws on empty brokerUrls (Sync 005 Z.42)', async () => {
    const sender = await senderPortAtGen(0)
    await expect(build(sender, RECIPIENT, [])).rejects.toThrow(/brokerUrls/)
  })

  it('applySpaceInviteBody applies a valid invite and persists keys + capability material', async () => {
    const sender = await senderPortAtGen(1)
    const body = await build(sender)
    const receiver = new InMemoryKeyManagementAdapter()
    const result = await applySpaceInviteBody({ crypto, keyPort: receiver, body, recipientDid: RECIPIENT, senderDid: ADMIN })
    expect(result.decision).toBe('apply')
    expect(await receiver.getKeyByGeneration(SPACE, 0)).not.toBeNull()
    expect(await receiver.getKeyByGeneration(SPACE, 1)).not.toBeNull()
    expect(await receiver.getCapabilityVerificationKey(SPACE, 1)).not.toBeNull()
    expect(await receiver.getOwnCapability(SPACE, 1)).toBe(body.capability)
  })

  it('rejects an invite whose capability audience does not match the recipient', async () => {
    const sender = await senderPortAtGen(0)
    const body = await build(sender) // audience = RECIPIENT
    const receiver = new InMemoryKeyManagementAdapter()
    const result = await applySpaceInviteBody({ crypto, keyPort: receiver, body, recipientDid: OTHER, senderDid: ADMIN })
    expect(result).toEqual({ decision: 'reject', reason: 'invalid-capability' })
    expect(await receiver.getKeyByGeneration(SPACE, 0)).toBeNull()
  })

  it('throws on a malformed spaceCapabilitySigningKey (wrong Ed25519 length, outside try/catch)', async () => {
    const sender = await senderPortAtGen(0)
    const body = await build(sender)
    const tampered: SpaceInviteBody = { ...body, spaceCapabilitySigningKey: encodeBase64Url(new Uint8Array(16)) }
    const receiver = new InMemoryKeyManagementAdapter()
    await expect(applySpaceInviteBody({ crypto, keyPort: receiver, body: tampered, recipientDid: RECIPIENT, senderDid: ADMIN })).rejects.toThrow()
  })

  it('throws when currentKeyGeneration does not match the highest content-key generation', async () => {
    const sender = await senderPortAtGen(0)
    const body = await build(sender) // currentKeyGeneration 0, spaceContentKeys [{gen 0}]
    const tampered: SpaceInviteBody = { ...body, currentKeyGeneration: 5 }
    const receiver = new InMemoryKeyManagementAdapter()
    await expect(applySpaceInviteBody({ crypto, keyPort: receiver, body: tampered, recipientDid: RECIPIENT, senderDid: ADMIN })).rejects.toThrow()
  })
})
