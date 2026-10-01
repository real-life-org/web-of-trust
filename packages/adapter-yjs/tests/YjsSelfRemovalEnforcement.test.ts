import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Wartebudget (waitUntil 15 s) und Testlimit angleichen: die Suiten warten auf
// echte Broker-/Sync-Bedingungen, unter Parallel-Last dauert das laenger als 5 s.
vi.setConfig({ testTimeout: 20_000 })
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import { initYjsPersonalDoc, resetYjsPersonalDoc } from '../src/YjsPersonalDocManager'
import { encodeBase64Url } from '@web_of_trust/core/protocol'

// Sync 005 §Self-Leave (#298): der austretende Member schreibt sein removed, die
// angekuendigte Rotation zieht ein beobachtender Admin nach. Faellt der Admin im
// Fenster zwischen persistierter Beobachtung und Staging aus, triggert der
// _members-Observer nie wieder (das Event-Set aendert sich nicht mehr) und die
// VE-C3-Recovery findet kein Pending — nur der Restore-Hook kann es noch nachziehen.

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** Deterministisch statt fester Sleeps: CI-Runner sind deutlich langsamer als Dev-Maschinen. */
async function waitUntil(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const BROKER_URLS = ['wss://broker.example.com']
const DEVICE_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface TestDoc { items: Record<string, { title: string }> }

interface DurableStores {
  docLogStore: InMemoryDocLogStore
  keyManagement: InMemoryKeyManagementAdapter
  metadataStorage: InMemorySpaceMetadataStorage
  compactStore: InMemoryCompactStore
}

function brokerGeneration(broker: InProcessLogBroker, docId: string): number | undefined {
  return (broker as unknown as { docs: Map<string, { generation: number }> }).docs.get(docId)?.generation
}

function adapterGeneration(adapter: YjsReplicationAdapter, spaceId: string): Promise<number> {
  return (adapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement.getCurrentGeneration(spaceId)
}

function spaceState(adapter: YjsReplicationAdapter, spaceId: string): unknown {
  return (adapter as unknown as { spaces: Map<string, unknown> }).spaces.get(spaceId)
}

/** Membership-Ereignisse im Doc des geladenen Space. */
function membershipEventsOf(adapter: YjsReplicationAdapter, spaceId: string): { did: string; status: string }[] {
  const internals = adapter as unknown as {
    spaces: Map<string, { doc: { getMap(name: string): { values(): Iterable<{ did: string; status: string }> } } }>
  }
  const state = internals.spaces.get(spaceId)
  if (!state) return []
  return Array.from(state.doc.getMap('_members').values())
}

function loadedMembers(adapter: YjsReplicationAdapter, spaceId: string): string[] {
  return (adapter as unknown as { spaces: Map<string, { info: { members: string[] } }> }).spaces.get(spaceId)!.info.members
}

/** Der vom Broker durable gehaltene Space-Capability-Key (base64url). */
function brokerVerificationKey(broker: InProcessLogBroker, docId: string): string | null | undefined {
  return (broker as unknown as { docs: Map<string, { verificationKey: string | null }> }).docs.get(docId)?.verificationKey
}

/**
 * Friert einen Tab MITTEN im Enforcement ein: das Staging ist durable, der
 * space-rotate erreicht den Broker nie. Das Promise loest nie auf — genau das
 * tut ein eingefrorener/geschlossener Tab auch.
 */
function stallRotateSend(adapter: YjsReplicationAdapter): void {
  const internals = adapter as unknown as {
    buildSecureRemovalDeps: (...args: unknown[]) => { sendSpaceRotate: unknown }
  }
  const real = internals.buildSecureRemovalDeps.bind(adapter)
  internals.buildSecureRemovalDeps = (...args: unknown[]) => ({
    ...real(...args),
    sendSpaceRotate: () => new Promise<void>(() => {}),
  })
}

/**
 * Haelt den space-rotate des Enforcements fest, bis der Test ihn freigibt —
 * ein langsamer Broker statt eines eingefrorenen Tabs.
 */
function holdRotateSend(adapter: YjsReplicationAdapter): () => void {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const internals = adapter as unknown as {
    buildSecureRemovalDeps: (...args: unknown[]) => { sendSpaceRotate: (...a: unknown[]) => Promise<void> }
  }
  const real = internals.buildSecureRemovalDeps.bind(adapter)
  internals.buildSecureRemovalDeps = (...args: unknown[]) => {
    const deps = real(...args)
    return { ...deps, sendSpaceRotate: async (...a: unknown[]) => { await gate; return deps.sendSpaceRotate(...a) } }
  }
  return release
}

/** Simuliert das Crash-Fenster: die Beobachtung wird persistiert, das Enforcement lief nie. */
function suppressEnforcement(adapter: YjsReplicationAdapter): void {
  ;(adapter as unknown as { enforceCanonicalSelfRemovalRotation: () => Promise<void> })
    .enforceCanonicalSelfRemovalRotation = async () => {}
}

async function makeStores(deviceId: string): Promise<DurableStores> {
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  await docLogStore.setDeviceId(deviceId)
  return {
    docLogStore,
    keyManagement: new InMemoryKeyManagementAdapter(),
    metadataStorage: new InMemorySpaceMetadataStorage(),
    compactStore: new InMemoryCompactStore(),
  }
}

describe('Yjs Self-Removal-Enforcement (#298) — Restore zieht eine ausgefallene Rotation nach', () => {
  let alice: PublicIdentitySession, bob: PublicIdentitySession
  let broker: InProcessLogBroker
  let aliceMessaging: InMemoryMessagingAdapter, bobMessaging: InMemoryMessagingAdapter
  let aliceStores: DurableStores
  const started: YjsReplicationAdapter[] = []

  function makeAdapter(identity: PublicIdentitySession, messaging: InMemoryMessagingAdapter, deviceId: string, stores: DurableStores): YjsReplicationAdapter {
    const adapter = new YjsReplicationAdapter({
      identity,
      messaging,
      brokerUrls: BROKER_URLS,
      keyManagement: stores.keyManagement,
      metadataStorage: stores.metadataStorage,
      compactStore: stores.compactStore,
      docLogStore: stores.docLogStore,
      deviceId,
      flushPersonalDoc: async () => {},
    })
    started.push(adapter)
    return adapter
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    alice = (await createTestIdentity('sr-enforce-alice')).identity
    bob = (await createTestIdentity('sr-enforce-bob')).identity
    aliceMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'alice-socket' })
    bobMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-socket' })
    await aliceMessaging.connect(alice.getDid())
    await bobMessaging.connect(bob.getDid())
    aliceStores = await makeStores(DEVICE_ALICE)
  })

  afterEach(async () => {
    for (const adapter of started.splice(0)) { try { await adapter.stop() } catch {} }
    await resetYjsPersonalDoc()
    InMemoryMessagingAdapter.resetAll()
    for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
  })

  it('Crash vor dem Staging: der Restore stößt das Enforcement nach', async () => {
    const aliceAdapter = makeAdapter(alice, aliceMessaging, DEVICE_ALICE, aliceStores)
    const bobAdapter = makeAdapter(bob, bobMessaging, DEVICE_BOB, await makeStores(DEVICE_BOB))
    await aliceAdapter.start()
    await bobAdapter.start()
    // leaveSpace macht die eigene Entfernung im PersonalDoc durabel.
    await initYjsPersonalDoc(bob)

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitUntil(() => brokerGeneration(broker, space.id) !== undefined, 'die Space-Registrierung am Broker')
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null, 'Bob hat den Space')
    expect(brokerGeneration(broker, space.id)).toBe(0)

    // Crash-Fenster: Alice beobachtet das removed (Doc + Metadata persistiert),
    // das Enforcement läuft aber nie und stagt nichts.
    suppressEnforcement(aliceAdapter)
    await bobAdapter.leaveSpace(space.id)
    await waitUntil(
      () => membershipEventsOf(aliceAdapter, space.id).some((event) => event.did === bob.getDid() && event.status === 'removed'),
      'Bobs removed-Ereignis in Alices _members',
    )
    expect(loadedMembers(aliceAdapter, space.id)).not.toContain(bob.getDid())
    expect(brokerGeneration(broker, space.id)).toBe(0)
    expect(await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())).toBeNull()
    // Den CompactStore-Save ERZWINGEN statt auf die Entprellung zu warten: genau
    // dieser Stand (Doc MIT dem removed) ist die Lücke — beim Restore liegt das
    // Ereignis bereits im Doc, der Observer feuert also nie wieder.
    await (aliceAdapter as unknown as { _saveToCompactStore(state: unknown): Promise<void> })
      ._saveToCompactStore(spaceState(aliceAdapter, space.id))
    await aliceAdapter.stop()

    // Neustart auf DENSELBEN Stores: das Event-Set ändert sich nicht mehr, der
    // Observer triggert also nie wieder — nur der Restore-Hook kann die
    // angekündigte Rotation noch nachziehen.
    const restarted = makeAdapter(alice, new InMemoryMessagingAdapter({ broker, socketId: 'alice-socket-2' }), DEVICE_ALICE, aliceStores)
    await (restarted as unknown as { messaging: InMemoryMessagingAdapter }).messaging.connect(alice.getDid())
    await restarted.start()
    await waitUntil(
      async () => (brokerGeneration(broker, space.id) ?? 0) > 0
        && (await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())) === null,
      'die nachgezogene Rotation am Broker samt abgeschlossenem Staging',
    )

    expect(brokerGeneration(broker, space.id)!).toBeGreaterThan(0)
    expect(await adapterGeneration(restarted, space.id)).toBeGreaterThan(0)
    expect(await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())).toBeNull()
  }, 30_000)

  // wot#386 (im Log-Modus aufgedeckt): der Admin laedt ein Mitglied neu ein,
  // WAEHREND die Enforcement-Rotation fuer dessen Austritt noch auf den Broker
  // wartet. Der Re-Invite-Guard in addMember rotierte parallel auf DIESELBE
  // Generation — "generation 1 is active with a DIVERGENT content key". Beide
  // Rotationen betreffen dieselbe DID und muessen hintereinander laufen.
  it('Neueinladung waehrend der laufenden Enforcement-Rotation: kein divergenter Schluessel, Bob ist wieder drin', async () => {
    const aliceAdapter = makeAdapter(alice, aliceMessaging, DEVICE_ALICE, aliceStores)
    const bobAdapter = makeAdapter(bob, bobMessaging, DEVICE_BOB, await makeStores(DEVICE_BOB))
    await aliceAdapter.start()
    await bobAdapter.start()
    await initYjsPersonalDoc(bob)

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitUntil(() => brokerGeneration(broker, space.id) !== undefined, 'die Space-Registrierung am Broker')
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null, 'Bob hat den Space')

    const releaseRotate = holdRotateSend(aliceAdapter)
    await bobAdapter.leaveSpace(space.id)
    await waitUntil(
      async () => (await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())) !== null,
      'das durable Staging des Enforcements',
    )

    // Neueinladung, waehrend das Enforcement am Broker haengt.
    const reinvite = aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    const reinviteOutcome = reinvite.then(() => 'ok', (err: unknown) => err)
    await new Promise((r) => setTimeout(r, 100))
    releaseRotate()

    expect(await reinviteOutcome).toBe('ok')
    await waitUntil(
      async () => (await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())) === null,
      'das aufgeloeste Staging',
    )
    await waitUntil(
      async () => ((await bobAdapter.getSpace(space.id))?.admission?.keyGeneration ?? -1) > 0,
      'Bobs neue Aufnahme-Kennung',
    )

    // Die Enforcement-Generation am Broker traegt genau Alices lokales Material.
    const generation = brokerGeneration(broker, space.id)!
    expect(generation).toBeGreaterThan(0)
    expect(encodeBase64Url((await aliceStores.keyManagement.getCapabilityVerificationKey(space.id, generation))!))
      .toBe(brokerVerificationKey(broker, space.id))
    expect(loadedMembers(aliceAdapter, space.id)).toContain(bob.getDid())

    // Und der Space funktioniert: ein Eintrag nach der Neueinladung erreicht Bob.
    const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
    handle.transact((doc) => { doc.items['nach-neueinladung'] = { title: 'wieder da' } })
    const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
    await waitUntil(() => bobHandle.getDoc().items['nach-neueinladung']?.title === 'wieder da', 'Alices Eintrag bei Bob')
    handle.close()
    bobHandle.close()
  }, 30_000)

  // #366: zwei Live-Instanzen DERSELBEN Identitaet teilen sich die durable
  // Stores. Nimmt die zweite auf, WAEHREND das Staging der ersten noch offen
  // ist, darf am Ende nur genau ein Material aktiv sein — das, welches der
  // Broker haelt. Das Praxis-Symptom aus #365 war der Gegenbeweis:
  // "generation 1 is active with a DIVERGENT content key".
  it('Wiederaufnahme waehrend des laufenden Enforcement-Stagings: lokaler Schluessel == Broker-Schluessel', async () => {
    const aliceAdapter = makeAdapter(alice, aliceMessaging, DEVICE_ALICE, aliceStores)
    const bobAdapter = makeAdapter(bob, bobMessaging, DEVICE_BOB, await makeStores(DEVICE_BOB))
    await aliceAdapter.start()
    await bobAdapter.start()
    await initYjsPersonalDoc(bob)

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitUntil(() => brokerGeneration(broker, space.id) !== undefined, 'die Space-Registrierung am Broker')
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null, 'Bob hat den Space')

    // Tab 1 stagt durable und friert vor dem space-rotate ein.
    stallRotateSend(aliceAdapter)
    await bobAdapter.leaveSpace(space.id)
    await waitUntil(
      async () => (await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())) !== null,
      'das durable Staging von Tab 1',
    )
    const staged = (await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid()))!
    expect(brokerGeneration(broker, space.id)).toBe(0)

    // Tab 2 nimmt auf DENSELBEN durable Stores wieder auf, waehrend Tab 1 noch
    // in seinem Enforcement haengt.
    const resumed = makeAdapter(alice, new InMemoryMessagingAdapter({ broker, socketId: 'alice-socket-2' }), DEVICE_ALICE, aliceStores)
    await (resumed as unknown as { messaging: InMemoryMessagingAdapter }).messaging.connect(alice.getDid())
    await resumed.start()
    await waitUntil(
      async () => (brokerGeneration(broker, space.id) ?? 0) > 0
        && (await aliceStores.docLogStore.getPendingRemoval(space.id, bob.getDid())) === null,
      'die abgeschlossene Rotation samt aufgeloestem Staging',
    )

    const generation = brokerGeneration(broker, space.id)!
    expect(await adapterGeneration(resumed, space.id)).toBe(generation)
    // Lokal aktiv ist GENAU das Material, das der Broker installiert hat ...
    expect(encodeBase64Url((await aliceStores.keyManagement.getCapabilityVerificationKey(space.id, generation))!))
      .toBe(brokerVerificationKey(broker, space.id))
    // ... und es ist das Material aus dem EINEN Staging, kein zweites.
    expect(Array.from((await aliceStores.keyManagement.getKeyByGeneration(space.id, generation))!))
      .toEqual(Array.from(staged.stagedKeyMaterial.contentKey))
  }, 30_000)
})
