import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import type { DocLogEntryKey, RecordRemoteAppliedEntry } from '../src/ports/DocLogStore'
import {
  LogSyncCoordinator,
  createSpaceCapabilityJws,
  createSpaceRegisterMessage,
  createSyncResponseMessage,
  encryptLogPayload,
  createLogEntryJwsWithSigner,
  type LogSyncEngineHooks,
  type ControlFrameReceipt,
} from '../src/protocol'

/**
 * Cold-Start PR3 (#353) — DocLog-Batch-API for the sync-response path.
 *
 * The measured cold-start restore (~2.400 entries) paid one IDB round-trip per
 * entry for the durable idempotency probe (getEntry) and one per persisted entry
 * (recordRemoteApplied) — get:entries 5.553 requests, ⌀544 ms (IDB queue
 * saturation). These tests pin the Read-Batch → Compute → Write-Batch design
 * with TEETH against an instrumented store:
 *  - a sync-response page with N entries issues O(1) store calls for existence
 *    (ONE hasEntriesBatch) and persistence (ONE recordRemoteAppliedBatch), and
 *    ZERO per-entry getEntry/recordRemoteApplied,
 *  - the in-memory applied-set is marked ONLY after the durable batch commit —
 *    a FAILED commit marks NOTHING, so the retry re-applies AND re-persists the
 *    whole page (no phantom idempotency mark ⇒ no durable data loss),
 *  - blocked-by-key entries are neither persisted nor marked, and their replay
 *    still runs through the unchanged single-entry path.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '33333333-3333-4333-8333-333333333333'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()
const CONTENT_KEY = new Uint8Array(32).fill(7)

let capabilitySigningSeed: Uint8Array

/**
 * InMemoryDocLogStore with call counters for the O(1)-vs-O(N) proof. The
 * InMemory batch delegates to per-entry recordRemoteApplied internally, so the
 * single-call counter only counts calls arriving from OUTSIDE a batch.
 */
class InstrumentedDocLogStore extends InMemoryDocLogStore {
  getEntryCalls = 0
  recordRemoteAppliedCalls = 0
  hasEntriesBatchCalls = 0
  recordRemoteAppliedBatchCalls = 0
  lastBatchSize = 0
  failNextBatchCommit = false
  private inBatch = false

  resetCounters(): void {
    this.getEntryCalls = 0
    this.recordRemoteAppliedCalls = 0
    this.hasEntriesBatchCalls = 0
    this.recordRemoteAppliedBatchCalls = 0
    this.lastBatchSize = 0
  }

  override async getEntry(docId: string, deviceId: string, seq: number) {
    this.getEntryCalls += 1
    return super.getEntry(docId, deviceId, seq)
  }

  override async recordRemoteApplied(entry: RecordRemoteAppliedEntry): Promise<void> {
    if (!this.inBatch) this.recordRemoteAppliedCalls += 1
    return super.recordRemoteApplied(entry)
  }

  override async hasEntriesBatch(
    docId: string,
    keys: readonly DocLogEntryKey[],
  ): Promise<DocLogEntryKey[]> {
    this.hasEntriesBatchCalls += 1
    return super.hasEntriesBatch(docId, keys)
  }

  override async recordRemoteAppliedBatch(
    entries: readonly RecordRemoteAppliedEntry[],
  ): Promise<void> {
    this.recordRemoteAppliedBatchCalls += 1
    this.lastBatchSize = entries.length
    if (this.failNextBatchCommit) {
      this.failNextBatchCommit = false
      throw new Error('injected batch-commit failure')
    }
    this.inBatch = true
    try {
      await super.recordRemoteAppliedBatch(entries)
    } finally {
      this.inBatch = false
    }
  }
}

interface Harness {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  logStore: InstrumentedDocLogStore
  coordinator: LogSyncCoordinator
  applied: Uint8Array[]
  /** Key generations available to getContentKeyByGeneration (mutable per test). */
  availableGenerations: Set<number>
}

async function makeCapability(audience: string): Promise<string> {
  return createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: SPACE_ID,
      audience,
      permissions: ['read', 'write'],
      generation: 0,
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
      applied.push(plaintext)
    },
  }
}

async function makeHarness(identity: PublicIdentitySession, deviceId: string): Promise<Harness> {
  const broker = new InProcessLogBroker()
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())

  const logStore = new InstrumentedDocLogStore()
  await logStore.init()

  const applied: Uint8Array[] = []
  const availableGenerations = new Set<number>([0])
  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: { sendControlFrame: (frame) => messaging.sendControlFrame!(frame) },
    envelopes: { send: (envelope) => messaging.send(envelope as never) },
    capabilities: { getCapabilityJws: () => makeCapability(identity.getDid()) },
    hooks: makeHooks(applied),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => ({ key: CONTENT_KEY, generation: 0 }),
    getContentKeyByGeneration: async (generation) =>
      availableGenerations.has(generation) ? CONTENT_KEY : null,
    getAvailableKeyGenerations: async () => [...availableGenerations].sort((a, b) => a - b),
    sendSpaceRegister: async () => {
      const register = await createSpaceRegisterMessage({
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
  return { identity, messaging, logStore, coordinator, applied, availableGenerations }
}

/** Build a signed+encrypted log-entry JWS for (deviceId, seq) under a key generation. */
async function buildEntryJws(
  author: PublicIdentitySession,
  deviceId: string,
  seq: number,
  plaintext: Uint8Array,
  keyGeneration = 0,
): Promise<string> {
  const enc = await encryptLogPayload({ crypto, spaceContentKey: CONTENT_KEY, deviceId, seq, plaintext })
  return createLogEntryJwsWithSigner({
    payload: {
      seq,
      deviceId,
      docId: SPACE_ID,
      authorKid: author.kid,
      keyGeneration,
      data: enc.blobBase64Url,
      timestamp: NOW,
    },
    sign: (input) => author.signEd25519(input),
  })
}

function makePage(from: PublicIdentitySession, entries: string[], heads: Record<string, number>) {
  return createSyncResponseMessage({
    id: globalThis.crypto.randomUUID(),
    from: from.getDid(),
    to: [from.getDid()],
    createdTime: Math.floor(Date.now() / 1000),
    thid: globalThis.crypto.randomUUID(),
    body: { docId: SPACE_ID, entries, heads, truncated: false },
  })
}

beforeEach(() => {
  InMemoryMessagingAdapter.resetAll()
  capabilitySigningSeed = new Uint8Array(32).fill(9)
})

afterEach(() => {
  InMemoryMessagingAdapter.resetAll()
})

describe('LogSyncCoordinator — Cold-Start PR3 (#353) DocLog batch API', () => {
  it('O(1) PROOF — a sync-response page with N entries issues ONE hasEntriesBatch + ONE recordRemoteAppliedBatch and ZERO per-entry getEntry/recordRemoteApplied', async () => {
    const N = 40
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const h = await makeHarness(bob, DEVICE_B)

    const entries: string[] = []
    for (let seq = 0; seq < N; seq++) {
      entries.push(await buildEntryJws(alice, DEVICE_A, seq, new Uint8Array([seq])))
    }
    h.logStore.resetCounters()

    const result = await h.coordinator.applySyncResponse(
      makePage(bob, entries, { [DEVICE_A]: N - 1 }),
    )

    expect(result.complete).toBe(true)
    expect(h.applied.length).toBe(N)
    expect((await h.logStore.getKnownHeads(SPACE_ID))[DEVICE_A]).toBe(N - 1)
    expect((await h.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(N - 1)

    // THE measurable criterion: O(1) store calls for existence + persistence —
    // NOT one getEntry and one recordRemoteApplied per entry (the IDB hot path).
    expect(h.logStore.hasEntriesBatchCalls).toBe(1)
    expect(h.logStore.recordRemoteAppliedBatchCalls).toBe(1)
    expect(h.logStore.lastBatchSize).toBe(N)
    expect(h.logStore.getEntryCalls).toBe(0)
    expect(h.logStore.recordRemoteAppliedCalls).toBe(0)
  })

  it('IDEMPOTENT RE-APPLY — the same page a second time skips durably (one probe, NO write-batch, no double CRDT apply)', async () => {
    const N = 10
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const h = await makeHarness(bob, DEVICE_B)

    const entries: string[] = []
    for (let seq = 0; seq < N; seq++) {
      entries.push(await buildEntryJws(alice, DEVICE_A, seq, new Uint8Array([seq])))
    }
    await h.coordinator.applySyncResponse(makePage(bob, entries, { [DEVICE_A]: N - 1 }))
    expect(h.applied.length).toBe(N)

    // Simulate a reload: the in-memory applied-set is gone, only the durable store
    // answers. A fresh coordinator over the SAME store must skip via ONE batch probe.
    const h2 = await makeHarnessOverStore(bob, DEVICE_B, h.logStore)
    h.logStore.resetCounters()
    await h2.coordinator.applySyncResponse(makePage(bob, entries, { [DEVICE_A]: N - 1 }))

    expect(h2.applied.length).toBe(0) // nothing re-applied to the CRDT
    expect(h.logStore.hasEntriesBatchCalls).toBe(1)
    expect(h.logStore.recordRemoteAppliedBatchCalls).toBe(0) // nothing new → no write-batch
    expect(h.logStore.getEntryCalls).toBe(0)
  })

  it('FAILED COMMIT — a thrown recordRemoteAppliedBatch marks NO entry in-memory: the retry re-applies AND persists the whole page (no phantom idempotency)', async () => {
    const N = 8
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const h = await makeHarness(bob, DEVICE_B)

    const entries: string[] = []
    for (let seq = 0; seq < N; seq++) {
      entries.push(await buildEntryJws(alice, DEVICE_A, seq, new Uint8Array([seq])))
    }

    h.logStore.failNextBatchCommit = true
    await expect(
      h.coordinator.applySyncResponse(makePage(bob, entries, { [DEVICE_A]: N - 1 })),
    ).rejects.toThrow(/injected batch-commit failure/)

    // Durably NOTHING was recorded, and NOTHING is marked applied in-memory.
    expect(await h.logStore.getKnownHeads(SPACE_ID)).toEqual({})

    // Retry the SAME page on the SAME coordinator: were any entry phantom-marked,
    // it would be skipped and NEVER persisted (durable loss). Instead the whole
    // page re-applies and commits.
    const result = await h.coordinator.applySyncResponse(
      makePage(bob, entries, { [DEVICE_A]: N - 1 }),
    )
    expect(result.complete).toBe(true)
    expect((await h.logStore.getKnownHeads(SPACE_ID))[DEVICE_A]).toBe(N - 1)
    expect((await h.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(N - 1)
    expect(h.logStore.lastBatchSize).toBe(N) // the retry persisted ALL N, not a subset
  })

  it('BLOCKED-BY-KEY — key-missing entries are neither persisted nor marked; the replay after key import converges via the unchanged single-entry path', async () => {
    const N = 5
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const h = await makeHarness(bob, DEVICE_B)

    // Entries under generation 1, which the harness does NOT hold yet.
    const entries: string[] = []
    for (let seq = 0; seq < N; seq++) {
      entries.push(await buildEntryJws(alice, DEVICE_A, seq, new Uint8Array([seq]), 1))
    }
    const result = await h.coordinator.applySyncResponse(
      makePage(bob, entries, { [DEVICE_A]: N - 1 }),
    )
    // Buffered, not applied: no CRDT apply, no durable record, no write-batch.
    expect(result.complete).toBe(true)
    expect(h.applied.length).toBe(0)
    expect(h.coordinator.blockedByKeyCount()).toBe(N)
    expect(await h.logStore.getKnownHeads(SPACE_ID)).toEqual({})
    expect(h.logStore.recordRemoteAppliedBatchCalls).toBe(0)

    // The key generation arrives → VE-5 replay drains the buffer through the
    // single-entry read path (recordRemoteApplied per entry — unchanged).
    h.availableGenerations.add(1)
    const converged = await h.coordinator.replayBlockedByKey()
    expect(converged).toBe(N)
    expect(h.applied.length).toBe(N)
    expect((await h.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(N - 1)
    expect(h.coordinator.blockedByKeyCount()).toBe(0)
  })

  it('MIXED PAGE — already-known and new entries in one page: one probe, one write-batch covering ONLY the new entries', async () => {
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const h = await makeHarness(bob, DEVICE_B)

    const first = [
      await buildEntryJws(alice, DEVICE_A, 0, new Uint8Array([0])),
      await buildEntryJws(alice, DEVICE_A, 1, new Uint8Array([1])),
    ]
    await h.coordinator.applySyncResponse(makePage(bob, first, { [DEVICE_A]: 1 }))

    const mixed = [
      ...first,
      await buildEntryJws(alice, DEVICE_A, 2, new Uint8Array([2])),
      await buildEntryJws(alice, DEVICE_A, 3, new Uint8Array([3])),
    ]
    h.logStore.resetCounters()
    await h.coordinator.applySyncResponse(makePage(bob, mixed, { [DEVICE_A]: 3 }))

    expect(h.applied.length).toBe(4) // 0,1 applied once; 2,3 newly applied
    expect(h.logStore.hasEntriesBatchCalls).toBe(1)
    expect(h.logStore.recordRemoteAppliedBatchCalls).toBe(1)
    expect(h.logStore.lastBatchSize).toBe(2) // only the NEW entries are persisted
    expect(h.logStore.getEntryCalls).toBe(0)
    expect(h.logStore.recordRemoteAppliedCalls).toBe(0)
    expect((await h.logStore.getStrictContiguousHeads(SPACE_ID))[DEVICE_A]).toBe(3)
  })
})

/** A harness over an EXISTING store (reload simulation for the idempotency test). */
async function makeHarnessOverStore(
  identity: PublicIdentitySession,
  deviceId: string,
  logStore: InstrumentedDocLogStore,
): Promise<Harness> {
  const broker = new InProcessLogBroker()
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())
  const applied: Uint8Array[] = []
  const availableGenerations = new Set<number>([0])
  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: { sendControlFrame: (frame) => messaging.sendControlFrame!(frame) },
    envelopes: { send: (envelope) => messaging.send(envelope as never) },
    capabilities: { getCapabilityJws: () => makeCapability(identity.getDid()) },
    hooks: makeHooks(applied),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => ({ key: CONTENT_KEY, generation: 0 }),
    getContentKeyByGeneration: async (generation) =>
      availableGenerations.has(generation) ? CONTENT_KEY : null,
    getAvailableKeyGenerations: async () => [...availableGenerations].sort((a, b) => a - b),
  })
  messaging.onMessage(async (message) => {
    await coordinator.handleIncoming(message)
  })
  return { identity, messaging, logStore, coordinator, applied, availableGenerations }
}
