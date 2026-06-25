import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  SyncNoProgressError,
  createSpaceCapabilityJws,
  createSpaceRegisterMessage,
  createLogEntryMessage,
  createSyncResponseMessage,
  encryptLogPayload,
  createLogEntryJwsWithSigner,
  SYNC_REQUEST_MESSAGE_TYPE,
  type LogSyncEngineHooks,
  type ControlFrameReceipt,
} from '../src/protocol'

/**
 * Slice B v2 — Catch-up completeness (pagination + out-of-order-apply + kontiger
 * Sync-Head + Soft-Skip/GapRepair). These tests have TEETH against the v2 review
 * blockers + greenwash traps:
 *  - the WIRE cursor must be getSyncRequestHeads (strict-contiguous), NEVER
 *    getKnownHeads(=max) — else a head over a hole makes the relay only return
 *    seq>max and the hole is permanently unrequestable (Codex data-loss),
 *  - a live entry above a hole is applied OUT-OF-ORDER immediately (assert the DOC
 *    value, not a buffer/disposition), the strict-contiguous head stays behind,
 *  - the terminator's (b) gap-pending / (c) timeout / (d) no-progress classes are
 *    tested SEPARATELY (a pauschal-throw greenwashes the legit class with the DoS),
 *  - the do-while-DoS control test: a multi-page gap-confirmed-absent + live trigger
 *    must TERMINATE, not hang (the Opus-reproduced spin),
 *  - the permanent-gap test: soft-skip ONLY after 3 distinct epochs + 60s, GapRepair
 *    keeps re-requesting, a later-arriving seq still applies → NO data loss.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '22222222-2222-4222-8222-222222222222'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEVICE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()
const CONTENT_KEY = new Uint8Array(32).fill(7)

let capabilitySigningSeed: Uint8Array

interface Harness {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  logStore: InMemoryDocLogStore
  coordinator: LogSyncCoordinator
  applied: Uint8Array[]
  /** All sync-request bodies sent through this harness (limit inspection + round count). */
  syncRequests: Array<{ heads: Record<string, number>; limit?: number }>
  sentEnvelopes: number
  /** Mutable clock the harness wires into the coordinator (60s soft-skip gate). */
  clock: { now: Date }
}

async function makeCapability(audience: string, generation = 0): Promise<string> {
  return createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: SPACE_ID,
      audience,
      permissions: ['read', 'write'],
      generation,
      issuedAt: NOW,
      validUntil: FUTURE,
    },
    signingSeed: capabilitySigningSeed,
  })
}

function makeHooks(applied: Uint8Array[]): LogSyncEngineHooks {
  return {
    engine: 'test-raw',
    encodeUpdate: (update) => update,
    applyRemoteUpdate: (plaintext) => {
      // A leading 0xff marks an engine-FOREIGN payload (cross-engine) — applyRemoteUpdate
      // throws, and the coordinator treats that as engine-foreign-skip (records nothing).
      if (plaintext.length > 0 && plaintext[0] === 0xff) throw new Error('engine-foreign')
      applied.push(plaintext)
    },
  }
}

async function makeHarness(
  identity: PublicIdentitySession,
  deviceId: string,
  broker: InProcessLogBroker,
  opts?: {
    registrationJws?: string
    catchUpPageSize?: number
    recipients?: string[]
    clock?: { now: Date }
  },
): Promise<Harness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())

  const logStore = new InMemoryDocLogStore()
  await logStore.init()

  const applied: Uint8Array[] = []
  const syncRequests: Array<{ heads: Record<string, number>; limit?: number }> = []
  const clock = opts?.clock ?? { now: new Date() }
  const harness: Partial<Harness> = { identity, messaging, logStore, applied, syncRequests, sentEnvelopes: 0, clock }

  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: { sendControlFrame: (frame) => messaging.sendControlFrame!(frame) },
    envelopes: {
      send: async (envelope) => {
        harness.sentEnvelopes! += 1
        const e = envelope as { type?: string; body?: { heads: Record<string, number>; limit?: number } }
        if (e.type === SYNC_REQUEST_MESSAGE_TYPE && e.body) {
          syncRequests.push({ heads: e.body.heads, limit: e.body.limit })
        }
        return messaging.send(envelope as never)
      },
    },
    capabilities: { getCapabilityJws: () => makeCapability(identity.getDid(), 0) },
    hooks: makeHooks(applied),
    signLogEntry: (input) => identity.signEd25519(input),
    getRecipients: opts?.recipients ? () => opts.recipients! : undefined,
    getContentKey: async () => ({ key: CONTENT_KEY, generation: 0 }),
    getContentKeyByGeneration: async (generation) => (generation <= 0 ? CONTENT_KEY : null),
    getAvailableKeyGenerations: async () => [0],
    catchUpPageSize: opts?.catchUpPageSize,
    now: () => clock.now,
    sendSpaceRegister: async () => {
      const register = opts?.registrationJws
        ? { type: 'https://web-of-trust.de/protocols/space-register/1.0' as const, registrationJws: opts.registrationJws }
        : await createSpaceRegisterMessage({
            spaceId: SPACE_ID,
            spaceCapabilityVerificationKey: 'AAAA',
            adminDids: [identity.getDid()],
            kid: identity.kid,
            signingSeed: new Uint8Array(32).fill(3),
          })
      return messaging.sendControlFrame!(register) as Promise<ControlFrameReceipt>
    },
  })

  messaging.onMessage(async (message) => {
    await coordinator.handleIncoming(message)
  })

  harness.coordinator = coordinator
  return harness as Harness
}

async function inviterRegistrationJws(inviter: PublicIdentitySession): Promise<string> {
  const register = await createSpaceRegisterMessage({
    spaceId: SPACE_ID,
    spaceCapabilityVerificationKey: 'AAAA',
    adminDids: [inviter.getDid()],
    kid: inviter.kid,
    signingSeed: new Uint8Array(32).fill(3),
  })
  return register.registrationJws
}

/** Build a signed+encrypted log-entry JWS for a specific (deviceId, seq) under gen 0. */
async function buildEntryJws(
  author: PublicIdentitySession,
  deviceId: string,
  seq: number,
  plaintext: Uint8Array,
): Promise<string> {
  const enc = await encryptLogPayload({ crypto, spaceContentKey: CONTENT_KEY, deviceId, seq, plaintext })
  return createLogEntryJwsWithSigner({
    payload: {
      seq,
      deviceId,
      docId: SPACE_ID,
      authorKid: author.kid,
      keyGeneration: 0,
      data: enc.blobBase64Url,
      timestamp: NOW,
    },
    sign: (input) => author.signEd25519(input),
  })
}

function wrapLogEntry(author: PublicIdentitySession, entryJws: string) {
  return createLogEntryMessage({
    id: globalThis.crypto.randomUUID(),
    from: author.getDid(),
    to: [author.getDid()],
    createdTime: Math.floor(Date.now() / 1000),
    entry: entryJws,
  })
}

/** Pull a broker-stored entry's JWS by (deviceId, seq) — for manual delivery to a peer. */
function brokerEntryJws(broker: InProcessLogBroker, deviceId: string, seq: number): string {
  return (broker as unknown as { docs: Map<string, { entries: Map<string, { entryJws: string }> }> })
    .docs.get(SPACE_ID)!.entries.get(`${deviceId}:${seq}`)!.entryJws
}

async function flush(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

beforeEach(() => {
  InMemoryMessagingAdapter.resetAll()
  capabilitySigningSeed = new Uint8Array(32).fill(9)
})

afterEach(() => {
  InMemoryMessagingAdapter.resetAll()
})

describe('LogSyncCoordinator — Slice B VE-B1 pagination', () => {
  it('VE-B1 HEADLINE — multi-page cold reconstruction (250 entries, limit 100) reconstructs ALL via >=2 sync-request rounds', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    const N = 250
    for (let i = 0; i < N; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i & 0xfe, (i >> 8) & 0xff]))

    // Bob: FRESH, empty heads. Pages with limit 100 → 3 pages (100,100,50).
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, catchUpPageSize: 100 })
    const result = await b.coordinator.catchUp()

    expect(result.complete).toBe(true)
    expect(b.applied.length).toBe(N) // ALL 250, not 100
    const heads = await b.logStore.getKnownHeads(SPACE_ID)
    expect(heads[DEVICE_A]).toBe(N - 1) // seq 0..249
    // The strict-contiguous head reached the end too (fully contiguous, no holes).
    const strict = await b.logStore.getStrictContiguousHeads(SPACE_ID)
    expect(strict[DEVICE_A]).toBe(N - 1)

    // >=2 sync-request rounds observed (multi-page proof, not a single-page greenwash).
    expect(b.syncRequests.length).toBeGreaterThanOrEqual(3)
    // Every sync-request carried an EXPLICIT limit == 100 (Codex #3 wire envelope).
    for (const req of b.syncRequests) expect(req.limit).toBe(100)
    // Heads advanced across rounds (page-2 request asks above page-1's last seq) — and
    // the WIRE head is the strict-contiguous cursor, not the broker MAX.
    expect(b.syncRequests[1].heads[DEVICE_A]).toBeGreaterThanOrEqual(99)
  })

  it('VE-B1 limit-default — without catchUpPageSize the sync-request carries an EXPLICIT body.limit == 100 (not absent)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const a = await makeHarness(alice, DEVICE_A, broker)
    await a.coordinator.catchUp()
    expect(a.syncRequests.length).toBeGreaterThanOrEqual(1)
    for (const req of a.syncRequests) expect(req.limit).toBe(100)
  })

  it('VE-B1 reconnect catch-up — an offline client that missed >limit entries converges fully on reconnect', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i < 150; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i & 0xfe, 1]))

    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, catchUpPageSize: 100 })
    const r1 = await b.coordinator.catchUp()
    expect(r1.complete).toBe(true)
    expect(b.applied.length).toBe(150)

    // More writes while Bob is "offline"; Bob reconnects and converges.
    for (let i = 150; i < 230; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i & 0xfe, 2]))
    b.coordinator.resetForReconnect()
    const r2 = await b.coordinator.catchUp()
    expect(r2.complete).toBe(true)
    expect(b.applied.length).toBe(230)
  })
})

describe('LogSyncCoordinator — Slice B VE-B1 termination classes (b/c/d SEPARATE)', () => {
  it('VE-B1 (d) NO-PROGRESS — truncated:true with no new entry THROWS SyncNoProgressError (not hang; control: a heads-based guard would hang)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const a = await makeHarness(alice, DEVICE_A, broker)
    await a.coordinator.ensurePublished()

    // Arm a persistent no-progress truncation: every sync-request answers
    // truncated:true with ZERO entries and seiten-invariant (broker-MAX) heads.
    broker.armSyncTruncationNoProgress({ docId: SPACE_ID, persistent: true })

    await expect(a.coordinator.catchUp()).rejects.toBeInstanceOf(SyncNoProgressError)
  })

  it('VE-B1 (b) GAP-PENDING — truncated:true with entries applied OVER a hole STOPS without throw, incomplete:gap-pending', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    await b.coordinator.ensurePublished()

    // A page that delivers ONLY non-contiguous entries for DEVICE_A (seq 5,6 — gap at
    // 0..4), truncated:true. Out-of-order apply applies BOTH immediately (the doc gets
    // them), but the STRICT-contiguous head does NOT advance (still -1, hole at 0).
    const e5 = await buildEntryJws(alice, DEVICE_A, 5, new Uint8Array([5]))
    const e6 = await buildEntryJws(alice, DEVICE_A, 6, new Uint8Array([6]))
    const page = createSyncResponseMessage({
      id: globalThis.crypto.randomUUID(),
      from: bob.getDid(),
      to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: globalThis.crypto.randomUUID(),
      body: { docId: SPACE_ID, entries: [e5, e6], heads: { [DEVICE_A]: 6 }, truncated: true },
    })

    const result = await b.coordinator.applySyncResponse(page)
    expect(result.complete).toBe(false)
    expect(result.incomplete).toBe('gap-pending')
    // OUT-OF-ORDER: 5,6 ARE in the doc (NOT buffered) — assert the DOC value.
    expect(b.applied.map((u) => u[0]).sort((x, y) => x - y)).toEqual([5, 6])
    // The strict-contiguous head stays behind the hole; getKnownHeads(=max) goes to 6.
    const strict = await b.logStore.getStrictContiguousHeads(SPACE_ID)
    expect(strict[DEVICE_A]).toBe(-1)
    const known = await b.logStore.getKnownHeads(SPACE_ID)
    expect(known[DEVICE_A]).toBe(6)
    // pendingGaps lists the open hole.
    expect(result.pendingGaps?.[0]).toEqual({ docId: SPACE_ID, device: DEVICE_A, firstMissing: 0 })
    // Crucially NOT a throw — distinct from class (d).
  })

  it('VE-B1 (c) TIMEOUT — a truncated page whose follow-up never arrives → incomplete:timeout, no throw', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const a = await makeHarness(alice, DEVICE_A, broker)
    await a.coordinator.ensurePublished()

    // Drop EVERY sync-request answer (the broker never delivers a response).
    const coordinator = a.coordinator as unknown as {
      config: { envelopes: { send: (e: unknown) => Promise<unknown> } }
    }
    const original = coordinator.config.envelopes.send
    coordinator.config.envelopes.send = async (e: unknown) => {
      const env = e as { type?: string }
      if (env.type === SYNC_REQUEST_MESSAGE_TYPE) return undefined // swallow → timeout
      return original(e)
    }

    const internal = a.coordinator as unknown as {
      catchUpInternal: (o: { presentCapabilityFirst: boolean; timeoutMs?: number }) => Promise<{ complete: boolean; incomplete?: string }>
    }
    const result = await internal.catchUpInternal({ presentCapabilityFirst: false, timeoutMs: 50 })
    expect(result.complete).toBe(false)
    expect(result.incomplete).toBe('timeout')
  })
})

describe('LogSyncCoordinator — Slice B VE-B2 out-of-order apply + kontiger Sync-Head', () => {
  it('VE-B2 SYNC-HEAD = highest contiguous seq — remote 0,2 (hole at 1) → strict + sync-request heads = 0, getKnownHeads = 2', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    await b.coordinator.ensurePublished()
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {} // isolate from auto catch-up

    // Deliver 0 then 2 (skip 1).
    await b.coordinator.receiveLogEntry(wrapLogEntry(alice, await buildEntryJws(alice, DEVICE_A, 0, new Uint8Array([0xa0]))))
    await b.coordinator.receiveLogEntry(wrapLogEntry(alice, await buildEntryJws(alice, DEVICE_A, 2, new Uint8Array([0xa2]))))

    // OUT-OF-ORDER apply: BOTH 0 and 2 are in the doc (assert DOC value).
    expect(b.applied.map((u) => u[0]).sort((x, y) => x - y)).toEqual([0xa0, 0xa2])
    // getKnownHeads = max = 2; strict + sync-request heads = 0 (stop at the hole). This
    // is the DocLogStore.test "0,5→5" contract umstellung: max stays 5/2, the SYNC head
    // stops at the gap.
    expect((await b.logStore.getKnownHeads(SPACE_ID))[DEVICE_A]).toBe(2)
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(0)
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(0) // no soft-skip yet → identical to strict
  })

  it('VE-B2 LIVE-GAP converges — seq 3 dropped, 4,5 live → applied out-of-order; sync-head stays 2; catch-up fetches 3 via head=2', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    // Bob publishes FIRST against an empty broker. Alice's recipients = just Alice, so
    // the broker does NOT live-broadcast to Bob — the test controls Bob's delivery.
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    await b.coordinator.ensurePublished()
    expect(b.applied.length).toBe(0)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i <= 5; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([0x10 + i]))

    // Feed Bob seq 0,1,2 contiguously, then SKIP 3, feed 4,5 LIVE — suppress the auto
    // gap-catch-up first so we can OBSERVE 4,5 applied out-of-order + head NOT jumping.
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    const origTrigger = coordInternal.triggerGapCatchUp.bind(b.coordinator)
    coordInternal.triggerGapCatchUp = () => {}

    for (const seq of [0, 1, 2]) {
      await b.coordinator.receiveLogEntry(wrapLogEntry(alice, brokerEntryJws(broker, DEVICE_A, seq)))
    }
    expect(b.applied.length).toBe(3)
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(2)

    for (const seq of [4, 5]) {
      const r = await b.coordinator.receiveLogEntry(wrapLogEntry(alice, brokerEntryJws(broker, DEVICE_A, seq)))
      expect(r.disposition).toBe('applied') // OUT-OF-ORDER applied, NOT blocked-by-seq
    }
    // 4,5 ARE in the doc; strict head did NOT jump over the gap; getKnownHeads = 5.
    expect(b.applied.length).toBe(5)
    expect(b.applied.map((u) => u[0]).sort((x, y) => x - y)).toEqual([0x10, 0x11, 0x12, 0x14, 0x15])
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(2)
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(2)
    expect((await b.logStore.getKnownHeads(SPACE_ID))[DEVICE_A]).toBe(5)

    // Restore the trigger + run catch-up: the WIRE head is 2 (strict), so getSince
    // returns seq>2 = 3 → it applies → now 0..5 contiguous.
    coordInternal.triggerGapCatchUp = origTrigger
    await b.coordinator.catchUp()

    expect(b.applied.length).toBe(6)
    expect(b.applied.map((u) => u[0]).sort((x, y) => x - y)).toEqual([0x10, 0x11, 0x12, 0x13, 0x14, 0x15])
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(5)
  })

  it('VE-B2 ENGINE-FOREIGN — a cross-engine payload above a hole is engine-foreign-skipped (records nothing), never tracked as a gap', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    await b.coordinator.ensurePublished()

    // A FOREIGN entry (first plaintext byte 0xff) authored by DEVICE_A at seq=2, while
    // Bob has applied NOTHING from DEVICE_A. Out-of-order apply attempts to apply it →
    // throws → engine-foreign-skip → records NOTHING (no head, no gap-state).
    const foreignJws = await buildEntryJws(alice, DEVICE_A, 2, new Uint8Array([0xff, 0x02]))
    const r = await b.coordinator.receiveLogEntry(wrapLogEntry(alice, foreignJws))

    expect(r.disposition).toBe('engine-foreign-skip')
    expect((await b.logStore.getKnownHeads(SPACE_ID))[DEVICE_A]).toBeUndefined() // nothing recorded
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBeUndefined()
  })

  it('VE-B2 LOOP-SAFETY — out-of-order apply + a catch-up that fills a gap emit ZERO log-entry sends (no delayed outbox loop)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i <= 2; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i]))

    // Track LOG-ENTRY envelope sends specifically (a re-broadcast loop would send these).
    let logEntrySends = 0
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    const bInternal = b.coordinator as unknown as {
      config: { envelopes: { send: (e: unknown) => Promise<unknown> } }
      triggerGapCatchUp: () => void
    }
    const origSend = bInternal.config.envelopes.send
    bInternal.config.envelopes.send = async (e: unknown) => {
      if ((e as { type?: string }).type === 'https://web-of-trust.de/protocols/log-entry/1.0') logEntrySends += 1
      return origSend(e)
    }
    await b.coordinator.ensurePublished()
    bInternal.triggerGapCatchUp = () => {}

    // Deliver 1,2 out-of-order (gap at 0), then catch-up fills seq 0.
    for (const seq of [1, 2]) {
      await b.coordinator.receiveLogEntry(wrapLogEntry(alice, brokerEntryJws(broker, DEVICE_A, seq)))
    }
    await b.coordinator.catchUp()
    await flush()

    expect(b.applied.length).toBe(3)
    // Bob applied Alice's entries but NEVER emitted a single log-entry (loop-guard).
    expect(logEntrySends).toBe(0)
  })

  it('VE-B2 MULTI-DEVICE x gap — Device A complete, Device B has a gap → both converge, A never lost, B gap filled', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const carol = (await createTestIdentity('carol')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i < 3; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([0xa0 + i]))

    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    await b.coordinator.ensurePublished()
    expect(b.applied.length).toBe(3) // A:0,1,2 already converged
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {}

    const c = await makeHarness(carol, DEVICE_C, broker, { registrationJws })
    await c.coordinator.ensurePublished()
    for (let i = 0; i < 3; i++) await c.coordinator.writeLocalUpdate(new Uint8Array([0xc0 + i]))

    // Bob receives DEVICE_C with a GAP (only C:2 live; C:0,1 missing). Out-of-order apply
    // applies C:2 immediately, but C's strict head stays behind its hole.
    const rGap = await b.coordinator.receiveLogEntry(wrapLogEntry(carol, brokerEntryJws(broker, DEVICE_C, 2)))
    expect(rGap.disposition).toBe('applied')

    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(2) // A complete, unaffected
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_C]).toBe(-1) // C strict behind its hole
    expect((await b.logStore.getKnownHeads(SPACE_ID))[DEVICE_C]).toBe(2) // C:2 IS in the doc

    // Run catch-up: WIRE head for C = -1 (strict) → getSince returns C:0,1,2 → converges.
    coordInternal.triggerGapCatchUp = (b.coordinator as unknown as { catchUp: () => Promise<unknown> }).catchUp.bind(b.coordinator) as never
    await b.coordinator.catchUp()

    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(2)
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_C]).toBe(2)
    expect(b.applied.length).toBe(6) // all 6 (3 from A, 3 from C) — no A entry lost
  })
})

describe('LogSyncCoordinator — Slice B VE-B2 soft-skip + GapRepair (permanent gap, no data loss)', () => {
  it('VE-B2 PERMANENT-GAP — soft-skip ONLY after 3 distinct epochs + 60s; GapRepair re-fetches a later-arriving seq → NO loss', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    // Alice writes ONLY seq 0,1 (so a hole at 2 is broker-confirmed-absent for now).
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i <= 1; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i]))

    const t0 = new Date()
    const clock = { now: t0 }
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, clock })
    await b.coordinator.ensurePublished()
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {}

    // Pre-load Bob with a LIVE seq 5 from DEVICE_A (above a permanent hole at 2..4) so a
    // truncated:false catch-up sees strict head < broker max for DEVICE_A. (The broker
    // only has 0,1,5 — Alice never wrote 2,3,4.) Author 5 directly via Alice's coordinator
    // would reserve seq 2; instead deliver a hand-built seq-5 entry to both broker + bob.
    const e5 = await buildEntryJws(alice, DEVICE_A, 5, new Uint8Array([0x05]))
    // Inject seq 5 into the broker's doc-log directly (it was authored "out of band").
    const docLog = (broker as unknown as { docs: Map<string, { entries: Map<string, { docId: string; deviceId: string; seq: number; entryJws: string }>; heads: Map<string, number> }> }).docs.get(SPACE_ID)!
    docLog.entries.set(`${DEVICE_A}:5`, { docId: SPACE_ID, deviceId: DEVICE_A, seq: 5, entryJws: e5 })
    docLog.heads.set(DEVICE_A, 5)

    // First catch-up (epoch 0): applies 0,1 contiguous + 5 out-of-order. strict head = 1,
    // broker max = 5 → records a gap-observation at firstMissing=2 under epoch 0.
    await b.coordinator.catchUp()
    expect(b.applied.map((u) => u[0]).sort((x, y) => x - y)).toEqual([0x00, 0x01, 0x05])
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(1)
    // No soft-skip yet (1 epoch, 0s) → sync-request head stays at strict (1).
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(1)

    // Two MORE catch-ups in DISTINCT epochs, advancing the clock past 60s.
    b.coordinator.resetForReconnect() // epoch 1
    clock.now = new Date(t0.getTime() + 30_000)
    await b.coordinator.catchUp()
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(1) // still no skip (2 epochs)

    b.coordinator.resetForReconnect() // epoch 2
    clock.now = new Date(t0.getTime() + 70_000) // > 60s old now
    await b.coordinator.catchUp()
    // NOW 3 distinct epochs + >60s → soft-skip fires: the sync-request cursor advances
    // PAST the hole to the contiguous run above (5), so the re-fetch churn ends.
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(5)
    // getStrictContiguousHeads stays behind the hole (truth about contiguity).
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(1)

    // The GapRepair record survives (not a final skip).
    const due = await b.logStore.listDueGapRepairs(clock.now.getTime() + 10 * 60_000)
    expect(due.some((g) => g.device === DEVICE_A && g.firstMissing === 2 && g.softSkipped)).toBe(true)

    // LATER seq 2,3,4 DO arrive at the broker (Alice was lagging). GapRepair (head=1)
    // re-fetches them → applied → auto-resolved → NO data loss.
    for (const seq of [2, 3, 4]) {
      const e = await buildEntryJws(alice, DEVICE_A, seq, new Uint8Array([seq]))
      docLog.entries.set(`${DEVICE_A}:${seq}`, { docId: SPACE_ID, deviceId: DEVICE_A, seq, entryJws: e })
    }
    // Advance the clock past the GapRepair backoff so the repair is due, then catch up.
    clock.now = new Date(t0.getTime() + 70_000 + 10 * 60_000)
    b.coordinator.resetForReconnect()
    await b.coordinator.catchUp()

    // 2,3,4 reached the doc; the hole is gone; the GapRepair auto-resolved.
    expect(b.applied.map((u) => u[0]).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5])
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(5)
    const dueAfter = await b.logStore.listDueGapRepairs(clock.now.getTime() + 10 * 60_000)
    expect(dueAfter.some((g) => g.device === DEVICE_A && g.firstMissing === 2)).toBe(false) // self-cleared
  })

  it('VE-B2 HEADLINE MULTI-PAGE-TAIL — after the soft-skip the >1-page tail above a permanent hole is pulled via the MAIN loop (v2 lost it); seq fills later → NO loss', async () => {
    // THE festival BLOCKER v2 lost: a permanent broker-confirmed-absent hole at seq 50 with a
    // tail of 200 entries (= TWO pages at limit 100). v2 observed only on truncated:false, which
    // NEVER occurs while the tail keeps every page truncated:true → soft-skip dead → 151..250
    // unreachable. v3 observes on broker-confirmed-absent (page-lowest > firstMissing, truncated:true
    // too) → soft-skip fires → the wire cursor advances past the hole → the SAME main pagination
    // fetches the whole tail. TEETH: v2 applies 150, v3 applies 250.
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const t0 = new Date()
    const clock = { now: t0 }
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, clock, catchUpPageSize: 100 })
    await b.coordinator.ensurePublished()
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {}

    // Broker holds DEVICE_A 0..49 + 51..250 (permanent hole at 50; tail 51..250 = 200 entries).
    const docLog = (broker as unknown as { docs: Map<string, { entries: Map<string, { docId: string; deviceId: string; seq: number; entryJws: string }>; heads: Map<string, number> }> }).docs.get(SPACE_ID)!
    for (let s = 0; s <= 250; s++) {
      if (s === 50) continue // the permanent hole
      const e = await buildEntryJws(alice, DEVICE_A, s, new Uint8Array([s & 0xff]))
      docLog.entries.set(`${DEVICE_A}:${s}`, { docId: SPACE_ID, deviceId: DEVICE_A, seq: s, entryJws: e })
    }
    docLog.heads.set(DEVICE_A, 250)

    // Epoch 0: paginates page-1 of the tail over the hole, observes the gap, pinned behind 50.
    await b.coordinator.catchUp()
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(49)
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(49) // no soft-skip yet

    b.coordinator.resetForReconnect() // epoch 1
    clock.now = new Date(t0.getTime() + 30_000)
    await b.coordinator.catchUp()
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(49) // still pinned (2 epochs)

    b.coordinator.resetForReconnect() // epoch 2 → 3 distinct epochs, >60s
    clock.now = new Date(t0.getTime() + 70_000)
    await b.coordinator.catchUp()

    // THE FIX: soft-skip fired DURING this catch-up → the wire cursor advanced past the hole →
    // the same main pagination pulled the ENTIRE multi-page tail (151..250), not just page 1.
    expect(b.applied.length).toBe(250) // 0..49 (50) + 51..250 (200); v2 would be 150
    expect(b.applied.some((u) => u[0] === 151)).toBe(true) // first entry of tail page 2
    expect(b.applied.some((u) => u[0] === 250)).toBe(true) // last tail entry — v2 never fetches it
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(250) // advanced past the hole
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(49) // truth: behind the hole

    const due = await b.logStore.listDueGapRepairs(clock.now.getTime() + 10 * 60_000)
    expect(due.some((g) => g.device === DEVICE_A && g.firstMissing === 50 && g.softSkipped)).toBe(true)

    // seq 50 finally arrives → GapRepair (head=49) re-fetches it → strict jumps to 250 → NO loss.
    const e50 = await buildEntryJws(alice, DEVICE_A, 50, new Uint8Array([50]))
    docLog.entries.set(`${DEVICE_A}:50`, { docId: SPACE_ID, deviceId: DEVICE_A, seq: 50, entryJws: e50 })
    clock.now = new Date(t0.getTime() + 70_000 + 10 * 60_000)
    b.coordinator.resetForReconnect()
    await b.coordinator.catchUp()
    expect(b.applied.length).toBe(251) // + seq 50
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(250) // hole closed
  })

  it('VE-B2 EPOCH-MECHANIC — 3 catch-ups in the SAME connection epoch do NOT soft-skip (even past 60s); only 3 DISTINCT epochs do', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    await a.coordinator.writeLocalUpdate(new Uint8Array([0]))

    const t0 = new Date()
    const clock = { now: t0 }
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, clock })
    await b.coordinator.ensurePublished()
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {}

    // Broker-confirmed hole: Alice has 0 + a hand-injected 3 (hole at 1,2).
    const docLog = (broker as unknown as { docs: Map<string, { entries: Map<string, { docId: string; deviceId: string; seq: number; entryJws: string }>; heads: Map<string, number> }> }).docs.get(SPACE_ID)!
    const e3 = await buildEntryJws(alice, DEVICE_A, 3, new Uint8Array([0x03]))
    docLog.entries.set(`${DEVICE_A}:3`, { docId: SPACE_ID, deviceId: DEVICE_A, seq: 3, entryJws: e3 })
    docLog.heads.set(DEVICE_A, 3)

    // THREE catch-ups in the SAME epoch (no resetForReconnect), clock past 60s.
    clock.now = new Date(t0.getTime() + 100_000)
    await b.coordinator.catchUp()
    await b.coordinator.catchUp()
    await b.coordinator.catchUp()
    // Same epoch → observedEpochs.size == 1 → NO soft-skip (the cursor stays at strict).
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(0)
    const dueSame = await b.logStore.listDueGapRepairs(clock.now.getTime() + 10 * 60_000)
    const gapSame = dueSame.find((g) => g.device === DEVICE_A && g.firstMissing === 1)
    expect(gapSame?.observedEpochs.length).toBe(1) // exactly one distinct epoch
    expect(gapSame?.softSkipped).toBe(false)

    // Now make them DISTINCT: two more reconnect epochs. The gap's firstSeenAt was set
    // at the FIRST observation (t0+100s); advance the clock so the LAST observation is
    // >= 60s past firstSeenAt (the age gate is now-firstSeenAt, not per-observation).
    b.coordinator.resetForReconnect()
    clock.now = new Date(t0.getTime() + 130_000)
    await b.coordinator.catchUp()
    b.coordinator.resetForReconnect()
    clock.now = new Date(t0.getTime() + 170_000) // > 60s past firstSeenAt (t0+100s)
    await b.coordinator.catchUp()
    // 3 distinct epochs + 60s → soft-skip fires → cursor advances past the hole to 3.
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(3)
  })

  it('VE-B2 BROKER-CONFIRMED-ABSENT on truncated:true — page-lowest > firstMissing DOES observe + soft-skips (v3 corrects v2 "only truncated:false")', async () => {
    // v2 recorded an observation ONLY on truncated:false; v3 records on broker-confirmed-absent
    // (the page's lowest delivered seq for the device is ABOVE firstMissing — the broker served
    // contiguously from the cursor and skipped the hole), which holds on truncated:true too.
    // Across 3 DISTINCT epochs + 60s the soft-skip MUST fire on a truncated:true page.
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const t0 = new Date()
    const clock = { now: t0 }
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, clock })
    await b.coordinator.ensurePublished()
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {}

    const e5 = await buildEntryJws(alice, DEVICE_A, 5, new Uint8Array([0x05]))
    // page-lowest = 5 > firstMissing (= 0, Bob has nothing for DEVICE_A) → broker-confirmed-absent,
    // even though truncated:true. Inject across 3 distinct epochs (resetForReconnect bumps epoch).
    const absentPage = () => createSyncResponseMessage({
      id: globalThis.crypto.randomUUID(),
      from: bob.getDid(),
      to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      thid: globalThis.crypto.randomUUID(),
      body: { docId: SPACE_ID, entries: [e5], heads: { [DEVICE_A]: 5 }, truncated: true },
    })
    await b.coordinator.applySyncResponse(absentPage()) // epoch 0 — observed, no skip yet
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(-1)
    const afterOne = await b.logStore.listDueGapRepairs(clock.now.getTime() + 10 * 60_000)
    expect(afterOne.some((g) => g.device === DEVICE_A && g.firstMissing === 0)).toBe(true) // v3: observed on truncated:true

    b.coordinator.resetForReconnect() // epoch 1
    clock.now = new Date(t0.getTime() + 30_000)
    await b.coordinator.applySyncResponse(absentPage())
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(-1) // 2 epochs, no skip

    b.coordinator.resetForReconnect() // epoch 2 → 3 distinct, >60s
    clock.now = new Date(t0.getTime() + 70_000)
    await b.coordinator.applySyncResponse(absentPage())
    // 3 distinct epochs + 60s on a truncated:true broker-confirmed-absent gap → soft-skip fires.
    expect((await b.logStore.getSyncRequestHeads(SPACE_ID))[DEVICE_A]).toBe(5)
  })

  it('VE-B2 PAGINATION-ARTEFACT — a contiguous-from-cursor truncated:true page records NO gap (the hole may be on the next page)', async () => {
    // The discriminator's OTHER arm: if the broker delivers firstMissing itself (page-lowest ==
    // firstMissing, serving contiguously), there is NO confirmed-absent hole — a seq beyond the
    // page is a pagination artefact, not a permanent gap. NO observation, NO soft-skip.
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const t0 = new Date()
    const clock = { now: t0 }
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, clock })
    await b.coordinator.ensurePublished()
    const coordInternal = b.coordinator as unknown as { triggerGapCatchUp: () => void }
    coordInternal.triggerGapCatchUp = () => {}

    // Bob has 0,1; the broker claims max 5 but THIS truncated:true page delivers 2,3 contiguously
    // (page-lowest = 2 == firstMissing) → strict advances to 3; seq 4 is un-fetched, NOT confirmed
    // absent → no gap. Even across many epochs + a clock far past 60s, nothing soft-skips.
    const e = async (s: number) => buildEntryJws(alice, DEVICE_A, s, new Uint8Array([s]))
    const seed = createSyncResponseMessage({
      id: globalThis.crypto.randomUUID(), from: bob.getDid(), to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000), thid: globalThis.crypto.randomUUID(),
      body: { docId: SPACE_ID, entries: [await e(0), await e(1)], heads: { [DEVICE_A]: 5 }, truncated: false },
    })
    await b.coordinator.applySyncResponse(seed)
    clock.now = new Date(t0.getTime() + 1_000_000)
    for (let round = 0; round < 4; round++) {
      b.coordinator.resetForReconnect()
      const page = createSyncResponseMessage({
        id: globalThis.crypto.randomUUID(), from: bob.getDid(), to: [bob.getDid()],
        createdTime: Math.floor(Date.now() / 1000), thid: globalThis.crypto.randomUUID(),
        body: { docId: SPACE_ID, entries: [await e(2), await e(3)], heads: { [DEVICE_A]: 5 }, truncated: true },
      })
      await b.coordinator.applySyncResponse(page)
    }
    // strict advanced to 3 (0,1,2,3 contiguous); no spurious gap at 4; no soft-skip.
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(3)
    const due = await b.logStore.listDueGapRepairs(clock.now.getTime() + 10 * 60_000)
    expect(due.some((g) => g.softSkipped)).toBe(false)
  })
})

describe('LogSyncCoordinator — Slice B re-entrancy + DoS control', () => {
  it('VE-B1 RE-ENTRANCY — a gap-trigger DURING a running catch-up does NOT start a second loop; converges once', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i < 150; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i & 0xfe, 9]))

    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, catchUpPageSize: 50 })

    // Fire a SECOND catchUp concurrently with the first (models a gap-trigger arriving
    // mid-loop). The catchingUp guard must coalesce them — no doubled apply.
    const [r1, r2] = await Promise.all([b.coordinator.catchUp(), b.coordinator.catchUp()])
    expect(r1.complete || r2.complete).toBe(true)
    expect(b.applied.length).toBe(150) // converged EXACTLY once (no 300)
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(149)
  })

  it('VE-B2 DoS CONTROL (Opus hang repro) — a MULTI-PAGE truncated:true broker-confirmed-absent gap + ACTIVE live trigger TERMINATES, does NOT spin', async () => {
    // The exact Opus blocker: the old do-while spun because a gap-pending page set catchUpAgain
    // forever. v3 exercises the REAL truncated:true loop e2e: a permanent hole at seq 2 with a
    // MULTI-PAGE tail (201..401 = 201 entries > limit 100), so every tail page is truncated:true
    // and the strict head is pinned behind the hole. The live gap-trigger is LEFT ACTIVE (not
    // stubbed) to model the auto-trigger the old code spun on. catchUp() MUST return (gap-pending)
    // within a sane bound; a hang/spin FAILS via the timeout race.
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i <= 1; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i])) // 0,1

    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, catchUpPageSize: 100 })
    await b.coordinator.ensurePublished()
    // Permanent hole at seq 2; tail 201..401 (201 entries) the broker genuinely lacks 2..200 of.
    const docLog = (broker as unknown as { docs: Map<string, { entries: Map<string, { docId: string; deviceId: string; seq: number; entryJws: string }>; heads: Map<string, number> }> }).docs.get(SPACE_ID)!
    for (let s = 201; s <= 401; s++) {
      const e = await buildEntryJws(alice, DEVICE_A, s, new Uint8Array([s & 0xff]))
      docLog.entries.set(`${DEVICE_A}:${s}`, { docId: SPACE_ID, deviceId: DEVICE_A, seq: s, entryJws: e })
    }
    docLog.heads.set(DEVICE_A, 401)

    // ACTIVE live trigger (triggerGapCatchUp NOT stubbed). catchUp() MUST terminate.
    const terminated = await Promise.race([
      b.coordinator.catchUp().then(() => 'terminated' as const),
      new Promise<'HANG'>((resolve) => setTimeout(() => resolve('HANG'), 3000)),
    ])
    expect(terminated).toBe('terminated')
    // strict head pinned behind the hole at seq 2; the page-1 tail applied out-of-order.
    expect((await b.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(1)
    expect(b.applied.length).toBeGreaterThan(0)
    const reqCountAfterFirst = b.syncRequests.length

    // A second catchUp also terminates AND does not accumulate an unbounded sync-request spin.
    const terminated2 = await Promise.race([
      b.coordinator.catchUp().then(() => 'terminated' as const),
      new Promise<'HANG'>((resolve) => setTimeout(() => resolve('HANG'), 3000)),
    ])
    expect(terminated2).toBe('terminated')
    // Bounded: the second pass adds only a handful of requests (page-walk to the hole), not 100s.
    expect(b.syncRequests.length - reqCountAfterFirst).toBeLessThan(20)
  })

  it('VE-B2 GapRepair OVER-FETCH fix (Codex Major 2) — a repair request holds OTHER devices at their cursor (not absent → full re-fetch); single page', async () => {
    // driveGapRepairs lowers ONLY the gap device to firstMissing-1 over the CURRENT wire cursor.
    // A `{[gapDevice]: firstMissing-1}`-only head would leave every other device absent ⇒ the
    // broker re-sends their entire history and the gap entry can be crowded out of the page limit.
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })

    // DEVICE_C has a healthy contiguous run (cursor must be PRESERVED in the repair request).
    for (const s of [0, 1, 2]) {
      const e = await buildEntryJws(alice, DEVICE_C, s, new Uint8Array([s]))
      await b.logStore.recordRemoteApplied({ docId: SPACE_ID, deviceId: DEVICE_C, seq: s, entryJws: e })
    }
    // DEVICE_A has seq 0 + a soft-skipped hole at firstMissing=1 (set up directly in the store).
    const e0 = await buildEntryJws(alice, DEVICE_A, 0, new Uint8Array([0]))
    await b.logStore.recordRemoteApplied({ docId: SPACE_ID, deviceId: DEVICE_A, seq: 0, entryJws: e0 })
    await b.logStore.recordGapObservation(SPACE_ID, DEVICE_A, 1, 5, 0, Date.now())
    await b.logStore.markGapSoftSkipped(SPACE_ID, DEVICE_A, 1)

    const before = b.syncRequests.length
    await (b.coordinator as unknown as { driveGapRepairs: () => Promise<void> }).driveGapRepairs()
    const repairReqs = b.syncRequests.slice(before)
    expect(repairReqs.length).toBe(1) // single page, no pagination
    const heads = repairReqs[0].heads
    expect(heads[DEVICE_A]).toBe(0) // gap device lowered to firstMissing-1 = 0
    expect(heads[DEVICE_C]).toBe(2) // OTHER device held at its cursor — NOT re-fetched from 0
  })
})
