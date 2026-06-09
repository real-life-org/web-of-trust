import { describe, expect, it } from 'vitest'
import {
  applyKeyRotation,
  createSpaceKey,
  importKey,
  rotateSpaceKey,
} from '../src/application/sync/group-key-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { verifySpaceCapabilityJws } from '../src/protocol'

// Sync 005 Z.285-299 key-rotation invariants + classifier; Sync 001 Z.96/Z.187
// one key per docId, generation-versioned; Sync 003 Z.234 capability minting.
// The workflow orchestrates the async KeyManagementPort + ProtocolCryptoAdapter.

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE = '11111111-1111-4111-8111-111111111111'
const SPACE_B = '22222222-2222-4222-8222-222222222222'
const OWNER = 'did:key:z6MkOwnerOwnerOwner'

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

describe('group-key-workflow', () => {
  it('createSpaceKey stores generation 0 and returns a 32-byte content key', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const r = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    expect(r.contentKey.length).toBe(32)
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(0)
    expect(hex((await keyPort.getCurrentKey(SPACE))!)).toBe(hex(r.contentKey))
  })

  it('createSpaceKey produces unique keys per space and across calls', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const a = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    const b = await createSpaceKey({ crypto, keyPort, spaceId: SPACE_B, ownerDid: OWNER })
    expect(hex(a.contentKey)).not.toBe(hex(b.contentKey))
    const keyPort2 = new InMemoryKeyManagementAdapter()
    const a2 = await createSpaceKey({ crypto, keyPort: keyPort2, spaceId: SPACE, ownerDid: OWNER })
    expect(hex(a2.contentKey)).not.toBe(hex(a.contentKey))
  })

  it('rotateSpaceKey increments generation and keeps the old key', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const k0 = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    const k1 = await rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(hex(k1.contentKey)).not.toBe(hex(k0.contentKey))
    expect(hex((await keyPort.getCurrentKey(SPACE))!)).toBe(hex(k1.contentKey))
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 0))!)).toBe(hex(k0.contentKey))
  })

  it('rotateSpaceKey throws for an unknown space', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    await expect(rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })).rejects.toThrow()
  })

  it('applyKeyRotation applies exactly the next generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER }) // gen 0
    const incoming = new Uint8Array(32).fill(1)
    const d = await applyKeyRotation({ keyPort, spaceId: SPACE, incomingGeneration: 1, incomingKey: incoming })
    expect(d).toBe('apply')
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(hex(incoming))
  })

  it('applyKeyRotation ignores a stale or duplicate generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const k0 = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER }) // gen 0
    const d = await applyKeyRotation({ keyPort, spaceId: SPACE, incomingGeneration: 0, incomingKey: new Uint8Array(32).fill(9) })
    expect(d).toBe('ignore-stale-or-duplicate')
    expect(hex((await keyPort.getCurrentKey(SPACE))!)).toBe(hex(k0.contentKey)) // unchanged
  })

  it('applyKeyRotation buffers a future generation (gap) without applying', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER }) // gen 0
    const d = await applyKeyRotation({ keyPort, spaceId: SPACE, incomingGeneration: 3, incomingKey: new Uint8Array(32).fill(3) })
    expect(d).toBe('future-buffer')
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(0) // not applied
  })

  it('applyKeyRotation returns future-buffer for an unknown space (no throw, not applied)', async () => {
    // Sync 005 Z.299: a rotation for a space whose initial key has not arrived
    // yet (rotation-before-invite reordering) is a future rotation to catch up
    // on, never a throw and never applied before the gap is closed.
    const keyPort = new InMemoryKeyManagementAdapter()
    const d = await applyKeyRotation({ keyPort, spaceId: SPACE, incomingGeneration: 1, incomingKey: new Uint8Array(32).fill(1) })
    expect(d).toBe('future-buffer')
    expect(await keyPort.getCurrentGeneration(SPACE)).toBe(-1) // space not created
  })

  it('importKey saves a key at a specific generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const key = new Uint8Array(32).fill(5)
    await importKey(keyPort, SPACE, 2, key)
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 2))!)).toBe(hex(key))
  })

  it('createSpaceKey fails fast if a key already exists (no gen-0 clobber)', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const k0 = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    await expect(createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })).rejects.toThrow()
    // also after a rotation (current generation > 0): generation 0 must survive
    await rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    await expect(createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })).rejects.toThrow()
    expect(hex((await keyPort.getKeyByGeneration(SPACE, 0))!)).toBe(hex(k0.contentKey))
  })

  it('applyKeyRotation rejects a malformed incoming generation, even for an unknown space', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const key = new Uint8Array(32).fill(1)
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        applyKeyRotation({ keyPort, spaceId: SPACE, incomingGeneration: bad, incomingKey: key }),
      ).rejects.toThrow()
    }
    // a valid future generation for an unknown space is still buffered, not rejected
    expect(
      await applyKeyRotation({ keyPort, spaceId: SPACE, incomingGeneration: 2, incomingKey: key }),
    ).toBe('future-buffer')
  })

  // --- 1.B.3-key-rotation: capability minting ---

  it('createSpaceKey mints a self-capability that verifies against its verification key (gen 0)', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const r = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    expect(r.capabilitySigningSeed.length).toBe(32)
    expect(r.capabilityVerificationKey.length).toBe(32)
    const payload = await verifySpaceCapabilityJws(r.ownCapabilityJws, {
      crypto,
      publicKey: r.capabilityVerificationKey,
      expectedSpaceId: SPACE,
      expectedAudience: OWNER,
      expectedGeneration: 0,
    })
    expect(payload.audience).toBe(OWNER)
    // persisted material round-trips through the port
    expect(hex((await keyPort.getCapabilityVerificationKey(SPACE, 0))!)).toBe(hex(r.capabilityVerificationKey))
    expect(await keyPort.getOwnCapability(SPACE, 0)).toBe(r.ownCapabilityJws)
  })

  it('rotateSpaceKey mints a fresh capability for the new generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const g0 = await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    const g1 = await rotateSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER })
    expect(hex(g1.capabilityVerificationKey)).not.toBe(hex(g0.capabilityVerificationKey))
    await expect(
      verifySpaceCapabilityJws(g1.ownCapabilityJws, {
        crypto,
        publicKey: g1.capabilityVerificationKey,
        expectedSpaceId: SPACE,
        expectedAudience: OWNER,
        expectedGeneration: 1,
      }),
    ).resolves.toBeDefined()
  })
})
