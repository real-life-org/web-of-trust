import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { IndexedDBKeyManagementAdapter } from '../src/adapters/key-management/IndexedDBKeyManagementAdapter'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  createSpaceCapabilityJws,
  createSpaceRegisterMessage,
  createLogEntryMessage,
  type LogSyncEngineHooks,
  type ControlFrameReceipt,
} from '../src/protocol'

/**
 * Cold-Start PR1 (#353) — the key-lookup HOTPATH of the read path.
 *
 * Before: every incoming entry ran getAvailableKeyGenerations() (a scan over
 * generation 0..current, one key-store access per generation) and THEN loaded the
 * same generation key again for decryption → O(N × generations) key-store accesses
 * for a catch-up of N entries. After: ONE exact lookup of the entry's generation
 * (its result is the decrypt key), and — through the key store's material cache —
 * at most O(1) IDB accesses per (docId, generation) for the whole catch-up.
 *
 * VE-5 semantics are unchanged: a generation without key material is
 * blocked-by-key (buffered, replayed after the key import), never dropped.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '33333333-3333-4333-8333-333333333333'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEVICE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()
const GEN0_KEY = new Uint8Array(32).fill(7)
const GEN1_KEY = new Uint8Array(32).fill(11)
const capabilitySigningSeed = new Uint8Array(32).fill(9)

let dbCounter = 0
const freshDbName = (): string => `test-hotpath-${Date.now()}-${++dbCounter}`

/** Per-object-store IDB access counters (the #353 measurement probe shape). */
function instrumentIdb(): { get: Record<string, number>; openCursor: Record<string, number> } {
  const counts = { get: {} as Record<string, number>, openCursor: {} as Record<string, number> }
  const proto = globalThis.IDBObjectStore.prototype
  const originalGet = proto.get
  const originalOpenCursor = proto.openCursor
  vi.spyOn(proto, 'get').mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    counts.get[this.name] = (counts.get[this.name] ?? 0) + 1
    return (originalGet as (...a: unknown[]) => IDBRequest).apply(this, args)
  })
  vi.spyOn(proto, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    counts.openCursor[this.name] = (counts.openCursor[this.name] ?? 0) + 1
    return (originalOpenCursor as (...a: unknown[]) => IDBRequest).apply(this, args)
  })
  return counts
}

async function makeCapability(audience: string, generation: number): Promise<string> {
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
      applied.push(plaintext)
    },
  }
}

/** Counting key config (fake key store) — proves the coordinator's OWN access pattern. */
interface KeyConfigProbe {
  byGenerationCalls: number[]
  availableCalls: number
  currentCalls: number
}

interface Harness {
  coordinator: LogSyncCoordinator
  applied: Uint8Array[]
  keyProbe: KeyConfigProbe
  messaging: InMemoryMessagingAdapter
}

async function makeHarness(
  identity: PublicIdentitySession,
  deviceId: string,
  broker: InProcessLogBroker,
  keys: {
    /** Exact per-generation lookup under test (wired to a fake map OR the real IDB store). */
    byGeneration: (generation: number) => Promise<Uint8Array | null>
    current: () => Promise<{ key: Uint8Array; generation: number } | null>
    /** Optional legacy scan — MUST never be consulted by the read path anymore. */
    available?: () => Promise<readonly number[]>
  },
): Promise<Harness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())
  const logStore = new InMemoryDocLogStore()
  await logStore.init()
  const applied: Uint8Array[] = []
  const keyProbe: KeyConfigProbe = { byGenerationCalls: [], availableCalls: 0, currentCalls: 0 }

  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: { sendControlFrame: (frame) => messaging.sendControlFrame!(frame) },
    envelopes: { send: (envelope) => messaging.send(envelope as never) },
    capabilities: {
      getCapabilityJws: async () => makeCapability(identity.getDid(), (await keys.current())?.generation ?? 0),
    },
    hooks: makeHooks(applied),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => {
      keyProbe.currentCalls += 1
      return keys.current()
    },
    getContentKeyByGeneration: async (generation) => {
      keyProbe.byGenerationCalls.push(generation)
      return keys.byGeneration(generation)
    },
    getAvailableKeyGenerations: keys.available
      ? async () => {
          keyProbe.availableCalls += 1
          return keys.available!()
        }
      : undefined,
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
  return { coordinator, applied, keyProbe, messaging }
}

/** Alice authors N entries (all under her CURRENT generation) and returns them as messages. */
async function authorEntries(
  broker: InProcessLogBroker,
  alice: PublicIdentitySession,
  bobDid: string,
  n: number,
  keyMap: Map<number, Uint8Array>,
  authorDeviceId: string = DEVICE_A,
): Promise<unknown[]> {
  const current = Math.max(...keyMap.keys())
  const a = await makeHarness(alice, authorDeviceId, broker, {
    byGeneration: async (g) => keyMap.get(g) ?? null,
    current: async () => ({ key: keyMap.get(current)!, generation: current }),
  })
  await a.coordinator.ensurePublished()
  const messages: unknown[] = []
  for (let i = 0; i < n; i++) {
    const entry = await a.coordinator.writeLocalUpdate(new Uint8Array([i & 0xff, (i >> 8) & 0xff]))
    messages.push(
      createLogEntryMessage({
        id: globalThis.crypto.randomUUID(),
        from: alice.getDid(),
        to: [bobDid],
        createdTime: Math.floor(Date.now() / 1000),
        entry: entry!.entryJws,
      }),
    )
  }
  return messages
}

beforeEach(() => {
  InMemoryMessagingAdapter.resetAll()
})

afterEach(() => {
  InMemoryMessagingAdapter.resetAll()
  vi.restoreAllMocks()
})

describe('LogSyncCoordinator — #353 PR1: exact key lookup replaces the per-entry generation scan', () => {
  it('receiving N entries of one generation makes exactly ONE exact lookup per entry and NEVER scans available generations', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const keyMap = new Map([[0, GEN0_KEY]])
    const N = 40
    const messages = await authorEntries(broker, alice, bob.getDid(), N, keyMap)

    const b = await makeHarness(bob, DEVICE_B, broker, {
      byGeneration: async (g) => keyMap.get(g) ?? null,
      current: async () => ({ key: GEN0_KEY, generation: 0 }),
      // The legacy scan closure is STILL provided (source-compat) — it must stay unused.
      available: async () => [0],
    })

    for (const m of messages) {
      expect((await b.coordinator.receiveLogEntry(m)).disposition).toBe('applied')
    }
    expect(b.applied.length).toBe(N)
    // Exactly one exact lookup per entry — the availability decision IS the key load.
    expect(b.keyProbe.byGenerationCalls.length).toBe(N)
    expect(b.keyProbe.byGenerationCalls.every((g) => g === 0)).toBe(true)
    // The former hotpath is gone: no generation scan, no current-generation probe on the read path.
    expect(b.keyProbe.availableCalls).toBe(0)
    expect(b.keyProbe.currentCalls).toBe(0)
  })

  it('VE-5 unchanged: a generation the exact lookup does not know is blocked-by-key (buffered), and replays after the key import', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    // Alice authors under gen 1; Bob only holds gen 0.
    const aliceKeys = new Map([
      [0, GEN0_KEY],
      [1, GEN1_KEY],
    ])
    const messages = await authorEntries(broker, alice, bob.getDid(), 3, aliceKeys)

    const bobKeys = new Map([[0, GEN0_KEY]])
    const b = await makeHarness(bob, DEVICE_B, broker, {
      byGeneration: async (g) => bobKeys.get(g) ?? null,
      current: async () => ({ key: GEN0_KEY, generation: 0 }),
    })

    for (const m of messages) {
      const r = await b.coordinator.receiveLogEntry(m)
      expect(r.disposition).toBe('blocked-by-key')
      expect((r as { keyGeneration?: number }).keyGeneration).toBe(1)
    }
    expect(b.applied.length).toBe(0)
    expect(b.coordinator.blockedByKeyCount()).toBe(3)
    expect(b.keyProbe.availableCalls).toBe(0)

    // The gen-1 key lands → replay converges every buffered entry through the read path.
    bobKeys.set(1, GEN1_KEY)
    expect(await b.coordinator.replayBlockedByKey()).toBe(3)
    expect(b.applied.length).toBe(3)
    expect(b.coordinator.blockedByKeyCount()).toBe(0)
  })

  it('MEASURABLE: a catch-up over N entries of one generation through the REAL IDB key store costs ≤ 1 get:contentKeys and 0 openCursor:contentKeys', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const keyMap = new Map([[0, GEN0_KEY]])
    const N = 60
    const messages = await authorEntries(broker, alice, bob.getDid(), N, keyMap)

    // Bob's key material lives in the durable (fake-)IndexedDB store — the store the
    // #353 measurement counted (get:contentKeys / openCursor:contentKeys).
    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    await km.saveKey(SPACE_ID, 0, GEN0_KEY)
    const b = await makeHarness(bob, DEVICE_B, broker, {
      // Wired EXACTLY like the Yjs/Automerge adapters: exact per-generation lookup.
      byGeneration: (g) => km.getKeyByGeneration(SPACE_ID, g),
      current: async () => {
        const generation = await km.getCurrentGeneration(SPACE_ID)
        const key = await km.getKeyByGeneration(SPACE_ID, generation)
        return key ? { key, generation } : null
      },
    })

    const counts = instrumentIdb()
    for (const m of messages) {
      expect((await b.coordinator.receiveLogEntry(m)).disposition).toBe('applied')
    }
    expect(b.applied.length).toBe(N)

    // O(1) per (docId, generation), NOT O(N): one IDB get for the whole catch-up, no scan.
    expect(counts.get.contentKeys ?? 0).toBeLessThanOrEqual(1)
    expect(counts.openCursor.contentKeys ?? 0).toBe(0)
    expect(counts.get.capKeyPairs ?? 0).toBe(0)
    await km.close()
  })

  it('MEASURABLE (two generations): a mixed catch-up costs ≤ 1 get:contentKeys PER generation', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    // Alice writes 20 entries under gen 0 (device A), then — after the rotation — 20
    // under gen 1 from a second device (C), so the (deviceId, seq) namespaces are
    // disjoint and every entry is a genuine first-time apply on Bob's side.
    const gen0 = await authorEntries(broker, alice, bob.getDid(), 20, new Map([[0, GEN0_KEY]]), DEVICE_A)
    InMemoryMessagingAdapter.resetAll()
    const broker2 = new InProcessLogBroker()
    const gen1 = await authorEntries(
      broker2,
      alice,
      bob.getDid(),
      20,
      new Map([
        [0, GEN0_KEY],
        [1, GEN1_KEY],
      ]),
      DEVICE_C,
    )
    InMemoryMessagingAdapter.resetAll()

    const km = new IndexedDBKeyManagementAdapter(freshDbName())
    await km.init()
    await km.saveKey(SPACE_ID, 0, GEN0_KEY)
    await km.saveKey(SPACE_ID, 1, GEN1_KEY)
    const b = await makeHarness(bob, DEVICE_B, new InProcessLogBroker(), {
      byGeneration: (g) => km.getKeyByGeneration(SPACE_ID, g),
      current: async () => ({ key: GEN1_KEY, generation: 1 }),
    })

    const counts = instrumentIdb()
    // Interleave generations so a naive "last key" cache would thrash.
    for (let i = 0; i < 20; i++) {
      expect((await b.coordinator.receiveLogEntry(gen0[i])).disposition).toBe('applied')
      expect((await b.coordinator.receiveLogEntry(gen1[i])).disposition).toBe('applied')
    }
    expect(b.applied.length).toBe(40)
    expect(counts.get.contentKeys ?? 0).toBeLessThanOrEqual(2) // one per generation
    expect(counts.openCursor.contentKeys ?? 0).toBe(0)
    await km.close()
  })
})
