/**
 * Slice 1.B.3-admin-management, Step 3 (Automerge-Mirror der Yjs-Step-2-Tests).
 *
 * Echte Admin-Liste im synchronisierten Doc (doc._admins, grow-only Add-only-Set,
 * VE-1) statt der createdBy-Single-Admin-Approximation. info.admins ist die
 * read-only Projektion der AKTIVEN Admins (resolveActiveAdmins = _admins ∩
 * aktive _members, Sync 005 Z.111-130 "Teilmenge von members").
 *
 * Spec-Anker:
 * - Z.111-130: admins = Teilmenge von members, CRDT-Operationen unrestricted.
 * - Z.221: ein Admin DARF einen Member zum Admin befoerdern (admin-add).
 * - Z.229-234: Entfernung eines Members ist Admin-Recht (client-enforced ueber
 *   knownAdminDids / spaceAdminDids).
 *
 * Die 11 Pflicht-Tests (Direktive Abschnitt 6), AM-seitig.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
} from '@web_of_trust/core/adapters'
import {
  resolveActiveAdmins,
  KEY_ROTATION_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { AdminEntry, DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

interface TestDoc { items: Record<string, { title: string }> }

function spaceState(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

function spaceDoc(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  const state = spaceState(adapter, spaceId)
  return (adapter as unknown as { repo: { handles: Record<string, { doc(): unknown }> } }).repo.handles[state.documentId]?.doc()
}

function adminEntries(adapter: AutomergeReplicationAdapter, spaceId: string): AdminEntry[] {
  const doc = spaceDoc(adapter, spaceId)
  return Object.values((doc?._admins ?? {}) as Record<string, AdminEntry>)
}

/** Greift den privaten Admin-Authority-Helper ab (Call-Site-Quelle der 4 Checks). */
function spaceAdminDids(adapter: AutomergeReplicationAdapter, spaceId: string): string[] {
  const state = spaceState(adapter, spaceId)
  return (adapter as unknown as { spaceAdminDids(space: any): string[] }).spaceAdminDids(state)
}

interface Peer {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  adapter: AutomergeReplicationAdapter
  metadata: InMemorySpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
  compactStore: InMemoryCompactStore
}

const cleanups: Array<() => Promise<void>> = []

async function createPeer(passphrase: string): Promise<Peer> {
  const identity = (await createTestIdentity(passphrase)).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(identity.getDid())
  const metadata = new InMemorySpaceMetadataStorage()
  const keyManagement = new InMemoryKeyManagementAdapter()
  const compactStore = new InMemoryCompactStore()
  const adapter = new AutomergeReplicationAdapter({
    identity,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement,
    metadataStorage: metadata,
    compactStore,
  })
  await adapter.start()
  cleanups.push(async () => {
    await adapter.stop()
    try { await identity.deleteStoredIdentity() } catch {}
  })
  return { identity, messaging, adapter, metadata, keyManagement, compactStore }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

/**
 * Selbstkonsistente gen-1-Rotation vom jeweiligen Sender (wie
 * AutomergeMembershipEvents Pflicht-Test 9): nur der Authority-Check
 * (knownAdminDids = spaceAdminDids) kann sie stoppen.
 */
async function craftedRotation(
  sender: PublicIdentitySession,
  recipient: PublicIdentitySession,
  spaceId: string,
): Promise<DidcommPlaintextMessage> {
  const port = new InMemoryKeyManagementAdapter()
  await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: sender.getDid() })
  await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId, ownerDid: sender.getDid() })
  const body = await buildKeyRotationBody({ keyPort: port, spaceId, newGeneration: 1, recipientDid: recipient.getDid() })
  return deliverInboxMessage({
    type: KEY_ROTATION_MESSAGE_TYPE,
    body: body as unknown as Record<string, unknown>,
    from: sender.getDid(),
    to: recipient.getDid(),
    recipientEncryptionPublicKey: await recipient.getEncryptionPublicKeyBytes(),
    sign: (input) => sender.signEd25519(input),
    crypto: protocolCrypto,
  })
}

describe('Pflicht-Test 1 — Creator = initialer Admin', () => {
  it('createSpace seedt doc._admins[creator]; info.admins === [creator]; spaceAdminDids liefert ihn', async () => {
    const alice = await createPeer('am-admin1-alice')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    const entries = adminEntries(alice.adapter, space.id)
    expect(entries.map((e) => e.did)).toEqual([alice.identity.getDid()])

    const info = await alice.adapter.getSpace(space.id)
    expect(info!.admins).toEqual([alice.identity.getDid()])
    expect(spaceAdminDids(alice.adapter, space.id)).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 2 — Promote: Member wird Admin und kann danach rotieren', () => {
  it('Admin promotet B → info.admins enthaelt beide; B-Rotation vorher rejected, nachher applied', async () => {
    const alice = await createPeer('am-admin2-alice')
    const bob = await createPeer('am-admin2-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    // Vorher: B ist kein Admin → eine von B signierte Rotation wird rejected.
    await bob.messaging.send(await craftedRotation(bob.identity, alice.identity, space.id))
    await wait()
    expect(await alice.keyManagement.getCurrentGeneration(space.id)).toBe(0)

    // Alice promotet Bob.
    await alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())
    const info = await alice.adapter.getSpace(space.id)
    expect([...info!.admins!].sort()).toEqual([alice.identity.getDid(), bob.identity.getDid()].sort())

    // Doc-Sync traegt die Promotion zu Bob.
    await waitUntil(async () => spaceAdminDids(bob.adapter, space.id).includes(bob.identity.getDid()))
    expect(spaceAdminDids(bob.adapter, space.id)).toContain(bob.identity.getDid())

    // Nachher: dieselbe Rotation von B wird jetzt applied (B ist Admin in alices Liste).
    await alice.messaging.send(await craftedRotation(bob.identity, alice.identity, space.id))
    await waitUntil(async () => (await alice.keyManagement.getCurrentGeneration(space.id)) === 1)
    expect(await alice.keyManagement.getCurrentGeneration(space.id)).toBe(1)
  })
})

describe('Pflicht-Test 3 — Promote-Guard: Nicht-Admin darf nicht befoerdern', () => {
  it('Nicht-Admin ruft promoteToAdmin → Fehler, doc._admins unveraendert', async () => {
    const alice = await createPeer('am-admin3-alice')
    const bob = await createPeer('am-admin3-bob')
    const carol = await createPeer('am-admin3-carol')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () =>
      (await bob.adapter.getSpace(space.id))?.members.length === 3
      && (await carol.adapter.getSpace(space.id))?.members.length === 3)

    // Bob (Nicht-Admin) versucht, Carol zu befoerdern → Fehler.
    await expect(bob.adapter.promoteToAdmin(space.id, carol.identity.getDid())).rejects.toThrow()

    // Bobs doc._admins traegt weiterhin nur den Creator.
    expect(adminEntries(bob.adapter, space.id).map((e) => e.did)).toEqual([alice.identity.getDid()])
    expect(spaceAdminDids(bob.adapter, space.id)).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 4 — member-update-Authority via echter Liste', () => {
  it('promoteter Admin B ist in spaceAdminDids → member-update von B haette Authority-Level 1', async () => {
    const alice = await createPeer('am-admin4-alice')
    const bob = await createPeer('am-admin4-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    // Vorher: B kein Admin.
    expect(spaceAdminDids(alice.adapter, space.id)).not.toContain(bob.identity.getDid())

    await alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())

    // Die member-update-Authority (knownAdminDids = spaceAdminDids) kennt B jetzt.
    expect(spaceAdminDids(alice.adapter, space.id)).toContain(bob.identity.getDid())
  })
})

describe('Pflicht-Test 5 — CRDT-Merge konkurrierender Promotes + Idempotenz', () => {
  it('zwei Promotes verschiedener Members + Doppel-Promote → grow-only, kein Verlust, idempotent', async () => {
    const alice = await createPeer('am-admin5-alice')
    const bob = await createPeer('am-admin5-bob')
    const carol = await createPeer('am-admin5-carol')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () =>
      (await bob.adapter.getSpace(space.id))?.members.length === 3
      && (await carol.adapter.getSpace(space.id))?.members.length === 3)

    await alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())
    await alice.adapter.promoteToAdmin(space.id, carol.identity.getDid())
    // Doppel-Promote derselben DID = idempotenter no-op (kein doppelter Eintrag).
    await alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())

    const entries = adminEntries(alice.adapter, space.id)
    expect(entries.map((e) => e.did).sort()).toEqual(
      [alice.identity.getDid(), bob.identity.getDid(), carol.identity.getDid()].sort(),
    )
    // Genau ein Eintrag pro DID (grow-only Set, kein Duplikat durch Re-Promote).
    expect(entries.length).toBe(3)

    const info = await alice.adapter.getSpace(space.id)
    expect([...info!.admins!].sort()).toEqual(
      [alice.identity.getDid(), bob.identity.getDid(), carol.identity.getDid()].sort(),
    )
  })
})

describe('Pflicht-Test 6 — Alt-Space-Fallback', () => {
  it('Space mit leerem _admins (nur createdBy) → spaceAdminDids = [createdBy] ∩ active', async () => {
    const alice = await createPeer('am-admin6-alice')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    // Alt-Space-Simulation: _admins aus dem Doc loeschen (pre-slice Space).
    const state = spaceState(alice.adapter, space.id)
    const repo = (alice.adapter as unknown as { repo: Repo }).repo
    const handle = (repo as any).handles[state.documentId]
    handle.change((d: any) => { delete d._admins })
    // info.admins-Projektion ebenfalls leeren (simuliert restore ohne _admins).
    state.info = { ...state.info, admins: undefined }

    expect(adminEntries(alice.adapter, space.id)).toHaveLength(0)
    // Fallback: [createdBy ?? members[0]] ∩ active — niemals leer fuer einen live Space.
    expect(spaceAdminDids(alice.adapter, space.id)).toEqual([alice.identity.getDid()])
  })

  it('createdBy inaktiv → Fallback auf aktives Mitglied, NICHT den inaktiven Creator (Risk 3)', async () => {
    const alice = await createPeer('am-admin6b-alice')
    const bob = await createPeer('am-admin6b-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await alice.adapter.getSpace(space.id))?.members.length === 2)

    // Alt-Space-Simulation: _admins entfernen; createdBy (alice) ist kein
    // aktives Mitglied mehr (nur bob aktiv).
    const state = spaceState(alice.adapter, space.id)
    const repo = (alice.adapter as unknown as { repo: Repo }).repo
    const handle = (repo as any).handles[state.documentId]
    handle.change((d: any) => { delete d._admins })
    state.info = { ...state.info, members: [bob.identity.getDid()], admins: undefined }

    // Fallback DARF NICHT den inaktiven createdBy liefern, sondern das aktive Mitglied.
    expect(spaceAdminDids(alice.adapter, space.id)).toEqual([bob.identity.getDid()])
  })
})

describe('Pflicht-Test 7 — Invitee sieht aktive Admins aus dem Snapshot', () => {
  it('Dritt-Member-Invite nach Promote: Invitee info.admins = aktuelle aktive Admin-Liste', async () => {
    const alice = await createPeer('am-admin7-alice')
    const bob = await createPeer('am-admin7-bob')
    const carol = await createPeer('am-admin7-carol')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())

    // Carol wird NACH der Promotion eingeladen — ihr Snapshot traegt _admins = {alice, bob}.
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () =>
      (await carol.adapter.getSpace(space.id))?.members.length === 3
      && spaceAdminDids(carol.adapter, space.id).length === 2)

    const carolSpace = await carol.adapter.getSpace(space.id)
    expect([...carolSpace!.admins!].sort()).toEqual([alice.identity.getDid(), bob.identity.getDid()].sort())
  })
})

describe('Pflicht-Test 8 — Nur aktive Members promotebar', () => {
  it('promoteToAdmin fuer Nicht-Member → Fehler, _admins unveraendert', async () => {
    const alice = await createPeer('am-admin8-alice')
    const stranger = await createPeer('am-admin8-stranger')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    await expect(alice.adapter.promoteToAdmin(space.id, stranger.identity.getDid())).rejects.toThrow()
    expect(adminEntries(alice.adapter, space.id).map((e) => e.did)).toEqual([alice.identity.getDid()])
  })

  it('promoteToAdmin fuer entfernten Member → Fehler', async () => {
    const alice = await createPeer('am-admin8b-alice')
    const bob = await createPeer('am-admin8b-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.removeMember(space.id, bob.identity.getDid())

    await expect(alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())).rejects.toThrow()
  })
})

describe('Pflicht-Test 9 — Entfernter Admin verliert Autoritaet (Active-Member-Intersection)', () => {
  it('Admin B promotet → B als Member entfernt → B NICHT mehr in info.admins/spaceAdminDids; B-Rotation rejected', async () => {
    const alice = await createPeer('am-admin9-alice')
    const bob = await createPeer('am-admin9-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.promoteToAdmin(space.id, bob.identity.getDid())
    expect(spaceAdminDids(alice.adapter, space.id)).toContain(bob.identity.getDid())

    // B als Member entfernen — _admins bleibt grow-only, die Intersection entzieht.
    await alice.adapter.removeMember(space.id, bob.identity.getDid())

    // Doc-internes _admins traegt B noch (grow-only), aber die aktive Projektion nicht.
    expect(adminEntries(alice.adapter, space.id).map((e) => e.did)).toContain(bob.identity.getDid())
    expect(spaceAdminDids(alice.adapter, space.id)).not.toContain(bob.identity.getDid())
    const info = await alice.adapter.getSpace(space.id)
    expect(info!.admins).not.toContain(bob.identity.getDid())
    expect(info!.admins).toEqual([alice.identity.getDid()])

    // resolveActiveAdmins-Lese-Regel direkt bestaetigen.
    expect(resolveActiveAdmins(adminEntries(alice.adapter, space.id), info!.members)).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 10 — removeMember-Admin-Guard', () => {
  it('Nicht-Admin ruft removeMember → Fehler, kein removed-Event, keine Rotation', async () => {
    const alice = await createPeer('am-admin10-alice')
    const bob = await createPeer('am-admin10-bob')
    const carol = await createPeer('am-admin10-carol')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () =>
      (await bob.adapter.getSpace(space.id))?.members.length === 3
      && (await carol.adapter.getSpace(space.id))?.members.length === 3)

    const genBefore = await bob.keyManagement.getCurrentGeneration(space.id)

    // Bob (Nicht-Admin) versucht, Carol zu entfernen → Fehler VOR jeder Mutation.
    await expect(bob.adapter.removeMember(space.id, carol.identity.getDid())).rejects.toThrow()

    // Kein removed-Event in Bobs Doc, keine Rotation.
    const doc = spaceDoc(bob.adapter, space.id)
    const removedKeys = Object.keys((doc?._members ?? {})).filter((k) => k.endsWith(':removed'))
    expect(removedKeys).toHaveLength(0)
    expect(await bob.keyManagement.getCurrentGeneration(space.id)).toBe(genBefore)
  })

  it('Self-Leave bleibt erlaubt: removeMember(self) durch Nicht-Admin wirft NICHT am Admin-Guard', async () => {
    // Self-Leave laeuft AM-seitig ueber leaveSpace, nicht removeMember(self) —
    // der Admin-Guard darf den eigenen Leave-Pfad nicht brechen. removeMember
    // durch einen Admin (Creator) auf einen anderen Member bleibt erlaubt.
    const alice = await createPeer('am-admin10b-alice')
    const bob = await createPeer('am-admin10b-bob')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    // Admin (alice) entfernt bob → erlaubt (Baseline-Verhalten bleibt).
    await expect(alice.adapter.removeMember(space.id, bob.identity.getDid())).resolves.toBeUndefined()
    expect((await alice.adapter.getSpace(space.id))!.members).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 11 — admins-Roundtrip (VE-6)', () => {
  it('promote → save → Restore re-projiziert info.admins aus dem Doc', async () => {
    const aliceId = (await createTestIdentity('am-admin11-alice')).identity
    const bobId = (await createTestIdentity('am-admin11-bob')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(aliceId.getDid())
    const bobMessaging = new InMemoryMessagingAdapter()
    await bobMessaging.connect(bobId.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    const bobAdapter = new AutomergeReplicationAdapter({
      identity: bobId, messaging: bobMessaging, brokerUrls: ['wss://b'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(), compactStore: new InMemoryCompactStore(),
    })
    await bobAdapter.start()

    const adapter1 = new AutomergeReplicationAdapter({
      identity: aliceId, messaging, brokerUrls: ['wss://b'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await adapter1.addMember(space.id, bobId.getDid(), await bobId.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null)
    await adapter1.promoteToAdmin(space.id, bobId.getDid())
    expect([...(await adapter1.getSpace(space.id))!.admins!].sort())
      .toEqual([aliceId.getDid(), bobId.getDid()].sort())

    await (adapter1 as any)._saveToCompactStore(spaceState(adapter1, space.id))
    await adapter1.stop()

    // Restore mit neuem Adapter (gleiche Identity, gleiche Metadata + CompactStore).
    const adapter2 = new AutomergeReplicationAdapter({
      identity: aliceId, messaging, brokerUrls: ['wss://b'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      await bobAdapter.stop()
      try { await aliceId.deleteStoredIdentity() } catch {}
      try { await bobId.deleteStoredIdentity() } catch {}
    })

    // info.admins ist nach Restore AUS DEM DOC re-projiziert.
    await waitUntil(async () => ((await adapter2.getSpace(space.id))?.admins?.length ?? 0) === 2)
    const restored = await adapter2.getSpace(space.id)
    expect([...restored!.admins!].sort()).toEqual([aliceId.getDid(), bobId.getDid()].sort())
    expect(spaceAdminDids(adapter2, space.id).sort()).toEqual([aliceId.getDid(), bobId.getDid()].sort())
  })

  it('zwischen Save und Restore als Member entfernter Admin ist nach Restore NICHT in info.admins', async () => {
    const aliceId = (await createTestIdentity('am-admin11b-alice')).identity
    const bobId = (await createTestIdentity('am-admin11b-bob')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(aliceId.getDid())
    const bobMessaging = new InMemoryMessagingAdapter()
    await bobMessaging.connect(bobId.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    const bobAdapter = new AutomergeReplicationAdapter({
      identity: bobId, messaging: bobMessaging, brokerUrls: ['wss://b'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(), compactStore: new InMemoryCompactStore(),
    })
    await bobAdapter.start()

    const adapter1 = new AutomergeReplicationAdapter({
      identity: aliceId, messaging, brokerUrls: ['wss://b'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await adapter1.addMember(space.id, bobId.getDid(), await bobId.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null)
    await adapter1.promoteToAdmin(space.id, bobId.getDid())
    // Bob als Member entfernen — grow-only _admins behaelt ihn, aktive Projektion nicht.
    await adapter1.removeMember(space.id, bobId.getDid())
    await (adapter1 as any)._saveToCompactStore(spaceState(adapter1, space.id))
    await adapter1.stop()

    const adapter2 = new AutomergeReplicationAdapter({
      identity: aliceId, messaging, brokerUrls: ['wss://b'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      await bobAdapter.stop()
      try { await aliceId.deleteStoredIdentity() } catch {}
      try { await bobId.deleteStoredIdentity() } catch {}
    })

    await waitUntil(async () => (await adapter2.getSpace(space.id)) !== null)
    const restored = await adapter2.getSpace(space.id)
    expect(restored!.admins).toEqual([aliceId.getDid()])
    expect(spaceAdminDids(adapter2, space.id)).toEqual([aliceId.getDid()])
  })
})

describe('Metadata-Serializer-Byte-Konsistenz (Risk 6)', () => {
  it('info.admins roundtrippt durch AutomergeSpaceMetadataStorage (Pre-Load-Cache)', async () => {
    const { AutomergeSpaceMetadataStorage } = await import('../src/AutomergeSpaceMetadataStorage')
    const doc: any = { spaces: {}, groupKeys: {} }
    const storage = new AutomergeSpaceMetadataStorage({
      getPersonalDoc: () => doc,
      changePersonalDoc: (fn) => { fn(doc); return doc },
    })
    const admins = ['did:key:zAlice', 'did:key:zBob']
    await storage.saveSpaceMetadata({
      info: {
        id: 's1', type: 'shared', members: ['did:key:zAlice', 'did:key:zBob'],
        createdBy: 'did:key:zAlice', admins, createdAt: '2026-01-01T00:00:00.000Z',
      },
      documentId: 'doc1', documentUrl: 'automerge:doc1', memberEncryptionKeys: {},
    })
    const loaded = await storage.loadSpaceMetadata('s1')
    expect(loaded!.info.admins).toEqual(admins)
  })

  it('fehlendes admins-Feld (Alt-Cache) → undefined nach deserialize (null-Guard wie createdBy)', async () => {
    const { AutomergeSpaceMetadataStorage } = await import('../src/AutomergeSpaceMetadataStorage')
    const doc: any = {
      spaces: {
        s1: {
          info: { id: 's1', type: 'shared', name: null, description: null, members: ['did:key:zAlice'], createdBy: 'did:key:zAlice', createdAt: '2026-01-01T00:00:00.000Z' },
          documentId: 'doc1', documentUrl: 'automerge:doc1', memberEncryptionKeys: {},
        },
      },
      groupKeys: {},
    }
    const storage = new AutomergeSpaceMetadataStorage({
      getPersonalDoc: () => doc,
      changePersonalDoc: (fn) => { fn(doc); return doc },
    })
    const loaded = await storage.loadSpaceMetadata('s1')
    expect(loaded!.info.admins).toBeUndefined()
  })
})
