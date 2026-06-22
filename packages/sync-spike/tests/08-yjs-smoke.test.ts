import { describe, it, expect } from 'vitest'
import {
  createLogEntryJws,
  verifyLogEntryJws,
  encryptLogPayload,
  decryptLogPayload,
  decodeBase64Url,
  type LogEntryPayload,
} from '@web_of_trust/core/protocol'
import { crypto, deriveSpaceContentKey, makeAuthorFromLabel, newUuid } from '../src/identity.js'

/**
 * OPTIONAL cross-check: the durable-log transport is CRDT-agnostic. We push REAL
 * Yjs binary updates through encrypt -> sign -> (retained log) -> verify -> decrypt
 * and confirm a cold client converges by applying the opaque updates to a fresh
 * Y.Doc. Kept skippable so a yjs hiccup can never block the 7 core tests.
 *
 * This does NOT replace the stub-based tests: the stub proves the SYNC DESIGN; this
 * proves the design also carries a production CRDT's opaque bytes unchanged.
 */

let Y: typeof import('yjs') | null = null
try {
  Y = await import('yjs')
} catch {
  Y = null
}

describe.skipIf(Y === null)('08 yjs smoke (optional)', () => {
  it('carries real Yjs updates through the encrypted durable log to a cold client', async () => {
    const yjs = Y!
    const author = await makeAuthorFromLabel('yjs-writer')
    const deviceId = newUuid()
    const docId = newUuid()
    const keyGeneration = 0
    const spaceContentKey = await deriveSpaceContentKey(docId, keyGeneration)

    // Writer produces a sequence of Yjs updates (opaque bytes to the transport).
    const writer = new yjs.Doc()
    const ymap = writer.getMap('space')
    const log: string[] = [] // retained durable log (JWS entries)

    let seq = 0
    async function commit(update: Uint8Array): Promise<void> {
      // update is the opaque CRDT byte blob — the transport never inspects it.
      const enc = await encryptLogPayload({ crypto, spaceContentKey, deviceId, seq, plaintext: update })
      const payload: LogEntryPayload = {
        seq,
        deviceId,
        docId,
        authorKid: author.authorKid,
        keyGeneration,
        data: enc.blobBase64Url,
        timestamp: '2026-06-22T10:00:00Z',
      }
      log.push(await createLogEntryJws({ payload, signingSeed: author.seed }))
      seq += 1
    }

    // Capture each transaction's incremental update.
    const pending: Uint8Array[] = []
    writer.on('update', (u: Uint8Array) => pending.push(u))
    ymap.set('title', 'Festival')
    ymap.set('capacity', 120)
    ymap.set('title', 'Festival 2026')
    for (const u of pending) await commit(u)

    expect(log.length).toBe(3)

    // COLD reader: empty Y.Doc, applies the decrypted opaque updates in log order.
    const reader = new yjs.Doc()
    for (const jws of log) {
      const verified = await verifyLogEntryJws(jws, { crypto })
      const blob = decodeBase64Url(verified.data)
      const update = await decryptLogPayload({ crypto, spaceContentKey, blob })
      yjs.applyUpdate(reader, update)
    }

    const rmap = reader.getMap('space')
    expect(rmap.get('title')).toBe('Festival 2026')
    expect(rmap.get('capacity')).toBe(120)

    // Deep convergence: encoded state vectors match.
    const writerState = yjs.encodeStateAsUpdate(writer)
    const readerState = yjs.encodeStateAsUpdate(reader)
    expect(Buffer.from(readerState).equals(Buffer.from(writerState))).toBe(true)
  })
})
