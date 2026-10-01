import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity, recoverTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemoryCompactStore,
  InMemoryDocLogStore,
  InMemoryKeyManagementAdapter,
  InProcessLogBroker,
  PersonalDocSpaceMetadataStorage,
} from '@web_of_trust/core/adapters'
import { derivePrivateSpaceGenesis, SPACE_REGISTER_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

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

function metadataInPersonalDoc(doc: Y.Doc): PersonalDocSpaceMetadataStorage {
  const roots = ['spaces', 'groupKeys', 'capabilitySigningSeeds']
  const read = () => Object.fromEntries(roots.map((root) => [root, doc.getMap(root).toJSON()]))
  const write = (state: Record<string, Record<string, unknown>>) => {
    doc.transact(() => {
      for (const root of roots) {
        const map = doc.getMap(root)
        map.clear()
        for (const [key, value] of Object.entries(state[root] ?? {})) map.set(key, value)
      }
    }, 'local')
  }
  return new PersonalDocSpaceMetadataStorage({
    getPersonalDoc: read,
    changePersonalDoc: (change) => { const s = read(); change(s); write(s) },
  })
}

async function makeDocLogStore(deviceId: string): Promise<InMemoryDocLogStore> {
  const store = new InMemoryDocLogStore()
  await store.init()
  await store.setDeviceId(deviceId)
  return store
}

/** The durable stores that survive a process restart (same device, same disk). */
interface DurableStores {
  metadataStorage: PersonalDocSpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
  compactStore: InMemoryCompactStore
  docLogStore: InMemoryDocLogStore
}

async function makeStores(deviceId: string, metadataStorage?: PersonalDocSpaceMetadataStorage): Promise<DurableStores> {
  return {
    metadataStorage: metadataStorage ?? metadataInPersonalDoc(new Y.Doc()),
    keyManagement: new InMemoryKeyManagementAdapter(),
    compactStore: new InMemoryCompactStore(),
    docLogStore: await makeDocLogStore(deviceId),
  }
}

async function makeAdapter(identity: PublicIdentitySession, broker: InProcessLogBroker, socketId: string, deviceId: string, stores?: DurableStores): Promise<{ adapter: YjsReplicationAdapter; messaging: InMemoryMessagingAdapter }> {
  const messaging = new InMemoryMessagingAdapter({ broker, socketId })
  await messaging.connect(identity.getDid())
  const durable = stores ?? await makeStores(deviceId)
  const adapter = new YjsReplicationAdapter({
    identity, messaging, brokerUrls: BROKER_URLS,
    metadataStorage: durable.metadataStorage,
    keyManagement: durable.keyManagement,
    compactStore: durable.compactStore,
    docLogStore: durable.docLogStore, deviceId,
  })
  return { adapter, messaging }
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

/** The adapter's live coordinator map — session-wide state a stale flight must not touch. */
function coordinatorsOf(adapter: YjsReplicationAdapter): Map<string, unknown> {
  return (adapter as unknown as { coordinators: Map<string, unknown> }).coordinators
}

/**
 * Gates the FIRST getEncryptionPublicKeyBytes() call — the await boundary that sits
 * between the epoch check and the `spaces.set()` mutation. Later calls pass through
 * so the new session can create the space while flight A is still parked.
 */
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

function identityGatedOnFirstEncKey(identity: PublicIdentitySession): { identity: PublicIdentitySession; encCalls: () => number; release: () => void } {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const proxied = new Proxy(identity as object, {
    get(target, prop) {
      if (prop === 'getEncryptionPublicKeyBytes') {
        return async () => {
          calls += 1
          if (calls === 1) await gate
          return (target as PublicIdentitySession).getEncryptionPublicKeyBytes()
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PublicIdentitySession
  return { identity: proxied, encCalls: () => calls, release: () => release() }
}

/**
 * Scripted durability boundary for the lifecycle repro: call 1 blocks on a gate
 * (the flight that will outlive its session), call 2 throws (the new session's
 * flight fails), call 3+ succeeds.
 */
function metadataGateThenFail(doc: Y.Doc): { storage: PersonalDocSpaceMetadataStorage; saveCalls: () => number; release: () => void } {
  const storage = metadataInPersonalDoc(doc)
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
function metadataFailingOnSecondSave(doc: Y.Doc): { storage: PersonalDocSpaceMetadataStorage; saveCalls: () => number } {
  const storage = metadataInPersonalDoc(doc)
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
function metadataFailingOnce(doc: Y.Doc): { storage: PersonalDocSpaceMetadataStorage; saveCalls: () => number } {
  const storage = metadataInPersonalDoc(doc)
  const realSave = storage.saveSpaceMetadata.bind(storage)
  let calls = 0
  storage.saveSpaceMetadata = async (meta) => {
    calls += 1
    if (calls === 1) throw new Error('injected durability failure: saveSpaceMetadata')
    return realSave(meta)
  }
  return { storage, saveCalls: () => calls }
}

describe('Deterministic private space (Sync 001) — Yjs adapter contract', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
  })

  it('openOrCreate returns the derived genesis id and is idempotent on the same device', async () => {
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-single')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const { adapter } = await makeAdapter(identity, broker, 'detps-single', 'd1111111-1111-4111-8111-111111111111')
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))

    const first = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(first.id).toBe(genesis.spaceId)
    expect(first.appTag).toBe('rls-private')

    const second = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(second.id).toBe(genesis.spaceId) // idempotent: same space, no duplicate
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(1)
  })

  it('resumes the missing phases after a failed create instead of reporting success', async () => {
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-fault')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const { storage, saveCalls } = metadataFailingOnce(new Y.Doc())
    const { adapter } = await makeAdapter(identity, broker, 'detps-fault', 'f1111111-1111-4111-8111-111111111111', await makeStores('f1111111-1111-4111-8111-111111111111', storage))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))

    // First attempt fails AT the durability boundary — after the space entered
    // this.spaces, before its metadata was persisted.
    await expect(adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)).rejects.toThrow(/injected durability failure/)
    expect(await storage.loadSpaceMetadata(genesis.spaceId)).toBeNull()

    // The retry must RESUME the missing phase, not early-return the half state.
    const space = await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(space.id).toBe(genesis.spaceId)
    expect(saveCalls()).toBeGreaterThan(1)
    expect(await storage.loadSpaceMetadata(genesis.spaceId)).not.toBeNull()
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(1)
  })

  it('publishes on a fresh instance when a previous process died before space-register', async () => {
    // Restart contract: completion must NOT be a RAM claim. Instance A persists
    // metadata but its publication never reaches the broker; the process dies.
    // Instance B (same durable stores, fresh RAM) restores the space and MUST
    // still register it instead of reporting a complete private space.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-restart')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'e1111111-1111-4111-8111-111111111111'
    const stores = await makeStores(DEVICE)

    const { adapter: adapterA, messaging: messagingA } = await makeAdapter(identity, broker, 'detps-restart-a', DEVICE, stores)
    // Publication of instance A fails (broker unreachable for control frames).
    ;(messagingA as unknown as { sendControlFrame: () => Promise<never> }).sendControlFrame = async () => {
      throw new Error('injected: control frame never reached the broker')
    }
    await adapterA.start()
    await adapterA.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).catch(() => {})
    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))
    // Metadata IS durable, so the restart sees the space — but it was never registered.
    expect(await stores.metadataStorage.loadSpaceMetadata(genesis.spaceId)).not.toBeNull()
    await adapterA.stop()

    // ── restart ──
    const { adapter: adapterB, messaging: messagingB } = await makeAdapter(identity, broker, 'detps-restart-b', DEVICE, stores)
    const registersB = countSpaceRegisters(messagingB)
    await adapterB.start()
    cleanup.push(async () => { await adapterB.stop() })
    await adapterB.restoreSpacesFromMetadata()

    const space = await adapterB.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(space.id).toBe(genesis.spaceId)
    // The contract: after open-or-create returns, the space IS registered.
    expect(registersB()).toBeGreaterThan(0)
  }, 60_000)

  it('a flight that outlived stop() must not certify the new session', async () => {
    // Lifecycle contract: flight A hangs before its metadata write, the adapter is
    // stopped and started, flight B fails at the same boundary, then A runs out.
    // A must NOT mark the space provisioned — otherwise the next call early-returns
    // and B's failed state is never resumed.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-lifecycle')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'a9999999-9999-4999-8999-999999999999'
    const { storage, saveCalls, release } = metadataGateThenFail(new Y.Doc())
    const { adapter } = await makeAdapter(identity, broker, 'detps-lifecycle', DEVICE, await makeStores(DEVICE, storage))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).catch(() => null)
    await waitUntil(() => saveCalls() >= 1, 'flight A to reach the gated metadata write')

    await adapter.stop()
    await adapter.start()

    // B fails at the same durability boundary in the NEW session.
    await expect(adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)).rejects.toThrow(/second flight/)

    release()
    await flightA // the stale flight runs out; it must not certify anything

    // ...and it must not have installed a coordinator built over its OWN (destroyed)
    // doc into the new session: the next open-or-create would find it by spaceId and
    // never re-bind it, leaving the log hooks writing against the dead state.
    expect(coordinatorsOf(adapter).size).toBe(0)

    // The next call must RESUME B's failed state (a third metadata write).
    await adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    expect(saveCalls()).toBeGreaterThan(2)
  }, 60_000)

  it('a flight parked in ensurePublished() must not seed the genesis log afterwards', async () => {
    // The publication tail is a chain of awaits — ensurePublished(), spaceLogIsEmpty(),
    // the seed write, the vault push — and every one of them is a lifecycle boundary.
    // A flight parked inside ensurePublished() across stop()/start() must not write the
    // genesis log from its own state: the next fresh retry would no longer see empty
    // heads and would skip its OWN correct seed, making the stale content durable.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-publish')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'c7777777-7777-4777-8777-777777777777'
    const { storage } = metadataFailingOnSecondSave(new Y.Doc())
    const stores = await makeStores(DEVICE, storage)
    const { adapter, messaging } = await makeAdapter(identity, broker, 'detps-publish', DEVICE, stores)
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))
    const gated = spaceRegisterGatedOnFirst(messaging)

    // Flight A parks INSIDE ensurePublished() — its metadata write already happened.
    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: { m: { title: 'stale' } } }, PRIVATE_META).catch(() => null)
    await waitUntil(() => gated.registerCalls() >= 1, 'flight A to reach the gated space-register')

    await adapter.stop()
    await adapter.start()

    // The new session's flight fails at its metadata write, so there is NO fresh
    // genesis seed yet — the log heads are the uncontested proof of who wrote.
    await expect(adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)).rejects.toThrow(/second flight/)

    gated.release()
    await flightA // the stale flight runs out

    expect(Object.keys(await stores.docLogStore.getKnownHeads(genesis.spaceId))).toHaveLength(0)
  }, 60_000)

  it('a flight parked in the genesis derivation must not create in a later session', async () => {
    // Review round 5: the lease used to be opened inside createSpaceWithId — one
    // await too late. A flight parked in derivePrivateSpaceGenesis() survived
    // stop()/start(), then issued itself a lease of the NEW session and actually
    // created the stale private space there (1 space instead of 0).
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-derive')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'c7777777-7777-4777-8777-777777777777'
    const gated = identityGatedOnFirstDerive(identity)
    const { adapter } = await makeAdapter(gated.identity, broker, 'detps-derive', DEVICE, await makeStores(DEVICE))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META).then(() => null, (e: Error) => e)
    await waitUntil(() => gated.deriveCalls() >= 1, 'flight A to reach the genesis derivation')

    await adapter.stop()
    await adapter.start()

    // The new session does nothing — the stale flight alone must not create.
    gated.release()
    const outcome = await flightA
    expect(outcome).toBeInstanceOf(Error) // lifecycle changed while in flight
    expect((await adapter.getSpaces()).filter((s) => s.appTag === 'rls-private')).toHaveLength(0)
  }, 60_000)

  it('a stale flight must not overwrite the fresh session at the encryption-key await', async () => {
    // The epoch check sits before `spaces.set()`, but `getEncryptionPublicKeyBytes()`
    // awaits in between. A flight parked there across stop()/start() must NOT install
    // its own doc over the one the new session just created.
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-enckey')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const DEVICE = 'b8888888-8888-4888-8888-888888888888'
    const gated = identityGatedOnFirstEncKey(identity)
    const { adapter } = await makeAdapter(gated.identity, broker, 'detps-enckey', DEVICE, await makeStores(DEVICE))
    await adapter.start()
    cleanup.push(async () => { await adapter.stop() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => identity.deriveFrameworkKey(info, length))

    // Flight A parks at the encryption-key await with its OWN doc content.
    const flightA = adapter.openOrCreateDeterministicPrivateSpace({ items: { m: { title: 'stale' } } }, PRIVATE_META).catch(() => null)
    await waitUntil(() => gated.encCalls() >= 1, 'flight A to reach the encryption-key await')

    await adapter.stop()
    await adapter.start()

    // The NEW session creates the space with fresh content (gate is open for call 2+).
    await adapter.openOrCreateDeterministicPrivateSpace({ items: { m: { title: 'fresh' } } }, PRIVATE_META)
    const freshCoordinator = coordinatorsOf(adapter).get(genesis.spaceId)
    expect(freshCoordinator).toBeDefined() // the fresh session owns the coordinator

    gated.release()
    await flightA // stale flight runs out — it must not install anything

    // Neither a replacement nor an addition: the coordinator stays the fresh session's,
    // so the log hooks keep pointing at the live doc.
    expect(coordinatorsOf(adapter).get(genesis.spaceId)).toBe(freshCoordinator)
    expect(coordinatorsOf(adapter).size).toBe(1)

    const handle = await adapter.openSpace<{ items: Record<string, { title: string }> }>(genesis.spaceId)
    cleanup.push(async () => { handle.close() })
    expect(handle.getDoc().items?.m?.title).toBe('fresh')
  }, 60_000)

  it('concurrent open-or-create calls share one flight and yield one space', async () => {
    const broker = new InProcessLogBroker()
    const { identity } = await createTestIdentity('detps-concurrent')
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const { adapter } = await makeAdapter(identity, broker, 'detps-concurrent', 'c1111111-1111-4111-8111-111111111111')
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
    const created = await createTestIdentity('detps-multi')
    const a = created.identity
    const b = await recoverTestIdentity(created.mnemonic, 'detps-multi') // same seed → same derivation
    cleanup.push(async () => { await a.deleteStoredIdentity() })
    cleanup.push(async () => { await b.deleteStoredIdentity() })

    const genesis = await derivePrivateSpaceGenesis((info, length) => a.deriveFrameworkKey(info, length))

    const { adapter: adapterA } = await makeAdapter(a, broker, 'detps-a', 'a1111111-1111-4111-8111-111111111111')
    await adapterA.start(); cleanup.push(async () => { await adapterA.stop() })
    const { adapter: adapterB } = await makeAdapter(b, broker, 'detps-b', 'b2222222-2222-4222-8222-222222222222')
    await adapterB.start(); cleanup.push(async () => { await adapterB.stop() })

    const sa = await adapterA.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)
    // Device B derives the SAME id and registers the SAME verification key → the
    // broker's first-writer-wins space-register is idempotent, not a conflict.
    const sb = await adapterB.openOrCreateDeterministicPrivateSpace({ items: {} }, PRIVATE_META)

    expect(sa.id).toBe(genesis.spaceId)
    expect(sb.id).toBe(genesis.spaceId)
    expect((await adapterA.getSpace(genesis.spaceId))?.id).toBe(genesis.spaceId)
    expect((await adapterB.getSpace(genesis.spaceId))?.id).toBe(genesis.spaceId)
  })
})
