import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { makeAuthorFromLabel, newUuid } from '../src/identity.js'

/**
 * Loop safety: observe -> write triggers NO re-broadcast; applying the same entry
 * twice is a no-op (no duplication, no echo). Bounded total broadcasts.
 * CONTROL: the naive re-broadcasting variant EXPLODES (reproduces the 5000+ loop).
 */

describe('02 loop safety', () => {
  it('loop-free: applying the same entry twice is a no-op; broadcasts are bounded', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('loop-A')
    const authorB = await makeAuthorFromLabel('loop-B')
    const authorC = await makeAuthorFromLabel('loop-C')
    const members = [authorA.did, authorB.did, authorC.did]

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    const c = new SimClient({ author: authorC, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect(); c.connect()

    // One single op fully propagates to 3 subscribers.
    await a.localWrite('title', 'Hello')
    // Exactly one append; broadcast fanout = 3 subscribers (a,b,c) for that 1 entry.
    expect(relay.totalAppendCalls).toBe(1)
    expect(relay.totalBroadcasts).toBe(3)
    expect(relay.logLength(docId)).toBe(1)

    // Applying the SAME entry again to B is an idempotent no-op (no echo append).
    const entry = { jws: relay.logEntries(docId)[0], docId, deviceId: a.deviceId, seq: 0, contentHash: '' }
    const r1 = await b.receive(entry)
    expect(r1.applied).toBe(false)
    // No new append happened from the duplicate receive.
    expect(relay.totalAppendCalls).toBe(1)

    // Three distinct ops total -> exactly three appends, three log entries.
    await b.localWrite('location', 'Here')
    await c.localWrite('capacity', '42')
    expect(relay.totalAppendCalls).toBe(3)
    expect(relay.logLength(docId)).toBe(3)
    // Broadcasts bounded: 3 ops x 3 subscribers = 9 (linear in ops, NOT exploding).
    expect(relay.totalBroadcasts).toBe(9)

    // All converge.
    const h = await a.hash()
    expect(await b.hash()).toBe(h)
    expect(await c.hash()).toBe(h)
  })

  it('CONTROL: naive re-broadcasting clients explode (the 5000+ outbox loop)', async () => {
    const relay = new SimRelay('transient')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('loop-naive-A')
    const authorB = await makeAuthorFromLabel('loop-naive-B')
    const members = [authorA.did, authorB.did]

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members, naiveRebroadcast: true })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members, naiveRebroadcast: true })
    // Safety valve so the process cannot truly hang. The cascade is unbounded in
    // principle (each observe triggers a fresh write -> broadcast -> observe ...);
    // we cap the budget only to keep CI fast. Crossing 1000 (vs exactly 1 in the
    // loop-free design) is the explosion signature of the historical 5000+ loop.
    a.echoBudget = 700
    b.echoBudget = 700
    a.connect(); b.connect()

    // A SINGLE user write. With naive observe->write echoing, this cascades.
    await a.localWrite('title', 'Boom')

    // A loop-free design produces exactly 1 append for one user write (see below).
    // The naive variant produces 1000+. Reproduces the outbox explosion.
    expect(relay.totalAppendCalls).toBeGreaterThan(1000)
  }, 30000)

  it('contrast: in the loop-free design one user write = exactly one append', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('loop-contrast-A')
    const authorB = await makeAuthorFromLabel('loop-contrast-B')
    const members = [authorA.did, authorB.did]
    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect()
    await a.localWrite('title', 'Once')
    expect(relay.totalAppendCalls).toBe(1)
    expect(await b.hash()).toBe(await a.hash())
  })

  it('broker dedup: replaying the IDENTICAL entry is idempotent-retransmission (no re-store, no re-broadcast)', async () => {
    // The SECOND independent loop guard (the first is "clients never re-broadcast"):
    // a duplicate of an already-stored (deviceId,seq,contentHash) is dropped by the
    // broker via classifyBrokerSeqCollision -> idempotent-retransmission. This bounds
    // exact retransmissions (e.g. a flaky reconnect re-sending) without growth.
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('loop-dedup-A')
    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members: [authorA.did] })
    a.connect()

    await a.localWrite('title', 'Once')
    expect(relay.logLength(docId)).toBe(1)
    const broadcastsBefore = relay.totalBroadcasts

    // Replay the EXACT same signed entry (same deviceId, seq, ciphertext).
    const jws = relay.logEntries(docId)[0]
    const result = await relay.append({ jws, docId, deviceId: a.deviceId, seq: 0, recipients: [] })

    expect(result.disposition).toBe('idempotent-retransmission')
    expect(result.broadcastFanout).toBe(0)
    // No re-store, no re-broadcast.
    expect(relay.logLength(docId)).toBe(1)
    expect(relay.totalBroadcasts).toBe(broadcastsBefore)
  })
})
