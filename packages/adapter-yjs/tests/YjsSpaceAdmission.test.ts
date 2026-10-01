import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Wartebudget (waitUntil 15 s) und Testlimit angleichen: die Suiten warten auf
// echte Broker-/Sync-Bedingungen, unter Parallel-Last dauert das laenger als 5 s.
vi.setConfig({ testTimeout: 20_000 })
import * as Y from 'yjs'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter, InProcessLogBroker, InMemoryKeyManagementAdapter, InMemoryCompactStore,
  InMemorySpaceMetadataStorage,
} from '@web_of_trust/core/adapters'
import { isSameAdmission, compareAdmission, buildSpaceInviteBody, deliverInboxMessage, createSpaceKey } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { SPACE_INVITE_MESSAGE_TYPE, formatMembershipEventKey } from '@web_of_trust/core/protocol'
import type { MembershipEvent } from '@web_of_trust/core/protocol'
import type { IncomingSpaceInvite, SpaceInfo } from '@web_of_trust/core/types'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import { logSyncOptions } from './helpers/log-sync'
import { initYjsPersonalDoc, resetYjsPersonalDoc } from '../src/YjsPersonalDocManager'

// RLS-Spec 12 Regel 4: die Aufnahme-Kennung ist eine PROJEKTION des
// synchronisierten _members-Event-Sets (erstes active des laufenden
// Mitgliedschafts-Laufs), nie ein gespeicherter Wert. Sie steigt genau dann,
// wenn nach einem removed erneut aufgenommen wird.

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
const protocolCrypto = new WebCryptoProtocolCryptoAdapter()
interface TestDoc { items: Record<string, { title: string }> }

describe('Yjs Space-Admission (Aufnahme-Kennung)', () => {
  let alice: PublicIdentitySession, bob: PublicIdentitySession, carol: PublicIdentitySession
  let aliceMsg: InMemoryMessagingAdapter
  let aliceKeys: InMemoryKeyManagementAdapter
  let aliceAdapter: YjsReplicationAdapter
  const started: YjsReplicationAdapter[] = []
  // wot#386: one broker per test, every device on the log-sync path the relay accepts.
  let broker: InProcessLogBroker
  const connectedMessaging = async (did: string): Promise<InMemoryMessagingAdapter> => {
    const messaging = new InMemoryMessagingAdapter({ broker, socketId: crypto.randomUUID() })
    await messaging.connect(did)
    return messaging
  }

  async function makeAdapter(identity: PublicIdentitySession, messaging: InMemoryMessagingAdapter, opts?: {
    keyManagement?: InMemoryKeyManagementAdapter
    metadataStorage?: InMemorySpaceMetadataStorage
    compactStore?: InMemoryCompactStore
    flushPersonalDoc?: () => Promise<void>
  }): Promise<YjsReplicationAdapter> {
    const adapter = new YjsReplicationAdapter({
      identity,
      messaging,
      ...(await logSyncOptions(crypto.randomUUID())),
      brokerUrls: BROKER_URLS,
      keyManagement: opts?.keyManagement ?? new InMemoryKeyManagementAdapter(),
      metadataStorage: opts?.metadataStorage,
      compactStore: opts?.compactStore,
      flushPersonalDoc: opts?.flushPersonalDoc,
    })
    started.push(adapter)
    return adapter
  }

  async function startBob(opts?: Parameters<typeof makeAdapter>[2]): Promise<{ adapter: YjsReplicationAdapter; messaging: InMemoryMessagingAdapter; events: IncomingSpaceInvite[] }> {
    const messaging = await connectedMessaging(bob.getDid())
    const adapter = await makeAdapter(bob, messaging, opts)
    await adapter.start()
    const events: IncomingSpaceInvite[] = []
    adapter.onSpaceInvite((invite) => events.push(invite))
    return { adapter, messaging, events }
  }

  /** Eine spec-konforme Einladung an bob, gebaut aus Alices aktuellem Key-Material. */
  async function sendInviteToBob(spaceId: string): Promise<void> {
    const body = await buildSpaceInviteBody({
      keyPort: aliceKeys, spaceId, recipientDid: bob.getDid(),
      brokerUrls: BROKER_URLS, adminDids: [alice.getDid()],
    })
    const envelope = await deliverInboxMessage({
      type: SPACE_INVITE_MESSAGE_TYPE,
      body: body as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    })
    await aliceMsg.send(envelope)
  }

  function spaceState(adapter: YjsReplicationAdapter, spaceId: string): { info: SpaceInfo; doc: Y.Doc } {
    return (adapter as unknown as { spaces: Map<string, { info: SpaceInfo; doc: Y.Doc }> }).spaces.get(spaceId)!
  }
  const loadedInfo = (adapter: YjsReplicationAdapter, spaceId: string): SpaceInfo => spaceState(adapter, spaceId).info
  /** Der Empfänger hat den Space lokal. */
  async function waitForSpace(adapter: YjsReplicationAdapter, spaceId: string): Promise<void> {
    await waitUntil(async () => (await adapter.getSpace(spaceId)) !== null, 'den Space beim Empfänger')
  }

  /** Die Aufnahme-Kennung des Empfängers liegt über `generation`. */
  async function waitForAdmissionAbove(adapter: YjsReplicationAdapter, spaceId: string, generation: number): Promise<void> {
    await waitUntil(
      async () => ((await adapter.getSpace(spaceId))?.admission?.keyGeneration ?? -1) > generation,
      `eine Aufnahme-Kennung über Generation ${generation}`,
    )
  }

  /** Die DID ist aus Alices Mitgliederprojektion verschwunden. */
  async function waitForMemberGone(spaceId: string, did: string): Promise<void> {
    await waitUntil(() => !loadedInfo(aliceAdapter, spaceId).members.includes(did), `den Wegfall von ${did.slice(0, 16)}`)
  }

  function ownEvents(adapter: YjsReplicationAdapter, spaceId: string, did: string): MembershipEvent[] {
    const map = spaceState(adapter, spaceId).doc.getMap<MembershipEvent>('_members')
    return Array.from(map.values()).filter((event) => event.did === did)
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity
    carol = (await createTestIdentity('carol-pass')).identity
    broker = new InProcessLogBroker()
    aliceMsg = await connectedMessaging(alice.getDid())
    aliceKeys = new InMemoryKeyManagementAdapter()
    aliceAdapter = await makeAdapter(alice, aliceMsg, { keyManagement: aliceKeys })
    await aliceAdapter.start()
  })

  afterEach(async () => {
    for (const adapter of started.splice(0)) { try { await adapter.stop() } catch {} }
    await resetYjsPersonalDoc()
    InMemoryMessagingAdapter.resetAll()
    for (const id of [alice, bob, carol]) { try { await id.deleteStoredIdentity() } catch {} }
  })

  it('Creator: Aufnahme mit der Genesis-Generation 0 (eigenes active@0 im Doc-Seed)', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    expect(space.admission).toEqual({ keyGeneration: 0 })
    expect((await aliceAdapter.getSpace(space.id))!.admission).toEqual({ keyGeneration: 0 })
  })

  it('Einladung annehmen: IncomingSpaceInvite.admission == SpaceInfo.admission', async () => {
    const { adapter: receiver, events } = await startBob()
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Garten' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForSpace(receiver, space.id)

    expect(events).toHaveLength(1)
    expect(events[0].admission).toEqual({ keyGeneration: 0 })
    expect((await receiver.getSpace(space.id))!.admission).toEqual(events[0].admission)
  })

  it('Entfernung + Wiederaufnahme: höhere Kennung', async () => {
    const { adapter: receiver, events } = await startBob()
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForSpace(receiver, space.id)
    const first = events[0].admission!
    expect(first).toEqual({ keyGeneration: 0 })

    await aliceAdapter.removeMember(space.id, bob.getDid())
    await waitForMemberGone(space.id, bob.getDid())
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(receiver, space.id, first.keyGeneration)

    const second = (await receiver.getSpace(space.id))!.admission!
    expect(isSameAdmission(first, second)).toBe(false)
    expect(compareAdmission(second, first)).toBeGreaterThan(0)
    // Alices Sicht auf Bob ist dieselbe (dasselbe Event-Set).
    expect(loadedInfo(aliceAdapter, space.id).admission).toEqual({ keyGeneration: 0 }) // Alice selbst unverändert
  })

  it('Rotation durch Entfernung eines Dritten + erneute Einladung an ein bestehendes Mitglied: Kennung unverändert', async () => {
    const { adapter: receiver } = await startBob()
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await aliceAdapter.addMember(space.id, carol.getDid(), await carol.getEncryptionPublicKeyBytes())
    await waitForSpace(receiver, space.id)
    const before = (await receiver.getSpace(space.id))!.admission!

    // Carol raus → Rotation auf eine höhere Generation.
    await aliceAdapter.removeMember(space.id, carol.getDid())
    await waitForMemberGone(space.id, carol.getDid())
    // Bob wird erneut eingeladen, ohne je entfernt worden zu sein.
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await sendInviteToBob(space.id)
    const bobKeys = (receiver as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement
    await waitUntil(
      async () => (await bobKeys.getCurrentGeneration(space.id)) > before.keyGeneration,
      'Bobs Schlüssel der rotierten Generation',
    )

    // Die aktuelle Generation IST gestiegen …
    expect(await bobKeys.getCurrentGeneration(space.id)).toBeGreaterThan(before.keyGeneration)
    // … und Bobs Mitgliedschaft endete nie: die Kennung bleibt stehen, auch
    // wenn addMember ein zweites active auf der neuen Generation geschrieben hat.
    expect((await receiver.getSpace(space.id))!.admission).toEqual(before)
    expect(loadedInfo(aliceAdapter, space.id).members).toContain(bob.getDid())
    expect(ownEvents(aliceAdapter, space.id, bob.getDid()).every((event) => event.status === 'active')).toBe(true)
  })

  it('Rotation ohne erneute Einladung: Kennung unverändert', async () => {
    const { adapter: receiver } = await startBob()
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await aliceAdapter.addMember(space.id, carol.getDid(), await carol.getEncryptionPublicKeyBytes())
    await waitForSpace(receiver, space.id)
    const bobBefore = (await receiver.getSpace(space.id))!.admission!
    const aliceBefore = (await aliceAdapter.getSpace(space.id))!.admission!

    await aliceAdapter.removeMember(space.id, carol.getDid())
    await waitForMemberGone(space.id, carol.getDid())

    expect((await receiver.getSpace(space.id))!.admission).toEqual(bobBefore)
    expect((await aliceAdapter.getSpace(space.id))!.admission).toEqual(aliceBefore)
  })

  it('Zweitgerät derselben DID, das nur den Doc-Sync sieht, bekommt dieselbe Kennung (Observer, ohne Neustart)', async () => {
    const { adapter: deviceA } = await startBob()
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForSpace(deviceA, space.id)
    // Stand, den ein Zweitgerät der ersten Aufnahme kennt.
    const snapshotFirstAdmission = Y.encodeStateAsUpdate(spaceState(deviceA, space.id).doc)

    await aliceAdapter.removeMember(space.id, bob.getDid())
    await waitForMemberGone(space.id, bob.getDid())
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(deviceA, space.id, 0)
    const admissionA = (await deviceA.getSpace(space.id))!.admission!
    expect(compareAdmission(admissionA, { keyGeneration: 0 })).toBeGreaterThan(0)

    // Gerät B steht auf dem alten Stand und sieht die Wiederaufnahme NUR über
    // den Doc-Sync — hier als CRDT-Merge des Doc-States eingespielt (der Inhalt,
    // den der verschlüsselte Sync transportiert, ohne dessen Transport-Rauschen).
    const deviceB = await makeAdapter(bob, await connectedMessaging(bob.getDid()))
    await deviceB.start()
    const docB = new Y.Doc()
    Y.applyUpdate(docB, snapshotFirstAdmission, 'remote')
    const stateB = {
      info: { ...spaceState(deviceA, space.id).info, admission: { keyGeneration: 0 } },
      doc: docB,
      handles: new Set(),
      memberEncryptionKeys: new Map(),
      unsubUpdate: null,
    }
    const internals = deviceB as unknown as { spaces: Map<string, unknown>; setupSpaceSync(state: unknown): void }
    internals.spaces.set(space.id, stateB)
    internals.setupSpaceSync(stateB)
    expect(loadedInfo(deviceB, space.id).admission).toEqual({ keyGeneration: 0 })

    // Doc-Sync: der Merge bringt das removed + das neue active.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(spaceState(deviceA, space.id).doc), 'remote')
    await waitUntil(
      () => loadedInfo(deviceB, space.id).admission?.keyGeneration === admissionA.keyGeneration,
      'die vom Observer nachgeführte Kennung auf Gerät B',
    )
    expect(loadedInfo(deviceB, space.id).admission).toEqual(admissionA)
  })

  it('Restore aus dem Compact-Store: Kennung abgeleitet, ohne sie je zu persistieren', async () => {
    const metadataStorage = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()
    const keyManagement = new InMemoryKeyManagementAdapter()

    const first = await makeAdapter(alice, aliceMsg, { keyManagement, metadataStorage, compactStore })
    await first.start()
    const space = await first.createSpace<TestDoc>('shared', { items: {} }, { name: 'Persistent' })
    // Persistenz ERZWINGEN statt auf die Entprellung zu warten.
    await (first as unknown as { _saveToCompactStore(state: unknown): Promise<void> })
      ._saveToCompactStore(spaceState(first, space.id))
    await first.stop()

    const second = await makeAdapter(alice, aliceMsg, { keyManagement, metadataStorage, compactStore })
    await second.start()
    expect((await second.getSpace(space.id))!.admission).toEqual({ keyGeneration: 0 })
  })

  it('Alt-Space ohne _members-Ereignisse: keine Kennung', async () => {
    const metadataStorage = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()
    const keyManagement = new InMemoryKeyManagementAdapter()

    const first = await makeAdapter(alice, aliceMsg, { keyManagement, metadataStorage, compactStore })
    await first.start()
    const space = await first.createSpace<TestDoc>('shared', { items: {} }, { name: 'Legacy' })
    await (first as unknown as { _saveToCompactStore(state: unknown): Promise<void> })
      ._saveToCompactStore(spaceState(first, space.id))
    await first.stop()

    // Bestand simulieren: das Doc eines Alt-Space trägt kein Event-Set.
    const legacyDoc = new Y.Doc()
    const binary = (await compactStore.load(space.id))!
    Y.applyUpdate(legacyDoc, binary)
    const members = legacyDoc.getMap<MembershipEvent>('_members')
    for (const key of Array.from(members.keys())) members.delete(key)
    await compactStore.save(space.id, Y.encodeStateAsUpdate(legacyDoc))

    const second = await makeAdapter(alice, aliceMsg, { keyManagement, metadataStorage, compactStore })
    await second.start()
    expect((await second.getSpace(space.id))!.admission).toBeUndefined()
  })

  it('Selbst-Verlassen (leaveSpace) + erneute Einladung: neue Kennung', async () => {
    const { adapter: receiver } = await startBob({ flushPersonalDoc: async () => {} })
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForSpace(receiver, space.id)
    expect((await receiver.getSpace(space.id))!.admission).toEqual({ keyGeneration: 0 })

    // leaveSpace macht die eigene Entfernung im PersonalDoc durabel.
    await initYjsPersonalDoc(bob)
    // Echter Austritt über die öffentliche Methode: leaveSpace schreibt das
    // kanonische removed-Ereignis, bevor es lokal aufräumt.
    await receiver.leaveSpace(space.id)
    await waitForMemberGone(space.id, bob.getDid())
    expect(await receiver.getSpace(space.id)).toBeNull()
    expect(loadedInfo(aliceAdapter, space.id).members).not.toContain(bob.getDid())

    // Erneute Einladung → Re-Invite-Guard rotiert, neues active auf höherer Generation.
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(receiver, space.id, 0)
    const again = (await receiver.getSpace(space.id))!.admission!
    expect(compareAdmission(again, { keyGeneration: 0 })).toBeGreaterThan(0)
  })
  it('Invite ohne Doc-Snapshot: Kennung erst undefined, nach dem Doc-Sync gesetzt — und der Space-Listener wurde benachrichtigt', async () => {
    const { adapter: receiver, events } = await startBob()
    const notified: SpaceInfo[][] = []
    receiver.watchSpaces().subscribe((spaces) => { notified.push(spaces.map((space) => ({ ...space }))) })

    // Spec-konformer Invite OHNE die Snapshot-Extension (wie buildSpaceInviteBody
    // ihn erzeugt): Bob bekommt Schlüssel + Capability, aber noch kein
    // _members-Event-Set — der Inhalt kommt über den Sync.
    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    const body = await buildSpaceInviteBody({
      keyPort: senderPort, spaceId, recipientDid: bob.getDid(),
      brokerUrls: BROKER_URLS, adminDids: [alice.getDid()],
    })
    await aliceMsg.send(await deliverInboxMessage({
      type: SPACE_INVITE_MESSAGE_TYPE,
      body: body as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    }))
    await waitUntil(() => events.length === 1, 'das Invite-Event ohne Snapshot')

    expect(events).toHaveLength(1)
    expect(events[0].admission).toBeUndefined()
    expect((await receiver.getSpace(spaceId))!.admission).toBeUndefined()
    const notificationsBefore = notified.length

    // Die nicht-autoritative Members-Saat des Invite-Zweigs ([sender, self])
    // auf den Endstand setzen: dadurch ist die Aufnahme-Kennung die EINZIGE
    // Änderung, die der Sync unten auslöst — die Benachrichtigung kann nicht
    // von der members-Projektion kommen.
    const seeded = spaceState(receiver, spaceId)
    seeded.info = { ...seeded.info, members: [alice.getDid(), bob.getDid()].sort() }

    // Doc-Sync: jetzt kommen die _members-Ereignisse des Inviters an.
    const inviterDoc = new Y.Doc()
    const inviterMembers = inviterDoc.getMap<MembershipEvent>('_members')
    for (const event of [
      { did: alice.getDid(), status: 'active' as const, sinceGeneration: 0 },
      { did: bob.getDid(), status: 'active' as const, sinceGeneration: 0 },
    ]) inviterMembers.set(formatMembershipEventKey(event), event)
    Y.applyUpdate(spaceState(receiver, spaceId).doc, Y.encodeStateAsUpdate(inviterDoc), 'remote')
    await waitUntil(
      async () => (await receiver.getSpace(spaceId))?.admission !== undefined,
      'die vom Observer nachgeführte Kennung',
    )

    expect((await receiver.getSpace(spaceId))!.admission).toEqual({ keyGeneration: 0 })
    // Der Übergang undefined → Wert ist eine sichtbare Änderung: die
    // watchSpaces-Subscriber müssen ihn erfahren haben.
    expect(notified.length).toBeGreaterThan(notificationsBefore)
    const lastSeen = notified[notified.length - 1].find((entry) => entry.id === spaceId)
    expect(lastSeen!.admission).toEqual({ keyGeneration: 0 })
  })
})
