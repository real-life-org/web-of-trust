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
import { personalDocIdFromKey, LOG_ENTRY_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import { YjsPersonalLogSyncAdapter } from '../src/YjsPersonalLogSyncAdapter'

const BROKER_URLS = ['wss://broker.example.com']
const A1_DEVICE = 'a1111111-1111-4111-8111-111111111111'
const A2_DEVICE = 'a2222222-2222-4222-8222-222222222222'
const PERSONAL_A1_DEVICE = 'c1111111-1111-4111-8111-111111111111'
const PERSONAL_A2_DEVICE = 'd2222222-2222-4222-8222-222222222222'

interface TestDoc { items: Record<string, { title: string }> }

const wait = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await wait()
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/**
 * A tiny test-only PersonalDoc facade: the production metadata port is backed by
 * a Personal CRDT doc, and this facade gives that port a real Y.Doc whose updates
 * travel through YjsPersonalLogSyncAdapter.  Each device gets its own Y.Doc.
 */
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
    changePersonalDoc: (change) => {
      const state = read()
      change(state)
      write(state)
    },
  })
}

async function makeDocLogStore(deviceId: string): Promise<InMemoryDocLogStore> {
  const store = new InMemoryDocLogStore()
  await store.init()
  await store.setDeviceId(deviceId)
  return store
}

async function makeSpaceAdapter(
  identity: PublicIdentitySession,
  messaging: InMemoryMessagingAdapter,
  metadataStorage: PersonalDocSpaceMetadataStorage,
  keyManagement: InMemoryKeyManagementAdapter,
  compactStore: InMemoryCompactStore,
  deviceId: string,
): Promise<YjsReplicationAdapter> {
  return new YjsReplicationAdapter({
    identity, messaging, brokerUrls: BROKER_URLS, metadataStorage, keyManagement, compactStore,
    docLogStore: await makeDocLogStore(deviceId), enableLogSync: true, deviceId,
  })
}

describe('Seed-recovery contract — seed + relay log + PersonalDoc keys', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
  })

  it('recovers every pre- and post-rotation item from the relay log without reconnecting', async () => {
    InMemoryMessagingAdapter.resetAll()
    const broker = new InProcessLogBroker()
    const created = await createTestIdentity('seed-recovery-contract')
    const a1 = created.identity
    const a2 = await recoverTestIdentity(created.mnemonic, 'seed-recovery-contract')
    const b = (await createTestIdentity('seed-recovery-b')).identity
    const removedThirdMember = (await createTestIdentity('seed-recovery-c')).identity
    cleanup.push(async () => { await a1.deleteStoredIdentity() })
    cleanup.push(async () => { await a2.deleteStoredIdentity() })
    cleanup.push(async () => { await b.deleteStoredIdentity() })
    cleanup.push(async () => { await removedThirdMember.deleteStoredIdentity() })

    const a1Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'seed-a1' })
    await a1Messaging.connect(a1.getDid())
    const personalA1Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'seed-personal-a1' })
    await personalA1Messaging.connect(a1.getDid())
    const personalA1Doc = new Y.Doc()
    const metaA1 = metadataInPersonalDoc(personalA1Doc)
    const personalKey = await a1.deriveFrameworkKey('personal-doc-v1')
    const personalDocId = personalDocIdFromKey(personalKey)
    const personalA1 = new YjsPersonalLogSyncAdapter({
      doc: personalA1Doc, messaging: personalA1Messaging, identity: a1, personalKey, docId: personalDocId,
      docLogStore: await makeDocLogStore(PERSONAL_A1_DEVICE), deviceId: PERSONAL_A1_DEVICE,
    })
    personalA1.start()
    cleanup.push(async () => { personalA1.destroy(); personalA1Doc.destroy(); await personalA1Messaging.disconnect() })

    const kmA1 = new InMemoryKeyManagementAdapter()
    const a1Adapter = await makeSpaceAdapter(a1, a1Messaging, metaA1, kmA1, new InMemoryCompactStore(), A1_DEVICE)
    await a1Adapter.start()
    cleanup.push(async () => { await a1Adapter.stop(); await a1Messaging.disconnect() })

    const space = await a1Adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Recovery contract' })
    await a1Adapter.addMember(space.id, b.getDid(), await b.getEncryptionPublicKeyBytes())
    await a1Adapter.addMember(space.id, removedThirdMember.getDid(), await removedThirdMember.getEncryptionPublicKeyBytes())
    const a1Handle = await a1Adapter.openSpace<TestDoc>(space.id)
    const expected = new Map<string, number>()
    for (let i = 0; i < 3; i++) {
      const id = `gen0-${i}`
      expected.set(id, 0)
      a1Handle.transact((doc) => { doc.items[id] = { title: id } })
      await waitUntil(() => brokerEntryCount(broker, space.id) >= i + 2, `gen0 broker entry ${i}`)
    }

    // Removing C rotates gen 0 -> gen 1 while A and B remain members.
    await a1Adapter.removeMember(space.id, removedThirdMember.getDid())
    await waitUntil(async () => (await kmA1.getKeyByGeneration(space.id, 1)) !== null, 'generation 1 key')
    for (let i = 0; i < 3; i++) {
      const id = `gen1-${i}`
      expected.set(id, 1)
      a1Handle.transact((doc) => { doc.items[id] = { title: id } })
      await waitUntil(() => brokerEntryCount(broker, space.id) >= i + 5, `gen1 broker entry ${i}`)
    }

    // Prerequisite of recovery: the PersonalDoc contains both content-key generations,
    // both current-generation signing seeds, and the discoverable space metadata.
    await waitUntil(async () => (await metaA1.loadGroupKeys(space.id)).length === 2, 'PersonalDoc group keys')
    expect((await metaA1.loadGroupKeys(space.id)).map((key) => key.generation).sort()).toEqual([0, 1])
    expect((await metaA1.loadCapabilitySigningSeeds(space.id)).map((seed) => seed.generation).sort()).toEqual([0, 1])
    expect((await metaA1.loadAllSpaceMetadata()).map((meta) => meta.info.id)).toContain(space.id)

    // Fresh recovery device: no key, compact, log, or PersonalDoc state is reused.
    const a2Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'seed-a2' })
    const personalA2Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'seed-personal-a2' })
    await a2Messaging.connect(a2.getDid())
    await personalA2Messaging.connect(a2.getDid())
    // The broker socket is the relay-side delivery boundary. Count log entries
    // before adapter.start(), including its automatic initial catch-up.
    let receivedLogEntries = 0
    const a2Socket = (broker as unknown as { sockets: Map<string, { deliver: (message: { type?: string }) => Promise<void> }> }).sockets.get('seed-a2')!
    const deliverA2 = a2Socket.deliver.bind(a2Socket)
    a2Socket.deliver = async (message) => {
      if (message.type === LOG_ENTRY_MESSAGE_TYPE) receivedLogEntries++
      await deliverA2(message)
    }
    const personalA2Doc = new Y.Doc()
    const metaA2 = metadataInPersonalDoc(personalA2Doc)
    const personalA2 = new YjsPersonalLogSyncAdapter({
      doc: personalA2Doc, messaging: personalA2Messaging, identity: a2, personalKey: await a2.deriveFrameworkKey('personal-doc-v1'), docId: personalDocId,
      docLogStore: await makeDocLogStore(PERSONAL_A2_DEVICE), deviceId: PERSONAL_A2_DEVICE,
    })
    personalA2.start()
    cleanup.push(async () => { personalA2.destroy(); personalA2Doc.destroy(); await personalA2Messaging.disconnect() })

    await waitUntil(async () => (await metaA2.loadGroupKeys(space.id)).length === 2, 'A2 PersonalDoc log catch-up')
    const kmA2 = new InMemoryKeyManagementAdapter()
    const a2Adapter = await makeSpaceAdapter(a2, a2Messaging, metaA2, kmA2, new InMemoryCompactStore(), A2_DEVICE)
    await a2Adapter.start()
    cleanup.push(async () => { await a2Adapter.stop(); await a2Messaging.disconnect() })

    let a2Handle = await a2Adapter.openSpace<TestDoc>(space.id)
    const internals = a2Adapter as unknown as {
      spaces: Map<string, unknown>
      getOrCreateCoordinator(state: unknown): Promise<{ blockedByKeyCount: () => number }>
    }
    const coordinator = await internals.getOrCreateCoordinator(internals.spaces.get(space.id)!)
    await a2Adapter.requestSync(space.id) // explicit Space catch-up; no reconnect event follows.

    // Grosszuegige Deadline: unter Voll-Suite-CPU-Last ist der Recovery-Catch-up
    // langsamer; ein knappes Fenster flaket (isoliert immer gruen).
    const deadline = Date.now() + 15_000
    // Vor dem Catch-up hat der recoverte Doc noch kein items-Root; die Warte-
    // bedingung darf daran NICHT werfen (`Object.keys(undefined)`), sondern muss
    // weiter pollen. Unter Voll-Suite-Last trat der Doc sonst als TypeError auf.
    while (Date.now() < deadline && expected.size !== Object.keys(a2Handle.getDoc().items ?? {}).length) await wait()
    const actual = a2Handle.getDoc().items ?? {}
    const missing = await Promise.all([...expected].filter(([id]) => !actual[id]).map(async ([id, generation]) =>
      `${id}(gen=${generation}, key=${(await kmA2.getKeyByGeneration(space.id, generation)) ? 'present' : 'missing'})`,
    ))
    const diagnosis = `brokerEntries=${brokerEntryCount(broker, space.id)} receiveLogEntry=${receivedLogEntries} blockedByKey=${coordinator.blockedByKeyCount()} missing=[${missing.join(', ')}]`

    expect((await a2Adapter.getSpaces()).map((s) => s.id), diagnosis).toContain(space.id)
    expect(Object.keys(actual).sort(), diagnosis).toEqual([...expected.keys()].sort())
    expect((await a2Adapter.getSpace(space.id))!.members.sort(), diagnosis).toEqual([a1.getDid(), b.getDid()].sort())

    a1Handle.close()
    a2Handle.close()
  })

  it('catches up a space restored from PersonalDoc after the adapter is already connected', async () => {
    InMemoryMessagingAdapter.resetAll()
    const broker = new InProcessLogBroker()
    const created = await createTestIdentity('late-space-recovery')
    const a1 = created.identity
    const a2 = await recoverTestIdentity(created.mnemonic, 'late-space-recovery')
    cleanup.push(async () => { await a1.deleteStoredIdentity() })
    cleanup.push(async () => { await a2.deleteStoredIdentity() })

    const a1Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'late-space-a1' })
    await a1Messaging.connect(a1.getDid())
    const personalA1Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'late-space-personal-a1' })
    await personalA1Messaging.connect(a1.getDid())
    const personalA1Doc = new Y.Doc()
    const metaA1 = metadataInPersonalDoc(personalA1Doc)
    const personalKey = await a1.deriveFrameworkKey('personal-doc-v1')
    const personalDocId = personalDocIdFromKey(personalKey)
    const personalA1 = new YjsPersonalLogSyncAdapter({
      doc: personalA1Doc, messaging: personalA1Messaging, identity: a1, personalKey, docId: personalDocId,
      docLogStore: await makeDocLogStore(PERSONAL_A1_DEVICE), deviceId: PERSONAL_A1_DEVICE,
    })
    personalA1.start()
    cleanup.push(async () => { personalA1.destroy(); personalA1Doc.destroy(); await personalA1Messaging.disconnect() })

    const a1Adapter = await makeSpaceAdapter(a1, a1Messaging, metaA1, new InMemoryKeyManagementAdapter(), new InMemoryCompactStore(), A1_DEVICE)
    await a1Adapter.start()
    cleanup.push(async () => { await a1Adapter.stop(); await a1Messaging.disconnect() })

    const space = await a1Adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Late metadata recovery' })
    const a1Handle = await a1Adapter.openSpace<TestDoc>(space.id)
    const expected = ['late-0', 'late-1', 'late-2']
    for (const id of expected) {
      a1Handle.transact((doc) => { doc.items[id] = { title: id } })
      await waitUntil(() => brokerEntryCount(broker, space.id) >= expected.indexOf(id) + 2, `broker entry ${id}`)
    }
    await waitUntil(async () => (await metaA1.loadGroupKeys(space.id)).length > 0, 'A1 PersonalDoc group key')
    // The source device is now offline. This keeps the content exclusively in
    // the relay log: no direct legacy full-state response may satisfy recovery.
    await a1Messaging.disconnect()

    // Start the recovered space adapter on an already-connected broker socket while
    // its PersonalDoc is still empty. Its initial catch-up therefore sees zero spaces.
    const a2Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'late-space-a2' })
    await a2Messaging.connect(a2.getDid())
    const personalA2Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'late-space-personal-a2' })
    await personalA2Messaging.connect(a2.getDid())
    const personalA2Doc = new Y.Doc()
    const metaA2 = metadataInPersonalDoc(personalA2Doc)
    const a2Adapter = await makeSpaceAdapter(a2, a2Messaging, metaA2, new InMemoryKeyManagementAdapter(), new InMemoryCompactStore(), A2_DEVICE)
    await a2Adapter.start()
    cleanup.push(async () => { await a2Adapter.stop(); await a2Messaging.disconnect() })
    expect(await a2Adapter.getSpaces()).toEqual([])

    // This is the RLS connector's path: PersonalDoc sync makes metadata and keys
    // visible only after start(), then it asks the adapter to restore them. Do not
    // manually requestSync(space.id): the restore itself must start relay-log catch-up.
    const personalA2 = new YjsPersonalLogSyncAdapter({
      doc: personalA2Doc, messaging: personalA2Messaging, identity: a2,
      personalKey: await a2.deriveFrameworkKey('personal-doc-v1'), docId: personalDocId,
      docLogStore: await makeDocLogStore(PERSONAL_A2_DEVICE), deviceId: PERSONAL_A2_DEVICE,
    })
    personalA2.start()
    cleanup.push(async () => { personalA2.destroy(); personalA2Doc.destroy(); await personalA2Messaging.disconnect() })
    await waitUntil(async () => (await metaA2.loadGroupKeys(space.id)).length > 0, 'A2 PersonalDoc metadata catch-up')
    await a2Adapter.restoreSpacesFromMetadata()

    const a2Handle = await a2Adapter.openSpace<TestDoc>(space.id)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && expected.length !== Object.keys(a2Handle.getDoc().items ?? {}).length) await wait()
    expect(Object.keys(a2Handle.getDoc().items ?? {}).sort()).toEqual(expected)

    a1Handle.close()
    a2Handle.close()
  }, 40_000)

  it('catches up an already-loaded keyless space when PersonalDoc restore makes its key available', async () => {
    const broker = new InProcessLogBroker()
    const created = await createTestIdentity('loaded-keyless-handoff')
    const a1 = created.identity
    const a2 = await recoverTestIdentity(created.mnemonic, 'loaded-keyless-handoff')
    cleanup.push(async () => { await a1.deleteStoredIdentity() })
    cleanup.push(async () => { await a2.deleteStoredIdentity() })

    const a1Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'handoff-a1' })
    await a1Messaging.connect(a1.getDid())
    const personalA1Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'handoff-personal-a1' })
    await personalA1Messaging.connect(a1.getDid())
    const personalA1Doc = new Y.Doc()
    const metaA1 = metadataInPersonalDoc(personalA1Doc)
    const personalKey = await a1.deriveFrameworkKey('personal-doc-v1')
    const personalDocId = personalDocIdFromKey(personalKey)
    const personalA1 = new YjsPersonalLogSyncAdapter({
      doc: personalA1Doc, messaging: personalA1Messaging, identity: a1, personalKey, docId: personalDocId,
      docLogStore: await makeDocLogStore(PERSONAL_A1_DEVICE), deviceId: PERSONAL_A1_DEVICE,
    })
    personalA1.start()
    cleanup.push(async () => { personalA1.destroy(); personalA1Doc.destroy(); await personalA1Messaging.disconnect() })

    const a1Adapter = await makeSpaceAdapter(a1, a1Messaging, metaA1, new InMemoryKeyManagementAdapter(), new InMemoryCompactStore(), A1_DEVICE)
    await a1Adapter.start()
    cleanup.push(async () => { await a1Adapter.stop(); await a1Messaging.disconnect() })
    const space = await a1Adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Loaded keyless handoff' })
    const a1Handle = await a1Adapter.openSpace<TestDoc>(space.id)
    a1Handle.transact((doc) => { doc.items['relay-only'] = { title: 'from the relay' } })
    await waitUntil(() => brokerEntryCount(broker, space.id) >= 2, 'source relay entries')
    await waitUntil(async () => (await metaA1.loadCapabilitySigningSeeds(space.id)).length > 0, 'source capability seed')
    await a1Messaging.disconnect()

    // Model the adversarial handoff: metadata arrives first, so the connected
    // adapter restores and starts a keyless catch-up. Keys arrive in a later
    // PersonalDoc restore while the space is already loaded.
    const personalA2Doc = new Y.Doc()
    const metaA2 = metadataInPersonalDoc(personalA2Doc)
    await metaA1.loadSpaceMetadata(space.id).then((meta) => metaA2.saveSpaceMetadata(meta!))
    const a2Messaging = new InMemoryMessagingAdapter({ broker, socketId: 'handoff-a2' })
    await a2Messaging.connect(a2.getDid())
    const a2Adapter = await makeSpaceAdapter(a2, a2Messaging, metaA2, new InMemoryKeyManagementAdapter(), new InMemoryCompactStore(), A2_DEVICE)
    await a2Adapter.start()
    cleanup.push(async () => { await a2Adapter.stop(); await a2Messaging.disconnect() })
    expect((await a2Adapter.getSpaces()).map((candidate) => candidate.id)).toContain(space.id)

    for (const key of await metaA1.loadGroupKeys(space.id)) await metaA2.saveGroupKey(key)
    for (const seed of await metaA1.loadCapabilitySigningSeeds(space.id)) await metaA2.saveCapabilitySigningSeed(seed)
    await a2Adapter.restoreSpacesFromMetadata()

    const a2Handle = await a2Adapter.openSpace<TestDoc>(space.id)
    await waitUntil(() => a2Handle.getDoc().items?.['relay-only']?.title === 'from the relay', 'key-handoff relay catch-up')
    a1Handle.close()
    a2Handle.close()
  }, 20_000)

  it('does not let a pre-stop space catch-up mutate the restarted session batch', async () => {
    const created = await createTestIdentity('space-catch-up-epoch')
    const identity = created.identity
    cleanup.push(async () => { await identity.deleteStoredIdentity() })
    const messaging = new InMemoryMessagingAdapter({ socketId: 'space-catch-up-epoch' })
    await messaging.connect(identity.getDid())
    const adapter = new YjsReplicationAdapter({ identity, messaging })
    cleanup.push(async () => { await adapter.stop(); await messaging.disconnect() })
    await adapter.start()

    const internals = adapter as unknown as {
      spaces: Map<string, any>
      pendingSpaceCatchUpBatches: number
      spaceCatchUpsInFlight: Set<string>
      requestSync: (spaceId: string) => Promise<void>
      requestCatchUpForSpaces: (spaceIds: Iterable<string>) => void
    }
    const spaceId = 'epoch-space'
    const addLoadedSpace = () => internals.spaces.set(spaceId, {
      info: { id: spaceId, type: 'shared', members: [], createdAt: new Date().toISOString() },
      doc: new Y.Doc(), handles: new Set(), memberEncryptionKeys: new Map(), unsubUpdate: null,
      unobservedRemoteUpdateRevision: 0,
    })
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldRequest = new Promise<void>((resolve) => { releaseOld = resolve })
    const newRequest = new Promise<void>((resolve) => { releaseNew = resolve })
    let requests = 0
    internals.requestSync = async () => {
      const request = requests++ === 0 ? oldRequest : newRequest
      await request
      const state = internals.spaces.get(spaceId)
      if (state) state.unobservedRemoteUpdateRevision += 1
    }

    addLoadedSpace()
    internals.requestCatchUpForSpaces([spaceId])
    await waitUntil(() => internals.pendingSpaceCatchUpBatches === 1, 'old catch-up batch')
    await adapter.stop()
    await adapter.start()
    addLoadedSpace()
    internals.requestCatchUpForSpaces([spaceId])
    await waitUntil(() => internals.pendingSpaceCatchUpBatches === 1 && requests === 2, 'new catch-up batch')

    releaseOld()
    await wait()
    expect(internals.pendingSpaceCatchUpBatches).toBe(1)
    expect(internals.spaceCatchUpsInFlight.has(spaceId)).toBe(true)

    releaseNew()
    await waitUntil(() => internals.pendingSpaceCatchUpBatches === 0, 'new catch-up settlement')
    expect(internals.pendingSpaceCatchUpBatches).toBe(0)
  })
})

function brokerEntryCount(broker: InProcessLogBroker, docId: string): number {
  const docs = (broker as unknown as { docs: Map<string, { entries: Map<string, unknown> }> }).docs
  return docs.get(docId)?.entries.size ?? 0
}

void LOG_ENTRY_MESSAGE_TYPE
