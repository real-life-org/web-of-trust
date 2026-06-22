import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { crypto, makeAuthorFromLabel, newUuid } from '../src/identity.js'
import { verifyLogEntryJws, decodeBase64Url } from '@web_of_trust/core/protocol'

/**
 * GRANULARITY MEASUREMENT (informs Slice A entry-per-update vs Slice C snapshot
 * batching). A typical edit session = 50 small map writes; record the number of
 * log entries produced and the average encrypted-`data` byte size + average full
 * JWS byte size. Numbers are emitted to granularity.json for FINDINGS.md.
 */

describe('09 granularity measurement', () => {
  it('50 small map writes => entry count + average byte sizes', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const author = await makeAuthorFromLabel('gran-writer')
    const members = [author.did]
    const client = new SimClient({ author, deviceId: newUuid(), docId, relay, members })
    client.connect()

    const WRITES = 50
    // Realistic "map editing" payloads: short keys + short values (e.g. moving a
    // marker, renaming a field). Each write is one CRDT op => one log entry.
    for (let i = 0; i < WRITES; i++) {
      await client.localWrite(`marker-${i % 10}`, `lat:52.${500 + i},lng:13.${400 + i}`)
    }

    const entries = relay.logEntries(docId)
    expect(entries.length).toBe(WRITES) // one entry per update (Slice A baseline)

    let dataBytesTotal = 0
    let jwsBytesTotal = 0
    for (const jws of entries) {
      jwsBytesTotal += new TextEncoder().encode(jws).length
      const verified = await verifyLogEntryJws(jws, { crypto })
      dataBytesTotal += decodeBase64Url(verified.data).length
    }

    const avgEntryBytes = dataBytesTotal / entries.length // encrypted CRDT update size
    const avgJwsBytes = jwsBytesTotal / entries.length // full signed wire frame size

    const result = {
      writes: WRITES,
      logEntries: entries.length,
      entriesPerEditSession: entries.length,
      avgEncryptedDataBytes: Math.round(avgEntryBytes),
      avgFullJwsBytes: Math.round(avgJwsBytes),
      totalLogBytes: jwsBytesTotal,
      note: 'one log entry per CRDT update (Slice A). Snapshot batching (Slice C) would collapse these into one checkpoint blob.',
    }
    const outPath = fileURLToPath(new URL('../granularity.json', import.meta.url))
    writeFileSync(outPath, JSON.stringify(result, null, 2))

    // Sanity bounds (deterministic-ish): encrypted data > 28 bytes (nonce+tag+ct),
    // full JWS is a few hundred bytes (Ed25519 sig + JSON payload).
    expect(avgEntryBytes).toBeGreaterThan(28)
    expect(avgJwsBytes).toBeGreaterThan(200)
  })
})
