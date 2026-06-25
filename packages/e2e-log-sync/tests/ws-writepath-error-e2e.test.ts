import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startRelay, makeIdentity, wait, waitFor, type StartedRelay } from './harness'
import { RawRelayClient, makeSpaceKeypair, mintSpaceCap, helperCrypto } from './raw-client'
import { makeYjsClient, type YjsClient } from './yjs-client'
import { makeAutomergeClient, type AutomergeClient } from './automerge-client'
import {
  createSpaceRotateMessageWithSigner,
  createPresentCapabilityControlFrame,
  createLogEntryMessage,
  createLogEntryJwsWithSigner,
  encryptLogPayload,
  KEY_ROTATION_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import { WebSocketMessagingAdapter } from '@web_of_trust/core/adapters/messaging/websocket'
import type { WireMessage } from '@web_of_trust/core/ports'
import type { PublicIdentitySession } from '@web_of_trust/core/application'
import type { InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'

/**
 * Slice SR Phase 5.5 — WebSocketMessagingAdapter write-path-error ROUTING (Test A).
 *
 * This is the focused proof for the P5.5 client-side fix in
 * `WebSocketMessagingAdapter.handleControlFrameError`: a top-level relay
 * `{ type:'error', thid, code }` whose `thid` is a SENT log-entry envelope id (a
 * WRITE-PATH reject, NOT a control-frame reject) MUST be fanned out to the
 * `onMessage` callbacks — the same path the in-process broker feeds as `message` —
 * so the replication adapter's `routeWritePathError` can drive the owning
 * coordinator (VE-4 reject-disposition / VE-C2 re-emit).
 *
 * BEFORE the fix the frame matched no `pendingControlFrames` waiter (those are keyed
 * by docId, not by a log-entry envelope UUID) and was SILENTLY DROPPED, so the
 * coordinator never acted on the reject. The InProcessLogBroker masked this because
 * it already feeds the same callback path as a `message` — a greenwash trap that the
 * in-process unit tests (which pass) cannot catch. This test exercises the reject
 * over a REAL `ws` socket against the REAL `RelayServer`, isolating the messaging
 * adapter (NO replication adapter) so the registered `onMessage` spy is the single
 * observer.
 *
 * TEETH (verified by mutation): comment out the fan-out line
 * `void this.handleIncomingMessage(msg as unknown as WireMessage)` in
 * `handleControlFrameError` and this test goes RED (the spy never sees the frame).
 */

const WS_DID_KID_SUFFIX = '#sig-0'

/** Build a log-entry envelope authored under an EXPLICIT deviceId + identity. */
async function buildStaleLogEntryEnvelope(params: {
  identity: PublicIdentitySession
  deviceId: string
  spaceId: string
  seq: number
  keyGeneration: number
  plaintext: string
}): Promise<WireMessage> {
  const spaceContentKey = await helperCrypto.sha256(
    new TextEncoder().encode(`ws-writepath-sck|${params.spaceId}`),
  )
  const enc = await encryptLogPayload({
    crypto: helperCrypto,
    spaceContentKey,
    deviceId: params.deviceId,
    seq: params.seq,
    plaintext: new TextEncoder().encode(params.plaintext),
  })
  const entryJws = await createLogEntryJwsWithSigner({
    payload: {
      seq: params.seq,
      deviceId: params.deviceId,
      docId: params.spaceId,
      authorKid: `${params.identity.getDid()}${WS_DID_KID_SUFFIX}`,
      keyGeneration: params.keyGeneration,
      data: enc.blobBase64Url,
      timestamp: new Date().toISOString(),
    },
    sign: (b) => params.identity.signEd25519(b),
  })
  return createLogEntryMessage({
    id: randomUUID(),
    from: params.identity.getDid(),
    to: [params.identity.getDid()],
    createdTime: Math.floor(Date.now() / 1000),
    entry: entryJws,
  }) as unknown as WireMessage
}

describe('Slice SR P5.5 — WS write-path-error routing (Test A) — real gated relay', () => {
  let relay: StartedRelay
  const rawClients: RawRelayClient[] = []
  const adapters: WebSocketMessagingAdapter[] = []
  const identities: PublicIdentitySession[] = []

  const newIdentity = async (): Promise<PublicIdentitySession> => {
    const id = await makeIdentity()
    identities.push(id)
    return id
  }
  const trackRaw = (c: RawRelayClient): RawRelayClient => {
    rawClients.push(c)
    return c
  }
  const trackAdapter = (a: WebSocketMessagingAdapter): WebSocketMessagingAdapter => {
    adapters.push(a)
    return a
  }

  beforeEach(async () => {
    relay = await startRelay()
  })

  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.disconnect().catch(() => {})
    for (const c of rawClients.splice(0)) await c.disconnect().catch(() => {})
    await relay?.stop()
    for (const id of identities.splice(0)) await id.deleteStoredIdentity().catch(() => {})
  })

  it('a write-path KEY_GENERATION_STALE error frame (thid == the sent log-entry envelope id) is FANNED OUT to the WebSocketMessagingAdapter onMessage callback (before the P5.5 fix: silently dropped)', async () => {
    const admin = await newIdentity()
    const spaceId = randomUUID()
    const gen0 = await makeSpaceKeypair()

    // (1) Register the space at gen 0 and land a baseline (gen-0 writes are accepted
    //     while the space is at gen 0) via a RAW admin socket — mirrors Criterion 2,
    //     but here ONLY the rotation/gate setup runs on the raw client; the write
    //     under test runs over the real WS adapter.
    const setup = trackRaw(new RawRelayClient(relay.url, admin))
    await setup.connect()
    expect(
      (await setup.sendSpaceRegister({ spaceId, verificationKey: gen0.verificationKey, adminDids: [admin.getDid()] }))
        .status,
    ).toBe('delivered')
    const cap0 = await mintSpaceCap({
      signingSeed: gen0.signingSeed,
      spaceId,
      audience: admin.getDid(),
      permissions: ['read', 'write'],
      generation: 0,
    })
    expect((await setup.presentCapability(cap0)).status).toBe('delivered')
    const baseline = await setup.sendLogEntryRaw({ spaceId, seq: 0, plaintext: 'baseline', keyGeneration: 0 })
    expect(baseline.outcome.kind).toBe('receipt')
    expect(relay.entryCount(spaceId)).toBe(1)

    // (2) Rotate the durable space to gen 1 (the removal mechanism).
    const gen1 = await makeSpaceKeypair()
    const rotateClient = trackRaw(new RawRelayClient(relay.url, admin))
    await rotateClient.connect()
    const rotateFrame = await createSpaceRotateMessageWithSigner({
      spaceId,
      newSpaceCapabilityVerificationKey: gen1.verificationKey,
      newGeneration: 1,
      kid: `${admin.getDid()}${WS_DID_KID_SUFFIX}`,
      sign: (b) => admin.signEd25519(b),
    })
    const rotateOutcome = await rotateClient.sendControlFrameRaw(rotateFrame as unknown as Record<string, unknown>)
    expect(rotateOutcome.kind).toBe('receipt')
    expect(relay.getSpace(spaceId)?.generation).toBe(1)

    // (3) Build the REAL WebSocketMessagingAdapter UNDER TEST (no replication adapter —
    //     the onMessage spy is the only observer). It authenticates with `admin`'s DID
    //     and a stable deviceId, so the relay registers (admin.did, deviceId) — the
    //     author-binding the log-entry below relies on.
    const deviceId = randomUUID()
    const messaging = trackAdapter(
      new WebSocketMessagingAdapter(relay.url, {
        deviceId,
        signBrokerAuthTranscript: (bytes) => admin.signEd25519(bytes),
        // Keep the receipt-timeout SHORT: the stale send() never receives a receipt
        // (the relay answers with an error), so the send-promise rejects on timeout.
        // The PROOF is the spy seeing the frame, not the send() resolution.
        sendTimeoutMs: 2_000,
      }),
    )
    await messaging.connect(admin.getDid())

    // (4) Register the onMessage SPY. earlyMessageBuffer (if any) flushes on register.
    const seen: WireMessage[] = []
    messaging.onMessage((m) => {
      seen.push(m)
    })

    // (5) Present a FRESH gen-1 write capability over the WS adapter so the capability
    //     gate passes on THIS socket and the durable generations-gate is the rejecting
    //     layer (exactly as Criterion 2 isolates it on the raw socket).
    const cap1 = await mintSpaceCap({
      signingSeed: gen1.signingSeed,
      spaceId,
      audience: admin.getDid(),
      permissions: ['read', 'write'],
      generation: 1,
    })
    const cap1Receipt = await messaging.sendControlFrame(createPresentCapabilityControlFrame({ capabilityJws: cap1 }))
    expect(cap1Receipt.status).toBe('delivered')

    // (6) Author + send a STALE keyGeneration-0 log-entry over the WS adapter. The
    //     relay's durable generations-gate (1 > 0) rejects KEY_GENERATION_STALE and
    //     answers `{ type:'error', thid: <envelope.id>, code:'KEY_GENERATION_STALE' }`.
    const staleEnvelope = await buildStaleLogEntryEnvelope({
      identity: admin,
      deviceId,
      spaceId,
      seq: 1,
      keyGeneration: 0,
      plaintext: 'stale-over-ws',
    })
    const sentMessageId = staleEnvelope.id
    // send() waits for a receipt that never comes (the relay sends an error) → it
    // rejects on sendTimeoutMs. Swallow that: the spy is the load-bearing assertion.
    void messaging.send(staleEnvelope).catch(() => {})

    // (7) ASSERT: the error frame reaches the onMessage callback via the fan-out fix,
    //     carrying thid == the sent envelope id. Without the fix `seen` stays empty.
    const arrived = await waitFor(
      () =>
        seen.some(
          (m) =>
            (m as { type?: unknown }).type === 'error' &&
            (m as { code?: unknown }).code === 'KEY_GENERATION_STALE' &&
            (m as { thid?: unknown }).thid === sentMessageId,
        ),
      { timeoutMs: 5_000 },
    )
    expect(arrived).toBe(true)

    const errorFrame = seen.find(
      (m) => (m as { type?: unknown }).type === 'error' && (m as { thid?: unknown }).thid === sentMessageId,
    ) as { type: string; code: string; thid: string } | undefined
    expect(errorFrame).toBeDefined()
    expect(errorFrame?.code).toBe('KEY_GENERATION_STALE')
    expect(errorFrame?.thid).toBe(sentMessageId)
    // The stale write left no durable trace (still just the baseline).
    expect(relay.entryCount(spaceId)).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Test B — Criterion 5: full legitimate-lagger re-emit over the REAL WS adapter.
//
// DEFERRED (describe.skip) — NOT flaky: a STRUCTURAL divergence between the
// InProcessLogBroker model and the REAL RelayServer makes the natural legitimate-
// lagger flow take a DIFFERENT reject path over the real wire, so the clean
// KEY_GENERATION_STALE → park → re-emit cycle this test set out to prove cannot be
// reached for a real legitimate lagger.
//
// WHY (confirmed by instrumenting Bob's onMessage with the fix in place):
//  - The InProcessLogBroker checks the write-capability scope (CAPABILITY_REQUIRED,
//    line 291) BEFORE the generations-gate (KEY_GENERATION_STALE, line 304), but its
//    rotate-scope-clear does not interact with the lagger the way the relay's does,
//    so the in-process lagger's stale gen-0 write reaches the generations-gate and
//    gets the clean KEY_GENERATION_STALE the VE-C2 re-emit needs.
//  - The REAL relay's `invalidateStaleScopesForDoc` (relay.ts:1447) DELETES every
//    cached scope with `generation < newGeneration` ATOMICALLY with the rotation. So
//    the moment the space is at gen 1, Bob's gen-0 write scope is GONE. His stale
//    write therefore fails the capability gate (relay.ts:1714) with CAPABILITY_REQUIRED
//    — it NEVER reaches the generations-gate, so KEY_GENERATION_STALE never fires for
//    the natural lagger. The coordinator's CAPABILITY_REQUIRED disposition re-presents
//    Bob's capability, but Bob still holds only a gen-0 capability (rotation held), so
//    the relay's present-capability generation gate rejects it CAPABILITY_GENERATION_STALE
//    (relay.ts:1442). Observed frames at Bob over real WS: CAPABILITY_REQUIRED,
//    CAPABILITY_GENERATION_STALE, MALFORMED_MESSAGE — never KEY_GENERATION_STALE.
//  - The only way to elicit KEY_GENERATION_STALE over the real relay is to present a
//    VALID current-generation capability and then author a log-entry whose JWS
//    `keyGeneration` is older — exactly what Criterion 2 and Test A do. That reject's
//    routing to the coordinator (the P5.5 fix) is PROVEN by Test A above.
//
// COVERAGE: the P5.5 client routing fix is proven over the real wire by Test A (with
// mutation teeth). The full VE-C2 catch-up-and-re-emit CYCLE is proven engine-neutral
// by the in-process P4 lagger unit tests (adapter-yjs YjsSecureRemoval.test.ts:185 /
// adapter-automerge AutomergeSecureRemoval), which legitimately use the in-process
// broker whose reject ordering surfaces the KEY_GENERATION_STALE path. A real-wire
// re-emit cycle would require revisiting the relay's rotate-scope-clear vs.
// generations-gate ordering for legitimate laggers (a relay/coordinator design change,
// out of scope for P5.5); the skipped test below records the exact scenario for that
// future work.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A `key-rotation/1.0` hold installed on a NOT-YET-STARTED client's messaging
 * adapter. The adapter registers its onMessage callback in `start()`; we override
 * `messaging.onMessage` (whose base is the harness-instrumented one) BEFORE start so
 * the adapter's callback is registered THROUGH this wrapper. The wrapper buffers
 * every envelope whose top-level `type === KEY_ROTATION_MESSAGE_TYPE` (the rotation
 * reaches the lagger as a DIDComm inbox message with that top-level type, exactly the
 * match the in-process `holdKeyRotations` helper uses) and replays the buffered
 * rotations into the SAME adapter callback on {@link Hold.release}. Member-update and
 * all log-path traffic pass straight through, so the lagger's MEMBER view stays
 * correct while it misses ONLY the rotation.
 */
interface Hold {
  release: () => Promise<void>
  readonly held: number
}

function installKeyRotationHold(messaging: WebSocketMessagingAdapter): Hold {
  const buffered: WireMessage[] = []
  const delivered: Array<(env: WireMessage) => void | Promise<void>> = []
  const base = messaging.onMessage.bind(messaging)
  ;(messaging as unknown as { onMessage: typeof messaging.onMessage }).onMessage = (
    cb: (envelope: WireMessage) => void | Promise<void>,
  ) => {
    delivered.push(cb)
    return base(async (envelope: WireMessage) => {
      if ((envelope as { type?: unknown }).type === KEY_ROTATION_MESSAGE_TYPE) {
        buffered.push(envelope)
        return
      }
      await cb(envelope)
    })
  }
  return {
    get held() {
      return buffered.length
    },
    release: async () => {
      const toDeliver = buffered.splice(0)
      for (const env of toDeliver) {
        for (const cb of delivered) await cb(env)
      }
    },
  }
}

interface TestDoc {
  items: Record<string, { title: string }>
}

interface LaggerClient {
  identity: PublicIdentitySession
  keyManagement: InMemoryKeyManagementAdapter
  messaging: WebSocketMessagingAdapter
  adapter: {
    start(): Promise<void>
    createSpace<T>(kind: string, initial: T, meta: { name: string }): Promise<{ id: string }>
    addMember(spaceId: string, did: string, enc: Uint8Array): Promise<void>
    removeMember(spaceId: string, did: string): Promise<void>
    openSpace<T>(spaceId: string): Promise<{
      getDoc(): T
      transact(fn: (doc: T) => void): void
      close(): void
    }>
  }
  stop(): Promise<void>
}

interface LaggerFixture {
  readonly name: string
  make(relay: StartedRelay, identity: PublicIdentitySession, opts?: { noStart?: boolean }): Promise<LaggerClient>
}

const yjsLaggerFixture: LaggerFixture = {
  name: 'Yjs',
  make: async (relay, identity, opts): Promise<LaggerClient> => {
    const c: YjsClient = await makeYjsClient({ relay, identity, noStart: opts?.noStart })
    return c as unknown as LaggerClient
  },
}

const automergeLaggerFixture: LaggerFixture = {
  name: 'Automerge',
  make: async (relay, identity, opts): Promise<LaggerClient> => {
    const c: AutomergeClient = await makeAutomergeClient({ relay, identity, noStart: opts?.noStart })
    return c as unknown as LaggerClient
  },
}

const adapterGeneration = (c: LaggerClient, spaceId: string): Promise<number> =>
  c.keyManagement.getCurrentGeneration(spaceId)

// DEFERRED: see the block comment above. `describe.skip` keeps the scenario compiled
// + type-checked (so it does not bit-rot) without asserting an unreachable real-wire
// reject path. Re-enable once the relay's lagger reject ordering is revisited.
describe.skip.each([yjsLaggerFixture, automergeLaggerFixture])(
  'Slice SR P5.5 — Criterion 5 legitimate-lagger re-emit over real WS ($name) [DEFERRED]',
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

    it('a still-active member that missed the rotation gets KEY_GENERATION_STALE (routed via the P5.5 fix over real WS), catches up on release, re-emits under a new seq + gen 1, and converges — no SEQ_COLLISION, no double-effect, pre-write preserved', async () => {
      // Three members: Alice (admin), Bob (the LAGGER, stays active), Carol (removed).
      const alice = await engine.make(relay, await newIdentity())
      cleanup.push(() => alice.stop())
      // Bob is built with noStart so the key-rotation HOLD is installed BEFORE his
      // adapter registers its onMessage callback in start().
      const bob = await engine.make(relay, await newIdentity(), { noStart: true })
      cleanup.push(() => bob.stop())
      const hold = installKeyRotationHold(bob.messaging)
      await bob.adapter.start()
      const carol = await engine.make(relay, await newIdentity())
      cleanup.push(() => carol.stop())

      // Alice creates the 3-member space over the real relay.
      const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'WS Lagger Space' })
      const spaceId = space.id
      await wait(250)
      await alice.adapter.addMember(spaceId, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
      await wait(300)
      await alice.adapter.addMember(spaceId, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
      await wait(400)

      const aliceHandle = await alice.adapter.openSpace<TestDoc>(spaceId)
      const bobHandle = await bob.adapter.openSpace<TestDoc>(spaceId)
      await wait(200)

      // Baseline: Bob (active, gen 0) writes a pre-rotation entry that converges to Alice.
      bobHandle.transact((d) => { d.items['pre'] = { title: 'bob-pre-rotation' } })
      expect(
        await waitFor(() => aliceHandle.getDoc().items['pre']?.title === 'bob-pre-rotation', { timeoutMs: 10_000 }),
      ).toBe(true)
      expect(await adapterGeneration(bob, spaceId)).toBe(0)

      // Alice removes Carol → durable rotation to gen 1. Bob's key-rotation is HELD,
      // so he stays the lagger on gen 0; his member-update (Carol-removed) still passes.
      await alice.adapter.removeMember(spaceId, carol.identity.getDid())
      expect(await waitFor(() => relay.getSpace(spaceId)?.generation === 1, { timeoutMs: 10_000 })).toBe(true)
      expect(await waitFor(() => hold.held >= 1, { timeoutMs: 10_000 })).toBe(true)
      // Bob is still the lagger (rotation held → gen 0).
      expect(await adapterGeneration(bob, spaceId)).toBe(0)

      // Bob writes under the stale gen-0 key → relay rejects KEY_GENERATION_STALE →
      // the error frame is FANNED OUT (P5.5 fix) to Bob's coordinator → the re-emit
      // PARKS (rotation not yet imported), so Alice does NOT see it yet.
      const frozen = relay.entryCount(spaceId)
      bobHandle.transact((d) => { d.items['lag'] = { title: 'written-while-lagging' } })
      // Give the stale write + reject round-trip time, then assert it did NOT land.
      await wait(600)
      expect(aliceHandle.getDoc().items['lag']).toBeUndefined()

      // Release the held rotation → Bob imports gen 1 → replayPendingReemits drains →
      // the lagging write is re-emitted under a NEW seq + gen 1 and converges to Alice.
      await hold.release()
      expect(await adapterGeneration(bob, spaceId)).toBe(1)
      expect(
        await waitFor(() => aliceHandle.getDoc().items['lag']?.title === 'written-while-lagging', { timeoutMs: 10_000 }),
      ).toBe(true)

      // No double-effect: exactly one 'lag' item; the pre-write survived; the durable
      // log grew by exactly the re-emitted entry (the stale write left no trace).
      expect(Object.keys(aliceHandle.getDoc().items).filter((k) => k === 'lag')).toHaveLength(1)
      expect(aliceHandle.getDoc().items['pre']?.title).toBe('bob-pre-rotation')
      expect(relay.entryCount(spaceId)).toBeGreaterThan(frozen)

      aliceHandle.close()
      bobHandle.close()
    })
  },
)
