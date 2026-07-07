import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startRelay, makeIdentity, wait, waitFor, testMode, type StartedRelay } from './harness'
import { makeYjsClient, type YjsClient } from './yjs-client'
import { makeAutomergeClient, type AutomergeClient } from './automerge-client'
import { InMemoryDocLogStore } from '@web_of_trust/core/adapters'
import { InMemoryRepoStorageAdapter } from '@web_of_trust/adapter-automerge'
import type { PublicIdentitySession } from '@web_of_trust/core/application'

/**
 * Slice A / VE-11 — cross-engine PROTOCOL conformance (NOT CRDT-state interop).
 *
 * A Yjs client and an Automerge client share ONE relay and ONE registered Space.
 * Wire-Contract-Interop: every party speaks the same Sync 002/003 frames
 * (space-register / present-capability / log-entry / sync-request). CRDT-state
 * interop is explicitly NOT a goal — a Yjs client that receives an Automerge-
 * authored log-entry MUST process the frame protocol-conformantly (verify +
 * decrypt) but MUST NOT apply the Automerge payload as Yjs state (engine-foreign
 * skip), and MUST NOT crash or loop.
 */

interface TestDoc {
  items: Record<string, { title: string }>
}

describe('VE-11 cross-engine protocol conformance — real gated relay', () => {
  let relay: StartedRelay
  const yjsClients: YjsClient[] = []
  const amClients: AutomergeClient[] = []
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
    for (const c of yjsClients.splice(0)) await c.stop().catch(() => {})
    for (const c of amClients.splice(0)) await c.stop().catch(() => {})
    await relay?.stop()
    for (const id of identities.splice(0)) await id.deleteStoredIdentity().catch(() => {})
  })

  // TC5: remote-destructive — amBob is a FRESH-deviceId clone of Bob's identity that joins
  // and writes (the same restore-clone op-class gated in yjs/automerge). Remote ONLY with
  // REMOTE_ALLOW_DESTRUCTIVE; else skipped (don't reserve a fresh device on a shared relay).
  it.skipIf(testMode.skipDestructiveRemote)('a Yjs client at the same relay processes Automerge-authored log-entry frames protocol-conformantly: it verifies+decrypts them but does NOT apply the Automerge payload as Yjs state (engine-foreign skip), without crash or loop; its own Yjs convergence keeps working', async () => {
    // A Yjs creator creates + registers the Space and invites a second Yjs member.
    const aliceId = await newIdentity()
    const bobId = await newIdentity()

    const aliceClient = await makeYjsClient({ relay, identity: aliceId })
    yjsClients.push(aliceClient)
    const bobClient = await makeYjsClient({ relay, identity: bobId })
    yjsClients.push(bobClient)

    const space = await aliceClient.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'XEngine' })
    await wait(250)
    const spaceId = space.id
    await aliceClient.adapter.addMember(spaceId, bobId.getDid(), await bobId.getEncryptionPublicKeyBytes())
    await wait(500)

    // Baseline Yjs convergence works (pure Yjs).
    const aliceHandle = await aliceClient.adapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobClient.adapter.openSpace<TestDoc>(spaceId)
    aliceHandle.transact((d: TestDoc) => { d.items['yjs-1'] = { title: 'yjs-1' } })
    expect(await waitFor(() => bobHandle.getDoc().items['yjs-1']?.title === 'yjs-1')).toBe(true)

    // An AUTOMERGE client joins the SAME registered Space using Bob's identity +
    // keys + membership metadata (so it presents a VALID Space capability and the
    // relay accepts its log-entries), but a FRESH device + FRESH log + repo. It
    // writes an Automerge-framed log-entry (UUID docId == spaceId) to the Space.
    const amBob = await makeAutomergeClient({
      relay,
      identity: bobId,
      keyManagement: bobClient.keyManagement,
      metadataStorage: bobClient.metadataStorage,
      docLogStore: new InMemoryDocLogStore(),
      repoStorage: new InMemoryRepoStorageAdapter(),
    })
    amClients.push(amBob)
    // The Automerge client catches up the existing log first (so its repo/doc is
    // consistent), then makes a local Automerge edit → an Automerge-encoded
    // log-entry is broadcast to the space members (including the Yjs Alice).
    await amBob.adapter.requestSync(spaceId)
    await wait(300)
    const amHandle = await amBob.adapter.openSpace<TestDoc>(spaceId)

    // Tap Alice's (Yjs) coordinator to observe how it dispositions the incoming
    // Automerge-authored log-entry. The protocol-conformant outcomes are
    // 'engine-foreign-skip' (verify+decrypt ok, apply rejected) or 'applied'
    // (Yjs tolerated the bytes as a no-op) — never a throw/crash.
    const aliceCoord = (aliceClient.adapter as unknown as {
      coordinators: Map<string, { receiveLogEntry: (m: unknown) => Promise<{ disposition: string; reason?: string }> }>
    }).coordinators.get(spaceId)!
    const dispositions: string[] = []
    const origReceive = aliceCoord.receiveLogEntry.bind(aliceCoord)
    aliceCoord.receiveLogEntry = async (m: unknown) => {
      const r = await origReceive(m)
      dispositions.push(r.disposition)
      return r
    }

    const aliceSentBefore = aliceClient.probe.sentLogEntries
    const aliceDocBefore = JSON.stringify(aliceHandle.getDoc())

    // The Automerge edit → Automerge log-entry frame on the wire. (amBob cannot
    // reconstruct the Yjs-authored state — it engine-foreign-skips those frames —
    // so its Automerge doc has no `items` root yet; initialize it. The point is to
    // emit a well-formed Automerge log-entry frame, not to share CRDT state.)
    amHandle.transact((d: TestDoc) => {
      if (!d.items) d.items = {}
      d.items['am-1'] = { title: 'from-automerge' }
    })
    // Give the frame time to be delivered + processed by Alice (Yjs).
    await wait(600)

    // PROTOCOL CONFORMANCE: Alice received + processed the Automerge-authored
    // log-entry WITHOUT crash. The frame verified (authorKid Ed25519) and decrypted
    // (Alice holds the Space content key); the resulting plaintext is an Automerge
    // change, which Yjs does NOT represent as state. Whichever way the engine reports
    // that — `engine-foreign-skip` (apply rejected) or `applied` as a tolerated
    // NO-OP — the load-bearing invariant is that the Automerge payload is NOT
    // absorbed into Yjs state, with no crash and no re-broadcast.
    expect(dispositions.length).toBeGreaterThanOrEqual(1)
    for (const d of dispositions) {
      // Never a malformed/invalid-jws REJECTION (that would mean the frame was not
      // protocol-conformant); only a tolerated no-op apply or an engine-foreign skip.
      expect(['engine-foreign-skip', 'applied', 'idempotent-skip']).toContain(d)
    }

    // NO LOOP: Alice did not re-broadcast anything from receiving the foreign frame.
    expect(aliceClient.probe.sentLogEntries).toBe(aliceSentBefore)
    // Alice's Yjs state did NOT absorb the Automerge payload (no `am-1` in Yjs doc):
    // this is the decisive "NOT applied as Yjs state" proof.
    expect(aliceHandle.getDoc().items['am-1']).toBeUndefined()
    // Alice's Yjs doc is otherwise unchanged by the foreign frame.
    expect(JSON.stringify(aliceHandle.getDoc())).toBe(aliceDocBefore)

    // Alice's OWN Yjs convergence still works after tolerating the foreign frame.
    aliceHandle.transact((d: TestDoc) => { d.items['yjs-2'] = { title: 'yjs-2' } })
    expect(await waitFor(() => bobHandle.getDoc().items['yjs-2']?.title === 'yjs-2')).toBe(true)

    // Legacy isolation held throughout (no content applied anywhere).
    expect(aliceClient.probe.contentMessagesApplied).toBe(0)
    expect(bobClient.probe.contentMessagesApplied).toBe(0)
    expect(amBob.probe.contentMessagesApplied).toBe(0)

    // The relay treated the docId as ONE Space for BOTH engines (single registry entry).
    expect(await relay.isSpaceRegistered(spaceId)).toBe(true)

    aliceHandle.close()
    bobHandle.close()
    amHandle.close()
  })
})
