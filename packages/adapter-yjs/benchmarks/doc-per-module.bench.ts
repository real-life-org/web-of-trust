/**
 * Doc-per-Module vs Doc-per-Space Benchmark
 *
 * Architecture question: Should each space be ONE Y.Doc with all modules,
 * or should each module (contacts, attestations, chat) be its OWN Y.Doc?
 *
 * Trade-offs:
 *   One Doc per Space:
 *     + Simpler key management (1 group key per space)
 *     + Atomic transactions across modules
 *     - Larger docs, slower merges
 *     - Any change syncs the whole doc
 *
 *   One Doc per Module:
 *     + Smaller docs, faster merges
 *     + Selective sync (only load modules you need)
 *     + Isolated growth (chat doesn't bloat contacts)
 *     - More docs to manage (N spaces × M modules)
 *     - Cross-module references need coordination
 *     - More encrypt/decrypt operations
 *
 * This benchmark measures the concrete performance difference.
 */
import * as Y from 'yjs'
import { bench, describe, beforeAll } from 'vitest'
import { EncryptedSyncService, GroupKeyService } from '@web_of_trust/core/services'

const FROM_DID = 'did:key:z6MkBenchModule00000000000000000000000000000'
const gks = new GroupKeyService()

// --- Space content generators ---

function addContacts(doc: Y.Doc, mapName: string, count: number) {
  const data = doc.getMap(mapName)
  const contacts = new Y.Map()
  data.set('contacts', contacts)
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const c = new Y.Map()
      c.set('name', `Contact ${i}`)
      c.set('did', `did:key:z6Mk${i.toString(16).padStart(40, '0')}`)
      c.set('verified', i % 3 === 0)
      contacts.set(`c-${i}`, c)
    }
  })
}

function addAttestations(doc: Y.Doc, mapName: string, count: number) {
  const data = doc.getMap(mapName)
  const attestations = new Y.Map()
  data.set('attestations', attestations)
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const att = new Y.Map()
      att.set('from', `did:key:z6MkFrom${i.toString(16).padStart(38, '0')}`)
      att.set('to', `did:key:z6MkTo${i.toString(16).padStart(40, '0')}`)
      att.set('claim', `trust-${i % 5}`)
      att.set('sig', `sig-${i}`.padEnd(88, '0'))
      attestations.set(`att-${i}`, att)
    }
  })
}

function addChat(doc: Y.Doc, mapName: string, count: number) {
  const data = doc.getMap(mapName)
  const chat = new Y.Array()
  data.set('chat', chat)
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const msg = new Y.Map()
      msg.set('from', `did:key:z6MkUser${(i % 20).toString(16).padStart(38, '0')}`)
      msg.set('text', `Message ${i}: This is a chat message with typical content length for real conversations.`)
      msg.set('ts', Date.now() + i * 60000)
      chat.push([msg])
    }
  })
}

// --- Scenarios ---

interface ModuleScenario {
  name: string
  contacts: number
  attestations: number
  chatMessages: number
}

const scenarios: ModuleScenario[] = [
  { name: 'small space', contacts: 50, attestations: 30, chatMessages: 100 },
  { name: 'medium space', contacts: 200, attestations: 100, chatMessages: 500 },
  { name: 'large space', contacts: 500, attestations: 300, chatMessages: 2000 },
]

// Pre-built fixtures
interface SingleDocFixture {
  doc: Y.Doc
  snapshot: Uint8Array
  groupKey: Uint8Array
}

interface MultiDocFixture {
  contactsDoc: Y.Doc
  attestationsDoc: Y.Doc
  chatDoc: Y.Doc
  contactsSnapshot: Uint8Array
  attestationsSnapshot: Uint8Array
  chatSnapshot: Uint8Array
  groupKey: Uint8Array
}

const singleDocFixtures: Record<string, SingleDocFixture> = {}
const multiDocFixtures: Record<string, MultiDocFixture> = {}

beforeAll(async () => {
  for (const s of scenarios) {
    // Single doc approach: everything in one Y.Doc
    const singleDoc = new Y.Doc()
    addContacts(singleDoc, 'data', s.contacts)
    addAttestations(singleDoc, 'data', s.attestations)
    addChat(singleDoc, 'data', s.chatMessages)

    const singleKey = await gks.createKey(`single-${s.name}`)
    singleDocFixtures[s.name] = {
      doc: singleDoc,
      snapshot: Y.encodeStateAsUpdate(singleDoc),
      groupKey: singleKey,
    }

    // Multi doc approach: separate Y.Doc per module
    const contactsDoc = new Y.Doc()
    addContacts(contactsDoc, 'data', s.contacts)

    const attestationsDoc = new Y.Doc()
    addAttestations(attestationsDoc, 'data', s.attestations)

    const chatDoc = new Y.Doc()
    addChat(chatDoc, 'data', s.chatMessages)

    const multiKey = await gks.createKey(`multi-${s.name}`)
    multiDocFixtures[s.name] = {
      contactsDoc,
      attestationsDoc,
      chatDoc,
      contactsSnapshot: Y.encodeStateAsUpdate(contactsDoc),
      attestationsSnapshot: Y.encodeStateAsUpdate(attestationsDoc),
      chatSnapshot: Y.encodeStateAsUpdate(chatDoc),
      groupKey: multiKey,
    }
  }

  // Report sizes
  const report: Record<string, {
    singleDocKB: string
    contactsKB: string
    attestationsKB: string
    chatKB: string
    multiTotalKB: string
    overhead: string
  }> = {}

  for (const s of scenarios) {
    const single = singleDocFixtures[s.name].snapshot.byteLength
    const c = multiDocFixtures[s.name].contactsSnapshot.byteLength
    const a = multiDocFixtures[s.name].attestationsSnapshot.byteLength
    const ch = multiDocFixtures[s.name].chatSnapshot.byteLength
    const multiTotal = c + a + ch

    report[s.name] = {
      singleDocKB: `${(single / 1024).toFixed(1)} KB`,
      contactsKB: `${(c / 1024).toFixed(1)} KB`,
      attestationsKB: `${(a / 1024).toFixed(1)} KB`,
      chatKB: `${(ch / 1024).toFixed(1)} KB`,
      multiTotalKB: `${(multiTotal / 1024).toFixed(1)} KB`,
      overhead: `${((multiTotal / single - 1) * 100).toFixed(1)}%`,
    }
  }

  console.log('\n=== Single Doc vs Multi Doc Size Report ===')
  console.table(report)
})

// --- Benchmark: Full load ---

describe('Load: Single doc (all modules)', () => {
  for (const s of scenarios) {
    bench(`load single ${s.name}`, () => {
      const fresh = new Y.Doc()
      Y.applyUpdate(fresh, singleDocFixtures[s.name].snapshot)
    })
  }
})

describe('Load: Multi doc (contacts only — selective)', () => {
  for (const s of scenarios) {
    bench(`load contacts-only ${s.name}`, () => {
      const fresh = new Y.Doc()
      Y.applyUpdate(fresh, multiDocFixtures[s.name].contactsSnapshot)
    })
  }
})

describe('Load: Multi doc (all 3 modules)', () => {
  for (const s of scenarios) {
    bench(`load all modules ${s.name}`, () => {
      const d1 = new Y.Doc()
      Y.applyUpdate(d1, multiDocFixtures[s.name].contactsSnapshot)
      const d2 = new Y.Doc()
      Y.applyUpdate(d2, multiDocFixtures[s.name].attestationsSnapshot)
      const d3 = new Y.Doc()
      Y.applyUpdate(d3, multiDocFixtures[s.name].chatSnapshot)
    })
  }
})

// --- Benchmark: Full sync pipeline (encrypt + decrypt + apply) ---

describe('Sync: Single doc full pipeline', () => {
  for (const s of scenarios) {
    bench(`sync single ${s.name}`, async () => {
      const f = singleDocFixtures[s.name]
      const update = Y.encodeStateAsUpdate(f.doc)
      const enc = await EncryptedSyncService.encryptChange(
        update, f.groupKey, `single-${s.name}`, 0, FROM_DID,
      )
      const dec = await EncryptedSyncService.decryptChange(enc, f.groupKey)
      const fresh = new Y.Doc()
      Y.applyUpdate(fresh, dec)
    })
  }
})

describe('Sync: Multi doc contacts-only pipeline', () => {
  for (const s of scenarios) {
    bench(`sync contacts-only ${s.name}`, async () => {
      const f = multiDocFixtures[s.name]
      const update = Y.encodeStateAsUpdate(f.contactsDoc)
      const enc = await EncryptedSyncService.encryptChange(
        update, f.groupKey, `multi-${s.name}-contacts`, 0, FROM_DID,
      )
      const dec = await EncryptedSyncService.decryptChange(enc, f.groupKey)
      const fresh = new Y.Doc()
      Y.applyUpdate(fresh, dec)
    })
  }
})

// --- Benchmark: Delta sync (add 5 contacts — the chat shouldn't affect this) ---

describe('Delta: Add 5 contacts to single doc', () => {
  for (const s of scenarios) {
    bench(`delta single ${s.name}`, () => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, singleDocFixtures[s.name].snapshot)
      const sv = Y.encodeStateVector(doc)

      const peer = new Y.Doc()
      Y.applyUpdate(peer, singleDocFixtures[s.name].snapshot)
      peer.transact(() => {
        const contacts = (peer.getMap('data').get('contacts') as Y.Map<any>)
        for (let i = 0; i < 5; i++) {
          const c = new Y.Map()
          c.set('name', `NewDelta-${i}`)
          contacts.set(`new-delta-${i}`, c)
        }
      })

      const delta = Y.encodeStateAsUpdate(peer, sv)
      Y.applyUpdate(doc, delta, 'remote')
    })
  }
})

describe('Delta: Add 5 contacts to multi doc (contacts module only)', () => {
  for (const s of scenarios) {
    bench(`delta multi ${s.name}`, () => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, multiDocFixtures[s.name].contactsSnapshot)
      const sv = Y.encodeStateVector(doc)

      const peer = new Y.Doc()
      Y.applyUpdate(peer, multiDocFixtures[s.name].contactsSnapshot)
      peer.transact(() => {
        const contacts = (peer.getMap('data').get('contacts') as Y.Map<any>)
        for (let i = 0; i < 5; i++) {
          const c = new Y.Map()
          c.set('name', `NewDelta-${i}`)
          contacts.set(`new-delta-${i}`, c)
        }
      })

      const delta = Y.encodeStateAsUpdate(peer, sv)
      Y.applyUpdate(doc, delta, 'remote')
    })
  }
})
