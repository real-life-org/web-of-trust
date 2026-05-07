/**
 * Reconnect-Storm Benchmark — What happens when a device comes online
 * after being offline and needs to sync all spaces at once.
 *
 * Real scenario:
 *   User has 8 spaces, was offline 1 hour.
 *   On reconnect: load all spaces from CompactStore, then process
 *   full state exchange for each space (serialize → encrypt → decrypt → apply).
 *
 * This measures the total "time to usable" after reconnect.
 */
import * as Y from 'yjs'
import { bench, describe, beforeAll } from 'vitest'
import { EncryptedSyncService, GroupKeyService } from '@web_of_trust/core/services'

const FROM_DID = 'did:key:z6MkBenchReconnect0000000000000000000000000'

interface SpaceFixture {
  id: string
  doc: Y.Doc
  snapshot: Uint8Array
  groupKey: Uint8Array
}

const gks = new GroupKeyService()

/** Create a space with realistic content (contacts + attestations + meta) */
function createRealisticSpace(id: string, memberCount: number, contactsPerMember: number): Y.Doc {
  const doc = new Y.Doc()
  const data = doc.getMap('data')
  const meta = doc.getMap('_meta')

  // Space metadata
  meta.set('name', `Space ${id}`)
  meta.set('description', `A collaborative space with ${memberCount} members`)
  meta.set('modules', ['contacts', 'attestations', 'chat'])
  meta.set('createdAt', Date.now())

  // Contacts module
  const contacts = new Y.Map()
  data.set('contacts', contacts)

  doc.transact(() => {
    for (let m = 0; m < memberCount; m++) {
      for (let c = 0; c < contactsPerMember; c++) {
        const contact = new Y.Map()
        contact.set('name', `Member${m}-Contact${c}`)
        contact.set('did', `did:key:z6Mk${m.toString(16).padStart(4, '0')}${c.toString(16).padStart(36, '0')}`)
        contact.set('verified', c % 2 === 0)
        contact.set('notes', `Added by member ${m} on day ${c}`)
        contacts.set(`m${m}-c${c}`, contact)
      }
    }
  })

  // Attestations module
  const attestations = new Y.Map()
  data.set('attestations', attestations)

  doc.transact(() => {
    const attestCount = Math.floor(memberCount * 1.5)
    for (let i = 0; i < attestCount; i++) {
      const att = new Y.Map()
      att.set('fromDid', `did:key:z6MkFrom${i.toString(16).padStart(38, '0')}`)
      att.set('toDid', `did:key:z6MkTo${i.toString(16).padStart(40, '0')}`)
      att.set('claim', `trust-level-${(i % 3) + 1}`)
      att.set('signature', `sig-${i}-placeholder`)
      att.set('createdAt', Date.now() - i * 3600000)
      attestations.set(`att-${i}`, att)
    }
  })

  return doc
}

// --- Scenarios ---

interface Scenario {
  name: string
  spaces: { members: number; contactsPerMember: number }[]
}

const scenarios: Scenario[] = [
  {
    name: 'light (3 spaces, few members)',
    spaces: [
      { members: 5, contactsPerMember: 3 },
      { members: 8, contactsPerMember: 2 },
      { members: 3, contactsPerMember: 5 },
    ],
  },
  {
    name: 'typical (8 spaces, mixed)',
    spaces: [
      { members: 5, contactsPerMember: 5 },
      { members: 12, contactsPerMember: 3 },
      { members: 50, contactsPerMember: 2 },
      { members: 8, contactsPerMember: 4 },
      { members: 3, contactsPerMember: 10 },
      { members: 20, contactsPerMember: 3 },
      { members: 15, contactsPerMember: 2 },
      { members: 10, contactsPerMember: 5 },
    ],
  },
  {
    name: 'heavy (12 spaces, large groups)',
    spaces: [
      { members: 50, contactsPerMember: 5 },
      { members: 50, contactsPerMember: 3 },
      { members: 30, contactsPerMember: 4 },
      { members: 25, contactsPerMember: 5 },
      { members: 20, contactsPerMember: 3 },
      { members: 15, contactsPerMember: 5 },
      { members: 40, contactsPerMember: 2 },
      { members: 10, contactsPerMember: 8 },
      { members: 8, contactsPerMember: 10 },
      { members: 5, contactsPerMember: 15 },
      { members: 50, contactsPerMember: 2 },
      { members: 35, contactsPerMember: 3 },
    ],
  },
]

const fixtures: Record<string, SpaceFixture[]> = {}

beforeAll(async () => {
  for (const scenario of scenarios) {
    const spaceFixtures: SpaceFixture[] = []
    for (let i = 0; i < scenario.spaces.length; i++) {
      const s = scenario.spaces[i]
      const id = `space-${scenario.name}-${i}`
      const doc = createRealisticSpace(id, s.members, s.contactsPerMember)
      const groupKey = await gks.createKey(id)
      const snapshot = Y.encodeStateAsUpdate(doc)
      spaceFixtures.push({ id, doc, snapshot, groupKey })
    }
    fixtures[scenario.name] = spaceFixtures
  }

  // Report sizes
  const report: Record<string, { spaces: number; totalKB: string; avgKB: string; largestKB: string }> = {}
  for (const scenario of scenarios) {
    const sf = fixtures[scenario.name]
    const sizes = sf.map(s => s.snapshot.byteLength)
    const total = sizes.reduce((a, b) => a + b, 0)
    report[scenario.name] = {
      spaces: sf.length,
      totalKB: `${(total / 1024).toFixed(1)} KB`,
      avgKB: `${(total / sizes.length / 1024).toFixed(1)} KB`,
      largestKB: `${(Math.max(...sizes) / 1024).toFixed(1)} KB`,
    }
  }
  console.log('\n=== Space Size Report ===')
  console.table(report)
})

// --- Benchmark: Load all spaces from snapshots (CompactStore simulation) ---

describe('Reconnect: Load all spaces from snapshots', () => {
  for (const scenario of scenarios) {
    bench(`load ${scenario.name}`, () => {
      const sf = fixtures[scenario.name]
      for (const space of sf) {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, space.snapshot)
      }
    })
  }
})

// --- Benchmark: Full state exchange for all spaces (encrypt + decrypt + apply) ---

describe('Reconnect: Full state sync all spaces (serialize → encrypt → decrypt → apply)', () => {
  for (const scenario of scenarios) {
    bench(`full sync ${scenario.name}`, async () => {
      const sf = fixtures[scenario.name]
      for (const space of sf) {
        // Serialize
        const update = Y.encodeStateAsUpdate(space.doc)
        // Encrypt
        const encrypted = await EncryptedSyncService.encryptChange(
          update, space.groupKey, space.id, 0, FROM_DID,
        )
        // Decrypt
        const decrypted = await EncryptedSyncService.decryptChange(encrypted, space.groupKey)
        // Apply to fresh doc
        const receiverDoc = new Y.Doc()
        Y.applyUpdate(receiverDoc, decrypted)
      }
    })
  }
})

// --- Benchmark: Parallel load (Promise.all) vs sequential ---

describe('Reconnect: Parallel vs sequential encrypt+decrypt', () => {
  for (const scenario of scenarios) {
    bench(`sequential ${scenario.name}`, async () => {
      const sf = fixtures[scenario.name]
      for (const space of sf) {
        const update = Y.encodeStateAsUpdate(space.doc)
        const enc = await EncryptedSyncService.encryptChange(
          update, space.groupKey, space.id, 0, FROM_DID,
        )
        await EncryptedSyncService.decryptChange(enc, space.groupKey)
      }
    })

    bench(`parallel ${scenario.name}`, async () => {
      const sf = fixtures[scenario.name]
      await Promise.all(sf.map(async (space) => {
        const update = Y.encodeStateAsUpdate(space.doc)
        const enc = await EncryptedSyncService.encryptChange(
          update, space.groupKey, space.id, 0, FROM_DID,
        )
        await EncryptedSyncService.decryptChange(enc, space.groupKey)
      }))
    })
  }
})
