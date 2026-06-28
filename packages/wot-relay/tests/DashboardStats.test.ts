import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { RelayServer } from '../src/relay.js'
import type { DocLog } from '../src/log-store.js'

// D1 / Spur-C — the remote-observation path (packages/e2e-log-sync harness) reads relay
// state ENTIRELY through GET /dashboard/data instead of an in-process docLog. These tests
// pin (1) the SHAPE + VALUES of the two fields that path binds to (logStats.entriesByDocAndDevice,
// logStats.spacesByDoc) against a known state when debug stats are ON, and (2) that those
// SENSITIVE fields are REDACTED by default — /dashboard/data is unauthenticated + public, so a
// prod relay must not leak admin DIDs / per-device counts. We seed the durable registry
// directly and assert both getStats() AND the real HTTP round-trip the harness uses.

function seedKnownState(docLog: DocLog): { spaceId: string; dev1: string; dev2: string; adminA: string; adminB: string } {
  const spaceId = randomUUID()
  const dev1 = randomUUID()
  const dev2 = randomUUID()
  const adminA = 'did:key:zAdminA'
  const adminB = 'did:key:zAdminB'
  docLog.registerSpace({ spaceId, verificationKey: 'vk-base64url', adminDids: [adminB, adminA] })
  // dev1 leaves 2 entries, dev2 leaves 1 — distinct (docId,deviceId,seq) so no VE-3 collision.
  docLog.appendEntry({ docId: spaceId, deviceId: dev1, seq: 0, contentHash: 'h-d1-0', entryJws: 'jws-d1-0' })
  docLog.appendEntry({ docId: spaceId, deviceId: dev1, seq: 1, contentHash: 'h-d1-1', entryJws: 'jws-d1-1' })
  docLog.appendEntry({ docId: spaceId, deviceId: dev2, seq: 0, contentHash: 'h-d2-0', entryJws: 'jws-d2-0' })
  return { spaceId, dev1, dev2, adminA, adminB }
}

describe('D1 /dashboard/data — remote-observation stats shape (debug stats ENABLED)', () => {
  let server: RelayServer
  let docLog: DocLog
  let httpBase: string

  beforeEach(async () => {
    // port:0 → OS-assigned ephemeral port, read back from the bound server (no TOCTOU race).
    server = new RelayServer({ port: 0, dbPath: ':memory:', exposeDebugStats: true })
    await server.start()
    httpBase = `http://localhost:${server.port}`
    docLog = (server as unknown as { docLog: DocLog }).docLog
  })

  afterEach(async () => {
    await server.stop()
  })

  it('exposes entriesByDoc / entriesByDocAndDevice[docId][deviceId] / spacesByDoc[docId]={registered,generation,admins}', async () => {
    const { spaceId, dev1, dev2, adminA, adminB } = seedKnownState(docLog)

    // (1) getStats() in-process shape.
    const stats = server.getStats() as { logStats: Record<string, unknown> }
    const logStats = stats.logStats as {
      entriesByDoc: Record<string, number>
      entriesByDocAndDevice: Record<string, Record<string, number>>
      spacesByDoc: Record<string, { registered: boolean; generation: number; admins: string[] }>
    }
    expect(logStats.entriesByDoc[spaceId]).toBe(3)
    expect(logStats.entriesByDocAndDevice[spaceId][dev1]).toBe(2)
    expect(logStats.entriesByDocAndDevice[spaceId][dev2]).toBe(1)
    expect(logStats.spacesByDoc[spaceId]).toEqual({
      registered: true,
      generation: 0,
      admins: [adminA, adminB], // ORDER BY admin_did ASC — deterministic
    })

    // (2) The real HTTP round-trip the remote harness performs (JSON serialization path).
    const res = await fetch(`${httpBase}/dashboard/data`)
    expect(res.ok).toBe(true)
    const json = (await res.json()) as typeof stats
    const httpLogStats = json.logStats as typeof logStats
    // entriesByDoc is the harness shape-gate field — assert it end-to-end too.
    expect(httpLogStats.entriesByDoc[spaceId]).toBe(3)
    expect(httpLogStats.entriesByDocAndDevice[spaceId][dev1]).toBe(2)
    expect(httpLogStats.entriesByDocAndDevice[spaceId][dev2]).toBe(1)
    expect(httpLogStats.spacesByDoc[spaceId].registered).toBe(true)
    expect(httpLogStats.spacesByDoc[spaceId].generation).toBe(0)
    expect(httpLogStats.spacesByDoc[spaceId].admins).toEqual([adminA, adminB])
  })

  it('omits a docId/spaceId that has no entries / is unregistered (reader treats absence as zero/false)', async () => {
    const unknownDoc = randomUUID()
    const res = await fetch(`${httpBase}/dashboard/data`)
    const json = (await res.json()) as {
      logStats: {
        entriesByDocAndDevice: Record<string, Record<string, number>>
        spacesByDoc: Record<string, unknown>
      }
    }
    expect(json.logStats.entriesByDocAndDevice[unknownDoc]).toBeUndefined()
    expect(json.logStats.spacesByDoc[unknownDoc]).toBeUndefined()
  })
})

describe('D1 /dashboard/data — sensitive stats REDACTED by default (debug stats OFF)', () => {
  let server: RelayServer
  let docLog: DocLog
  let httpBase: string

  beforeEach(async () => {
    // port:0 → OS-assigned ephemeral port, read back from the bound server (no TOCTOU race).
    server = new RelayServer({ port: 0, dbPath: ':memory:' }) // exposeDebugStats defaults to FALSE (prod)
    await server.start()
    httpBase = `http://localhost:${server.port}`
    docLog = (server as unknown as { docLog: DocLog }).docLog
  })

  afterEach(async () => {
    await server.stop()
  })

  it('does NOT leak admin DIDs (spacesByDoc) or per-device counts (entriesByDocAndDevice) over public /dashboard/data', async () => {
    seedKnownState(docLog) // a registered space WITH admin DIDs + per-device entries exists...

    const res = await fetch(`${httpBase}/dashboard/data`)
    const json = (await res.json()) as { logStats: Record<string, unknown> }
    // ...yet the unauthenticated, ACAO:* endpoint must omit the sensitive fields entirely.
    expect(json.logStats.spacesByDoc).toBeUndefined()
    expect(json.logStats.entriesByDocAndDevice).toBeUndefined()
    // The non-sensitive base aggregates stay public (unchanged pre-PR behavior).
    expect(json.logStats.totalEntries).toBe(3)
    expect((json.logStats.entriesByDoc as Record<string, number>) && Object.keys(json.logStats.entriesByDoc as object).length).toBe(1)
  })
})
