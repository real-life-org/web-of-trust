import { describe, expect, it } from 'vitest'
import { PersonalDocSpaceMetadataStorage } from '../src/adapters/storage/AutomergeSpaceMetadataStorage'
import type { PersistedSpaceMetadata } from '../src/ports/SpaceMetadataStorage'

const SPACE = '11111111-1111-4111-8111-111111111111'
const ALICE = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const BOB = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG'

interface FakePersonalDoc {
  spaces: Record<string, unknown>
  groupKeys: Record<string, { spaceId: string; generation: number; key: number[] }>
}

function createStorage(): { storage: PersonalDocSpaceMetadataStorage; doc: FakePersonalDoc } {
  const doc: FakePersonalDoc = { spaces: {}, groupKeys: {} }
  const storage = new PersonalDocSpaceMetadataStorage({
    getPersonalDoc: () => doc,
    changePersonalDoc: (fn) => {
      fn(doc)
      return doc
    },
  })
  return { storage, doc }
}

function meta(overrides: Partial<PersistedSpaceMetadata['info']> = {}): PersistedSpaceMetadata {
  return {
    info: {
      id: SPACE,
      type: 'shared',
      name: 'Test Space',
      members: [ALICE, BOB],
      createdAt: '2026-06-11T00:00:00.000Z',
      ...overrides,
    },
    documentId: 'doc-1',
    documentUrl: 'automerge:doc-1',
    memberEncryptionKeys: { [ALICE]: new Uint8Array([1, 2, 3]) },
  }
}

describe('PersonalDocSpaceMetadataStorage — SpaceInfo round-trip', () => {
  // VE-2: createdBy ist die persistierte Admin-Approximation — ohne sie
  // fiele ein Restore vor dem Doc-Load auf members[0] zurueck.
  it('persistiert createdBy und projiziert es beim Lesen (loadSpaceMetadata + loadAllSpaceMetadata)', async () => {
    const { storage } = createStorage()
    await storage.saveSpaceMetadata(meta({ createdBy: ALICE }))

    const loaded = await storage.loadSpaceMetadata(SPACE)
    expect(loaded?.info.createdBy).toBe(ALICE)

    const all = await storage.loadAllSpaceMetadata()
    expect(all).toHaveLength(1)
    expect(all[0].info.createdBy).toBe(ALICE)
  })

  it('laesst createdBy bei Spaces ohne Creator-Feld weg (kein undefined-Key)', async () => {
    const { storage } = createStorage()
    await storage.saveSpaceMetadata(meta())

    const loaded = await storage.loadSpaceMetadata(SPACE)
    expect(loaded).not.toBeNull()
    expect('createdBy' in loaded!.info).toBe(false)
  })

  it('erhaelt die uebrigen SpaceInfo-Felder im Round-trip (members, appTag, name)', async () => {
    const { storage } = createStorage()
    await storage.saveSpaceMetadata(meta({ createdBy: ALICE, appTag: 'wot-demo' }))

    const loaded = await storage.loadSpaceMetadata(SPACE)
    expect(loaded?.info.members).toEqual([ALICE, BOB])
    expect(loaded?.info.appTag).toBe('wot-demo')
    expect(loaded?.info.name).toBe('Test Space')
    expect(loaded?.memberEncryptionKeys[ALICE]).toEqual(new Uint8Array([1, 2, 3]))
  })
})
