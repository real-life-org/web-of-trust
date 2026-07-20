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
})

function brokerEntryCount(broker: InProcessLogBroker, docId: string): number {
  const docs = (broker as unknown as { docs: Map<string, { entries: Map<string, unknown> }> }).docs
  return docs.get(docId)?.entries.size ?? 0
}

void LOG_ENTRY_MESSAGE_TYPE
