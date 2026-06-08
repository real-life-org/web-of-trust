import { describe, expect, it } from 'vitest'
import {
  applyKeyRotation,
  createSpaceKey,
  importKey,
  rotateSpaceKey,
} from '../src/application/sync/group-key-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

// Sync 005 Z.285-299 key-rotation invariants + classifier; Sync 001 Z.96/Z.187
// one key per docId, generation-versioned. The workflow orchestrates the async
// KeyManagementPort + ProtocolCryptoAdapter + evaluateKeyRotationDisposition.

const crypto = new WebCryptoProtocolCryptoAdapter()
function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

describe('group-key-workflow', () => {
  it('createSpaceKey stores generation 0 and returns a 32-byte key', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const key = await createSpaceKey({ crypto, keyPort, spaceId: 's1' })
    expect(key.length).toBe(32)
    expect(await keyPort.getCurrentGeneration('s1')).toBe(0)
    expect(hex((await keyPort.getCurrentKey('s1'))!)).toBe(hex(key))
  })

  it('createSpaceKey produces unique keys per space and across calls', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const a = await createSpaceKey({ crypto, keyPort, spaceId: 'a' })
    const b = await createSpaceKey({ crypto, keyPort, spaceId: 'b' })
    expect(hex(a)).not.toBe(hex(b))
    const keyPort2 = new InMemoryKeyManagementAdapter()
    const a2 = await createSpaceKey({ crypto, keyPort: keyPort2, spaceId: 'a' })
    expect(hex(a2)).not.toBe(hex(a))
  })

  it('rotateSpaceKey increments generation and keeps the old key', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const k0 = await createSpaceKey({ crypto, keyPort, spaceId: 's1' })
    const k1 = await rotateSpaceKey({ crypto, keyPort, spaceId: 's1' })
    expect(await keyPort.getCurrentGeneration('s1')).toBe(1)
    expect(hex(k1)).not.toBe(hex(k0))
    expect(hex((await keyPort.getCurrentKey('s1'))!)).toBe(hex(k1))
    expect(hex((await keyPort.getKeyByGeneration('s1', 0))!)).toBe(hex(k0))
  })

  it('rotateSpaceKey throws for an unknown space', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    await expect(rotateSpaceKey({ crypto, keyPort, spaceId: 'nope' })).rejects.toThrow()
  })

  it('applyKeyRotation applies exactly the next generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto, keyPort, spaceId: 's1' }) // gen 0
    const incoming = new Uint8Array(32).fill(1)
    const d = await applyKeyRotation({ keyPort, spaceId: 's1', incomingGeneration: 1, incomingKey: incoming })
    expect(d).toBe('apply')
    expect(await keyPort.getCurrentGeneration('s1')).toBe(1)
    expect(hex((await keyPort.getKeyByGeneration('s1', 1))!)).toBe(hex(incoming))
  })

  it('applyKeyRotation ignores a stale or duplicate generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const k0 = await createSpaceKey({ crypto, keyPort, spaceId: 's1' }) // gen 0
    const d = await applyKeyRotation({ keyPort, spaceId: 's1', incomingGeneration: 0, incomingKey: new Uint8Array(32).fill(9) })
    expect(d).toBe('ignore-stale-or-duplicate')
    expect(hex((await keyPort.getCurrentKey('s1'))!)).toBe(hex(k0)) // unchanged
  })

  it('applyKeyRotation buffers a future generation (gap) without applying', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto, keyPort, spaceId: 's1' }) // gen 0
    const d = await applyKeyRotation({ keyPort, spaceId: 's1', incomingGeneration: 3, incomingKey: new Uint8Array(32).fill(3) })
    expect(d).toBe('future-buffer')
    expect(await keyPort.getCurrentGeneration('s1')).toBe(0) // not applied
  })

  it('applyKeyRotation returns future-buffer for an unknown space (no throw, not applied)', async () => {
    // Sync 005 Z.299: a rotation for a space whose initial key has not arrived
    // yet (rotation-before-invite reordering) is a future rotation to catch up
    // on, never a throw and never applied before the gap is closed.
    const keyPort = new InMemoryKeyManagementAdapter()
    const d = await applyKeyRotation({ keyPort, spaceId: 'unknown', incomingGeneration: 1, incomingKey: new Uint8Array(32).fill(1) })
    expect(d).toBe('future-buffer')
    expect(await keyPort.getCurrentGeneration('unknown')).toBe(-1) // space not created
  })

  it('importKey saves a key at a specific generation', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const key = new Uint8Array(32).fill(5)
    await importKey(keyPort, 's1', 2, key)
    expect(hex((await keyPort.getKeyByGeneration('s1', 2))!)).toBe(hex(key))
  })

  it('createSpaceKey fails fast if a key already exists (no gen-0 clobber)', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const k0 = await createSpaceKey({ crypto, keyPort, spaceId: 's1' })
    await expect(createSpaceKey({ crypto, keyPort, spaceId: 's1' })).rejects.toThrow()
    // also after a rotation (current generation > 0): generation 0 must survive
    await rotateSpaceKey({ crypto, keyPort, spaceId: 's1' })
    await expect(createSpaceKey({ crypto, keyPort, spaceId: 's1' })).rejects.toThrow()
    expect(hex((await keyPort.getKeyByGeneration('s1', 0))!)).toBe(hex(k0))
  })

  it('applyKeyRotation rejects a malformed incoming generation, even for an unknown space', async () => {
    const keyPort = new InMemoryKeyManagementAdapter()
    const key = new Uint8Array(32).fill(1)
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        applyKeyRotation({ keyPort, spaceId: 'unknown', incomingGeneration: bad, incomingKey: key }),
      ).rejects.toThrow()
    }
    // a valid future generation for an unknown space is still buffered, not rejected
    expect(
      await applyKeyRotation({ keyPort, spaceId: 'unknown', incomingGeneration: 2, incomingKey: key }),
    ).toBe('future-buffer')
  })
})
