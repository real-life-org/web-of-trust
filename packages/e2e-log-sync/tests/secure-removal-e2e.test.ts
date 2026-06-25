import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startRelay, makeIdentity, wait, waitFor, type StartedRelay } from './harness'
import { makeYjsClient, type YjsClient } from './yjs-client'
import { makeAutomergeClient, type AutomergeClient } from './automerge-client'
import { RawRelayClient, makeSpaceKeypair, mintSpaceCap } from './raw-client'
import { createSpaceRotateMessageWithSigner } from '@web_of_trust/core/protocol'
import type { PublicIdentitySession } from '@web_of_trust/core/application'

/**
 * Slice SR Phase 5 — VE-T acceptance against the REAL RelayServer.
 *
 * These tests validate the secure member-removal acceptance criteria over a REAL
 * `ws` socket against the REAL `RelayServer` (better-sqlite3 :memory:), NOT the
 * InProcessLogBroker model. The headline value is that they exercise the
 * APPROVAL-GATED P4 relay change (`thid` on the KEY_GENERATION_STALE error frame)
 * across an actual socket — a greenwash trap the in-process unit tests cannot catch
 * because the InProcessLogBroker already wires thid through the same in-memory path.
 *
 * Every negative test carries a positive control:
 *  - a PRE-removal / PRE-rotation write GROWS relay.entryCount(docId) and converges;
 *  - the gated write does NOT grow entryCount and never reaches the remaining member.
 *
 * Criterion 5 (full lagger re-emit through the production WebSocketMessagingAdapter):
 * the client-side routing gap that previously dropped a write-path KEY_GENERATION_STALE
 * error frame (whose `thid` is a log-entry envelope UUID) inside
 * WebSocketMessagingAdapter.handleControlFrameError is now FIXED (P5.5): such a frame
 * is fanned out to the message-callback path and reaches the coordinator. That routing
 * fix is proven over the real wire — with mutation teeth — by Test A in
 * `ws-writepath-error-e2e.test.ts`. The relay side of VE-C2 is proven by Criterion 2
 * here (thid==messageId), and the full catch-up-and-re-emit cycle by the in-process P4
 * lagger unit tests (YjsSecureRemoval / AutomergeSecureRemoval). A NATURAL legitimate-
 * lagger re-emit over real WS is DEFERRED for a STRUCTURAL reason (not flakiness):
 * the relay deletes the lagger's stale-generation scope atomically with the rotation,
 * so its stale write fails the capability gate (CAPABILITY_REQUIRED /
 * CAPABILITY_GENERATION_STALE) instead of the generations-gate, and KEY_GENERATION_STALE
 * never fires for it — see the deferred (`describe.skip`) Test B in
 * `ws-writepath-error-e2e.test.ts` for the full rationale.
 */

interface TestDoc {
  items: Record<string, { title: string }>
}

const assertNoContentApplied = (...probes: Array<{ contentMessagesApplied: number }>): void => {
  for (const p of probes) expect(p.contentMessagesApplied).toBe(0)
}

// ════════════════════════════════════════════════════════════════════════════
// Criterion 1 + 6 — HEADLINE removal-negative, parametrised over both engines.
// ════════════════════════════════════════════════════════════════════════════

/**
 * An engine-erased client bundle: just the operations the headline test needs,
 * so the two concrete clients (YjsClient / AutomergeClient) collapse to ONE type
 * and `describe.each` does not intersect them. Each fixture's `make` adapts its
 * concrete client into this shape (the casts are local to the fixture).
 */
interface EngineClient {
  adapter: {
    createSpace<T>(kind: string, initial: T, meta: { name: string }): Promise<{ id: string }>
    addMember(spaceId: string, did: string, enc: Uint8Array): Promise<void>
    removeMember(spaceId: string, did: string): Promise<void>
    openSpace<T>(spaceId: string): Promise<{
      getDoc(): T
      transact(fn: (doc: T) => void): void
      close(): void
    }>
  }
  identity: PublicIdentitySession
  probe: { contentMessagesApplied: number }
  stop(): Promise<void>
}

interface EngineFixture {
  readonly name: string
  make(relay: StartedRelay, identity: PublicIdentitySession): Promise<EngineClient>
}

const yjsFixture: EngineFixture = {
  name: 'Yjs',
  make: async (relay, identity): Promise<EngineClient> => {
    const c: YjsClient = await makeYjsClient({ relay, identity })
    return c as unknown as EngineClient
  },
}

const automergeFixture: EngineFixture = {
  name: 'Automerge',
  make: async (relay, identity): Promise<EngineClient> => {
    const c: AutomergeClient = await makeAutomergeClient({ relay, identity })
    return c as unknown as EngineClient
  },
}

describe.each([yjsFixture, automergeFixture])(
  'VE-T HEADLINE removal-negative ($name) — real gated relay',
  (engine) => {
    let relay: StartedRelay
    const cleanup: Array<() => Promise<void>> = []
    const identities: PublicIdentitySession[] = []

    const newIdentity = async (): Promise<PublicIdentitySession> => {
      const id = await makeIdentity()
      identities.push(id)
      return id
    }

    beforeEach(async () => {
      relay = await startRelay()
    })

    afterEach(async () => {
      for (const stop of cleanup.splice(0)) await stop().catch(() => {})
      await relay?.stop()
      for (const id of identities.splice(0)) await id.deleteStoredIdentity().catch(() => {})
    })

    it('Alice removes Bob: Bobs PRE-removal write converges + grows entryCount; after gen===1 his POST-removal write over the still-open old socket is gated out (entryCount frozen, Alice never sees it)', async () => {
      const alice = await engine.make(relay, await newIdentity())
      cleanup.push(() => alice.stop())
      const bob = await engine.make(relay, await newIdentity())
      cleanup.push(() => bob.stop())

      const aliceAdapter = alice.adapter
      const bobAdapter = bob.adapter

      // Alice creates the space and invites Bob over the real relay.
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'SR Space' })
      const spaceId = space.id
      await wait(250)
      const bobEnc = await bob.identity.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(spaceId, bob.identity.getDid(), bobEnc)
      await wait(500)

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)
      await wait(150)

      // The space is at generation 0 before any removal.
      expect(relay.getSpace(spaceId)?.generation ?? 0).toBe(0)

      // (a) POSITIVE CONTROL — Bob writes BEFORE the removal: it is a legitimate
      // pre-enforcement write that MUST converge to Alice and grow the durable log.
      const beforePre = relay.entryCount(spaceId)
      bobHandle.transact((d) => { d.items['pre'] = { title: 'bob-pre-removal' } })
      const preConverged = await waitFor(
        () => aliceHandle.getDoc().items['pre']?.title === 'bob-pre-removal',
        { timeoutMs: 10_000 },
      )
      expect(preConverged).toBe(true)
      expect(relay.entryCount(spaceId)).toBeGreaterThan(beforePre)

      // (b) Alice removes Bob: the two-phase, single-home-broker secure removal drives
      // a real space-rotate over the actual WS. Re-enable proof (Criterion 6): this
      // removeMember does NOT throw "not yet supported" — it runs to completion and the
      // durable generation advances to 1.
      await aliceAdapter.removeMember(spaceId, bob.identity.getDid())
      const rotated = await waitFor(() => relay.getSpace(spaceId)?.generation === 1, { timeoutMs: 10_000 })
      expect(rotated).toBe(true)

      // (c) Bob writes AFTER the confirmed rotation over his STILL-OPEN old socket.
      // His adapter is still on generation 0 and never received the new key, so the
      // REAL relay rejects the write (KEY_GENERATION_STALE / a stale-scope reject):
      // entryCount does NOT grow and Alice never sees the post-removal item.
      const frozen = relay.entryCount(spaceId)
      bobHandle.transact((d) => { d.items['post'] = { title: 'bob-post-removal-should-be-gated' } })
      await wait(600)

      // The post-removal write left no durable trace and did not reach Alice.
      expect(relay.entryCount(spaceId)).toBe(frozen)
      expect(aliceHandle.getDoc().items['post']).toBeUndefined()
      // The pre-removal write survived (no state loss across the rotation).
      expect(aliceHandle.getDoc().items['pre']?.title).toBe('bob-pre-removal')

      // Legacy-content channel stayed dead throughout.
      assertNoContentApplied(alice.probe, bob.probe)

      aliceHandle.close()
      bobHandle.close()
    })
  },
)

// ════════════════════════════════════════════════════════════════════════════
// Criteria 2/3/4 — RAW-socket protocol assertions against the REAL relay.
// ════════════════════════════════════════════════════════════════════════════

describe('VE-T raw-socket — real gated relay', () => {
  let relay: StartedRelay
  const rawClients: RawRelayClient[] = []
  const identities: PublicIdentitySession[] = []

  const newIdentity = async (): Promise<PublicIdentitySession> => {
    const id = await makeIdentity()
    identities.push(id)
    return id
  }
  const track = (c: RawRelayClient): RawRelayClient => {
    rawClients.push(c)
    return c
  }

  beforeEach(async () => {
    relay = await startRelay()
  })

  afterEach(async () => {
    for (const c of rawClients.splice(0)) await c.disconnect().catch(() => {})
    await relay?.stop()
    for (const id of identities.splice(0)) await id.deleteStoredIdentity().catch(() => {})
  })

  // ── Criterion 2: thid==messageId on KEY_GENERATION_STALE over a REAL socket ──
  it('Criterion 2 — a stale-generation log-entry to the rotated real relay is rejected KEY_GENERATION_STALE with thid == the rejected envelope id (validates the P4 relay change on the wire)', async () => {
    const admin = await newIdentity()
    const spaceId = randomUUID()
    const gen0 = await makeSpaceKeypair()

    const c = track(new RawRelayClient(relay.url, admin))
    await c.connect()
    expect((await c.sendSpaceRegister({ spaceId, verificationKey: gen0.verificationKey, adminDids: [admin.getDid()] })).status).toBe('delivered')

    // Present a gen-0 write capability and land a baseline entry (positive control:
    // a gen-0 write IS accepted while the space is at gen 0, and grows entryCount).
    const cap0 = await mintSpaceCap({ signingSeed: gen0.signingSeed, spaceId, audience: admin.getDid(), permissions: ['read', 'write'], generation: 0 })
    expect((await c.presentCapability(cap0)).status).toBe('delivered')
    const baseline = await c.sendLogEntryRaw({ spaceId, seq: 0, plaintext: 'baseline', keyGeneration: 0 })
    expect(baseline.outcome.kind).toBe('receipt')
    expect(relay.entryCount(spaceId)).toBe(1)

    // Rotate the space to gen 1 (the removal mechanism) via an admin space-rotate.
    const gen1 = await makeSpaceKeypair()
    const rotateClient = track(new RawRelayClient(relay.url, admin))
    await rotateClient.connect()
    await sendAdminRotate(rotateClient, { spaceId, admin, newVerificationKey: gen1.verificationKey, newGeneration: 1 })
    expect(relay.getSpace(spaceId)?.generation).toBe(1)

    // The rotation invalidated `c`'s cached gen-0 write scope across ALL sockets, so a
    // raw write would now hit the capability gate FIRST. To ISOLATE the durable
    // generations-gate (the P4 change under test), re-present a freshly minted gen-1
    // write capability — exactly as the in-process SecureRemovalRelay test does. The
    // capability gate then passes and the generations-gate is the rejecting layer.
    const cap1 = await mintSpaceCap({ signingSeed: gen1.signingSeed, spaceId, audience: admin.getDid(), permissions: ['read', 'write'], generation: 1 })
    expect((await c.presentCapability(cap1)).status).toBe('delivered')

    // `c` now has a VALID gen-1 write scope, but it deliberately authors a STALE
    // keyGeneration-0 entry (an old-content-key write). The durable generations-gate
    // reads the durable generation (1), sees 0 < 1, and rejects KEY_GENERATION_STALE.
    // The returned error frame MUST carry thid == the rejected envelope id (P4).
    const frozen = relay.entryCount(spaceId)
    const stale = await c.sendLogEntryRaw({ spaceId, seq: 1, plaintext: 'stale', keyGeneration: 0 })
    expect(stale.outcome.kind).toBe('error')
    if (stale.outcome.kind === 'error') {
      expect(stale.outcome.error.code).toBe('KEY_GENERATION_STALE')
      // The load-bearing P4 assertion: thid correlates the reject to the exact write.
      expect(stale.outcome.error.thid).toBe(stale.sentMessageId)
    }
    // Not stored: the stale write left no durable trace.
    expect(relay.entryCount(spaceId)).toBe(frozen)
  })

  // ── Criterion 3: keyGeneration >= space.generation is accepted (not buffered) ─
  it('Criterion 3 — a log-entry at keyGeneration > the current (non-rotated) space.generation is ACCEPTED and stored (not buffered, not rejected)', async () => {
    const admin = await newIdentity()
    const spaceId = randomUUID()
    const gen0 = await makeSpaceKeypair()

    const c = track(new RawRelayClient(relay.url, admin))
    await c.connect()
    expect((await c.sendSpaceRegister({ spaceId, verificationKey: gen0.verificationKey, adminDids: [admin.getDid()] })).status).toBe('delivered')
    // The space stays at generation 0 (never rotated).
    expect(relay.getSpace(spaceId)?.generation).toBe(0)

    const cap0 = await mintSpaceCap({ signingSeed: gen0.signingSeed, spaceId, audience: admin.getDid(), permissions: ['read', 'write'], generation: 0 })
    expect((await c.presentCapability(cap0)).status).toBe('delivered')

    // A FUTURE generation (1) against a gen-0 space: 1 < 0 is false → accepted +
    // PERSISTED immediately (multi-broker liveness), not buffered.
    const before = relay.entryCount(spaceId)
    const future = await c.sendLogEntryRaw({ spaceId, seq: 0, plaintext: 'future-gen', keyGeneration: 1 })
    expect(future.outcome.kind).toBe('receipt')
    expect(relay.entryCount(spaceId)).toBe(before + 1)
    // The space generation did NOT change (the entry was stored, not a rotation).
    expect(relay.getSpace(spaceId)?.generation).toBe(0)
  })

  // ── Criterion 4: relay-whitelist + sync-response bypass ─────────────────────
  it('Criterion 4 — a deprecated content envelope and a client-originated sync-response are rejected MALFORMED_MESSAGE (no thid, not relayed/queued); a whitelisted inbox envelope is still accepted', async () => {
    const sender = await newIdentity()
    const recipient = await newIdentity()

    const senderClient = track(new RawRelayClient(relay.url, sender))
    await senderClient.connect()

    // (4a) Deprecated old-world content MessageEnvelope (v:1/fromDid/toDid) → rejected
    // MALFORMED_MESSAGE on the wire; the reject carries NO thid (only the gate sets it).
    const deprecated = await senderClient.sendDeprecatedContentEnvelope({ recipientDid: recipient.getDid() })
    expect(deprecated.kind).toBe('error')
    if (deprecated.kind === 'error') {
      expect(deprecated.error.code).toBe('MALFORMED_MESSAGE')
      expect(deprecated.error.thid).toBeUndefined()
    }

    // (4b) CLIENT-originated sync-response/1.0 (only the broker may emit it) → rejected
    // MALFORMED_MESSAGE; it never reaches generic routing, so applySyncResponse on the
    // recipient is never invoked.
    const forged = await senderClient.sendForgedSyncResponse({ docId: randomUUID(), recipientDid: recipient.getDid() })
    expect(forged.kind).toBe('error')
    if (forged.kind === 'error') {
      expect(forged.error.code).toBe('MALFORMED_MESSAGE')
      expect(forged.error.thid).toBeUndefined()
    }

    // POSITIVE CONTROL: a whitelisted ECIES Inbox envelope (space-invite/1.0) stays
    // accepted (queued for the offline recipient) — the whitelist is type-specific,
    // not a blanket reject, so cold-start is not broken.
    const inbox = await senderClient.sendInboxEnvelope({ recipientDid: recipient.getDid() })
    expect(inbox.kind).toBe('receipt')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Helper: drive an admin space-rotate control-frame over a RAW authed socket.
// (Mirrors the in-process SecureRemovalRelay test's sendSpaceRotate; isolates the
// generations-gate in Criterion 2 by rotating the durable generation while another
// socket keeps a stale cached scope.)
// ════════════════════════════════════════════════════════════════════════════

async function sendAdminRotate(
  client: RawRelayClient,
  params: { spaceId: string; admin: PublicIdentitySession; newVerificationKey: string; newGeneration: number },
): Promise<void> {
  const frame = await createSpaceRotateMessageWithSigner({
    spaceId: params.spaceId,
    newSpaceCapabilityVerificationKey: params.newVerificationKey,
    newGeneration: params.newGeneration,
    kid: `${params.admin.getDid()}#sig-0`,
    sign: (b) => params.admin.signEd25519(b),
  })
  const outcome = await client.sendControlFrameRaw(frame as unknown as Record<string, unknown>)
  if (outcome.kind === 'error') {
    throw new Error(`space-rotate rejected: ${outcome.error.code}`)
  }
}
