import { describe, it, expect, afterEach, vi } from 'vitest'
// Wartebudget (waitUntil 15 s) und Testlimit angleichen: die Suiten warten auf
// echte Broker-/Sync-Bedingungen, unter Parallel-Last dauert das laenger als 5 s.
vi.setConfig({ testTimeout: 20_000 })
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemoryKeyManagementAdapter, InMemoryCompactStore, InMemorySpaceMetadataStorage, InMemoryDocLogStore, InProcessLogBroker } from '@web_of_trust/core/adapters'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'
import { compareAdmission } from '@web_of_trust/core/application'
import { encodeBase64Url } from '@web_of_trust/core/protocol'
import type { SpaceInfo } from '@web_of_trust/core/types'
import type { MembershipEvent } from '@web_of_trust/core/protocol'
import { SPACE_ROTATE_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'

// RLS-Spec 12 Regel 4 (Automerge-Spiegel): die Aufnahme-Kennung ist eine
// Projektion des _members-Event-Sets, nie ein gespeicherter Wert. Auch der
// Austritt (leaveSpace) schreibt sein removed-Ereignis dorthin (Yjs-Paritaet),
// eine Wiederaufnahme danach ist also erkennbar.

interface TestDoc { items: Record<string, { title: string }> }
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms))

/** Deterministisch statt fester Sleeps: CI-Runner sind deutlich langsamer als Dev-Maschinen. */
async function waitUntil(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Der Space ist am Broker registriert (erste Publikation durch). */
async function waitForSpaceRegistered(broker: InProcessLogBroker, spaceId: string): Promise<void> {
  await waitUntil(() => brokerGeneration(broker, spaceId) !== undefined, 'die Space-Registrierung am Broker')
}

/** Der Eingeladene hat den Space lokal. */
async function waitForSpace(peer: { adapter: AutomergeReplicationAdapter }, spaceId: string): Promise<void> {
  await waitUntil(async () => (await peer.adapter.getSpace(spaceId)) !== null, 'den Space beim Eingeladenen')
}

/** Die Aufnahme-Kennung des Eingeladenen liegt über `generation`. */
async function waitForAdmissionAbove(peer: { adapter: AutomergeReplicationAdapter }, spaceId: string, generation: number): Promise<void> {
  await waitUntil(
    async () => ((await peer.adapter.getSpace(spaceId))?.admission?.keyGeneration ?? -1) > generation,
    `eine Aufnahme-Kennung über Generation ${generation}`,
  )
}

/** Die DID ist aus der Mitgliederprojektion des Beobachters verschwunden. */
async function waitForMemberGone(observer: { adapter: AutomergeReplicationAdapter }, spaceId: string, did: string): Promise<void> {
  await waitUntil(() => !loadedInfo(observer.adapter, spaceId).members.includes(did), `den Wegfall von ${did.slice(0, 16)}`)
}

/** Der Austritt ist beim beobachtenden Admin angekommen UND die Rotation durchgesetzt. */
async function waitForEnforcedSelfRemoval(
  broker: InProcessLogBroker, admin: LogSyncPeer, spaceId: string, removedDid: string,
): Promise<void> {
  await waitUntil(
    async () => !loadedInfo(admin.adapter, spaceId).members.includes(removedDid)
      && (brokerGeneration(broker, spaceId) ?? 0) > 0
      && (await admin.docLogStore.getPendingRemoval(spaceId, removedDid)) === null,
    `die durchgesetzte Rotation zum Austritt von ${removedDid.slice(0, 16)}`,
  )
}
const cleanups: Array<() => Promise<void>> = []

function adapterGeneration(adapter: AutomergeReplicationAdapter, spaceId: string): Promise<number> {
  return (adapter as unknown as { keyManagement: InMemoryKeyManagementAdapter }).keyManagement.getCurrentGeneration(spaceId)
}

function membershipEventsOf(adapter: AutomergeReplicationAdapter, spaceId: string): MembershipEvent[] {
  const internals = adapter as unknown as {
    spaces: Map<string, { documentId: string }>
    repo: { handles: Record<string, { doc(): unknown }> }
    readMembershipEvents(doc: unknown): MembershipEvent[]
  }
  const documentId = internals.spaces.get(spaceId)?.documentId
  if (!documentId) return []
  return internals.readMembershipEvents(internals.repo.handles[documentId]?.doc())
}

/** Simuliert das Crash-Fenster: die Beobachtung wird persistiert, das Enforcement lief nie. */
function suppressEnforcement(adapter: AutomergeReplicationAdapter): void {
  ;(adapter as unknown as { enforceCanonicalSelfRemovalRotation: () => Promise<void> })
    .enforceCanonicalSelfRemovalRotation = async () => {}
}

function loadedInfo(adapter: AutomergeReplicationAdapter, spaceId: string): SpaceInfo {
  return (adapter as unknown as { spaces: Map<string, { info: SpaceInfo }> }).spaces.get(spaceId)!.info
}

async function createPeer(passphrase: string): Promise<{ identity: PublicIdentitySession; adapter: AutomergeReplicationAdapter }> {
  const identity = (await createTestIdentity(passphrase)).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(identity.getDid())
  const adapter = new AutomergeReplicationAdapter({
    identity,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement: new InMemoryKeyManagementAdapter(),
    metadataStorage: new InMemorySpaceMetadataStorage(),
    compactStore: new InMemoryCompactStore(),
  })
  await adapter.start()
  cleanups.push(async () => {
    try { await adapter.stop() } catch {}
    try { await identity.deleteStoredIdentity() } catch {}
  })
  return { identity, adapter }
}

/**
 * Zwei Geraete am selben In-Process-Broker mit log-sync — die Konfiguration, in
 * der die Membership-Ereignisse als durable Log-Eintraege reisen (persist before
 * send). Der Austritt muss die verbleibenden Mitglieder auf diesem Weg
 * erreichen, BEVOR das austretende Geraet lokal aufraeumt.
 */
interface DurableStores {
  keyManagement: InMemoryKeyManagementAdapter
  metadataStorage: InMemorySpaceMetadataStorage
  repoStorage: InMemoryRepoStorageAdapter
  docLogStore: InMemoryDocLogStore
}

interface LogSyncPeer {
  identity: PublicIdentitySession
  adapter: AutomergeReplicationAdapter
  messaging: InMemoryMessagingAdapter
  docLogStore: InMemoryDocLogStore
  stores: DurableStores
}

async function createLogSyncPeer(
  passphrase: string,
  broker: InProcessLogBroker,
  socketId: string,
  deviceId: string,
  opts?: { identity?: PublicIdentitySession; stores?: DurableStores },
): Promise<LogSyncPeer> {
  const identity = opts?.identity ?? (await createTestIdentity(passphrase)).identity
  const messaging = new InMemoryMessagingAdapter({ broker, socketId })
  await messaging.connect(identity.getDid())
  const docLogStore = opts?.stores?.docLogStore ?? new InMemoryDocLogStore()
  if (!opts?.stores) {
    await docLogStore.init()
    await docLogStore.setDeviceId(deviceId)
  }
  const stores: DurableStores = opts?.stores ?? {
    keyManagement: new InMemoryKeyManagementAdapter(),
    metadataStorage: new InMemorySpaceMetadataStorage(),
    repoStorage: new InMemoryRepoStorageAdapter(),
    docLogStore,
  }
  const adapter = new AutomergeReplicationAdapter({
    identity,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement: stores.keyManagement,
    metadataStorage: stores.metadataStorage,
    repoStorage: stores.repoStorage,
    docLogStore: stores.docLogStore,
    deviceId,
  })
  await adapter.start()
  cleanups.push(async () => {
    try { await adapter.stop() } catch {}
    if (!opts?.identity) { try { await identity.deleteStoredIdentity() } catch {} }
  })
  return { identity, adapter, messaging, docLogStore: stores.docLogStore, stores }
}

/** Generation, auf der der Broker ein Doc fuehrt (Enforcement-Beweis). */
function brokerGeneration(broker: InProcessLogBroker, docId: string): number | undefined {
  return (broker as unknown as { docs: Map<string, { generation: number }> }).docs.get(docId)?.generation
}

/** Der am Broker installierte Space-Capability-Verification-Key (Base64URL). */
function brokerVerificationKey(broker: InProcessLogBroker, docId: string): string | null | undefined {
  return (broker as unknown as { docs: Map<string, { verificationKey: string | null }> }).docs.get(docId)?.verificationKey
}

/** Anzahl durabler Log-Eintraege, die der Broker fuer ein Doc haelt (Durabilitaets-Beweis). */
function brokerEntryCount(broker: InProcessLogBroker, docId: string): number {
  return (broker as unknown as { docs: Map<string, { entries: Map<string, unknown> }> }).docs.get(docId)?.entries.size ?? 0
}

/** Laesst den naechsten durablen Append EINMAL werfen. */
function armAppendFailure(store: InMemoryDocLogStore): void {
  const realAppend = store.appendLocalEntry.bind(store)
  let armed = true
  ;(store as unknown as { appendLocalEntry: typeof store.appendLocalEntry }).appendLocalEntry = (async (params: any) => {
    if (armed) {
      armed = false
      throw new Error('simulated durable append failure (leaveSpace)')
    }
    return realAppend(params)
  }) as typeof store.appendLocalEntry
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

describe('Automerge Space-Admission (Aufnahme-Kennung)', () => {
  it('Creator: Aufnahme mit der Genesis-Generation 0', async () => {
    const alice = await createPeer('am-adm-create')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    expect(space.admission).toEqual({ keyGeneration: 0 })
    expect(loadedInfo(alice.adapter, space.id).admission).toEqual({ keyGeneration: 0 })
  })

  it('Entfernung + Wiederaufnahme: höhere Kennung beim Eingeladenen', async () => {
    const alice = await createPeer('am-adm-alice')
    const bob = await createPeer('am-adm-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    const first = (await bob.adapter.getSpace(space.id))!.admission!
    expect(first).toEqual({ keyGeneration: 0 })

    await alice.adapter.removeMember(space.id, bob.identity.getDid())
    await waitForMemberGone(alice, space.id, bob.identity.getDid())
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(bob, space.id, first.keyGeneration)

    const second = (await bob.adapter.getSpace(space.id))!.admission!
    expect(compareAdmission(second, first)).toBeGreaterThan(0)
  })

  it('Selbst-Verlassen (leaveSpace) + erneute Einladung: neue, höhere Kennung', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-leave-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-leave-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    expect((await bob.adapter.getSpace(space.id))!.admission).toEqual({ keyGeneration: 0 })

    // Austritt über die öffentliche Methode: das kanonische removed-Ereignis
    // muss Alice erreichen, sonst wäre die Wiederaufnahme nicht erkennbar.
    // Die nachgezogene Rotation MUSS abgeschlossen sein, bevor unten erneut
    // eingeladen wird: eine Einladung rotiert selbst, und ein noch laufendes
    // Enforcement-Staging daneben läuft in die Drift-Prüfung des Core-Workflows
    // (siehe Issue #366 (Secure Removal Staging-Rennen)).
    await bob.adapter.leaveSpace(space.id)
    await waitForEnforcedSelfRemoval(broker, alice, space.id, bob.identity.getDid())
    expect(await bob.adapter.getSpace(space.id)).toBeNull()
    expect(loadedInfo(alice.adapter, space.id).members).not.toContain(bob.identity.getDid())

    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(bob, space.id, 0)
    const again = (await bob.adapter.getSpace(space.id))!.admission!
    expect(compareAdmission(again, { keyGeneration: 0 })).toBeGreaterThan(0)
  })

  it('Selbst-Verlassen lässt die Kennung eines Dritten unverändert', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-third-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-third-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const carol = await createLogSyncPeer('am-third-carol', broker, 'carol-socket', '33333333-3333-4333-8333-333333333333')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(carol, space.id)
    const carolBefore = (await carol.adapter.getSpace(space.id))!.admission!
    const aliceBefore = loadedInfo(alice.adapter, space.id).admission!

    await bob.adapter.leaveSpace(space.id)
    await waitForMemberGone(alice, space.id, bob.identity.getDid())

    expect(loadedInfo(alice.adapter, space.id).members).not.toContain(bob.identity.getDid())
    expect((await carol.adapter.getSpace(space.id))!.admission).toEqual(carolBefore)
    expect(loadedInfo(alice.adapter, space.id).admission).toEqual(aliceBefore)
  })
  it('Austritt mit fehlgeschlagenem Log-Append: kein Cleanup — der Retry repariert die Durabilität, erst dann wird aufgeräumt', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-retry-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-retry-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)

    // Erster Austritt: der durable Append wirft NACH der lokalen Doc-Mutation.
    armAppendFailure(bob.docLogStore)
    await expect(bob.adapter.leaveSpace(space.id)).rejects.toThrow(/simulated durable append failure/)
    // Das removed-Ereignis ist lokal angewandt (Projektion), …
    await waitForMemberGone(bob, space.id, bob.identity.getDid())
    // … der Cleanup lief aber NICHT: der Space ist lokal noch da.
    expect(await bob.adapter.getSpace(space.id)).not.toBeNull()
    expect(loadedInfo(bob.adapter, space.id).members).not.toContain(bob.identity.getDid())
    // … aber Alice weiß nichts davon (nichts wurde durabel geloggt).
    expect(loadedInfo(alice.adapter, space.id).members).toContain(bob.identity.getDid())
    const entriesAfterFailure = brokerEntryCount(broker, space.id)

    // Zweiter Austritt: der Retry darf NICHT auf die lokale Präsenz des
    // Ereignisses kurzschließen, sondern muss den Reparaturpfad von
    // commitMembershipEventDurable laufen lassen — der Broker-Log MUSS wachsen.
    await bob.adapter.leaveSpace(space.id)
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) === null, 'Bobs lokalen Cleanup')
    await waitForMemberGone(alice, space.id, bob.identity.getDid())
    expect(brokerEntryCount(broker, space.id)).toBeGreaterThan(entriesAfterFailure)
    expect(await bob.adapter.getSpace(space.id)).toBeNull()
    expect(loadedInfo(alice.adapter, space.id).members).not.toContain(bob.identity.getDid())
  })
  it('Sync 005 §Self-Leave: der beobachtende Admin zieht die Rotation nach — Broker und eigene Generation folgen dem removed', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-enforce-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-enforce-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    expect(brokerGeneration(broker, space.id)).toBe(0)

    await bob.adapter.leaveSpace(space.id)
    await waitForEnforcedSelfRemoval(broker, alice, space.id, bob.identity.getDid())
    expect(loadedInfo(alice.adapter, space.id).members).not.toContain(bob.identity.getDid())

    // VOR jeder erneuten Einladung: die angekündigte Rotation MUSS durchgesetzt
    // sein, sonst blieben Bobs alte Schlüssel und Capabilities gültig (#298).
    const removedEvent = (alice.adapter as unknown as { readMembershipEvents(doc: unknown): MembershipEvent[] })
      .readMembershipEvents((alice.adapter as unknown as { repo: { handles: Record<string, { doc(): unknown }> }; spaces: Map<string, { documentId: string }> })
        .repo.handles[(alice.adapter as unknown as { spaces: Map<string, { documentId: string }> }).spaces.get(space.id)!.documentId].doc())
      .find((event) => event.did === bob.identity.getDid() && event.status === 'removed')!
    expect(removedEvent.sinceGeneration).toBeGreaterThan(0)
    expect(brokerGeneration(broker, space.id)!).toBeGreaterThan(0)
    expect(await adapterGeneration(alice.adapter, space.id)).toBeGreaterThanOrEqual(removedEvent.sinceGeneration)

    // Und die Wiederaufnahme funktioniert weiterhin.
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(bob, space.id, 0)
    const again = (await bob.adapter.getSpace(space.id))!.admission!
    expect(again.keyGeneration).toBeGreaterThan(0)
  })

  it('Erneute Beobachtung desselben removed löst keinen weiteren Rotate aus; genau eine wirksame Rotation', async () => {
    // UMFANG (ehrlich): dieser Test deckt den SEQUENTIELLEN Re-Trigger ab — ein
    // zweiter Beobachter sieht dasselbe kanonische removed, nachdem die Rotation
    // bereits durchgesetzt ist. Er beweist NICHT das echte Rennen: die zweite
    // Instanz teilt hier durable Stores UND KeyManagement mit der ersten, eine
    // Staging-Reihenfolge wird nicht erzwungen, und zwei exakt gleichzeitige
    // Beobachter stagen ohnehin beide (die Bestätigung im Core ist nicht an das
    // gestagte Material gebunden — siehe Issue #366 (Secure Removal Staging-Rennen)).
    // Was hier gilt: genau EINE Rotation wird wirksam, und der lokal aktive
    // Schlüssel der Admin-Instanz ist derselbe, den der Broker installiert hat.
    const broker = new InProcessLogBroker()
    // Space-rotate-Frames am Broker zählen: die erneute Beobachtung darf keinen
    // zweiten Rotate erzeugen — nicht erst der Broker soll ihn ablehnen müssen.
    const rotateFrames: unknown[] = []
    const realHandleControlFrame = broker.handleControlFrame.bind(broker)
    ;(broker as unknown as { handleControlFrame: unknown }).handleControlFrame = async (socketId: string, frame: { type?: string }) => {
      if (frame.type === SPACE_ROTATE_MESSAGE_TYPE) rotateFrames.push(frame)
      return realHandleControlFrame(socketId, frame as never)
    }

    const alice = await createLogSyncPeer('am-dedup-alice', broker, 'alice-socket-a', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-dedup-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    const generationBefore = brokerGeneration(broker, space.id)!

    // Zweite LIVE-Instanz desselben Admin-Geräts (gleiche DID, dieselben durablen
    // Stores — das Staging im gemeinsamen docLogStore ist der Dedup-Schlüssel).
    const aliceSecond = await createLogSyncPeer('', broker, 'alice-socket-b', '11111111-1111-4111-8111-111111111111', {
      identity: alice.identity, stores: alice.stores,
    })
    await waitUntil(
      () => (aliceSecond.adapter as unknown as { spaces: Map<string, unknown> }).spaces.has(space.id),
      'den Space in der zweiten Instanz',
    )

    await bob.adapter.leaveSpace(space.id)
    await waitForEnforcedSelfRemoval(broker, alice, space.id, bob.identity.getDid())
    expect(brokerGeneration(broker, space.id)).toBe(generationBefore + 1)
    const framesAfterFirstEnforcement = rotateFrames.length

    // Der lokal aktive Schlüssel der Admin-Instanz IST der am Broker
    // installierte — die wirksame Rotation ist die eigene, nicht eine fremde.
    const activeGeneration = await adapterGeneration(alice.adapter, space.id)
    const localVerificationKey = await alice.stores.keyManagement.getCapabilityVerificationKey(space.id, activeGeneration)
    expect(localVerificationKey).not.toBeNull()
    expect(brokerVerificationKey(broker, space.id)).toBe(encodeBase64Url(localVerificationKey!))

    // Die zweite Instanz sieht DASSELBE kanonische removed. Weder ein weiteres
    // Staging noch ein weiterer Rotate darf daraus entstehen: die erneute
    // Generationsprüfung und das Staging im gemeinsamen docLogStore greifen.
    const events = membershipEventsOf(alice.adapter, space.id)
    const second = aliceSecond.adapter as unknown as {
      enforceCanonicalSelfRemovalRotation(space: unknown, events: MembershipEvent[]): Promise<void>
      spaces: Map<string, unknown>
    }
    await second.enforceCanonicalSelfRemovalRotation(second.spaces.get(space.id), events)
    // Bounded Karenz für einen etwaigen (hier unerwünschten) Rotate-Versuch:
    // prüft die ABWESENHEIT eines Effekts.
    await wait()

    expect(rotateFrames).toHaveLength(framesAfterFirstEnforcement)
    expect(brokerGeneration(broker, space.id)).toBe(generationBefore + 1)
    expect(brokerVerificationKey(broker, space.id)).toBe(encodeBase64Url(localVerificationKey!))
  })

  it('Wiederaufnahme im existing-Zweig benachrichtigt die watchSpaces-Subscriber', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-notify-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-notify-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    expect((await bob.adapter.getSpace(space.id))!.admission).toEqual({ keyGeneration: 0 })

    // Bob behält den Space (kein leaveSpace) — die erneute Einladung nach einer
    // Entfernung durch Alice läuft damit in den existing-Zweig.
    const notified: SpaceInfo[][] = []
    bob.adapter.watchSpaces().subscribe((spaces) => { notified.push(spaces.map((entry) => ({ ...entry }))) })
    await alice.adapter.removeMember(space.id, bob.identity.getDid())
    await waitForMemberGone(alice, space.id, bob.identity.getDid())
    const before = notified.length
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForAdmissionAbove(bob, space.id, 0)

    const admission = (await bob.adapter.getSpace(space.id))!.admission!
    expect(compareAdmission(admission, { keyGeneration: 0 })).toBeGreaterThan(0)
    expect(notified.length).toBeGreaterThan(before)
    const lastSeen = notified[notified.length - 1].find((entry) => entry.id === space.id)
    expect(lastSeen!.admission).toEqual(admission)
  })
  it('Admin-Self-Leave wird fail-closed abgelehnt: kein removed-Ereignis, Space unverändert', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-adminleave-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-adminleave-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)

    // Der Admin-Self-Leave-Ablauf (eigene Rotation + Broker-admin-remove) ist in
    // diesem Adapter nicht implementiert — er muss abgelehnt werden, BEVOR
    // irgendetwas geschrieben wird (sonst bliebe die Admin-Berechtigung am
    // Broker bestehen, während die DID kanonisch entfernt ist).
    await expect(alice.adapter.leaveSpace(space.id)).rejects.toThrow(/secure self-leave is not supported/)
    expect(await alice.adapter.getSpace(space.id)).not.toBeNull()
    expect(membershipEventsOf(alice.adapter, space.id).filter((event) => event.did === alice.identity.getDid() && event.status === 'removed')).toHaveLength(0)
    expect(loadedInfo(alice.adapter, space.id).members).toContain(alice.identity.getDid())

    // Nicht-Admin bleibt unverändert möglich.
    await bob.adapter.leaveSpace(space.id)
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) === null, 'Bobs lokalen Cleanup')
    expect(await bob.adapter.getSpace(space.id)).toBeNull()
  })

  it('Nach der Enforcement-Rotation hat der Ausgetretene den neuen Schlüssel NICHT', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-nokey-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-nokey-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    const bobGenerationBefore = await adapterGeneration(bob.adapter, space.id)

    await bob.adapter.leaveSpace(space.id)
    await waitForEnforcedSelfRemoval(broker, alice, space.id, bob.identity.getDid())

    // Alice ist rotiert, Bob bekommt KEINE key-rotation — sonst wäre der
    // Austritt sicherheitlich wertlos.
    expect(await adapterGeneration(alice.adapter, space.id)).toBeGreaterThan(bobGenerationBefore)
    expect(brokerGeneration(broker, space.id)!).toBeGreaterThan(bobGenerationBefore)
    // Bob hat KEINE key-rotation bekommen: sein lokaler Schlüsselstand ist nicht
    // über die alte Generation hinausgewachsen (nach dem Austritt hat er gar
    // keine Schlüssel mehr — cleanupSpaceLocally löscht sie).
    expect(await adapterGeneration(bob.adapter, space.id)).toBeLessThanOrEqual(bobGenerationBefore)
  })

  it('Crash vor dem Staging: der Restore stößt das Enforcement nach', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-crash-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-crash-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)

    // Crash-Fenster: Alice beobachtet das removed (Doc + Digest + Metadata
    // persistiert), das Enforcement läuft aber nie und stagt nichts.
    suppressEnforcement(alice.adapter)
    await bob.adapter.leaveSpace(space.id)
    await waitUntil(
      () => !loadedInfo(alice.adapter, space.id).members.includes(bob.identity.getDid()),
      'Bobs removed-Ereignis bei Alice',
    )
    expect(loadedInfo(alice.adapter, space.id).members).not.toContain(bob.identity.getDid())
    expect(brokerGeneration(broker, space.id)).toBe(0)
    expect(await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())).toBeNull()
    await alice.adapter.stop()

    // Neustart auf DENSELBEN Stores: das Event-Set ändert sich nicht mehr, der
    // Observer triggert also nie wieder — nur der Restore-Hook kann die
    // angekündigte Rotation noch nachziehen.
    const restarted = await createLogSyncPeer('', broker, 'alice-socket-2', '11111111-1111-4111-8111-111111111111', {
      identity: alice.identity, stores: alice.stores,
    })
    await waitUntil(
      async () => (brokerGeneration(broker, space.id) ?? 0) > 0
        && (await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())) === null,
      'die nachgezogene Rotation samt abgeschlossenem Staging',
    )
    expect(brokerGeneration(broker, space.id)!).toBeGreaterThan(0)
    expect(await adapterGeneration(restarted.adapter, space.id)).toBeGreaterThan(0)
  })

  it('Recovery eines gestagten canonical-self-removal-rotation: rotiert, ohne zweiten Membership-Commit und ohne member-update', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-recover-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-recover-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    // Drittes Mitglied: NUR an einem verbliebenen Mitglied ist sichtbar, ob die
    // Recovery fälschlich ein member-update broadcastet (Bob ist weg und hat
    // keinen Encryption-Key mehr, an ihm wäre jede Doppel-Zustellung unsichtbar).
    const carol = await createLogSyncPeer('am-recover-carol', broker, 'carol-socket', '33333333-3333-4333-8333-333333333333')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await carol.adapter.getSpace(space.id)) !== null, 'Carol hat den Space')

    // NUR der space-rotate erreicht den Broker nicht → das Removal bleibt
    // gestagt. Die übrigen Control-Frames müssen laufen, sonst erreicht Alice
    // das kanonische removed gar nicht erst. Injektion am Broker, weil der
    // Coordinator seine sendControlFrame-Referenz bereits gebunden hat.
    const realHandleControlFrame = broker.handleControlFrame.bind(broker)
    ;(broker as unknown as { handleControlFrame: unknown }).handleControlFrame = async (socketId: string, frame: { type?: string }) => {
      if (frame.type === SPACE_ROTATE_MESSAGE_TYPE) throw new Error('injected: space-rotate never reached the broker')
      return realHandleControlFrame(socketId, frame as never)
    }
    await bob.adapter.leaveSpace(space.id)
    await waitUntil(
      async () => (await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())) !== null,
      'das gestagte Removal bei Alice',
    )
    const staged = await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())
    expect(staged?.kind).toBe('canonical-self-removal-rotation')
    expect(brokerGeneration(broker, space.id)).toBe(0)
    expect(membershipEventsOf(alice.adapter, space.id)
      .filter((event) => event.did === bob.identity.getDid() && event.status === 'removed')).toHaveLength(1)
    await alice.adapter.stop()
    ;(broker as unknown as { handleControlFrame: unknown }).handleControlFrame = realHandleControlFrame

    // Ab hier zählen: die Recovery dieser Art darf KEIN member-update senden
    // (die Entfernung ist bereits kanonisch, Bob hat sie selbst geschrieben) und
    // keinen zweiten Membership-Commit ins Log schreiben. Die key-rotation an
    // Carol ist dagegen erwünscht — sie IST der Zweck der Rotation.
    const memberUpdatesToCarol: unknown[] = []
    carol.messaging.onMessage((message: unknown) => {
      if ((message as { type?: string }).type === MEMBER_UPDATE_MESSAGE_TYPE) memberUpdatesToCarol.push(message)
    })
    const logEntriesBefore = brokerEntryCount(broker, space.id)

    // Neustart: die VE-C3-Recovery nimmt das gestagte Removal wieder auf.
    const restarted = await createLogSyncPeer('', broker, 'alice-socket-2', '11111111-1111-4111-8111-111111111111', {
      identity: alice.identity, stores: alice.stores,
    })
    await waitUntil(
      async () => (brokerGeneration(broker, space.id) ?? 0) > 0
        && (await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())) === null,
      'die abgeschlossene Recovery',
    )
    // Bounded Karenz für ein etwaiges (hier unerwünschtes) member-update bzw.
    // einen zusätzlichen Log-Eintrag: prüft die ABWESENHEIT eines Effekts.
    await wait()

    expect(brokerGeneration(broker, space.id)!).toBeGreaterThan(0)
    expect(await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())).toBeNull()
    // Kein member-update an das verbliebene Mitglied …
    expect(memberUpdatesToCarol).toHaveLength(0)
    // … kein zusätzlicher Log-Eintrag (die Rotation allein schreibt keinen) …
    expect(brokerEntryCount(broker, space.id)).toBe(logEntriesBefore)
    // … genau EIN removed-Ereignis für Bob …
    expect(membershipEventsOf(restarted.adapter, space.id)
      .filter((event) => event.did === bob.identity.getDid() && event.status === 'removed')).toHaveLength(1)
    // … und Bob hat den neuen Schlüssel weiterhin nicht.
    expect(await adapterGeneration(bob.adapter, space.id)).toBeLessThanOrEqual(0)
  })

  it('Reconnect nimmt ein gestagtes Removal wieder auf und schließt die Rotation ab', async () => {
    const broker = new InProcessLogBroker()
    const alice = await createLogSyncPeer('am-reconnect-alice', broker, 'alice-socket', '11111111-1111-4111-8111-111111111111')
    const bob = await createLogSyncPeer('am-reconnect-bob', broker, 'bob-socket', '22222222-2222-4222-8222-222222222222')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await waitForSpaceRegistered(broker, space.id)
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitForSpace(bob, space.id)

    // Home-Broker unerreichbar: die Rotation bleibt gestagt.
    const realHandleControlFrame = broker.handleControlFrame.bind(broker)
    ;(broker as unknown as { handleControlFrame: unknown }).handleControlFrame = async (socketId: string, frame: { type?: string }) => {
      if (frame.type === SPACE_ROTATE_MESSAGE_TYPE) throw new Error('injected: broker unreachable')
      return realHandleControlFrame(socketId, frame as never)
    }
    await bob.adapter.leaveSpace(space.id)
    await waitUntil(
      async () => (await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())) !== null,
      'das gestagte Removal bei Alice',
    )
    expect((await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid()))?.kind).toBe('canonical-self-removal-rotation')
    expect(brokerGeneration(broker, space.id)).toBe(0)

    // Broker wieder erreichbar + echter Reconnect (disconnect → connect).
    ;(broker as unknown as { handleControlFrame: unknown }).handleControlFrame = realHandleControlFrame
    await alice.messaging.disconnect()
    await alice.messaging.connect(alice.identity.getDid())
    // Der Reconnect-Pfad ist um 2s entprellt — auf das ERGEBNIS warten, nicht
    // auf die Entprellung.
    await waitUntil(
      async () => (brokerGeneration(broker, space.id) ?? 0) > 0
        && (await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())) === null,
      'die nach dem Reconnect abgeschlossene Rotation',
    )

    expect(brokerGeneration(broker, space.id)!).toBeGreaterThan(0)
    expect(await alice.docLogStore.getPendingRemoval(space.id, bob.identity.getDid())).toBeNull()
  }, 20_000)
})
