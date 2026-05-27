/**
 * Full sync pipeline benchmark — the complete path a change takes:
 *
 *   Y.Doc change → serialize → encrypt → [relay] → decrypt → apply to remote Y.Doc
 *
 * This measures the end-to-end cost of our encrypt-then-sync architecture.
 * The relay is simulated (no network), so this isolates compute cost.
 *
 * Compares:
 * - Full state sync (current: Y.encodeStateAsUpdate on every connect)
 * - Delta sync (optimized: only send diff via state vector)
 * - Snapshot-only (secsync-style: pre-computed encrypted snapshot)
 */
import * as Y from 'yjs'
import { bench, describe, beforeAll } from 'vitest'
import { EncryptedSyncService, GroupKeyService } from '@web_of_trust/core/services'

const SPACE_ID = 'bench-pipeline-00000000-0000-0000-0000-000000000000'
const FROM_DID = 'did:key:z6MkBenchSender00000000000000000000000000'

let groupKey: Uint8Array

function createPopulatedDoc(contactCount: number): Y.Doc {
  const doc = new Y.Doc()
  const data = doc.getMap('data')
  const contacts = new Y.Map()
  data.set('contacts', contacts)

  doc.transact(() => {
    for (let i = 0; i < contactCount; i++) {
      const contact = new Y.Map()
      contact.set('name', `Contact ${i}`)
      contact.set('did', `did:key:z6Mk${i.toString(16).padStart(40, '0')}`)
      contact.set('verified', i % 3 === 0)
      contact.set('notes', `Some notes about contact ${i} that add realistic payload size.`)
      contacts.set(`c-${i}`, contact)
    }
  })

  return doc
}

// Pre-built docs
const docSizes = [100, 500, 1_000, 5_000] as const
const docs: Record<number, Y.Doc> = {}
const snapshots: Record<number, Uint8Array> = {}

beforeAll(async () => {
  const gks = new GroupKeyService()
  groupKey = await gks.createKey(SPACE_ID)

  for (const n of docSizes) {
    docs[n] = createPopulatedDoc(n)
    snapshots[n] = Y.encodeStateAsUpdate(docs[n])
  }
})

// --- Full State Sync (current implementation) ---

describe('Full state sync (serialize → encrypt → decrypt → apply)', () => {
  for (const n of docSizes) {
    bench(`full sync ${n} contacts`, async () => {
      // Sender: serialize full state
      const update = Y.encodeStateAsUpdate(docs[n])

      // Sender: encrypt
      const encrypted = await EncryptedSyncService.encryptChange(
        update, groupKey, SPACE_ID, 0, FROM_DID,
      )

      // Receiver: decrypt
      const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)

      // Receiver: apply to empty doc (worst case: new device)
      const receiverDoc = new Y.Doc()
      Y.applyUpdate(receiverDoc, decrypted)
    })
  }
})

// --- Delta Sync (optimized: only diff) ---

describe('Delta sync (10 new contacts on existing doc)', () => {
  for (const n of docSizes) {
    bench(`delta sync on ${n}-contact doc`, async () => {
      // Both sender and receiver start from same base
      const senderDoc = new Y.Doc()
      Y.applyUpdate(senderDoc, snapshots[n])

      const receiverDoc = new Y.Doc()
      Y.applyUpdate(receiverDoc, snapshots[n])

      // Sender makes 10 changes
      senderDoc.transact(() => {
        const contacts = (senderDoc.getMap('data').get('contacts') as Y.Map<any>)
        for (let i = 0; i < 10; i++) {
          const c = new Y.Map()
          c.set('name', `Delta Contact ${i}`)
          contacts.set(`delta-${i}`, c)
        }
      })

      // Compute delta
      const receiverSV = Y.encodeStateVector(receiverDoc)
      const delta = Y.encodeStateAsUpdate(senderDoc, receiverSV)

      // Encrypt delta
      const encrypted = await EncryptedSyncService.encryptChange(
        delta, groupKey, SPACE_ID, 0, FROM_DID,
      )

      // Decrypt and apply
      const decrypted = await EncryptedSyncService.decryptChange(encrypted, groupKey)
      Y.applyUpdate(receiverDoc, delta)
    })
  }
})

// --- Size comparison report ---

describe('Payload size comparison', () => {
  bench('report sizes (printed to console)', async () => {
    const report: Record<string, {
      contacts: number
      fullStateBytes: number
      fullStateKB: string
      deltaBytes: number
      deltaKB: string
      ratio: string
    }> = {}

    for (const n of docSizes) {
      const fullState = Y.encodeStateAsUpdate(docs[n])

      // Simulate delta: receiver has the base doc, sender added 10 contacts
      const senderDoc = new Y.Doc()
      Y.applyUpdate(senderDoc, snapshots[n])
      senderDoc.transact(() => {
        const contacts = (senderDoc.getMap('data').get('contacts') as Y.Map<any>)
        for (let i = 0; i < 10; i++) {
          const c = new Y.Map()
          c.set('name', `Size Report ${i}`)
          contacts.set(`sr-${i}`, c)
        }
      })
      const receiverSV = Y.encodeStateVector(docs[n])
      const delta = Y.encodeStateAsUpdate(senderDoc, receiverSV)

      report[`${n} contacts`] = {
        contacts: n,
        fullStateBytes: fullState.byteLength,
        fullStateKB: `${(fullState.byteLength / 1024).toFixed(1)} KB`,
        deltaBytes: delta.byteLength,
        deltaKB: `${(delta.byteLength / 1024).toFixed(1)} KB`,
        ratio: `${(fullState.byteLength / delta.byteLength).toFixed(1)}x`,
      }
    }

    console.table(report)
  }, { iterations: 1 })
})
