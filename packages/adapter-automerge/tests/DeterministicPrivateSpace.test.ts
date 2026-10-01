import { describe, it, expect, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity, recoverTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import { derivePrivateSpaceGenesis, SPACE_REGISTER_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'

const BROKER_URLS = ['wss://broker.example.com']

/** Deterministic wait — no fixed sleeps (CI runners are far slower than dev boxes). */
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const PRIVATE_META = { name: 'Privat', appTag: 'rls-private', modules: ['feed'] }

/** The durable stores that survive a process restart (same device, same disk). */
interface DurableStores {
  metadataStorage: InMemorySpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
  repoStorage: InMemoryRepoStorageAdapter
  docLogStore: InMemoryDocLogStore
}

async function makeStores(deviceId: string, metadataStorage?: InMemorySpaceMetadataStorage): Promise<DurableStores> {
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  await docLogStore.setDeviceId(deviceId)
  return {
    metadataStorage: metadataStorage ?? new InMemorySpaceMetadataStorage(),
    keyManagement: new InMemoryKeyManagementAdapter(),
    repoStorage: new InMemoryRepoStorageAdapter(),
    docLogStore,
  }
}

async function makeAdapter(identity: PublicIdentitySession, broker: InProcessLogBroker, socketId: string, deviceId: string, stores?: DurableStores): Promise<{ adapter: AutomergeReplicationAdapter; messaging: InMemoryMessagingAdapter }> {
  const messaging = new InMemoryMessagingAdapter({ broker, socketId })
  await messaging.connect(identity.getDid())
  const durable = stores ?? await makeStores(deviceId)
  const adapter = new AutomergeReplicationAdapter({
    identity, messaging, brokerUrls: BROKER_URLS,
    keyManagement: durable.keyManagement,
    metadataStorage: durable.metadataStorage,
    repoStorage: durable.repoStorage,
    docLogStore: durable.docLogStore, deviceId,
  })
  return { adapter, messaging }
}

/** The adapter's live coordinator map — session-wide state a stale flight must not touch. */
function coordinatorsOf(adapter: AutomergeReplicationAdapter): Map<string, unknown> {
  return (adapter as unknown as { coordinators: Map<string, unknown> }).coordinators
}

/**
 * How many log-change observers currently sit on the doc handle of `spaceId` in the
 * adapter's CURRENT repo. A stale flight re-attaching its observer (closing over the
 * shut-down session's SpaceState) shows up here as an extra listener.
 */
function logChangeListeners(adapter: AutomergeReplicationAdapter, spaceId: string): number {
  const internals = adapter as unknown as {
    spaces: Map<string, { documentId: string }>
    repo: { handles: Record<string, { listenerCount: (event: string) => number }> }
  }
  const documentId = internals.spaces.get(spaceId)?.documentId
  if (!documentId) return 0
  return internals.repo.handles[documentId]?.listenerCount('change') ?? 0
}

/** Counts space-register control frames a given messaging adapter sends. */
function countSpaceRegisters(messaging: InMemoryMessagingAdapter): () => number {
  let count = 0
  const base = messaging.sendControlFrame!.bind(messaging)
  ;(messaging as unknown as { sendControlFrame: typeof messaging.sendControlFrame }).sendControlFrame = async (frame) => {
    if ((frame as { type?: string }).type === SPACE_REGISTER_MESSAGE_TYPE) count += 1
    return base(frame)
  }
  return () => count
}

/**
 * Gates the FIRST deriveFrameworkKey() call — the genesis DERIVATION itself, i.e.
 * the very first await of the flight, before any lease used to exist there.
 */
function identityGatedOnFirstDerive(identity: PublicIdentitySession): { identity: PublicIdentitySession; deriveCalls: () => number; release: () => void } {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const proxied = new Proxy(identity as object, {
    get(target, prop) {
      if (prop === 'deriveFrameworkKey') {
        return async (info: string, length?: number) => {
          calls += 1
          if (calls === 1) await gate
          return (target as PublicIdentitySession).deriveFrameworkKey(info, length)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PublicIdentitySession
  return { identity: proxied, deriveCalls: () => calls, release: () => release() }
}

/**
 * Gates the FIRST saveKey() call — an await inside the key provisioning that sits
 * BEFORE the network registrations. Later calls pass through so the new session can
 * finish while flight A is still parked.
 */
function keyManagementGatedOnFirstSave(km: InMemoryKeyManagementAdapter): { keyManagement: InMemoryKeyManagementAdapter; saveKeyCalls: () => number; release: () => void } {
  const realSave = km.saveKey.bind(km)
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  km.saveKey = async (spaceId, generation, key) => {
    calls += 1
    if (calls === 1) await gate
    return realSave(spaceId, generation, key)
  }
  return { keyManagement: km, saveKeyCalls: () => calls, release: () => release() }
}

/**
 * Scripted durability boundary for the lifecycle repro: call 1 blocks on a gate,
 * call 2 throws (new session's flight fails), call 3+ succeeds.
 */
function metadataGateThenFail(): { storage: InMemorySpaceMetadataStorage; saveCalls: () => number; release: () => void } {
  const storage = new InMemorySpaceMetadataStorage()
  const realSave = storage.saveSpaceMetadata.bind(storage)
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  storage.saveSpaceMetadata = async (meta) => {
    calls += 1
    if (calls === 1) { await gate; return realSave(meta) }
    if (calls === 2) throw new Error('injected durability failure: second flight')
    return realSave(meta)
  }
  return { storage, saveCalls: () => calls, release: () => release() }
}

/**
 * Gates the FIRST space-register control frame — the await boundary INSIDE
 * ensurePublished(), i.e. after this flight already persisted its metadata. Later
 * frames pass through so the rest of the session is unaffected.
 */
function spaceRegisterGatedOnFirst(messaging: InMemoryMessagingAdapter): { registerCalls: () => number; release: () => void } {
  const base = messaging.sendControlFrame!.bind(messaging)
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  ;(messaging as unknown as { sendControlFrame: typeof messaging.sendControlFrame }).sendControlFrame = async (frame) => {
    if ((frame as { type?: string }).type === SPACE_REGISTER_MESSAGE_TYPE) {
      calls += 1
      if (calls === 1) await gate
    }
    return base(frame)
  }
  return { registerCalls: () => calls, release: () => release() }
}

/** Fault injection for the late-publish repro: the SECOND saveSpaceMetadata throws. */
function metadataFailingOnSecondSave(): { storage: InMemorySpaceMetadataStorage; saveCalls: () => number } {
  const storage = new InMemorySpaceMetadataStorage()
  const realSave = storage.saveSpaceMetadata.bind(storage)
  let calls = 0
  storage.saveSpaceMetadata = async (meta) => {
    calls += 1
    if (calls === 2) throw new Error('injected durability failure: second flight')
    return realSave(meta)
  }
  return { storage, saveCalls: () => calls }
}

/** Fault injection at a durability boundary: the first saveSpaceMetadata throws. */
function metadataFailingOnce(): { storage: InMemorySpaceMetadataStorage; saveCalls: () => number } {
  const storage = new InMemorySpaceMetadataStorage()
  const realSave = storage.saveSpaceMetadata.bind(storage)
  let calls = 0
  storage.saveSpaceMetadata = async (meta) => {
    calls += 1
    if (calls === 1) throw new Error('injected durability failure: saveSpaceMetadata')
    return realSave(meta)
  }
  return { storage, saveCalls: () => calls }
}

// Parity with adapter-yjs/tests/DeterministicPrivateSpace.test.ts — the same
// deterministic-genesis contract must hold identically for the Automerge engine.
describe('Deterministic private space (Sync 001) — Automerge adapter contract', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
  })

  it('openOrCreate returns the derived genesis id and is idempotent on the same device', async () => {
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-single')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const { adapter } = await makeAdapter(identity, broker, 'detps-am-single', 'd1111111-1111-4111-8111-111111111111')
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))

    const first = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(first.id).toBe(genesis.spaceId)
    expect(first.appTag).toBe('rls-private')

    const second = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(second.id).toBe(genesis.spaceId)
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(1)
  })

  it('resumes the missing phases after a failed create instead of reporting success', async () => {
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-fault')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const { storage, saveCalls } = metadataFailingOnce()
    const { adapter } = await makeAdapter(identity, broker, 'detps-am-fault', 'f1111111-1111-4111-8111-111111111111', await makeStores('f1111111-1111-4111-8111-111111111111', storage))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))

    await expect(adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)).rejects.toThrow(/injected durability failure/)
    expect(await storage.loadSpaceMetadata(genesis.spaceId)).toBeNull()

    const space = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(space.id).toBe(genesis.spaceId)
    expect(saveCalls()).toBeGreaterThan(1)
    expect(await storage.loadSpaceMetadata(genesis.spaceId)).not.toBeNull()
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(1)
  })

  it('publishes on a fresh instance when a previous process died before space-register', async () => {
    // Restart contract (parity with Yjs): completion must NOT be a RAM claim.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-restart')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'e1111111-1111-4111-8111-111111111111'
    const stores = await makeStores(DEVICE)

    const { adapter: adapterA, messaging: messagingA } = await makeAdapter(identity, broker, 'detps-am-restart-a', DEVICE, stores)
    ;(messagingA as unknown as { sendControlFrame: () => Promise<never> }).sendControlFrame = async () => {
      throw new Error('injected: control frame never reached the broker')
    }
    await adapterA.start()
    await adapterA.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).catch(() => {})
    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))
    expect(await stores.metadataStorage.loadSpaceMetadata(genesis.spaceId)).not.toBeNull()
    await adapterA.stop()

    // ── restart ──
    const { adapter: adapterB, messaging: messagingB } = await makeAdapter(identity, broker, 'detps-am-restart-b', DEVICE, stores)
    const registersB = countSpaceRegisters(messagingB)
    await adapterB.start()
    cleanup.push(async () => { await adapterB.stop() })
    await adapterB.restoreSpacesFromMetadata()

    const space = await adapterB.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(space.id).toBe(genesis.spaceId)
    expect(registersB()).toBeGreaterThan(0)
  }, 60_000)

  it('a flight that outlived stop() must not certify the new session', async () => {
    // Lifecycle contract (parity with Yjs).
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-lifecycle')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'a9999999-9999-4999-8999-999999999999'
    const { storage, saveCalls, release } = metadataGateThenFail()
    const { adapter } = await makeAdapter(identity, broker, 'detps-am-lifecycle', DEVICE, await makeStores(DEVICE, storage))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).catch(() => null)
    await waitUntil(() => saveCalls() >= 1, 'flight A to reach the gated metadata write')

    await adapter.stop()
    await adapter.start()

    await expect(adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)).rejects.toThrow(/second flight/)

    release()
    await flightA

    // ...and it must not have installed a coordinator built over its OWN space state
    // (from the shut-down repo) into the new session, nor flipped the fresh network
    // adapter to log-sync-managed on its behalf.
    expect(coordinatorsOf(adapter).size).toBe(0)

    await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(saveCalls()).toBeGreaterThan(2)
  }, 60_000)

  it('a flight parked in ensurePublished() must not seed the genesis log afterwards', async () => {
    // Parity with Yjs: the publication tail is a chain of awaits, and a flight parked
    // inside ensurePublished() across stop()/start() must not write the genesis log
    // from its own state — the next fresh retry would then skip its OWN correct seed.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-publish')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'c7777777-7777-4777-8777-777777777777'
    const { storage } = metadataFailingOnSecondSave()
    const stores = await makeStores(DEVICE, storage)
    const { adapter, messaging } = await makeAdapter(identity, broker, 'detps-am-publish', DEVICE, stores)
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))
    const gated = spaceRegisterGatedOnFirst(messaging)

    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: { m: { title: 'stale' } } }, PRIVATE_META).catch(() => null)
    await waitUntil(() => gated.registerCalls() >= 1, 'flight A to reach the gated space-register')

    await adapter.stop()
    await adapter.start()

    await expect(adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)).rejects.toThrow(/second flight/)

    gated.release()
    await flightA

    expect(Object.keys(await stores.docLogStore.getKnownHeads(genesis.spaceId))).toHaveLength(0)
  }, 60_000)

  it('a flight parked in the genesis derivation must not create in a later session', async () => {
    // Parity with Yjs (review round 5): the lease must be issued synchronously at
    // the public entry point, and the derivation itself must run under it.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-derive')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'c7777777-7777-4777-8777-777777777777'
    const gated = identityGatedOnFirstDerive(identity)
    const { adapter } = await makeAdapter(gated.identity, broker, 'detps-am-derive', DEVICE, await makeStores(DEVICE))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).then(() => null, (e: Error) => e)
    await waitUntil(() => gated.deriveCalls() >= 1, 'flight A to reach the genesis derivation')

    await adapter.stop()
    await adapter.start()

    gated.release()
    const outcome = await flightA
    expect(outcome).toBeInstanceOf(Error) // lifecycle changed while in flight
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(0)
  }, 60_000)

  it('a stale flight must not touch the coordinator or log observer of the fresh session', async () => {
    // Parity with the Yjs encryption-key repro: the await inside key provisioning
    // sits BEFORE session-wide state (coordinator, log observer).
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-netreg')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'b8888888-8888-4888-8888-888888888888'
    const stores = await makeStores(DEVICE)
    const gated = keyManagementGatedOnFirstSave(stores.keyManagement)
    const { adapter } = await makeAdapter(identity, broker, 'detps-am-netreg', DEVICE, stores)
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).catch(() => null)
    await waitUntil(() => gated.saveKeyCalls() >= 1, 'flight A to reach the gated key write')

    await adapter.stop()
    await adapter.start()

    const fresh = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    const freshCoordinator = coordinatorsOf(adapter).get(fresh.id)
    expect(freshCoordinator).toBeDefined() // the fresh session owns the coordinator
    const freshListeners = logChangeListeners(adapter, fresh.id)

    gated.release()
    await flightA // the stale flight runs out

    // It must NOT have replaced/added a coordinator built over its own shut-down
    // state, nor re-attached its log observer to the fresh session's doc handle.
    expect(coordinatorsOf(adapter).get(fresh.id)).toBe(freshCoordinator)
    expect(coordinatorsOf(adapter).size).toBe(1)
    expect(logChangeListeners(adapter, fresh.id)).toBe(freshListeners)
  }, 60_000)

  it('concurrent open-or-create calls share one flight and yield one space', async () => {
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-am-concurrent')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const { adapter } = await makeAdapter(identity, broker, 'detps-am-concurrent', 'c1111111-1111-4111-8111-111111111111')
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const results = await Promise.all([
      adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META),
      adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META),
      adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META),
    ])
    expect(new Set(results.map((r) => r.id)).size).toBe(1)
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(1)
  })

  it('two devices of the same identity derive the same private space; register is idempotent (no conflict)', async () => {
    const broker = new InProcessLogBroker()
    const created = await createTestIdentity('detps-am-multi')
    const a = created.identity
    const b = await recoverTestIdentity(created.mnemonic, 'detps-am-multi')
    cleanup.push(async () => { await a.deleteStoredIdentity() })
    cleanup.push(async () => { await b.deleteStoredIdentity() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => a.deriveFrameworkKey(info, length))

    const { adapter: adapterA } = await makeAdapter(a, broker, 'detps-am-a', 'a1111111-1111-4111-8111-111111111111')
    await adapterA.start(); cleanup.push(async () => { await adapterA.stop() })
    const { adapter: adapterB } = await makeAdapter(b, broker, 'detps-am-b', 'b2222222-2222-4222-8222-222222222222')
    await adapterB.start(); cleanup.push(async () => { await adapterB.stop() })

    const sa = await adapterA.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    const sb = await adapterB.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)

    expect(sa.id).toBe(genesis.spaceId)
    expect(sb.id).toBe(genesis.spaceId)
    expect((await adapterA.getSpace(genesis.spaceId))?.id).toBe(genesis.spaceId)
    expect((await adapterB.getSpace(genesis.spaceId))?.id).toBe(genesis.spaceId)
  })
})
