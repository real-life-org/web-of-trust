import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startRelay, makeIdentity, wait, waitFor, waitForStableCount, testMode, type StartedRelay } from './harness'
import { makeAutomergeClient, type AutomergeClient } from './automerge-client'
import { isCanonicalUuidV4, spaceIdToDocumentId, InMemoryRepoStorageAdapter } from '@web_of_trust/adapter-automerge'
import { InMemoryDocLogStore } from '@web_of_trust/core/adapters'
import { decodeBase64Url } from '@web_of_trust/core/protocol'
import type { PublicIdentitySession } from '@web_of_trust/core/application'

/**
 * Slice A / VE-11 — Automerge end-to-end acceptance against the REAL gated relay
 * (separate engine; Wire-Contract-Interop, NOT CRDT-state-interop).
 *
 * Same harness contract as the Yjs suite: in-process RelayServer + REAL WS
 * clients + REAL AutomergeReplicationAdapters (enableLogSync:true, NO vault, NO
 * CompactStore). Legacy isolation enforced in every test.
 */

interface TestDoc {
  items: Record<string, { title: string }>
}

const assertLegacyIsolation = (...clients: AutomergeClient[]): void => {
  for (const c of clients) expect(c.probe.contentMessagesApplied).toBe(0)
}

/** Decode (NOT verify) the docId from a log-entry JWS payload. */
function logEntryDocId(entryJws: string): string {
  const payloadSegment = entryJws.split('.')[1]
  return (JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadSegment))) as { docId: string }).docId
}

// TC5 test-mode matrix: every `it` below is remote-CAPABLE (in-process AND remote vs
// Staging, random docId/DID) UNLESS wrapped. `it.skipIf(testMode.skipDestructiveRemote)`
// = remote-destructive (restore-clone / key-rotation → remote only with REMOTE_ALLOW_DESTRUCTIVE).
describe('VE-11 Automerge — real gated relay', () => {
  let relay: StartedRelay
  const tracked: AutomergeClient[] = []
  const identities: PublicIdentitySession[] = []

  const newIdentity = async (): Promise<PublicIdentitySession> => {
    const id = await makeIdentity()
    identities.push(id)
    return id
  }
  const track = (c: AutomergeClient): AutomergeClient => {
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

  async function createSharedSpace(creator: AutomergeClient, members: AutomergeClient[]): Promise<string> {
    const space = await creator.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'VE11 AM Space' })
    await wait(300)
    for (const m of members) {
      const enc = await m.identity.getEncryptionPublicKeyBytes()
      await creator.adapter.addMember(space.id, m.identity.getDid(), enc)
    }
    await wait(members.length > 0 ? 600 : 200)
    return space.id
  }

  // ── Loop-safety ──────────────────────────────────────────────────────────────
  it('Loop-safety — receiving remote log entries applies them with ZERO re-broadcast; both clients converge; send count == local edits', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
    const aliceBase = alice.probe.sentLogEntries
    const bobBase = bob.probe.sentLogEntries
    // Steady-state baseline: the automerge-repo native channel may emit a few
    // `content` frames during the initial space/peer handshake BEFORE the
    // coordinator sets logSyncManaged (the gate that suppresses content). VE-7's
    // "content-sender off" is a STEADY-STATE property (after VE-2), so we assert no
    // content is sent from this point on — matching the AutomergeLogSync unit test
    // (which instruments after setup for the same reason).
    const aliceSentBaseline = alice.probe.sentTypes.length

    const N = 5
    for (let i = 0; i < N; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`a-${i}`] = { title: `alice-${i}` } })
      await wait(70)
    }

    const converged = await waitFor(() => {
      const d = bobHandle.getDoc()
      return Array.from({ length: N }).every((_, i) => d.items[`a-${i}`]?.title === `alice-${i}`)
    })
    expect(converged).toBe(true)
    expect(alice.probe.sentLogEntries - aliceBase).toBe(N)
    expect(bob.probe.sentLogEntries - bobBase).toBe(0) // LOOP-GUARD
    expect(await relay.entryCount(spaceId)).toBeGreaterThanOrEqual(N)
    assertLegacyIsolation(alice, bob)
    // Steady-state: no content sent during the edit storm (only log-entry).
    expect(alice.probe.sentTypes.slice(aliceSentBaseline)).not.toContain('content')

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Content-sender off ─────────────────────────────────────────────────────
  it('Content-sender off — steady-state edits send only log-entry, never content', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [])
    const handle = await alice.adapter.openSpace<TestDoc>(spaceId)
    // Steady-state baseline (see Loop-safety note on the initial-handshake content).
    const baseline = alice.probe.sentTypes.length
    handle.transact((d: TestDoc) => { d.items['t1'] = { title: 'first' } })
    handle.transact((d: TestDoc) => { d.items['t2'] = { title: 'second' } })
    await wait(250)
    expect(alice.probe.sentTypes.slice(baseline)).not.toContain('content')
    expect(alice.probe.sentLogEntries).toBeGreaterThanOrEqual(2)
    expect(await relay.entryCount(spaceId)).toBeGreaterThanOrEqual(2)
    assertLegacyIsolation(alice)
    handle.close()
  })

  // ── Multi-device parallel writes ───────────────────────────────────────────
  it('Multi-device — parallel writes converge deterministically; distinct (deviceId,seq) namespaces', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])
    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)

    for (let i = 0; i < 3; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`a-${i}`] = { title: `A${i}` } })
      bobHandle.transact((d: TestDoc) => { d.items[`b-${i}`] = { title: `B${i}` } })
      await wait(70)
    }

    const both = await waitFor(() => {
      const all = (d: TestDoc) =>
        Array.from({ length: 3 }).every((_, i) => d.items[`a-${i}`]?.title === `A${i}` && d.items[`b-${i}`]?.title === `B${i}`)
      return all(aliceHandle.getDoc()) && all(bobHandle.getDoc())
    })
    expect(both).toBe(true)
    expect(await relay.entryCount(spaceId)).toBeGreaterThanOrEqual(6)
    assertLegacyIsolation(alice, bob)

    aliceHandle.close()
    bobHandle.close()
  })

  // ── Restore/Clone: fresh deviceId joins cleanly ────────────────────────────
  it.skipIf(testMode.skipDestructiveRemote)('Restore/Clone — a fresh deviceId of the same identity joins and converges cleanly', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])
    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['base'] = { title: 'base' } })
    await wait(200)

    const bob2 = track(await makeAutomergeClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      repoStorage: new InMemoryRepoStorageAdapter(),
    }))
    expect(bob2.deviceId).not.toBe(bob.deviceId)
    await bob2.adapter.requestSync(spaceId)
    const bob2Handle = await bob2.adapter.openSpace<TestDoc>(spaceId)
    expect(await waitFor(() => bob2Handle.getDoc().items['base']?.title === 'base')).toBe(true)

    bob2Handle.transact((d: TestDoc) => { d.items['from-bob2'] = { title: 'b2' } })
    expect(await waitFor(() => aliceHandle.getDoc().items['from-bob2']?.title === 'b2')).toBe(true)
    assertLegacyIsolation(alice, bob2)

    aliceHandle.close()
    bob2Handle.close()
  })

  // ── Key-rotation blocked-by-key buffer + replay ────────────────────────────
  it.skipIf(testMode.skipDestructiveRemote)('Key-rotation — an entry under a not-yet-available generation is buffered, then replays loop-free after the key arrives', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])
    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['base'] = { title: 'base' } })
    expect(await waitFor(() => bobHandle.getDoc().items['base']?.title === 'base')).toBe(true)

    const gen1 = crypto.getRandomValues(new Uint8Array(32))
    await alice.keyManagement.saveKey(spaceId, 1, gen1)
    aliceHandle.transact((d: TestDoc) => { d.items['secret'] = { title: 'secret' } })
    await wait(250)

    const bobCoord = (bob.adapter as unknown as {
      coordinators: Map<string, { blockedByKeyCount: () => number; replayBlockedByKey: () => Promise<number> }>
    }).coordinators.get(spaceId)!
    expect(bobCoord.blockedByKeyCount()).toBeGreaterThanOrEqual(1)
    expect(bobHandle.getDoc().items['secret']).toBeUndefined()

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

  // ── space-register detection ───────────────────────────────────────────────
  it('space-register detection — after createSpace the relay marks the docId (UUID) as a registered Space', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [])
    expect(await relay.isSpaceRegistered(spaceId)).toBe(true)
    expect(await relay.getSpaceAdmins(spaceId)).toContain(alice.identity.getDid())
    assertLegacyIsolation(alice)
  })

  // ── VE-9 Automerge docId wire conformance (a/b/c/d) ────────────────────────
  it('VE-9 wire conformance — (a) log-entry docId is the canonical lowercase UUID (=spaceId), NOT base58; (b) a second Automerge client converges; (c) present-capability carries the same UUID; (d) a fresh start with NO repo cache re-maps to the same UUID docId', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    // (a) docId conformance.
    expect(isCanonicalUuidV4(spaceId)).toBe(true)
    expect(spaceId).toBe(spaceId.toLowerCase())
    const base58 = spaceIdToDocumentId(spaceId)
    expect(base58).not.toBe(spaceId)

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['shared'] = { title: 'shared-item' } })
    await wait(250)

    // (b) a second Automerge client converged (UUID wire identity).
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
    expect(await waitFor(() => bobHandle.getDoc().items['shared']?.title === 'shared-item')).toBe(true)

    // (a, cont.) the stored log-entry payload docId is the canonical UUID, not base58.
    const store = (alice.adapter as unknown as { docLogStore: InMemoryDocLogStore }).docLogStore
    const seed = await store.getEntry(spaceId, alice.deviceId, 0)
    expect(seed).not.toBeNull()
    expect(logEntryDocId(seed!.entryJws)).toBe(spaceId)
    expect(logEntryDocId(seed!.entryJws)).not.toBe(base58)

    // (c) present-capability carried the UUID docId: the relay registered the space
    // under the UUID, and a capability minted for the UUID was accepted (entries exist).
    expect(await relay.isSpaceRegistered(spaceId)).toBe(true)
    expect(await relay.entryCount(spaceId)).toBeGreaterThan(0)

    aliceHandle.close()
    bobHandle.close()

    // (d) a fresh Bob start with NO repo cache re-maps to the same UUID docId and
    // converges the existing log via cold-start catch-up.
    const fresh = track(await makeAutomergeClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      repoStorage: new InMemoryRepoStorageAdapter(),
    }))
    await fresh.adapter.requestSync(spaceId)
    const freshState = (fresh.adapter as unknown as { spaces: Map<string, { documentId: string }> }).spaces.get(spaceId)
    expect(freshState).toBeTruthy()
    expect(freshState!.documentId).toBe(base58) // re-derived from the canonical UUID
    const freshHandle = await fresh.adapter.openSpace<TestDoc>(spaceId)
    expect(await waitFor(() => freshHandle.getDoc().items['shared']?.title === 'shared-item')).toBe(true)
    assertLegacyIsolation(fresh)
    freshHandle.close()
  })

  // ── HEADLINE: Cold-Reconstruction (Automerge) ──────────────────────────────
  it('HEADLINE Cold-Reconstruction (Automerge) — N writers fill the log; a FRESH Automerge client (same identity+membership, present-capability, NO vault/CompactStore, content blocked) reconstructs fully via sync-response; relay.docLog.entryCount == N before disconnect; syncResponseEntriesApplied > 0', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['a1'] = { title: 'A1' } })
    await wait(90)
    aliceHandle.transact((d: TestDoc) => { d.items['a2'] = { title: 'A2' } })
    await wait(90)
    bobHandle.transact((d: TestDoc) => { d.items['b1'] = { title: 'B1' } })
    await wait(250)

    const N = await relay.entryCount(spaceId)
    expect(N).toBeGreaterThanOrEqual(5)
    const expected = aliceHandle.getDoc()
    expect(expected.items['a1']?.title).toBe('A1')
    expect(expected.items['b1']?.title).toBe('B1')

    aliceHandle.close()
    bobHandle.close()

    // FRESH Bob device: same identity + keys + metadata, EMPTY log + repo, NO vault.
    const fresh = track(await makeAutomergeClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      repoStorage: new InMemoryRepoStorageAdapter(),
    }))
    await fresh.adapter.requestSync(spaceId)
    const freshHandle = await fresh.adapter.openSpace<TestDoc>(spaceId)
    const reconstructed = await waitFor(() => {
      const d = freshHandle.getDoc()
      return d.items['a1']?.title === 'A1' && d.items['a2']?.title === 'A2' && d.items['b1']?.title === 'B1'
    }, { timeoutMs: 10_000 })
    expect(reconstructed).toBe(true)

    // POSITIVE proofs.
    expect(fresh.probe.syncResponseEntriesApplied).toBeGreaterThan(0)
    expect(fresh.probe.sentLogEntries).toBe(0)
    expect(await relay.entryCount(spaceId)).toBe(N)
    assertLegacyIsolation(alice, bob, fresh)

    freshHandle.close()
  })

  // ── Slice B HEADLINE: Multi-page Cold-Reconstruction (Automerge parity) ──────
  it('Slice B HEADLINE Multi-page Cold-Reconstruction (Automerge) — >100 log entries (default limit 100) reconstruct FULLY via >=2 sync-request/sync-response rounds against the real relay', async () => {
    const alice = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const bob = track(await makeAutomergeClient({ relay, identity: await newIdentity() }))
    const spaceId = await createSharedSpace(alice, [bob])

    const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
    // Each transact = one Automerge change = one log-entry. 120 edits + seed/membership
    // entries puts the relay's log well over a single 100-entry page.
    const WRITES = 120
    for (let i = 0; i < WRITES; i++) {
      aliceHandle.transact((d: TestDoc) => { d.items[`k${i}`] = { title: `v${i}` } })
      if (i % 20 === 0) await wait(20) // let the outbox drain in batches
    }
    // Drain BARRIER (not a fixed wait): settle the relay entry count before snapshotting N —
    // a fixed wait races Automerge's async outbox under load (Slice B v3, Opus merge-blocker).
    const N = await waitForStableCount(() => relay.entryCount(spaceId), { stableMs: 400, timeoutMs: 25_000 })
    expect(N).toBeGreaterThan(100) // multi-page territory (drain complete)
    const expected = aliceHandle.getDoc()
    expect(Object.keys(expected.items).length).toBeGreaterThanOrEqual(WRITES)
    aliceHandle.close()

    // FRESH Bob device: same identity/keys/membership, EMPTY log + repo, no vault → MUST
    // reconstruct purely via a PAGINATED sync-response sequence. noStart + start() (not an extra
    // requestSync): the reconstruction rides a SINGLE restore catch-up that MUST paginate. An
    // auto-start restore catch-up PLUS an explicit requestSync would be TWO catch-ups, so a
    // single-page-per-catch-up regression would still reconstruct (1 page each) and mask the
    // pagination break (CodeRabbit greenwash).
    const fresh = track(await makeAutomergeClient({
      relay,
      identity: bob.identity,
      keyManagement: bob.keyManagement,
      metadataStorage: bob.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      repoStorage: new InMemoryRepoStorageAdapter(),
      noStart: true,
    }))
    await fresh.adapter.start()
    const freshHandle = await fresh.adapter.openSpace<TestDoc>(spaceId)
    const reconstructed = await waitFor(() => {
      const d = freshHandle.getDoc()
      return Object.keys(expected.items).every((k) => d.items[k]?.title === expected.items[k].title)
    }, { timeoutMs: 25_000 })
    expect(reconstructed).toBe(true)
    expect(Object.keys(freshHandle.getDoc().items).length).toBe(Object.keys(expected.items).length) // all 120

    // MULTI-PAGE proof: >=2 sync-request rounds AND >=2 sync-response pages observed.
    expect(fresh.probe.sentSyncRequests).toBeGreaterThanOrEqual(2)
    expect(fresh.probe.syncResponseEnvelopes).toBeGreaterThanOrEqual(2)
    expect(fresh.probe.syncResponseEntriesApplied).toBeGreaterThanOrEqual(N)
    expect(fresh.probe.sentLogEntries).toBe(0) // pure reader — the real "did not write" invariant
    expect(await relay.entryCount(spaceId)).toBeGreaterThanOrEqual(N) // settled count; read path added nothing
    assertLegacyIsolation(alice, bob, fresh)

    freshHandle.close()
  })
})
