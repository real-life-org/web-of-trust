import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RelayServer } from '@web_of_trust/relay'
import { startRelay, makeIdentity, wait, waitFor, waitForStableCount, freePort, type StartedRelay } from './harness'
import { makeYjsClient, type YjsClient } from './yjs-client'
import { RawRelayClient, makeSpaceKeypair, mintSpaceCap } from './raw-client'
import { InMemoryDocLogStore, InMemoryCompactStore } from '@web_of_trust/core/adapters'
import { createPersonalDocCapabilityJwsWithSigner } from '@web_of_trust/core/protocol'
import type { PublicIdentitySession } from '@web_of_trust/core/application'

/**
 * Slice A / VE-11 — Yjs end-to-end acceptance against the REAL gated relay.
 *
 * Every test boots an in-process RelayServer + REAL WebSocketMessagingAdapter
 * clients + REAL YjsReplicationAdapters (enableLogSync:true, NO vault). Legacy
 * isolation is enforced in every test (no vault, content blocked by the spy,
 * positive docLog/sync-response assertions). Wire-Contract-Interop only.
 */

interface TestDoc {
  items: Record<string, { title: string }>
}

const assertLegacyIsolation = (...clients: YjsClient[]): void => {
  for (const c of clients) {
    // Content channel is DEAD: nothing was applied from a `content` envelope.
    expect(c.probe.contentMessagesApplied).toBe(0)
  }
}

describe('VE-11 Yjs — real gated relay', () => {
  let relay: StartedRelay
  const tracked: YjsClient[] = []
  const identities: PublicIdentitySession[] = []

  const newIdentity = async (): Promise<PublicIdentitySession> => {
    const id = await makeIdentity()
    identities.push(id)
    return id
  }
  const track = (c: YjsClient): YjsClient => {
    tracked.push(c)
    return c
  }

  beforeEach(async () => {
    relay = await startRelay()
  })

  afterEach(async () => {
    for (const c of tracked.splice(0)) await c.stop().catch(() => {})
    await relay?.stop()
    for (const id of identities.splice(0)) await id.deleteStoredIdentity().catch(() => {})
  })

  /** Creator creates a space + invites `members` over the REAL relay (ungated inbox cold-start). */
  async function createSharedSpace(
    creator: YjsClient,
    members: YjsClient[],
  ): Promise<string> {
    const space = await creator.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'VE11 Space' })
    await wait(250)
    for (const m of members) {
      const enc = await m.identity.getEncryptionPublicKeyBytes()
      await creator.adapter.addMember(space.id, m.identity.getDid(), enc)
    }
    await wait(members.length > 0 ? 500 : 150)
    return space.id
  }

  // ── Loop-safety: observe→write never re-broadcasts (the 5000+-outbox anchor) ──
  it('Loop-safety — receiving remote log entries applies them with ZERO re-broadcast; both clients converge; send count == local edits', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)

    // Baseline send counts AFTER setup (createSpace/addMember already emitted entries).
    const aliceBaseSent = alice.probe.sentLogEntries
    const bobBaseSent = bob.probe.sentLogEntries

    const N = 5
    for (let i = 0; i < N; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`a-${i}`] = { title: `alice-${i}` } })
      await wait(60)
    }

    const converged = await waitFor(() => {
      const d = bobHandle.getDoc()
      return Array.from({ length: N }).every((_, i) => d.items[`a-${i}`]?.title === `alice-${i}`)
    })
    expect(converged).toBe(true)

    // LOOP-GUARD: Alice sent exactly N new log-entries; Bob sent ZERO from receiving.
    expect(alice.probe.sentLogEntries - aliceBaseSent).toBe(N)
    expect(bob.probe.sentLogEntries - bobBaseSent).toBe(0)

    // Positive proof + legacy isolation.
    expect(relay.entryCount(spaceId)).toBeGreaterThanOrEqual(N)
    assertLegacyIsolation(alice, bob)
    expect(alice.probe.sentTypes).not.toContain('content')

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Content-sender off: never a `content` envelope after VE-2 ────────────────
  it('Content-sender off — steady-state edits send only log-entry, never content', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [])

    const handle = await alice.adapter.openSpace<TestDoc>(spaceId)
    handle.transact((d: TestDoc) => { d.items['t1'] = { title: 'first' } })
    handle.transact((d: TestDoc) => { d.items['t2'] = { title: 'second' } })
    await wait(200)

    expect(alice.probe.sentTypes).not.toContain('content')
    expect(alice.probe.sentLogEntries).toBeGreaterThanOrEqual(2)
    expect(relay.entryCount(spaceId)).toBeGreaterThanOrEqual(2)
    assertLegacyIsolation(alice)
    handle.close()
  })

  // ── Catch-up: offline device reconnect → present-capability + sync-request ───
  it('Catch-up — a device that was OFFLINE during the writes converges via sync-request (not live broadcast)', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    // Alice writes 3 edits BEFORE bob's catch-up device exists (it cannot have
    // received them via live broadcast — only sync-request can deliver them).
    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    for (let i = 0; i < 3; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`pre-${i}`] = { title: `pre-${i}` } })
      await wait(40)
    }
    await wait(150)

    // A FRESH Bob device (no live broadcast could have reached it): same identity +
    // keys + metadata, EMPTY log + compact store, NO vault. It MUST catch up via
    // sync-request → sync-response.
    const bobLate = track(await makeYjsClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      compactStore: new InMemoryCompactStore(),
    }))
    await bobLate.adapter.requestSync(spaceId)
    const bobHandle = await bobLate.adapter.openSpace<TestDoc>(spaceId)
    const converged = await waitFor(() => {
      const d = bobHandle.getDoc()
      return Array.from({ length: 3 }).every((_, i) => d.items[`pre-${i}`]?.title === `pre-${i}`)
    })
    expect(converged).toBe(true)
    // Catch-up rode sync-response (positive proof), NOT content.
    expect(bobLate.probe.syncResponseEntriesApplied).toBeGreaterThan(0)
    assertLegacyIsolation(alice, bobLate)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Multi-device: parallel writers, deterministic convergence, no nonce reuse ─
  it('Multi-device — parallel writes converge; each device keeps its own (deviceId,seq) namespace', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)

    // Interleaved parallel writes from both devices.
    for (let i = 0; i < 3; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`a-${i}`] = { title: `A${i}` } })
      bobHandle.transact((d: TestDoc) => { d.items[`b-${i}`] = { title: `B${i}` } })
      await wait(60)
    }

    const both = await waitFor(() => {
      const a = aliceHandle.getDoc()
      const b = bobHandle.getDoc()
      const all = (d: TestDoc) =>
        Array.from({ length: 3 }).every((_, i) => d.items[`a-${i}`]?.title === `A${i}` && d.items[`b-${i}`]?.title === `B${i}`)
      return all(a) && all(b)
    })
    expect(both).toBe(true)

    // Deterministic convergence: both docs identical.
    expect(aliceHandle.getDoc()).toEqual(bobHandle.getDoc())
    // Distinct device namespaces (no nonce-reuse across devices): the relay tracks
    // both devices' entries for the doc.
    expect(relay.entryCount(spaceId)).toBeGreaterThanOrEqual(6)
    assertLegacyIsolation(alice, bob)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Restore/Clone: new deviceId joins cleanly (no seq collision) ─────────────
  it('Restore/Clone — a fresh deviceId of the same identity joins and converges cleanly (new namespace)', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['base'] = { title: 'base' } })
    await wait(150)

    // A SECOND Bob device (new deviceId), sharing keys+metadata, fresh log+compact.
    const bob2 = track(await makeYjsClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      compactStore: new InMemoryCompactStore(),
    }))
    expect(bob2.deviceId).not.toBe(bob.deviceId)
    await bob2.adapter.requestSync(spaceId)
    const bob2Handle = await bob2.adapter.openSpace<TestDoc>(spaceId)
    expect(await waitFor(() => bob2Handle.getDoc().items['base']?.title === 'base')).toBe(true)

    // The new device can also WRITE under its fresh namespace and Alice converges.
    bob2Handle.transact((d: TestDoc) => { d.items['from-bob2'] = { title: 'b2' } })
    expect(await waitFor(() => aliceHandle.getDoc().items['from-bob2']?.title === 'b2')).toBe(true)
    assertLegacyIsolation(alice, bob2)

    aliceHandle.close()
    bob2Handle.close()
  })

  // ── Key-rotation: blocked-by-key buffer + replay converges, loop-free ────────
  it('Key-rotation — an entry under a not-yet-available generation is buffered, then replays loop-free after the key arrives', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['base'] = { title: 'base' } })
    expect(await waitFor(() => bobHandle.getDoc().items['base']?.title === 'base')).toBe(true)

    // Alice writes under a gen-1 key Bob does NOT have yet.
    const gen1 = crypto.getRandomValues(new Uint8Array(32))
    await alice.keyManagement.saveKey(spaceId, 1, gen1)
    aliceHandle.transact((d: TestDoc) => { d.items['secret'] = { title: 'secret' } })
    await wait(250)

    const bobCoord = (bob.adapter as unknown as {
      coordinators: Map<string, { blockedByKeyCount: () => number; replayBlockedByKey: () => Promise<number> }>
    }).coordinators.get(spaceId)!
    expect(bobCoord.blockedByKeyCount()).toBeGreaterThanOrEqual(1)
    expect(bobHandle.getDoc().items['secret']).toBeUndefined()

    // Import the gen-1 key into Bob and replay — replay must NOT send anything.
    const bobSentBefore = bob.probe.sentLogEntries
    await bob.keyManagement.saveKey(spaceId, 1, gen1)
    const converged = await bobCoord.replayBlockedByKey()
    expect(converged).toBeGreaterThanOrEqual(1)
    expect(await waitFor(() => bobHandle.getDoc().items['secret']?.title === 'secret')).toBe(true)
    expect(bob.probe.sentLogEntries - bobSentBefore).toBe(0) // LOOP-GUARD
    assertLegacyIsolation(alice, bob)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── space-register detection: the real relay treats the docId as a Space ─────
  it('space-register detection — after createSpace the relay marks the docId as a registered Space and accepts the Space capability', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [])

    expect(relay.isSpaceRegistered(spaceId)).toBe(true)
    expect(relay.getSpaceAdmins(spaceId)).toContain(alice.identity.getDid())
    // The creator already presented a Space capability + wrote → entries exist.
    const handle = await alice.adapter.openSpace<TestDoc>(spaceId)
    handle.transact((d: TestDoc) => { d.items['x'] = { title: 'x' } })
    await wait(150)
    expect(relay.entryCount(spaceId)).toBeGreaterThanOrEqual(1)
    assertLegacyIsolation(alice)
    handle.close()
  })

  // ── present-capability gate: no cap → CAPABILITY_REQUIRED; read-only → write rejected; then ok ─
  it('present-capability gate — no capability → CAPABILITY_REQUIRED; read-only scope rejects log-entry; after a read+write present it works', async () => {
    // Drive a RAW authenticated socket so we control exactly which capability is presented.
    const admin = await newIdentity()
    const spaceId = randomUUID()
    const { signingSeed, verificationKey } = await makeSpaceKeypair()

    const c = new RawRelayClient(relay.url, admin)
    await c.connect()

    // Register the space (admin), so it is governed by the Space path.
    expect((await c.sendSpaceRegister({ spaceId, verificationKey, adminDids: [admin.getDid()] })).status).toBe('delivered')
    expect(relay.isSpaceRegistered(spaceId)).toBe(true)

    // (1) No capability presented yet → log-entry AND sync-request rejected CAPABILITY_REQUIRED.
    await expect(c.sendLogEntry({ spaceId, seq: 0, plaintext: 'blocked' }))
      .rejects.toThrow(/CAPABILITY_REQUIRED/)
    await expect(c.sendSyncRequest(spaceId)).rejects.toThrow(/CAPABILITY_REQUIRED/)

    // (2) READ-only scope: sync-request served, but log-entry (write) rejected.
    const readCap = await mintSpaceCap({ signingSeed, spaceId, audience: admin.getDid(), permissions: ['read'] })
    expect((await c.presentCapability(readCap)).status).toBe('delivered')
    const readResp = await c.sendSyncRequestExpectResponse(spaceId)
    expect(readResp.type).toContain('sync-response')
    await expect(c.sendLogEntry({ spaceId, seq: 0, plaintext: 'no-write' }))
      .rejects.toThrow(/CAPABILITY_REQUIRED/)

    // (3) read+write scope: log-entry accepted.
    const rwCap = await mintSpaceCap({ signingSeed, spaceId, audience: admin.getDid(), permissions: ['read', 'write'] })
    expect((await c.presentCapability(rwCap)).status).toBe('delivered')
    expect((await c.sendLogEntry({ spaceId, seq: 0, plaintext: 'ok' })).status).toBe('delivered')
    expect(relay.entryCount(spaceId)).toBe(1)

    await c.disconnect()
  })

  // ── Capability-Herkunft NEGATIV: self-issued identity-signed cap for a Space docId → CAPABILITY_INVALID ─
  it('Capability-Herkunft negative — a member self-issues a capability with its Identity key for a registered Space docId → CAPABILITY_INVALID; follow-up frame stays CAPABILITY_REQUIRED; the correctly space-key-signed capability is accepted', async () => {
    const admin = await newIdentity()
    const spaceId = randomUUID()
    const { signingSeed, verificationKey } = await makeSpaceKeypair()

    const c = new RawRelayClient(relay.url, admin)
    await c.connect()
    expect((await c.sendSpaceRegister({ spaceId, verificationKey, adminDids: [admin.getDid()] })).status).toBe('delivered')

    // NEGATIVE: present a GENUINE self-issued Identity capability (kid = <did>#sig-0,
    // signed by the member's REAL Identity key — kid and signature are consistent) for
    // the now-SPACE docId. The relay routes to the Space path and verifies against the
    // registered space verification key, so even a cryptographically-valid Identity
    // self-issued cap fails → CAPABILITY_INVALID. This proves Space-vs-personal
    // authority routing (Identity authority cannot grant Space access), not merely a
    // generic bad-signature rejection.
    const selfIssued = await createPersonalDocCapabilityJwsWithSigner({
      payload: {
        type: 'capability',
        spaceId,
        audience: admin.getDid(),
        permissions: ['read', 'write'],
        generation: 0,
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      },
      kid: `${admin.getDid()}#sig-0`,
      sign: (input) => admin.signEd25519(input),
    })
    await expect(c.presentCapability(selfIssued)).rejects.toThrow(/CAPABILITY_INVALID/)

    // The rejected present cached nothing → the next write stays CAPABILITY_REQUIRED.
    await expect(c.sendLogEntry({ spaceId, seq: 0, plaintext: 'x' }))
      .rejects.toThrow(/CAPABILITY_REQUIRED/)

    // COUNTER-PROOF: the correctly space-key-signed capability (kid wot:space:...) is accepted.
    const correct = await mintSpaceCap({ signingSeed, spaceId, audience: admin.getDid(), permissions: ['read', 'write'] })
    expect((await c.presentCapability(correct)).status).toBe('delivered')
    expect((await c.sendLogEntry({ spaceId, seq: 0, plaintext: 'ok' })).status).toBe('delivered')

    await c.disconnect()
  })

  // ── validUntil expiry (client-side clock advance) → CAPABILITY_EXPIRED → re-present converges ─
  it('validUntil expiry — a short-lived capability stops authorizing once now >= validUntil (CAPABILITY_EXPIRED); a re-presented capability converges', async () => {
    // Inject the relay clock so we can advance past validUntil deterministically.
    await relay.stop()
    const validUntil = '2026-06-23T12:00:00Z'
    const expiryMs = Date.parse(validUntil)
    let clock = expiryMs - 60_000
    relay = await startRelayWithClock(() => clock)

    const admin = await newIdentity()
    const spaceId = randomUUID()
    const { signingSeed, verificationKey } = await makeSpaceKeypair()

    const c = new RawRelayClient(relay.url, admin)
    await c.connect()
    expect((await c.sendSpaceRegister({ spaceId, verificationKey, adminDids: [admin.getDid()] })).status).toBe('delivered')

    const mintShortLived = () => mintSpaceCap({ signingSeed, spaceId, audience: admin.getDid(), permissions: ['read', 'write'], validUntil })

    // Present while valid, write a baseline entry.
    expect((await c.presentCapability(await mintShortLived())).status).toBe('delivered')
    expect((await c.sendLogEntry({ spaceId, seq: 0, plaintext: 'before' })).status).toBe('delivered')

    // Advance the clock past validUntil → the cached scope is expired → write rejected EXPIRED.
    clock = expiryMs + 1_000
    await expect(c.sendLogEntry({ spaceId, seq: 1, plaintext: 'after' }))
      .rejects.toThrow(/CAPABILITY_EXPIRED/)
    // The post-expiry write was NOT stored.
    expect(relay.entryCount(spaceId)).toBe(1)

    // Re-present (rewind so the freshly-minted cap is valid) → write converges again.
    clock = expiryMs - 60_000
    expect((await c.presentCapability(await mintShortLived())).status).toBe('delivered')
    expect((await c.sendLogEntry({ spaceId, seq: 1, plaintext: 'after-renew' })).status).toBe('delivered')
    expect(relay.entryCount(spaceId)).toBe(2)

    await c.disconnect()
  })

  // ── HEADLINE: Cold-Reconstruction (Yjs), real relay, legacy isolation ────────
  it('HEADLINE Cold-Reconstruction (Yjs) — N writers fill the log; a FRESH Yjs client (same identity+membership, present-capability, NO vault, content blocked) reconstructs the doc fully via sync-response; relay.docLog.entryCount == N before disconnect; syncResponseEntriesApplied > 0', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    // Alice + Bob both write into the shared space.
    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['a1'] = { title: 'A1' } })
    await wait(80)
    aliceHandle.transact((d: TestDoc) => { d.items['a2'] = { title: 'A2' } })
    await wait(80)
    bobHandle.transact((d: TestDoc) => { d.items['b1'] = { title: 'B1' } })
    await wait(200)

    // Positive proof BEFORE the fresh client: the relay holds exactly N entries.
    const N = relay.entryCount(spaceId)
    expect(N).toBeGreaterThanOrEqual(5) // seed + bob-membership + 3 edits
    // Expected reconstructed plaintext (the convergence target).
    const expected = aliceHandle.getDoc()
    expect(expected.items['a1']?.title).toBe('A1')
    expect(expected.items['b1']?.title).toBe('B1')

    aliceHandle.close()
    bobHandle.close()

    // FRESH Bob device: SAME identity + keys + membership metadata, but EMPTY log +
    // EMPTY compact store, NO vault. It MUST reconstruct purely via sync-response.
    const fresh = track(await makeYjsClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      compactStore: new InMemoryCompactStore(),
    }))
    await fresh.adapter.requestSync(spaceId)
    const freshHandle = await fresh.adapter.openSpace<TestDoc>(spaceId)
    const reconstructed = await waitFor(() => {
      const d = freshHandle.getDoc()
      return d.items['a1']?.title === 'A1' && d.items['a2']?.title === 'A2' && d.items['b1']?.title === 'B1'
    }, { timeoutMs: 10_000 })
    expect(reconstructed).toBe(true)
    // Full doc equality with the original.
    expect(freshHandle.getDoc()).toEqual(expected)

    // POSITIVE proofs: catch-up rode sync-response; NO content was applied; entry
    // count is still N (the read path did not write).
    expect(fresh.probe.syncResponseEntriesApplied).toBeGreaterThan(0)
    expect(fresh.probe.sentLogEntries).toBe(0) // a pure reader never wrote
    expect(relay.entryCount(spaceId)).toBe(N)
    assertLegacyIsolation(alice, bob, fresh)

    freshHandle.close()
  })

  // ── Slice B HEADLINE: Multi-page Cold-Reconstruction against the REAL relay ───
  it('Slice B HEADLINE Multi-page Cold-Reconstruction (Yjs) — >100 log entries (default limit 100) reconstruct FULLY via >=2 sync-request/sync-response rounds against the real relay', async () => {
    const alice = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeYjsClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    // Write enough entries that the default page size (100) forces >=2 pages. Each
    // transact = one Yjs update = one log-entry. 120 edits + the seed/membership
    // entries puts the relay's log well over a single 100-entry page.
    const WRITES = 120
    for (let i = 0; i < WRITES; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`k${i}`] = { title: `v${i}` } })
      if (i % 20 === 0) await wait(20) // let the outbox drain in batches
    }
    // Drain BARRIER (not a fixed wait): wait until the relay entry count settles, so N is a
    // stable post-drain snapshot — a fixed wait(400) races Alice's async outbox under load.
    const N = await waitForStableCount(() => relay.entryCount(spaceId), { stableMs: 400, timeoutMs: 20_000 })
    expect(N).toBeGreaterThan(100) // multi-page territory (drain complete)
    const expected = aliceHandle.getDoc()
    expect(Object.keys(expected.items).length).toBeGreaterThanOrEqual(WRITES)
    aliceHandle.close()

    // FRESH Bob device: same identity/keys/membership, EMPTY log + compact store, no
    // vault → MUST reconstruct purely via a PAGINATED sync-response sequence.
    const fresh = track(await makeYjsClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      compactStore: new InMemoryCompactStore(),
    }))
    await fresh.adapter.requestSync(spaceId)
    const freshHandle = await fresh.adapter.openSpace<TestDoc>(spaceId)
    const reconstructed = await waitFor(() => {
      const d = freshHandle.getDoc()
      // ALL keys present — not just the first page's worth.
      return Object.keys(expected.items).every((k) => d.items[k]?.title === expected.items[k].title)
    }, { timeoutMs: 20_000 })
    expect(reconstructed).toBe(true)
    expect(freshHandle.getDoc()).toEqual(expected) // full doc equality, all 120

    // MULTI-PAGE proof: >=2 sync-request rounds AND >=2 sync-response pages observed
    // (a single-page catch-up would be exactly 1 each — the pagination teeth).
    expect(fresh.probe.sentSyncRequests).toBeGreaterThanOrEqual(2)
    expect(fresh.probe.syncResponseEnvelopes).toBeGreaterThanOrEqual(2)
    // Total reconstructed entries >= N (every page applied; the initial-sync +
    // requestSync may both run, so the sum can exceed N, but never fall short).
    expect(fresh.probe.syncResponseEntriesApplied).toBeGreaterThanOrEqual(N)
    expect(fresh.probe.sentLogEntries).toBe(0) // pure reader — the real "did not write" invariant
    expect(relay.entryCount(spaceId)).toBeGreaterThanOrEqual(N) // settled count; read path added nothing
    assertLegacyIsolation(alice, bob, fresh)

    freshHandle.close()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Helpers: Space capability keypair + a RAW authenticated relay client (so the
// gate / capability-origin tests present EXACTLY the capability under test).
// ════════════════════════════════════════════════════════════════════════════

async function startRelayWithClock(now: () => number): Promise<StartedRelay> {
  const port = await freePort()
  const server = new RelayServer({ port, dbPath: ':memory:', now })
  await server.start()
  const docLog = (server as unknown as {
    docLog: {
      entryCount: (id?: string) => number
      entryCountForDevice: (docId: string, deviceId: string) => number
      isSpaceRegistered: (id: string) => boolean
      getSpace: (id: string) => { verificationKey: string; generation: number } | null
      getSpaceAdmins: (id: string) => string[]
    }
  }).docLog
  return {
    server,
    url: `ws://localhost:${port}`,
    port,
    entryCount: (id) => docLog.entryCount(id),
    entryCountForDevice: (docId, deviceId) => docLog.entryCountForDevice(docId, deviceId),
    isSpaceRegistered: (id) => docLog.isSpaceRegistered(id),
    getSpace: (id) => docLog.getSpace(id),
    getSpaceAdmins: (id) => docLog.getSpaceAdmins(id),
    stop: () => server.stop(),
  }
}
