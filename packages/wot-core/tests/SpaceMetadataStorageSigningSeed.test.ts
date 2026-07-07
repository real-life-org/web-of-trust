import { describe, it, expect } from 'vitest'
import { InMemorySpaceMetadataStorage } from '../src/adapters/storage/InMemorySpaceMetadataStorage'

/**
 * #234 — capability signing seed store contract: separate grow-only map,
 * set-if-absent (never overwrite/delete), dies with the space + clearAll.
 */
describe('SpaceMetadataStorage capability signing seeds (#234)', () => {
  const seedA = new Uint8Array(32).fill(1)
  const seedB = new Uint8Array(32).fill(2)

  it('is set-if-absent / grow-only — a second save never overwrites', async () => {
    const s = new InMemorySpaceMetadataStorage()
    await s.saveCapabilitySigningSeed({ spaceId: 'sp', generation: 0, seed: seedA })
    await s.saveCapabilitySigningSeed({ spaceId: 'sp', generation: 0, seed: seedB }) // divergent — must be ignored
    const loaded = await s.loadCapabilitySigningSeeds('sp')
    expect(loaded).toHaveLength(1)
    expect(Array.from(loaded[0].seed)).toEqual(Array.from(seedA))
  })

  it('loads only the requested space and keeps generations distinct', async () => {
    const s = new InMemorySpaceMetadataStorage()
    await s.saveCapabilitySigningSeed({ spaceId: 'sp', generation: 0, seed: seedA })
    await s.saveCapabilitySigningSeed({ spaceId: 'sp', generation: 1, seed: seedB })
    await s.saveCapabilitySigningSeed({ spaceId: 'other', generation: 0, seed: seedA })
    const loaded = await s.loadCapabilitySigningSeeds('sp')
    expect(loaded.map(x => x.generation).sort()).toEqual([0, 1])
    expect(await s.loadCapabilitySigningSeeds('other')).toHaveLength(1)
  })

  it('deleteGroupKeys removes the seeds of that space (dies with the space)', async () => {
    const s = new InMemorySpaceMetadataStorage()
    await s.saveGroupKey({ spaceId: 'sp', generation: 0, key: seedA })
    await s.saveCapabilitySigningSeed({ spaceId: 'sp', generation: 0, seed: seedA })
    await s.saveCapabilitySigningSeed({ spaceId: 'keep', generation: 0, seed: seedB })
    await s.deleteGroupKeys('sp')
    expect(await s.loadCapabilitySigningSeeds('sp')).toHaveLength(0)
    expect(await s.loadCapabilitySigningSeeds('keep')).toHaveLength(1) // unrelated space untouched
  })

  it('clearAll wipes the seeds (identity reset / teardown)', async () => {
    const s = new InMemorySpaceMetadataStorage()
    await s.saveCapabilitySigningSeed({ spaceId: 'sp', generation: 0, seed: seedA })
    await s.clearAll()
    expect(await s.loadCapabilitySigningSeeds('sp')).toHaveLength(0)
  })
})
