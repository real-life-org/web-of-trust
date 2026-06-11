/**
 * VE-1/VE-2/VE-3 (Slice 1.B.3-sync-recovery, Step 5 — Automerge-Mirror):
 * kanonische Mitgliederliste als grow-only Membership-Event-Set in
 * doc.members (Record<string, MembershipEvent>) + doc.createdBy.
 *
 * Sync 005 Z.163: die kanonische Mitgliederliste ist Teil des signierten und
 * synchronisierten Space-Dokuments. Sync 005 Z.305: "Wenn Einladung und
 * Entfernung konkurrieren, gewinnt die hoehere Key-Generation."
 *
 * Pflicht-Test 10 ist der Stop-1-DETEKTOR: verliert der Automerge-Merge
 * konkurrierende change()-Bloecke auf VERSCHIEDENE Record-Keys, ist das
 * Event-Set-Design auf Automerge nicht verlustfrei umsetzbar.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as Automerge from '@automerge/automerge'
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
  resolveActiveMembers, encryptOneShot,
  MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE, SPACE_INVITE_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { MembershipEvent, DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, buildSpaceInviteBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { encodeSpaceInviteSnapshotPayload } from '../src/space-invite-snapshot'

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

interface TestDoc { items: Record<string, { title: string }> }

function spaceState(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

function spaceDoc(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  const state = spaceState(adapter, spaceId)
  return (adapter as unknown as { repo: { handles: Record<string, { doc(): unknown }> } }).repo.handles[state.documentId]?.doc()
}

function membershipEvents(adapter: AutomergeReplicationAdapter, spaceId: string): Map<string, MembershipEvent> {
  const doc = spaceDoc(adapter, spaceId)
  return new Map(Object.entries((doc?.members ?? {}) as Record<string, MembershipEvent>))
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
  adapter: AutomergeReplicationAdapter
  metadata: InMemorySpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
}

const cleanups: Array<() => Promise<void>> = []

async function createPeer(passphrase: string): Promise<Peer> {
  const identity = (await createTestIdentity(passphrase)).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(identity.getDid())
  const metadata = new InMemorySpaceMetadataStorage()
  const keyManagement = new InMemoryKeyManagementAdapter()
  const adapter = new AutomergeReplicationAdapter({
    identity,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement,
    metadataStorage: metadata,
    compactStore: new InMemoryCompactStore(),
  })
  await adapter.start()
  cleanups.push(async () => {
    await adapter.stop()
    try { await identity.deleteStoredIdentity() } catch {}
  })
  return { identity, messaging, adapter, metadata, keyManagement }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

describe('VE-1 — doc.members Event-Set + members-Projektion', () => {
  it('createSpace schreibt active@0 (self) + doc.createdBy; Projektion = [self]', async () => {
    const alice = await createPeer('am-me-create')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    const events = membershipEvents(alice.adapter, space.id)
    const selfKey = `${alice.identity.getDid()}:0:active`
    expect(events.size).toBe(1)
    expect(events.get(selfKey)).toMatchObject({ did: alice.identity.getDid(), status: 'active', sinceGeneration: 0 })

    expect(spaceDoc(alice.adapter, space.id).createdBy).toBe(alice.identity.getDid())
    expect(space.createdBy).toBe(alice.identity.getDid())
    expect(space.members).toEqual([alice.identity.getDid()])
  })

  it('addMember schreibt active@currentGen mit addedBy; removeMember schreibt removed@newGen — beide Events bleiben (grow-only), Projektion folgt der Lese-Regel', async () => {
    const alice = await createPeer('am-me-addremove-a')
    const bob = await createPeer('am-me-addremove-b')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    let events = membershipEvents(alice.adapter, space.id)
    expect(events.get(`${bob.identity.getDid()}:0:active`)).toMatchObject({
      did: bob.identity.getDid(), status: 'active', sinceGeneration: 0, addedBy: alice.identity.getDid(),
    })
    expect([...spaceState(alice.adapter, space.id).info.members].sort())
      .toEqual([alice.identity.getDid(), bob.identity.getDid()].sort())

    await alice.adapter.removeMember(space.id, bob.identity.getDid())
    events = membershipEvents(alice.adapter, space.id)
    // grow-only: das active-Event wird NICHT geloescht, das removed-Event kommt dazu.
    expect(events.get(`${bob.identity.getDid()}:0:active`)).toBeDefined()
    expect(events.get(`${bob.identity.getDid()}:1:removed`)).toMatchObject({
      did: bob.identity.getDid(), status: 'removed', sinceGeneration: 1,
    })
    // removed@1 VOR der Rotation geschrieben; die Rotation hat stattgefunden (gen 1).
    expect(await alice.adapter.getKeyGeneration(space.id)).toBe(1)
    expect(spaceState(alice.adapter, space.id).info.members).toEqual([alice.identity.getDid()])
  })
})

describe('Pflicht-Test 8 — Invitee-Bootstrap aus dem Snapshot, ohne Backfill (VE-3)', () => {
  it('Dritter-Member-Invite: Invitee sieht alle aktiven Members aus dem Snapshot; KEINE member-update-Sends an den Invitee', async () => {
    const alice = await createPeer('am-boot-alice')
    const bob = await createPeer('am-boot-bob')
    const carol = await createPeer('am-boot-carol')
    const bobInbox = inbox(bob.messaging)
    const carolInbox = inbox(carol.messaging)

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await wait()
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await wait()

    // Carol bootstrapped die Mitgliederliste aus dem doc.members-Event-Set des
    // Invite-Snapshots — nicht aus [senderDid, ownDid] + Backfill.
    const carolSpace = await carol.adapter.getSpace(space.id)
    expect(carolSpace).not.toBeNull()
    expect([...carolSpace!.members].sort()).toEqual(
      [alice.identity.getDid(), bob.identity.getDid(), carol.identity.getDid()].sort(),
    )
    expect(carolSpace!.createdBy).toBe(alice.identity.getDid())

    // VE-3-Beweis: kein einziges member-update an den Invitee (Backfill ist tot).
    expect(carolInbox.filter((m) => m.type === MEMBER_UPDATE_MESSAGE_TYPE)).toHaveLength(0)
    // Die Notify-Schleife an Bestandsmitglieder BLEIBT: bob erfaehrt von carol.
    expect(bobInbox.filter((m) => m.type === MEMBER_UPDATE_MESSAGE_TYPE).length).toBeGreaterThan(0)

    // Bestandsmitglied bob konvergiert ueber den automerge-repo-Doc-Sync auf
    // dieselbe Projektion.
    const bobSpace = await bob.adapter.getSpace(space.id)
    expect([...bobSpace!.members].sort()).toEqual(
      [alice.identity.getDid(), bob.identity.getDid(), carol.identity.getDid()].sort(),
    )
  })
})

describe('Pflicht-Test 9 — Admin-Konsistenz via createdBy (VE-2)', () => {
  it('Invitee und Inviter berechnen denselben Admin (createdBy), auch wenn ein Nicht-Creator einlaedt; Rotation: Creator applied, Nicht-Creator-Inviter rejected', async () => {
    const alice = await createPeer('am-admin-alice')
    const bob = await createPeer('am-admin-bob')
    const carol = await createPeer('am-admin-carol')

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await wait()

    // bob (Nicht-Creator) laedt carol ein — vor VE-2 divergierte carols Admin-
    // Annahme auf den Inviter (members[0] = senderDid), jetzt traegt der
    // Snapshot doc.createdBy = alice.
    await bob.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await wait()

    const bobSpace = await bob.adapter.getSpace(space.id)
    const carolSpace = await carol.adapter.getSpace(space.id)
    expect(bobSpace!.createdBy).toBe(alice.identity.getDid())
    expect(carolSpace!.createdBy).toBe(alice.identity.getDid())

    // Selbstkonsistente gen-1-Rotation vom jeweiligen Sender: nur der
    // Authority-Check (knownAdminDids = [createdBy]) kann sie stoppen.
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

    // Rotation vom Nicht-Creator-Inviter (bob) → rejected, Generation bleibt 0.
    await bob.messaging.send(await craftedRotation(bob.identity))
    await wait()
    expect(await carol.keyManagement.getCurrentGeneration(space.id)).toBe(0)

    // Identische Form vom Creator (alice) → applied, Generation 1.
    await alice.messaging.send(await craftedRotation(alice.identity))
    await wait()
    expect(await carol.keyManagement.getCurrentGeneration(space.id)).toBe(1)
  })
})

describe('Pflicht-Test 10 — Z.305-Konflikt auf Event-Ebene (Stop-1-Detektor fuer Automerge)', () => {
  const DID = 'did:key:z6MkConflictedMember'

  type MembersDoc = { members: Record<string, MembershipEvent> }

  function fork(base: Automerge.Doc<MembersDoc>, event: MembershipEvent): Automerge.Doc<MembersDoc> {
    return Automerge.change(Automerge.clone(base), (d) => {
      d.members[`${event.did}:${event.sinceGeneration}:${event.status}`] = { ...event }
    })
  }

  function readEvents(doc: Automerge.Doc<MembersDoc>): MembershipEvent[] {
    return Object.values(doc.members)
  }

  it('active@2 vs. removed@3 in konkurrierenden change()-Bloecken OFFLINE geschrieben → nach dem Merge existieren BEIDE Events, Projektion = removed (beide Reihenfolgen)', () => {
    const base = Automerge.from<MembersDoc>({ members: {} })
    // Offline-Divergenz: zwei Peers schreiben konkurrierend auf VERSCHIEDENE Keys.
    const docA = fork(base, { did: DID, status: 'active', sinceGeneration: 2 })
    const docB = fork(base, { did: DID, status: 'removed', sinceGeneration: 3 })

    const mergedAB = Automerge.merge(Automerge.clone(docA), docB)
    const mergedBA = Automerge.merge(Automerge.clone(docB), docA)

    for (const doc of [mergedAB, mergedBA]) {
      // Event-Ebene: genau das verlor das v2-Design (ein LWW-Eintrag pro DID).
      expect(doc.members[`${DID}:2:active`]).toMatchObject({ did: DID, status: 'active', sinceGeneration: 2 })
      expect(doc.members[`${DID}:3:removed`]).toMatchObject({ did: DID, status: 'removed', sinceGeneration: 3 })
      expect(Object.keys(doc.members)).toHaveLength(2)
      // Projektion: hoehere Generation gewinnt (Sync 005 Z.305) → removed.
      expect(resolveActiveMembers(readEvents(doc))).toEqual([])
    }
  })

  it('10b Tie-Break: active@N vs. removed@N konkurrierend → removed gewinnt in beiden Merge-Reihenfolgen', () => {
    const base = Automerge.from<MembersDoc>({ members: {} })
    const docA = fork(base, { did: DID, status: 'active', sinceGeneration: 4 })
    const docB = fork(base, { did: DID, status: 'removed', sinceGeneration: 4 })

    const mergedAB = Automerge.merge(Automerge.clone(docA), docB)
    const mergedBA = Automerge.merge(Automerge.clone(docB), docA)

    for (const doc of [mergedAB, mergedBA]) {
      expect(Object.keys(doc.members)).toHaveLength(2)
      expect(resolveActiveMembers(readEvents(doc))).toEqual([])
    }
  })

  it('10c Re-Invite-Guard: addMember nach removed@N rotiert zuerst — Invitee wird active@N+1 und ist in der Projektion', async () => {
    const alice = await createPeer('am-guard-alice')
    const bob = await createPeer('am-guard-bob')
    const bobDid = bob.identity.getDid()
    const bobEncKey = await bob.identity.getEncryptionPublicKeyBytes()

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bobDid, bobEncKey)
    await alice.adapter.removeMember(space.id, bobDid) // removed@1, Generation → 1
    expect(await alice.adapter.getKeyGeneration(space.id)).toBe(1)

    await alice.adapter.addMember(space.id, bobDid, bobEncKey)

    // Guard: erst rotieren (gen 2), dann active@2 — active@1 verloere gegen
    // removed@1 per Tie-Break (siehe Negativ-Kontrolle unten).
    expect(await alice.adapter.getKeyGeneration(space.id)).toBe(2)
    const events = membershipEvents(alice.adapter, space.id)
    expect(events.get(`${bobDid}:0:active`)).toBeDefined()
    expect(events.get(`${bobDid}:1:removed`)).toBeDefined()
    expect(events.get(`${bobDid}:2:active`)).toMatchObject({ did: bobDid, status: 'active', sinceGeneration: 2 })
    expect(spaceState(alice.adapter, space.id).info.members).toContain(bobDid)
  })

  it('10c Negativ-Kontrolle: OHNE Guard (active@N gegen removed@N) bliebe der Re-Invitee per Tie-Break draussen', () => {
    const projection = resolveActiveMembers([
      { did: DID, status: 'removed', sinceGeneration: 1 },
      { did: DID, status: 'active', sinceGeneration: 1 },
    ])
    expect(projection).toEqual([])
  })
})

describe('Review-Minor — members-Container-Seed im Invite-Apply (Invite mit leerem docBinary)', () => {
  /** Spec-konformer Invite mit leerem Doc-Binary: Inhalt kaeme via Live-Sync. */
  async function craftedEmptyInvite(
    senderDid: string,
    recipientDid: string,
    spaceId: string,
    senderPort: InMemoryKeyManagementAdapter,
    documentUrl: string,
  ): Promise<Record<string, unknown>> {
    const body = await buildSpaceInviteBody({
      keyPort: senderPort, spaceId, recipientDid,
      brokerUrls: ['wss://broker.example.com'], adminDids: [senderDid],
    })
    const groupKey = (await senderPort.getKeyByGeneration(spaceId, body.currentKeyGeneration))!
    const snapshot = await encryptOneShot({
      crypto: protocolCrypto,
      spaceContentKey: groupKey,
      plaintext: encodeSpaceInviteSnapshotPayload({ documentUrl, docBinary: new Uint8Array(0) }),
    })
    return {
      type: SPACE_INVITE_MESSAGE_TYPE,
      senderDid,
      body: body as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: { encryptedDocSnapshot: snapshot.blobBase64Url },
    }
  }

  it('zwei Peers initialisieren konkurrierend ab demselben Invite, schreiben je ein Event → nach dem Merge existieren BEIDE Events (deterministischer Container-Seed)', async () => {
    // Vor dem Fix: jeder Peer importierte Automerge.init() (random Actor) und
    // legte d.members im ersten writeMembershipEvent lazy an — konkurrierende
    // Container-Zuweisungen sind in Automerge ein Property-Konflikt, die
    // Events des unterlegenen Containers verschwinden aus der Merge-Sicht.
    // Der deterministische Seed (fester Actor aus der spaceId, time 0) erzeugt
    // auf allen Peers die IDENTISCHE Initial-Change → der Merge dedupliziert
    // sie, beide Peers schreiben in DENSELBEN Container.
    const alice = (await createTestIdentity('am-seed-inviter')).identity
    const bob = await createPeer('am-seed-bob')
    const carol = await createPeer('am-seed-carol')
    cleanups.push(async () => { try { await alice.deleteStoredIdentity() } catch {} })

    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    const documentUrl = new Repo({ network: [] }).create({}).url

    await (bob.adapter as any).handleSpaceInvite(
      await craftedEmptyInvite(alice.getDid(), bob.identity.getDid(), spaceId, senderPort, documentUrl))
    await (carol.adapter as any).handleSpaceInvite(
      await craftedEmptyInvite(alice.getDid(), carol.identity.getDid(), spaceId, senderPort, documentUrl))

    // Konkurrierende Erst-Writes OHNE Sync dazwischen (Offline-Divergenz).
    ;(bob.adapter as any).writeMembershipEvent(
      spaceState(bob.adapter, spaceId), { did: bob.identity.getDid(), status: 'active', sinceGeneration: 0 })
    ;(carol.adapter as any).writeMembershipEvent(
      spaceState(carol.adapter, spaceId), { did: carol.identity.getDid(), status: 'active', sinceGeneration: 0 })

    const bobBinary = Automerge.save(spaceDoc(bob.adapter, spaceId))
    const carolBinary = Automerge.save(spaceDoc(carol.adapter, spaceId))
    const bobKey = `${bob.identity.getDid()}:0:active`
    const carolKey = `${carol.identity.getDid()}:0:active`

    for (const merged of [
      Automerge.merge(Automerge.load<any>(bobBinary), Automerge.load<any>(carolBinary)),
      Automerge.merge(Automerge.load<any>(carolBinary), Automerge.load<any>(bobBinary)),
    ]) {
      expect(merged.members?.[bobKey]).toMatchObject({ did: bob.identity.getDid(), status: 'active', sinceGeneration: 0 })
      expect(merged.members?.[carolKey]).toMatchObject({ did: carol.identity.getDid(), status: 'active', sinceGeneration: 0 })
    }
  })
})
