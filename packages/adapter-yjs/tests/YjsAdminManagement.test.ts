/**
 * Slice 1.B.3-admin-management, Step 2 (Yjs): echte Admin-Liste als grow-only
 * `_admins`-Map im synchronisierten Doc, Projektion `info.admins` der AKTIVEN
 * Admins (`resolveActiveAdmins(_admins, resolveActiveMembers(_members))`),
 * `promoteToAdmin`, removeMember-Admin-Guard und Alt-Space-Fallback.
 *
 * Spec-Anker (Sync 005):
 *  - Z.111-130: `admins` ist die Haupt-DID-Liste der Admins, TEILMENGE von
 *    `members`; CRDT-Operationen, nicht autoritaetsgeprueft.
 *  - Z.221: ein Admin DARF einen Member zum Admin befoerdern (Add-only).
 *  - Z.229-234: Entfernung/Rotation ist Admin-Recht (client-enforced).
 *
 * Pflicht-Tests (Direktive §6) fuer Yjs:
 *  1  Creator = initialer Admin
 *  2  Promote enables rotation (Authority via echter Liste)
 *  3  Promote-Guard (Nicht-Admin → Fehler, _admins unveraendert)
 *  4  member-update-Authority via echter Liste
 *  5  konkurrierende Promotes mergen (grow-only) + idempotent
 *  6  Alt-Space-Fallback ([createdBy ?? members[0]])
 *  7  Invitee sieht Admins aus dem Snapshot
 *  8  Nur aktive Members promotebar
 *  9  Entfernter Admin verliert Autoritaet
 * 10  removeMember-Guard (Nicht-Admin → Fehler, kein Event/Rotation)
 * 11  admins-Roundtrip (Restore re-projiziert aus dem Doc, inkl.
 *     removed-between-save-and-restore)
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
} from '@web_of_trust/core/adapters'
import {
  formatMembershipEventKey, resolveActiveMembers, resolveActiveAdmins,
  KEY_ROTATION_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { MembershipEvent, AdminEntry, DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

interface TestDoc { items: Record<string, { title: string }> }

function spaceState(adapter: YjsReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

function adminEntries(adapter: YjsReplicationAdapter, spaceId: string): Map<string, AdminEntry> {
  const doc: Y.Doc = spaceState(adapter, spaceId).doc
  const entries = new Map<string, AdminEntry>()
  doc.getMap<AdminEntry>('_admins').forEach((value, key) => entries.set(key, value))
  return entries
}

function inbox(messaging: InMemoryMessagingAdapter): DidcommPlaintextMessage[] {
  const captured: DidcommPlaintextMessage[] = []
  messaging.onMessage((message: WireMessage) => {
    if (isDidcommMessage(message)) captured.push(message)
  })
  return captured
}

interface Peer {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  adapter: YjsReplicationAdapter
  metadata: InMemorySpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
  compactStore: InMemoryCompactStore
}

const cleanups: Array<() => Promise<void>> = []

async function createPeer(passphrase: string, shared?: {
  metadata?: InMemorySpaceMetadataStorage
  keyManagement?: InMemoryKeyManagementAdapter
  compactStore?: InMemoryCompactStore
  identity?: PublicIdentitySession
}): Promise<Peer> {
  const identity = shared?.identity ?? (await createTestIdentity(passphrase)).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(identity.getDid())
  const metadata = shared?.metadata ?? new InMemorySpaceMetadataStorage()
  const keyManagement = shared?.keyManagement ?? new InMemoryKeyManagementAdapter()
  const compactStore = shared?.compactStore ?? new InMemoryCompactStore()
  const adapter = new YjsReplicationAdapter({
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
  })
  return { identity, messaging, adapter, metadata, keyManagement, compactStore }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

describe('Pflicht-Test 1 — Creator = initialer Admin', () => {
  it('createSpace seedet _admins[creator]; info.admins = [creator]; spaceAdminDids liefert ihn', async () => {
    const alice = await createPeer('admin-init')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    const entries = adminEntries(alice.adapter, space.id)
    expect(entries.size).toBe(1)
    expect(entries.get(alice.identity.getDid())).toMatchObject({ did: alice.identity.getDid() })

    expect(space.admins).toEqual([alice.identity.getDid()])
    const state = spaceState(alice.adapter, space.id)
    expect(state.info.admins).toEqual([alice.identity.getDid()])
    expect((alice.adapter as any).spaceAdminDids(state)).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 2 — Promote enables rotation', () => {
  it('Admin promotet Member B → info.admins enthaelt beide; B kann danach rotieren (vorher rejected)', async () => {
    const alice = await createPeer('promrot-alice')
    const bob = await createPeer('promrot-bob')
    const carol = await createPeer('promrot-carol')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => ((await carol.adapter.getSpace(space.id))?.members.length === 3))

    // Selbstkonsistente gen-1-Rotation vom jeweiligen Sender (wie Membership-Test 9).
    async function craftedRotation(sender: PublicIdentitySession): Promise<DidcommPlaintextMessage> {
      const port = new InMemoryKeyManagementAdapter()
      await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: sender.getDid() })
      await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: sender.getDid() })
      const body = await buildKeyRotationBody({ keyPort: port, spaceId: space.id, newGeneration: 1, recipientDid: carol.identity.getDid() })
      return deliverInboxMessage({
        type: KEY_ROTATION_MESSAGE_TYPE,
        body: body as unknown as Record<string, unknown>,
        from: sender.getDid(),
        to: carol.identity.getDid(),
        recipientEncryptionPublicKey: await carol.identity.getEncryptionPublicKeyBytes(),
        sign: (input) => sender.signEd25519(input),
        crypto: protocolCrypto,
      })
    }

    // VORHER: B ist kein Admin → carol rejected die Rotation, Generation bleibt 0.
    await bob.messaging.send(await craftedRotation(bob.identity))
    await wait()
    expect(await carol.keyManagement.getCurrentGeneration(space.id)).toBe(0)

    // Promote B durch alice (Admin).
    await alice.adapter.promoteToAdmin(space.id, bobDid)
    const aliceState = spaceState(alice.adapter, space.id)
    expect([...aliceState.info.admins].sort()).toEqual([alice.identity.getDid(), bobDid].sort())

    // Das _admins-Event propagiert via CRDT-Sync zu carol — sie zaehlt B nun als Admin.
    await waitUntil(async () => ((await carol.adapter.getSpace(space.id))?.admins ?? []).includes(bobDid))
    const carolSpace = await carol.adapter.getSpace(space.id)
    expect(carolSpace!.admins).toContain(bobDid)

    // NACHHER: identische Rotation von B → carol applied, Generation 1.
    await bob.messaging.send(await craftedRotation(bob.identity))
    await waitUntil(async () => (await carol.keyManagement.getCurrentGeneration(space.id)) === 1)
    expect(await carol.keyManagement.getCurrentGeneration(space.id)).toBe(1)
  })
})

describe('Pflicht-Test 3 — Promote-Guard', () => {
  it('Nicht-Admin ruft promoteToAdmin → Fehler, _admins unveraendert', async () => {
    const alice = await createPeer('guard-alice')
    const bob = await createPeer('guard-bob')
    const carol = await createPeer('guard-carol')
    const bobDid = bob.identity.getDid()
    const carolDid = carol.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.addMember(space.id, carolDid, await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => ((await bob.adapter.getSpace(space.id))?.members.length === 3))

    // bob ist nur Member (kein Admin) und versucht, carol zu befoerdern.
    await expect(bob.adapter.promoteToAdmin(space.id, carolDid)).rejects.toThrow()

    // _admins bei bob unveraendert (nur alice).
    const bobEntries = adminEntries(bob.adapter, space.id)
    expect(Array.from(bobEntries.keys())).toEqual([alice.identity.getDid()])
    const bobSpace = await bob.adapter.getSpace(space.id)
    expect(bobSpace!.admins).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 4 — member-update-Authority via echter Liste', () => {
  it('member-update signiert vom promoteten Admin B → Authority-Level 1 (vorher 0)', async () => {
    const alice = await createPeer('mu-alice')
    const bob = await createPeer('mu-bob')
    const carol = await createPeer('mu-carol')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => ((await carol.adapter.getSpace(space.id))?.members.length === 3))

    // VORHER: carol sieht B nicht als Admin → spaceAdminDids ohne B.
    const carolState0 = spaceState(carol.adapter, space.id)
    expect((carol.adapter as any).spaceAdminDids(carolState0)).not.toContain(bobDid)

    await alice.adapter.promoteToAdmin(space.id, bobDid)
    await waitUntil(async () => ((await carol.adapter.getSpace(space.id))?.admins ?? []).includes(bobDid))

    // NACHHER: B ist in carols spaceAdminDids → member-update von B traegt Authority 1.
    const carolState1 = spaceState(carol.adapter, space.id)
    expect((carol.adapter as any).spaceAdminDids(carolState1)).toContain(bobDid)
  })
})

describe('Pflicht-Test 5 — konkurrierende Promotes mergen + idempotent', () => {
  it('zwei Admins promoten verschiedene Members offline → nach Merge beide in info.admins; doppelt = idempotent', async () => {
    // Offline-Divergenz direkt auf der _admins-Map (grow-only Set, verschiedene Keys).
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const X = 'did:key:z6MkPromoteX'
    const Y_DID = 'did:key:z6MkPromoteY'
    docA.getMap<AdminEntry>('_admins').set(X, { did: X, addedBy: 'did:key:z6MkAdminA' })
    docB.getMap<AdminEntry>('_admins').set(Y_DID, { did: Y_DID, addedBy: 'did:key:z6MkAdminB' })

    const updateA = Y.encodeStateAsUpdate(docA)
    const updateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docB, updateA)
    Y.applyUpdate(docA, updateB)

    for (const doc of [docA, docB]) {
      const map = doc.getMap<AdminEntry>('_admins')
      expect(map.get(X)).toMatchObject({ did: X })
      expect(map.get(Y_DID)).toMatchObject({ did: Y_DID })
      expect(map.size).toBe(2)
      const entries = Array.from(map.values())
      expect(resolveActiveAdmins(entries, [X, Y_DID]).sort()).toEqual([X, Y_DID].sort())
    }

    // Idempotenz: dieselbe DID doppelt promotet → derselbe Key, Set bleibt bei 1.
    const docC = new Y.Doc()
    docC.getMap<AdminEntry>('_admins').set(X, { did: X })
    docC.getMap<AdminEntry>('_admins').set(X, { did: X })
    expect(docC.getMap('_admins').size).toBe(1)
  })

  it('promoteToAdmin ist idempotent (re-promote = no-op, kein zweiter Eintrag)', async () => {
    const alice = await createPeer('idem-alice')
    const bob = await createPeer('idem-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    await alice.adapter.promoteToAdmin(space.id, bobDid)
    await alice.adapter.promoteToAdmin(space.id, bobDid)

    const entries = adminEntries(alice.adapter, space.id)
    expect(entries.size).toBe(2) // alice + bob, nicht mehr
    const aliceSpace = await alice.adapter.getSpace(space.id)
    expect([...aliceSpace!.admins!].sort()).toEqual([alice.identity.getDid(), bobDid].sort())
  })
})

describe('Pflicht-Test 6 — Alt-Space-Fallback', () => {
  it('Space mit leerem _admins → spaceAdminDids = [createdBy] (Parität zur alten Demo)', async () => {
    const alice = await createPeer('alt-alice')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    const state = spaceState(alice.adapter, space.id)

    // Alt-Space simulieren: _admins leeren (Pre-Slice-Stand).
    state.doc.transact(() => {
      const map = state.doc.getMap('_admins')
      Array.from(map.keys()).forEach((k) => map.delete(k))
    }, 'local')

    expect(state.doc.getMap('_admins').size).toBe(0)
    expect((alice.adapter as any).spaceAdminDids(state)).toEqual([alice.identity.getDid()])
  })

  it('Fallback ∩ active: createdBy nicht mehr aktiv → fällt auf members[0] der aktiven Liste, NIE leer', async () => {
    const alice = await createPeer('alt-fallback-alice')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    const state = spaceState(alice.adapter, space.id)

    // _admins leeren + createdBy auf eine nicht-aktive DID setzen.
    const stranger = 'did:key:z6MkStrangerCreator'
    state.doc.transact(() => {
      const map = state.doc.getMap('_admins')
      Array.from(map.keys()).forEach((k) => map.delete(k))
    }, 'local')
    state.info = { ...state.info, createdBy: stranger }

    // createdBy ist nicht aktiv → Fallback ∩ active fällt auf members[0] (alice).
    const result = (alice.adapter as any).spaceAdminDids(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 7 — Invitee sieht Admins aus dem Snapshot', () => {
  it('Dritt-Member-Invite → Invitee info.admins = aktuelle aktive Admin-Liste aus dem Snapshot', async () => {
    const alice = await createPeer('inv-alice')
    const bob = await createPeer('inv-bob')
    const carol = await createPeer('inv-carol')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.promoteToAdmin(space.id, bobDid)

    // carol wird erst NACH der Promotion eingeladen → der Invite-Snapshot traegt _admins[alice,bob].
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => ((await carol.adapter.getSpace(space.id))?.members.length === 3))

    const carolSpace = await carol.adapter.getSpace(space.id)
    expect([...carolSpace!.admins!].sort()).toEqual([alice.identity.getDid(), bobDid].sort())
  })
})

describe('Pflicht-Test 8 — Nur aktive Members promotebar', () => {
  it('promoteToAdmin für Nicht-Member → Fehler, _admins unveraendert', async () => {
    const alice = await createPeer('active-alice')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    const stranger = 'did:key:z6MkNotAMember'
    await expect(alice.adapter.promoteToAdmin(space.id, stranger)).rejects.toThrow()
    expect(adminEntries(alice.adapter, space.id).size).toBe(1)
  })

  it('promoteToAdmin für entfernten Member → Fehler', async () => {
    const alice = await createPeer('active-rm-alice')
    const bob = await createPeer('active-rm-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.removeMember(space.id, bobDid)
    await waitUntil(() => spaceState(alice.adapter, space.id).info.members.includes(bobDid) === false)

    await expect(alice.adapter.promoteToAdmin(space.id, bobDid)).rejects.toThrow()
  })
})

describe('Pflicht-Test 9 — Entfernter Admin verliert Autoritaet', () => {
  it('Admin B promotet → dann B als Member entfernt → B nicht mehr in info.admins/spaceAdminDids', async () => {
    const alice = await createPeer('lose-alice')
    const bob = await createPeer('lose-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.promoteToAdmin(space.id, bobDid)

    const state = spaceState(alice.adapter, space.id)
    expect(state.info.admins).toContain(bobDid)
    expect((alice.adapter as any).spaceAdminDids(state)).toContain(bobDid)

    // B als Member entfernen → die Intersection entzieht B die Admin-Eigenschaft.
    await alice.adapter.removeMember(space.id, bobDid)
    await waitUntil(() => state.info.members.includes(bobDid) === false)

    // _admins ist grow-only → der Roh-Eintrag bleibt, aber die Projektion droppt B.
    expect(adminEntries(alice.adapter, space.id).has(bobDid)).toBe(true)
    expect(state.info.admins).not.toContain(bobDid)
    expect((alice.adapter as any).spaceAdminDids(state)).not.toContain(bobDid)
  })
})

describe('Pflicht-Test 10 — removeMember-Guard', () => {
  it('Nicht-Admin ruft removeMember → Fehler, kein removed-Event, keine Rotation', async () => {
    const alice = await createPeer('rmg-alice')
    const bob = await createPeer('rmg-bob')
    const carol = await createPeer('rmg-carol')
    const bobDid = bob.identity.getDid()
    const carolDid = carol.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.addMember(space.id, carolDid, await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => ((await bob.adapter.getSpace(space.id))?.members.length === 3))

    const bobGenBefore = await bob.keyManagement.getCurrentGeneration(space.id)
    const bobDoc: Y.Doc = spaceState(bob.adapter, space.id).doc
    const membersBefore = bobDoc.getMap('_members').size

    // bob (Nicht-Admin) versucht carol zu entfernen → Fehler vor jeder Mutation.
    await expect(bob.adapter.removeMember(space.id, carolDid)).rejects.toThrow()

    // Kein removed-Event geschrieben, keine Rotation.
    expect(bobDoc.getMap('_members').size).toBe(membersBefore)
    const removedKey = `${carolDid}:${bobGenBefore + 1}:removed`
    expect(bobDoc.getMap('_members').has(removedKey)).toBe(false)
    expect(await bob.keyManagement.getCurrentGeneration(space.id)).toBe(bobGenBefore)
  })

  it('Admin ruft removeMember → wie gehabt (Event + Rotation)', async () => {
    const alice = await createPeer('rmg-ok-alice')
    const bob = await createPeer('rmg-ok-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    await expect(alice.adapter.removeMember(space.id, bobDid)).resolves.toBeUndefined()
    expect(await alice.adapter.getKeyGeneration(space.id)).toBe(1)
    expect(spaceState(alice.adapter, space.id).info.members).toEqual([alice.identity.getDid()])
  })

  it('Self-leave ueber removeMember bleibt fuer einen Admin moeglich (Guard bricht es nicht)', async () => {
    // Der Creator ist Admin und entfernt sich selbst — der Guard (caller ∈ admins)
    // darf den Self-Leave nicht blockieren.
    const alice = await createPeer('self-leave-alice')
    const bob = await createPeer('self-leave-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    await expect(alice.adapter.removeMember(space.id, alice.identity.getDid())).resolves.toBeUndefined()
  })
})

describe('Pflicht-Test 11 — admins-Roundtrip (Restore re-projiziert aus dem Doc)', () => {
  it('promote → save → Restore → info.admins re-projiziert aus dem Doc', async () => {
    const passphrase = 'roundtrip-restore'
    const identity = (await createTestIdentity(passphrase)).identity
    const metadata = new InMemorySpaceMetadataStorage()
    const keyManagement = new InMemoryKeyManagementAdapter()
    const compactStore = new InMemoryCompactStore()

    const alice = await createPeer(passphrase, { metadata, keyManagement, compactStore, identity })
    const bob = await createPeer('roundtrip-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.promoteToAdmin(space.id, bobDid)
    await (alice.adapter as any)._saveToCompactStore(spaceState(alice.adapter, space.id))
    await (alice.adapter as any).saveSpaceMetadata(spaceState(alice.adapter, space.id))

    // Adapter-Neustart mit DENSELBEN Stores → Restore aus CompactStore + Metadata.
    const restored = new YjsReplicationAdapter({
      identity,
      messaging: new InMemoryMessagingAdapter(),
      brokerUrls: ['wss://broker.example.com'],
      keyManagement,
      metadataStorage: metadata,
      compactStore,
    })
    cleanups.push(async () => { await restored.stop() })
    await restored.start()

    const restoredSpace = await restored.getSpace(space.id)
    expect(restoredSpace).not.toBeNull()
    expect([...restoredSpace!.admins!].sort()).toEqual([identity.getDid(), bobDid].sort())
    // Re-projiziert AUS dem Doc: _admins-Map traegt beide Eintraege.
    expect(adminEntries(restored, space.id).size).toBe(2)
  })

  it('Admin zwischen Save und Restore als Member entfernt → nach Restore NICHT in info.admins', async () => {
    const passphrase = 'roundtrip-removed'
    const identity = (await createTestIdentity(passphrase)).identity
    const metadata = new InMemorySpaceMetadataStorage()
    const keyManagement = new InMemoryKeyManagementAdapter()
    const compactStore = new InMemoryCompactStore()

    const alice = await createPeer(passphrase, { metadata, keyManagement, compactStore, identity })
    const bob = await createPeer('roundtrip-rm-bob')
    const bobDid = bob.identity.getDid()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.promoteToAdmin(space.id, bobDid)
    // B als Member entfernen (removed@gen ins Doc) → die Roh-_admins-Map behaelt B,
    // aber die aktive Projektion entzieht ihn.
    await alice.adapter.removeMember(space.id, bobDid)
    await waitUntil(() => spaceState(alice.adapter, space.id).info.members.includes(bobDid) === false)
    await (alice.adapter as any)._saveToCompactStore(spaceState(alice.adapter, space.id))
    await (alice.adapter as any).saveSpaceMetadata(spaceState(alice.adapter, space.id))

    const restored = new YjsReplicationAdapter({
      identity,
      messaging: new InMemoryMessagingAdapter(),
      brokerUrls: ['wss://broker.example.com'],
      keyManagement,
      metadataStorage: metadata,
      compactStore,
    })
    cleanups.push(async () => { await restored.stop() })
    await restored.start()

    const restoredSpace = await restored.getSpace(space.id)
    expect(restoredSpace).not.toBeNull()
    // B ist im Roh-_admins-Set (grow-only), aber NICHT in der re-projizierten Liste.
    expect(adminEntries(restored, space.id).has(bobDid)).toBe(true)
    expect(restoredSpace!.admins).not.toContain(bobDid)
    expect(restoredSpace!.admins).toEqual([identity.getDid()])
  })
})
