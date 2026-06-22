import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { SimVault } from '../src/sim-vault.js'
import { newDoc, localWrite } from '../src/crdt-stub.js'
import { makeAuthorFromLabel, newUuid } from '../src/identity.js'

/**
 * HEADLINE: N clients write to one space, sync, then ALL clear cache + disconnect.
 * A FRESH client (same identity/membership + spaceContentKey) reconstructs the
 * FULL space.
 *
 *  - durable-log: succeeds (relay retains the log; empty-heads sync gets everything).
 *  - transient control: fails (entries gone after ACK; fresh client gets nothing).
 *  - Plan-B: SimVault snapshot WITH coverage-heads + log-since-snapshot converges,
 *    and a snapshot is never claimed as a log replacement.
 */

async function buildSpace() {
  const docId = newUuid()
  const authorA = await makeAuthorFromLabel('cold-A')
  const authorB = await makeAuthorFromLabel('cold-B')
  const authorC = await makeAuthorFromLabel('cold-C')
  const members = [authorA.did, authorB.did, authorC.did]
  return { docId, authorA, authorB, authorC, members }
}

describe('01 cold reconstruction (HEADLINE)', () => {
  it('durable-log: a fresh empty client reconstructs the full space', async () => {
    const relay = new SimRelay('durable-log')
    const { docId, authorA, authorB, authorC, members } = await buildSpace()

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    const c = new SimClient({ author: authorC, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect(); c.connect()

    await a.localWrite('title', 'Festival Camp')
    await b.localWrite('location', 'Black Rock')
    await c.localWrite('capacity', '120')
    await a.localWrite('title', 'Festival Camp 2026')

    // All three converge live.
    const originalHash = await a.hash()
    expect(await b.hash()).toBe(originalHash)
    expect(await c.hash()).toBe(originalHash)
    expect(a.snapshot()).toEqual({ title: 'Festival Camp 2026', location: 'Black Rock', capacity: '120' })

    // Everyone clears cache + disconnects (cold).
    a.goOffline(); b.goOffline(); c.goOffline()
    a.clearCache(); b.clearCache(); c.clearCache()

    // A brand new device with the same identity/membership joins cold.
    const fresh = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    fresh.connect()
    const result = await fresh.catchUp()
    expect(result.appliedCount).toBe(4)
    expect(await fresh.hash()).toBe(originalHash)
    expect(fresh.snapshot()).toEqual({ title: 'Festival Camp 2026', location: 'Black Rock', capacity: '120' })

    // The relay actually retained the log.
    expect(relay.logLength(docId)).toBe(4)
  })

  it('CONTROL (transient): the space is permanently lost after ACK', async () => {
    const relay = new SimRelay('transient')
    const { docId, authorA, authorB, members } = await buildSpace()

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })

    await a.localWrite('title', 'Festival Camp')
    await a.localWrite('location', 'Black Rock')
    await b.localWrite('capacity', '120')

    // B comes online, drains its queue, ACKs => rows deleted.
    const delivered = relay.transientDeliver(authorB.did)
    for (const e of delivered) await b.receive(e)
    relay.transientAck(authorB.did)
    // A also drains + ACKs.
    const deliveredA = relay.transientDeliver(authorA.did)
    for (const e of deliveredA) await a.receive(e)
    relay.transientAck(authorA.did)

    const originalSnapshot = { title: 'Festival Camp', location: 'Black Rock', capacity: '120' }
    const originalHash = await a.hash()
    // (live broadcast already converged a + b before ACK; that is not the point.)

    // Everyone clears cache (browser cache wiped) and disconnects.
    a.clearCache(); b.clearCache()

    // A fresh client tries cold reconstruction. Transient relay retains NOTHING.
    const fresh = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const page = relay.syncPage(docId, {}, undefined)
    expect(page.entries).toEqual([]) // no retained log to serve

    // The fresh client ends up empty: the space is GONE.
    expect(fresh.snapshot()).toEqual({})
    // Reconstructed visible state != original (the permanent-space-loss bug).
    expect(fresh.snapshot()).not.toEqual(originalSnapshot)
    expect(await fresh.hash()).not.toBe(originalHash)
    // The transient relay retains NO per-doc log (durable-log would).
    expect(relay.logLength(docId)).toBe(0)
    // B's drained+ACKed rows are deleted; only C's never-drained rows linger,
    // and even those are useless for a FRESH client (no per-doc history API).
    expect(relay.transientDeliver(authorB.did)).toEqual([]) // B has nothing left
  })

  it('PLAN-B: snapshot (coverage-heads) + log-since-heads converges — optimization is real AND load-bearing; snapshot is never a log replacement', async () => {
    const relay = new SimRelay('durable-log')
    const vault = new SimVault()
    const { docId, authorA, authorB, members } = await buildSpace()

    const a = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    const b = new SimClient({ author: authorB, deviceId: newUuid(), docId, relay, members })
    a.connect(); b.connect()

    // First epoch, then take a coverage snapshot (full registers + coverage-heads).
    await a.localWrite('title', 'Camp')
    await b.localWrite('location', 'Desert') // pre-snapshot-ONLY key
    const snapHeads = relay.brokerHeads(docId)
    await vault.putSnapshot({ docId, keyGeneration: 0, doc: a.doc, heads: snapHeads })

    // Second epoch AFTER the snapshot (these live ONLY in the log, not the snapshot).
    await a.localWrite('capacity', '80') // new key
    await b.localWrite('title', 'Camp 2026') // OVERWRITES a snapshot key
    const finalHash = await a.hash()
    expect(await b.hash()).toBe(finalHash)

    const snapshot = vault.getSnapshot(docId)!
    const disposition = vault.classify({
      snapshot,
      expectedDocId: docId,
      expectedKeyGeneration: 0,
      keyMaterial: 'available',
    })
    // A snapshot is NEVER an append-only-log replacement.
    expect(disposition.markSnapshotProcessed).toBe(false)
    // With coverage-heads it is catch-up-optimization-eligible.
    expect(disposition.status).toBe('catch-up-optimization-eligible')
    expect(disposition.actions).toContain('log-head-coverage-optimization')

    // Behaviour is DRIVEN by the disposition, not just asserted on it.
    const restored = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    if (disposition.status === 'catch-up-optimization-eligible') {
      await vault.mergeInto(restored.doc, snapshot) // relay-independent checkpoint
      restored.seedCoverage(snapshot.heads!) // skip the pre-snapshot log
    }
    // Snapshot alone is NOT authoritative — it lacks the second epoch.
    expect(await restored.hash()).not.toBe(finalHash)

    // Catch up ONLY the log since the snapshot heads: EXACTLY the 2 post-snapshot
    // entries are fetched (the optimization), not all 4.
    const caught = await restored.catchUp()
    expect(caught.appliedCount).toBe(2)
    expect(await restored.hash()).toBe(finalHash)
    expect(restored.snapshot()).toEqual({ title: 'Camp 2026', location: 'Desert', capacity: '80' })

    // The snapshot is genuinely LOAD-BEARING: a since-heads catch-up WITHOUT it loses
    // the pre-snapshot-only key 'location'.
    const noSnapshot = new SimClient({ author: authorA, deviceId: newUuid(), docId, relay, members })
    noSnapshot.seedCoverage(snapHeads)
    await noSnapshot.catchUp()
    expect(noSnapshot.snapshot()).toEqual({ title: 'Camp 2026', capacity: '80' }) // 'location' missing
    expect(await noSnapshot.hash()).not.toBe(finalHash)
  })

  it('PLAN-B negative: a snapshot WITHOUT coverage-heads is only a crdt-merge helper', async () => {
    const vault = new SimVault()
    const docId = newUuid()
    const doc = newDoc()
    localWrite(doc, 'title', 'X', newUuid())
    await vault.putSnapshot({ docId, keyGeneration: 0, doc, heads: undefined }) // NO coverage-heads
    const snapshot = vault.getSnapshot(docId)!
    const disposition = vault.classify({
      snapshot,
      expectedDocId: docId,
      expectedKeyGeneration: 0,
      keyMaterial: 'available',
    })
    expect(disposition.status).toBe('crdt-merge-helper-only')
    expect(disposition.markSnapshotProcessed).toBe(false)
    expect(disposition.actions).toContain('sync-request-log-catch-up')
  })
})
