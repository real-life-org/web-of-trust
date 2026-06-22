import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { makeAuthorFromLabel, newUuid, crypto } from '../src/identity.js'
import {
  verifyLogEntryJws,
  decodeBase64Url,
  deriveLogPayloadNonce,
  bytesToHex,
} from '@web_of_trust/core/protocol'

/**
 * Multi-device: 3 devices write concurrently. seq is per-(deviceId,docId), the set
 * of (deviceId,seq) pairs has NO duplicate with differing content (no nonce reuse),
 * and the CRDT merge converges deterministically regardless of delivery order.
 */

describe('04 multi-device concurrency', () => {
  it('per-device seq, no nonce reuse, order-independent convergence', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('md-A')
    const authorB = await makeAuthorFromLabel('md-B')
    const authorC = await makeAuthorFromLabel('md-C')
    const members = [authorA.did, authorB.did, authorC.did]

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    const c = new SimClient({ author: authorC, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect(); c.connect()

    // Interleaved concurrent writes (some to the SAME key to force LWW conflict).
    await a.localWrite('shared', 'a1')
    await b.localWrite('shared', 'b1')
    await c.localWrite('owner-c', 'c1')
    await a.localWrite('owner-a', 'a2')
    await b.localWrite('shared', 'b2')

    const converged = await a.hash()
    expect(await b.hash()).toBe(converged)
    expect(await c.hash()).toBe(converged)

    // seq is per (deviceId, docId): each device's seqs start at 0 and increment.
    const seqKeys = relay.seqKeys(docId)
    const perDevice = new Map<string, number[]>()
    for (const key of seqKeys) {
      const sep = key.lastIndexOf('|')
      const dev = key.slice(0, sep)
      const seq = Number(key.slice(sep + 1))
      if (!perDevice.has(dev)) perDevice.set(dev, [])
      perDevice.get(dev)!.push(seq)
    }
    expect(perDevice.size).toBe(3)
    expect(perDevice.get(a.deviceId)!.sort((x, y) => x - y)).toEqual([0, 1])
    expect(perDevice.get(b.deviceId)!.sort((x, y) => x - y)).toEqual([0, 1])
    expect(perDevice.get(c.deviceId)!.sort((x, y) => x - y)).toEqual([0])

    // No nonce reuse: every (deviceId,seq) pair is unique => deterministic nonces
    // are all distinct. We verify each entry's nonce matches SHA(deviceId|seq) AND
    // that no two ACCEPTED entries share a (deviceId,seq) with differing content.
    const nonces = new Set<string>()
    const seqContent = new Map<string, string>()
    for (const jws of relay.logEntries(docId)) {
      const payload = await verifyLogEntryJws(jws, { crypto })
      const blob = decodeBase64Url(payload.data)
      const nonce = blob.slice(0, 12)
      const expectedNonce = await deriveLogPayloadNonce(crypto, payload.deviceId, payload.seq)
      expect(bytesToHex(nonce)).toBe(bytesToHex(expectedNonce))
      const key = `${payload.deviceId}|${payload.seq}`
      const ch = bytesToHex(await crypto.sha256(blob))
      if (seqContent.has(key)) {
        // same (deviceId,seq) must NOT carry different content (that is reuse).
        expect(seqContent.get(key)).toBe(ch)
      }
      seqContent.set(key, ch)
      nonces.add(bytesToHex(nonce))
    }
    // All nonces distinct across the accepted log.
    expect(nonces.size).toBe(relay.logLength(docId))
  })

  it('delivery order does not affect the converged state', async () => {
    // Produce a fixed set of entries from 3 devices on a "source" relay.
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('md2-A')
    const authorB = await makeAuthorFromLabel('md2-B')
    const authorC = await makeAuthorFromLabel('md2-C')
    const members = [authorA.did, authorB.did, authorC.did]
    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    const c = new SimClient({ author: authorC, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect(); c.connect()
    await a.localWrite('shared', 'a1')
    await b.localWrite('shared', 'b1')
    await c.localWrite('shared', 'c1')
    await a.localWrite('x', 'ax')
    const target = await a.hash()

    const entries = relay.logEntries(docId)
    // Apply the SAME entries in two different permutations to two fresh clients.
    const order1 = [0, 1, 2, 3]
    const order2 = [3, 1, 0, 2]

    async function applyInOrder(order: number[]): Promise<string> {
      const client = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
      for (const idx of order) {
        const jws = entries[idx]
        const payload = await verifyLogEntryJws(jws, { crypto })
        await client.receive({ jws, docId, deviceId: payload.deviceId, seq: payload.seq, contentHash: '' })
      }
      return client.hash()
    }

    const h1 = await applyInOrder(order1)
    const h2 = await applyInOrder(order2)
    expect(h1).toBe(h2)
    expect(h1).toBe(target)
  })

  it('offline-concurrent writes to the SAME key reconcile deterministically on catch-up', async () => {
    // Two genuinely divergent causal histories (not a replayed fixed op-set): both
    // devices write the same key while OFFLINE, each at Lamport 1, unaware of the
    // other. On catch-up the LWW tie (equal Lamport) is broken by the higher
    // deviceId — deterministic and order-independent.
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('md3-A')
    const authorB = await makeAuthorFromLabel('md3-B')
    const members = [authorA.did, authorB.did]
    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })

    // Both OFFLINE (never connect): each only knows its own write.
    await a.localWrite('title', 'from-A')
    await b.localWrite('title', 'from-B')
    expect(a.snapshot()).toEqual({ title: 'from-A' })
    expect(b.snapshot()).toEqual({ title: 'from-B' })

    // Each catches up the other's entry from the durable log and reconciles.
    await a.catchUp()
    await b.catchUp()
    expect(await a.hash()).toBe(await b.hash())

    // Deterministic winner: higher deviceId wins the equal-Lamport tie.
    const winner = a.deviceId > b.deviceId ? 'from-A' : 'from-B'
    expect(a.snapshot()).toEqual({ title: winner })
    expect(b.snapshot()).toEqual({ title: winner })
  })
})
