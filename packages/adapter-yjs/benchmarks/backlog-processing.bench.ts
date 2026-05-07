/**
 * Backlog Processing Benchmark — What happens when queued messages
 * arrive after being offline.
 *
 * Real scenario:
 *   Space has 50 members, each made a few changes while we were offline.
 *   On reconnect we receive N encrypted updates and need to decrypt + merge
 *   them all into our local Y.Doc.
 *
 * This simulates the relay delivering a batch of queued messages.
 */
import * as Y from 'yjs'
import { bench, describe, beforeAll } from 'vitest'
import { EncryptedSyncService, GroupKeyService } from '@web_of_trust/core/services'

const SPACE_ID = 'bench-backlog-00000000-0000-0000-0000-000000000000'
const gks = new GroupKeyService()
let groupKey: Uint8Array

interface QueuedUpdate {
  encrypted: Awaited<ReturnType<typeof EncryptedSyncService.encryptChange>>
  plaintextSize: number
}

/** Create a base doc that represents "our local state before going offline" */
function createBaseDoc(contactCount: number): Y.Doc {
  const doc = new Y.Doc()
  const data = doc.getMap('data')
  const contacts = new Y.Map()
  data.set('contacts', contacts)

  doc.transact(() => {
    for (let i = 0; i < contactCount; i++) {
      const c = new Y.Map()
      c.set('name', `Contact ${i}`)
      c.set('did', `did:key:z6Mk${i.toString(16).padStart(40, '0')}`)
      contacts.set(`c-${i}`, c)
    }
  })

  return doc
}

/**
 * Simulate N members each making M changes while we were offline.
 * Returns encrypted deltas (what the relay would deliver).
 */
async function createBacklog(
  baseSnapshot: Uint8Array,
  memberCount: number,
  changesPerMember: number,
): Promise<QueuedUpdate[]> {
  const updates: QueuedUpdate[] = []

  for (let m = 0; m < memberCount; m++) {
    // Each member starts from the same base
    const memberDoc = new Y.Doc()
    Y.applyUpdate(memberDoc, baseSnapshot)
    const svBefore = Y.encodeStateVector(memberDoc)

    // Member makes their changes
    const contacts = memberDoc.getMap('data').get('contacts') as Y.Map<any>
    memberDoc.transact(() => {
      for (let c = 0; c < changesPerMember; c++) {
        const contact = new Y.Map()
        contact.set('name', `M${m}-NewContact-${c}`)
        contact.set('did', `did:key:z6MkNew${m.toString(16).padStart(4, '0')}${c.toString(16).padStart(34, '0')}`)
        contact.set('verified', false)
        contacts.set(`new-m${m}-c${c}`, contact)
      }
    })

    // Compute delta (what the relay would queue)
    const delta = Y.encodeStateAsUpdate(memberDoc, svBefore)

    // Encrypt it (as it would be on the relay)
    const fromDid = `did:key:z6MkMember${m.toString(16).padStart(38, '0')}`
    const encrypted = await EncryptedSyncService.encryptChange(
      delta, groupKey, SPACE_ID, 0, fromDid,
    )

    updates.push({ encrypted, plaintextSize: delta.byteLength })
  }

  return updates
}

// --- Scenarios ---

interface BacklogScenario {
  name: string
  baseContacts: number
  members: number
  changesPerMember: number
}

const scenarios: BacklogScenario[] = [
  { name: '5 members × 2 changes (small group, short offline)', baseContacts: 50, members: 5, changesPerMember: 2 },
  { name: '10 members × 5 changes (medium group, 1h offline)', baseContacts: 100, members: 10, changesPerMember: 5 },
  { name: '20 members × 3 changes (larger group)', baseContacts: 200, members: 20, changesPerMember: 3 },
  { name: '50 members × 2 changes (full space)', baseContacts: 300, members: 50, changesPerMember: 2 },
  { name: '50 members × 10 changes (full space, long offline)', baseContacts: 300, members: 50, changesPerMember: 10 },
]

const backlogs: Record<string, { baseSnapshot: Uint8Array; updates: QueuedUpdate[] }> = {}

beforeAll(async () => {
  groupKey = await gks.createKey(SPACE_ID)

  for (const s of scenarios) {
    const baseDoc = createBaseDoc(s.baseContacts)
    const baseSnapshot = Y.encodeStateAsUpdate(baseDoc)
    const updates = await createBacklog(baseSnapshot, s.members, s.changesPerMember)
    backlogs[s.name] = { baseSnapshot, updates }
  }

  // Report
  const report: Record<string, {
    baseKB: string
    messages: number
    totalPayloadKB: string
    avgPayloadBytes: string
  }> = {}
  for (const s of scenarios) {
    const b = backlogs[s.name]
    const totalPayload = b.updates.reduce((sum, u) => sum + u.plaintextSize, 0)
    report[s.name] = {
      baseKB: `${(b.baseSnapshot.byteLength / 1024).toFixed(1)} KB`,
      messages: b.updates.length,
      totalPayloadKB: `${(totalPayload / 1024).toFixed(1)} KB`,
      avgPayloadBytes: `${Math.round(totalPayload / b.updates.length)} B`,
    }
  }
  console.log('\n=== Backlog Report ===')
  console.table(report)
})

// --- Benchmark: Process entire backlog (decrypt + merge each update sequentially) ---

describe('Backlog: decrypt + merge all updates (sequential)', () => {
  for (const s of scenarios) {
    bench(`process ${s.name}`, async () => {
      const b = backlogs[s.name]

      // Start from our local state
      const localDoc = new Y.Doc()
      Y.applyUpdate(localDoc, b.baseSnapshot)

      // Process each queued message
      for (const update of b.updates) {
        const plaintext = await EncryptedSyncService.decryptChange(
          update.encrypted, groupKey,
        )
        Y.applyUpdate(localDoc, plaintext, 'remote')
      }
    })
  }
})

// --- Benchmark: Batch merge (decrypt all, then apply all at once) ---

describe('Backlog: decrypt all then batch-apply', () => {
  for (const s of scenarios) {
    bench(`batch ${s.name}`, async () => {
      const b = backlogs[s.name]

      // Decrypt all first
      const plaintexts: Uint8Array[] = []
      for (const update of b.updates) {
        const plaintext = await EncryptedSyncService.decryptChange(
          update.encrypted, groupKey,
        )
        plaintexts.push(plaintext)
      }

      // Then apply all to doc
      const localDoc = new Y.Doc()
      Y.applyUpdate(localDoc, b.baseSnapshot)
      for (const pt of plaintexts) {
        Y.applyUpdate(localDoc, pt, 'remote')
      }
    })
  }
})

// --- Benchmark: Full state vs incremental (what if we just sent one snapshot instead?) ---

describe('Backlog: Full snapshot alternative (skip backlog, just send latest state)', () => {
  for (const s of scenarios) {
    bench(`snapshot-only ${s.name}`, async () => {
      const b = backlogs[s.name]

      // Simulate: remote peer sends their full state as one snapshot
      // (this is the "just send me everything" approach)
      const remoteDoc = new Y.Doc()
      Y.applyUpdate(remoteDoc, b.baseSnapshot)

      // Apply all updates to get the "latest remote state"
      for (const update of b.updates) {
        const plaintext = await EncryptedSyncService.decryptChange(
          update.encrypted, groupKey,
        )
        Y.applyUpdate(remoteDoc, plaintext, 'remote')
      }

      // Now serialize and send as one snapshot
      const fullSnapshot = Y.encodeStateAsUpdate(remoteDoc)
      const encrypted = await EncryptedSyncService.encryptChange(
        fullSnapshot, groupKey, SPACE_ID, 0, 'did:key:z6MkRemotePeer',
      )
      const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)

      // Receiver loads from snapshot
      const localDoc = new Y.Doc()
      Y.applyUpdate(localDoc, decrypted)
    })
  }
})
