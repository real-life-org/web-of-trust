import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { makeAuthorFromLabel, newUuid } from '../src/identity.js'
import { compareSyncHeads } from '@web_of_trust/core/protocol'

/**
 * Catch-up: B offline while A writes M entries. On reconnect, compare broker vs
 * local heads -> sync-request -> missing entries delivered -> B converges to A.
 * Also exercises paging (limit/truncated).
 */

describe('03 catch-up', () => {
  it('offline B catches up to A after M writes and converges', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('catchup-A')
    const authorB = await makeAuthorFromLabel('catchup-B')
    const members = [authorA.did, authorB.did]

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect()

    // Initial shared write so both have a common base.
    await a.localWrite('k0', 'v0')
    expect(await b.hash()).toBe(await a.hash())

    // B goes offline; A writes M more entries.
    b.goOffline()
    const M = 8
    for (let i = 1; i <= M; i++) await a.localWrite(`k${i}`, `v${i}`)

    // Heads now diverge.
    expect(compareSyncHeads(b.localHeads(), relay.brokerHeads(docId))).toBe('divergent')

    // B reconnects and catches up.
    b.connect()
    const result = await b.catchUp()
    expect(result.appliedCount).toBe(M) // exactly the missing entries
    expect(compareSyncHeads(b.localHeads(), relay.brokerHeads(docId))).toBe('consistent')
    expect(await b.hash()).toBe(await a.hash())
  })

  it('cold client (relay restart simulation) catches up via paging', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('catchup-cold-A')
    const authorB = await makeAuthorFromLabel('catchup-cold-B')
    const members = [authorA.did, authorB.did]

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    a.connect()
    const N = 10
    for (let i = 0; i < N; i++) await a.localWrite(`k${i}`, `v${i}`)
    const targetHash = await a.hash()

    // A fresh client (empty cache, never connected) pages through the full log.
    const fresh = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    const result = await fresh.catchUp(3) // limit=3 -> forces multiple pages
    expect(result.pages).toBeGreaterThan(1) // truncation actually exercised
    expect(result.appliedCount).toBe(N)
    expect(await fresh.hash()).toBe(targetHash)
  })
})
