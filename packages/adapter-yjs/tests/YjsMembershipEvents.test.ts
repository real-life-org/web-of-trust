/**
 * VE-1/VE-2/VE-3 (Slice 1.B.3-sync-recovery, Step 2): kanonische Mitgliederliste
 * als grow-only Membership-Event-Set in der Top-Level Y.Map `_members`.
 *
 * Sync 005 Z.163: die kanonische Mitgliederliste ist Teil des signierten und
 * synchronisierten Space-Dokuments. Sync 005 Z.305: "Wenn Einladung und
 * Entfernung konkurrieren, gewinnt die hoehere Key-Generation."
 *
 * Pflicht-Test 10 ist der Stop-1-DETEKTOR: verliert die Y.Map konkurrierende
 * Schreiber auf VERSCHIEDENE Keys, ist das Event-Set-Design auf Yjs nicht
 * verlustfrei umsetzbar.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
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
  formatMembershipEventKey, resolveActiveMembers,
  MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { MembershipEvent, DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import type { MessageEnvelope } from '@web_of_trust/core/types'
import { signEnvelope } from '@web_of_trust/core/crypto'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

/**
 * Flake-Haertung (Review-Minor): pollt eine Bedingung statt fix zu schlafen.
 * Loest bei Timeout still auf — die nachfolgenden expects liefern dann die
 * aussagekraeftige Diff.
 */
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

function membershipEvents(adapter: YjsReplicationAdapter, spaceId: string): Map<string, MembershipEvent> {
  const doc: Y.Doc = spaceState(adapter, spaceId).doc
  const events = new Map<string, MembershipEvent>()
  doc.getMap<MembershipEvent>('_members').forEach((value, key) => events.set(key, value))
  return events
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
}

const cleanups: Array<() => Promise<void>> = []

async function createPeer(passphrase: string): Promise<Peer> {
  const identity = (await createTestIdentity(passphrase)).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(identity.getDid())
  const metadata = new InMemorySpaceMetadataStorage()
  const keyManagement = new InMemoryKeyManagementAdapter()
  const adapter = new YjsReplicationAdapter({
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

describe('VE-1 — _members Event-Set + members-Projektion', () => {
  it('createSpace schreibt active@0 (self) + _meta.createdBy; Projektion = [self]', async () => {
    const alice = await createPeer('me-create')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    const events = membershipEvents(alice.adapter, space.id)
    const selfKey = `${alice.identity.getDid()}:0:active`
    expect(events.size).toBe(1)
    expect(events.get(selfKey)).toMatchObject({ did: alice.identity.getDid(), status: 'active', sinceGeneration: 0 })

    const doc: Y.Doc = spaceState(alice.adapter, space.id).doc
    expect(doc.getMap('_meta').get('createdBy')).toBe(alice.identity.getDid())
    expect(space.createdBy).toBe(alice.identity.getDid())
    expect(space.members).toEqual([alice.identity.getDid()])
  })

  it('addMember schreibt active@currentGen mit addedBy; removeMember schreibt removed@newGen — beide Events bleiben (grow-only), Projektion folgt der Lese-Regel', async () => {
    const alice = await createPeer('me-addremove-a')
    const bob = await createPeer('me-addremove-b')
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

  it('#181b: eine reine _members-Event-Aenderung (ohne Projektion-Aenderung) bricht den Metadata-Dirty-Check', async () => {
    const alice = await createPeer('me-fingerprint')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    const state = spaceState(alice.adapter, space.id)
    await (alice.adapter as any).saveSpaceMetadata(state)

    const saveCalls: number[] = []
    const originalSave = alice.metadata.saveSpaceMetadata.bind(alice.metadata)
    alice.metadata.saveSpaceMetadata = async (meta) => { saveCalls.push(1); return originalSave(meta) }

    // removed-Event fuer eine nie aktive DID: Projektion bleibt [alice], das
    // Event-Set aendert sich → der Digest muss den Dirty-Check brechen.
    const stranger = 'did:key:z6MkStrangerStranger'
    const event: MembershipEvent = { did: stranger, status: 'removed', sinceGeneration: 1 }
    const doc: Y.Doc = state.doc
    doc.transact(() => {
      doc.getMap<MembershipEvent>('_members').set(formatMembershipEventKey(event), event)
    }, 'local')
    await wait(50)
    expect(state.info.members).toEqual([alice.identity.getDid()])
    expect(saveCalls.length).toBe(1)

    // Idempotenz: derselbe Key erneut geschrieben aendert den Digest nicht.
    doc.transact(() => {
      doc.getMap<MembershipEvent>('_members').set(formatMembershipEventKey(event), event)
    }, 'local')
    await wait(50)
    expect(saveCalls.length).toBe(1)
  })
})

describe('Pflicht-Test 8 — Invitee-Bootstrap aus dem Snapshot, ohne Backfill (VE-3)', () => {
  it('Dritter-Member-Invite: Invitee sieht alle aktiven Members aus dem Snapshot; KEINE member-update-Sends an den Invitee', async () => {
    const alice = await createPeer('boot-alice')
    const bob = await createPeer('boot-bob')
    const carol = await createPeer('boot-carol')
    const bobInbox = inbox(bob.messaging)
    const carolInbox = inbox(carol.messaging)

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () =>
      ((await carol.adapter.getSpace(space.id))?.members.length === 3)
      && ((await bob.adapter.getSpace(space.id))?.members.length === 3))

    // Carol bootstrapped die Mitgliederliste aus dem _members-Event-Set des
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

    // Bestandsmitglied bob konvergiert ueber den CRDT-Sync auf dieselbe Projektion.
    const bobSpace = await bob.adapter.getSpace(space.id)
    expect([...bobSpace!.members].sort()).toEqual(
      [alice.identity.getDid(), bob.identity.getDid(), carol.identity.getDid()].sort(),
    )
  })
})

describe('P0a Gate 2 — Membership-Catch-up nach Offline-Fenster', () => {
  it('zwei Geraete: verliert B das _members-Update offline, konvergieren nach Reconnect trotzdem Item UND Member-Event', async () => {
    // A and B are separate peer identities; C is the third member A adds while
    // B is offline. A member-update must request the canonical state from A,
    // not from B's own (unrelated) devices.
    const alice = await createPeer('p0a-alice')
    const bob = await createPeer('p0a-bob')
    const carol = await createPeer('p0a-carol')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'P0a' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    await bob.messaging.disconnect()
    // Drop precisely the canonical content update that carries C's _members
    // event. A later item update is retained, reproducing "items sync, member
    // entry missing" rather than merely testing a fully offline device.
    const baseSend = alice.messaging.send.bind(alice.messaging)
    let dropContent = true
    let droppedContentCount = 0
    ;(alice.messaging as unknown as { send: typeof alice.messaging.send }).send = async (message) => {
      if (dropContent && (message as { type?: string; toDid?: string }).type === 'content'
        && (message as { toDid?: string }).toDid === bob.identity.getDid()) {
        droppedContentCount += 1
        throw new Error('test drop: membership content update')
      }
      return baseSend(message)
    }
    await alice.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    // Deterministisch statt wait(150): erst weiter, wenn der Drop wirklich
    // stattgefunden hat — das ist die Vorbedingung des Szenarios.
    await waitUntil(() => droppedContentCount > 0)
    dropContent = false
    const handleA = await alice.adapter.openSpace<TestDoc>(space.id)
    handleA.transact((doc) => { doc.items['after-offline'] = { title: 'arrived' } })
    handleA.close()

    await bob.messaging.connect(bob.identity.getDid())
    await waitUntil(async () => {
      const remote = await bob.adapter.openSpace<TestDoc>(space.id)
      const itemArrived = remote.getDoc().items['after-offline']?.title === 'arrived'
      remote.close()
      return itemArrived && (await bob.adapter.getSpace(space.id))?.members.includes(carol.identity.getDid()) === true
    })

    const spaceB = await bob.adapter.getSpace(space.id)
    expect(spaceB?.members).toContain(carol.identity.getDid())
    const handleB = await bob.adapter.openSpace<TestDoc>(space.id)
    expect(handleB.getDoc().items['after-offline']?.title).toBe('arrived')
    handleB.close()
  })

})

describe('P0a Gate 2 — space-sync-request authorization', () => {
  async function sendRequest(
    sender: Peer,
    recipient: Peer,
    spaceId: string,
    options: { unsigned?: boolean; fromDid?: string } = {},
  ): Promise<void> {
    const envelope: MessageEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      type: 'space-sync-request',
      fromDid: options.fromDid ?? sender.identity.getDid(),
      toDid: recipient.identity.getDid(),
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify({ spaceId }),
      signature: '',
    }
    if (!options.unsigned) await signEnvelope(envelope, (data) => sender.identity.sign(data))
    await sender.messaging.send(envelope)
  }

  it('rejects unsigned, non-member, and canonically removed requesters before full-state encoding or response', async () => {
    const alice = await createPeer('p0a-auth-alice')
    const bob = await createPeer('p0a-auth-bob')
    const mallory = await createPeer('p0a-auth-mallory')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: { secret: { title: 'kept' } } }, { name: 'P0a auth' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    const responseSend = vi.spyOn(alice.messaging, 'send')
    const encode = vi.spyOn(alice.adapter as any, 'encodeFullSpaceState')
    const assertRejected = async (request: () => Promise<void>) => {
      responseSend.mockClear()
      encode.mockClear()
      await request()
      await wait(40)
      expect(responseSend.mock.calls.filter(([message]) => (message as { type?: string }).type === 'content')).toHaveLength(0)
      expect(encode).not.toHaveBeenCalled()
    }

    await assertRejected(() => sendRequest(bob, alice, space.id, { unsigned: true }))
    await assertRejected(() => sendRequest(mallory, alice, space.id))

    await alice.adapter.removeMember(space.id, bob.identity.getDid())
    await assertRejected(() => sendRequest(bob, alice, space.id))

    encode.mockRestore()
    responseSend.mockRestore()
  })

  it('rejects a signature whose signer does not match the declared requester DID', async () => {
    const alice = await createPeer('p0a-auth-bind-alice')
    const bob = await createPeer('p0a-auth-bind-bob')
    const mallory = await createPeer('p0a-auth-bind-mallory')
    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'P0a auth binding' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())

    const responseSend = vi.spyOn(alice.messaging, 'send')
    const encode = vi.spyOn(alice.adapter as any, 'encodeFullSpaceState')
    await sendRequest(mallory, alice, space.id, { fromDid: bob.identity.getDid() })
    await wait(40)
    expect(responseSend.mock.calls.filter(([message]) => (message as { type?: string }).type === 'content')).toHaveLength(0)
    expect(encode).not.toHaveBeenCalled()
    encode.mockRestore()
    responseSend.mockRestore()
  })
})

describe('Pflicht-Test 9 — Admin-Konsistenz via createdBy (VE-2)', () => {
  it('Invitee und Inviter berechnen denselben Admin (createdBy), auch wenn ein Nicht-Creator einlaedt; Rotation: Creator applied, Nicht-Creator-Inviter rejected', async () => {
    const alice = await createPeer('admin-alice')
    const bob = await createPeer('admin-bob')
    const carol = await createPeer('admin-carol')

    const space = await alice.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await alice.adapter.addMember(space.id, bob.identity.getDid(), await bob.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bob.adapter.getSpace(space.id)) !== null)

    // bob (Nicht-Creator) laedt carol ein — vor VE-2 divergierte carols Admin-
    // Annahme auf den Inviter (members[0] = senderDid), jetzt traegt der
    // Snapshot _meta.createdBy = alice.
    await bob.adapter.addMember(space.id, carol.identity.getDid(), await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await carol.adapter.getSpace(space.id))?.createdBy !== undefined)

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
    await waitUntil(async () => (await carol.keyManagement.getCurrentGeneration(space.id)) === 1)
    expect(await carol.keyManagement.getCurrentGeneration(space.id)).toBe(1)
  })
})

describe('Pflicht-Test 10 — Z.305-Konflikt auf Event-Ebene (Stop-1-Detektor)', () => {
  function writeEvent(doc: Y.Doc, event: MembershipEvent): void {
    doc.getMap<MembershipEvent>('_members').set(formatMembershipEventKey(event), event)
  }
  function readEvents(doc: Y.Doc): MembershipEvent[] {
    const events: MembershipEvent[] = []
    doc.getMap<MembershipEvent>('_members').forEach((value) => events.push(value))
    return events
  }

  const DID = 'did:key:z6MkConflictedMember'

  it('active@2 vs. removed@3 OFFLINE geschrieben → nach dem Merge existieren BEIDE Events, Projektion = removed (beide Reihenfolgen)', () => {
    for (const reverseOrder of [false, true]) {
      const docA = new Y.Doc()
      const docB = new Y.Doc()
      // Offline-Divergenz: zwei Peers schreiben konkurrierend auf VERSCHIEDENE Keys.
      writeEvent(docA, { did: DID, status: 'active', sinceGeneration: 2 })
      writeEvent(docB, { did: DID, status: 'removed', sinceGeneration: 3 })

      const updateA = Y.encodeStateAsUpdate(docA)
      const updateB = Y.encodeStateAsUpdate(docB)
      if (reverseOrder) {
        Y.applyUpdate(docA, updateB)
        Y.applyUpdate(docB, updateA)
      } else {
        Y.applyUpdate(docB, updateA)
        Y.applyUpdate(docA, updateB)
      }

      for (const doc of [docA, docB]) {
        const map = doc.getMap<MembershipEvent>('_members')
        // Event-Ebene: genau das verlor das v2-Design (ein LWW-Eintrag pro DID).
        expect(map.get(`${DID}:2:active`)).toMatchObject({ did: DID, status: 'active', sinceGeneration: 2 })
        expect(map.get(`${DID}:3:removed`)).toMatchObject({ did: DID, status: 'removed', sinceGeneration: 3 })
        expect(map.size).toBe(2)
        // Projektion: hoehere Generation gewinnt (Sync 005 Z.305) → removed.
        expect(resolveActiveMembers(readEvents(doc))).toEqual([])
      }
    }
  })

  it('10b Tie-Break: active@N vs. removed@N konkurrierend → removed gewinnt auf beiden Peers', () => {
    for (const reverseOrder of [false, true]) {
      const docA = new Y.Doc()
      const docB = new Y.Doc()
      writeEvent(docA, { did: DID, status: 'active', sinceGeneration: 4 })
      writeEvent(docB, { did: DID, status: 'removed', sinceGeneration: 4 })

      const updateA = Y.encodeStateAsUpdate(docA)
      const updateB = Y.encodeStateAsUpdate(docB)
      if (reverseOrder) {
        Y.applyUpdate(docA, updateB)
        Y.applyUpdate(docB, updateA)
      } else {
        Y.applyUpdate(docB, updateA)
        Y.applyUpdate(docA, updateB)
      }

      for (const doc of [docA, docB]) {
        expect(doc.getMap('_members').size).toBe(2)
        expect(resolveActiveMembers(readEvents(doc))).toEqual([])
      }
    }
  })

  it('10c Re-Invite-Guard: addMember nach removed@N rotiert zuerst — Invitee wird active@N+1 und ist in der Projektion', async () => {
    const alice = await createPeer('guard-alice')
    const bob = await createPeer('guard-bob')
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

describe('Review-MINOR-1 — Enc-Key-Cache-Pruning gegen kanonische removed-Gewinner (Security)', () => {
  it('removed-Event kommt via Sync (KEIN lokales removeMember) → naechste Rotation sendet KEINE key-rotation an den Entfernten; der Entfernte erhaelt die neue Generation nicht', async () => {
    // Modelliert Geraet 2 eines Multi-Device-Admins: es hat carol selbst
    // eingeladen (Enc-Key im Cache), die ENTFERNUNG erreicht es aber nur als
    // kanonisches removed-Event via Doc-Sync — der lokale removeMember-Pfad
    // (der den Cache loescht) laeuft hier nie.
    const admin2 = await createPeer('minor1-admin-geraet2')
    const bob = await createPeer('minor1-bob')
    const carol = await createPeer('minor1-carol')
    const bobDid = bob.identity.getDid()
    const carolDid = carol.identity.getDid()

    const space = await admin2.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await admin2.adapter.addMember(space.id, bobDid, await bob.identity.getEncryptionPublicKeyBytes())
    await admin2.adapter.addMember(space.id, carolDid, await carol.identity.getEncryptionPublicKeyBytes())
    await waitUntil(async () =>
      (await bob.keyManagement.getCurrentGeneration(space.id)) === 0 &&
      (await carol.keyManagement.getCurrentGeneration(space.id)) === 0)
    expect(await carol.keyManagement.getKeyByGeneration(space.id, 0)).not.toBeNull()

    // Kanonisches removed@1 fuer carol trifft via Doc-Sync ein (origin 'remote').
    const state = spaceState(admin2.adapter, space.id)
    const removedEvent: MembershipEvent = { did: carolDid, status: 'removed', sinceGeneration: 1 }
    const doc: Y.Doc = state.doc
    doc.transact(() => {
      doc.getMap<MembershipEvent>('_members').set(formatMembershipEventKey(removedEvent), removedEvent)
    }, 'remote')
    await waitUntil(() => state.info.members.includes(carolDid) === false)
    expect(state.info.members).not.toContain(carolDid)

    // Kern des Fixes: der Projektion-Update-Pfad prunt den Enc-Key-Cache fuer
    // removed-Gewinner; der Remaining-Member bob bleibt erhalten.
    expect(state.memberEncryptionKeys.has(carolDid)).toBe(false)
    expect(state.memberEncryptionKeys.has(bobDid)).toBe(true)

    // Naechste Rotation DIESES Geraets: der Send-Spy beweist, dass KEINE
    // key-rotation an den Entfernten geht (bob als Positiv-Kontrolle).
    const sendSpy = vi.spyOn(admin2.messaging, 'send')
    const newGen = await (admin2.adapter as any).rotateSpaceKeyAndDistribute(state)
    await waitUntil(async () => (await bob.keyManagement.getCurrentGeneration(space.id)) === newGen)

    const rotationRecipients = sendSpy.mock.calls
      .map(([envelope]) => envelope as WireMessage)
      .filter((envelope) => isDidcommMessage(envelope) && envelope.type === KEY_ROTATION_MESSAGE_TYPE)
      .map((envelope) => (envelope as DidcommPlaintextMessage).to?.[0])
    expect(rotationRecipients).toContain(bobDid)
    expect(rotationRecipients).not.toContain(carolDid)

    // Der Entfernte kann die neue Generation nicht entschluesseln: sein
    // KeyManagement kennt den neuen Key nicht (bob als Positiv-Kontrolle schon).
    expect(await bob.keyManagement.getKeyByGeneration(space.id, newGen)).not.toBeNull()
    expect(await carol.keyManagement.getKeyByGeneration(space.id, newGen)).toBeNull()
    expect(await carol.keyManagement.getCurrentGeneration(space.id)).toBe(0)
  })

  it('P0a Sicherheit — Requester, der WÄHREND der Antwortaufbereitung entfernt wird, erhält keinen State (TOCTOU)', async () => {
    const alice = await createPeer('toctou-alice')
    const bob = await createPeer('toctou-bob')
    const space = await alice.adapter.createSpace('shared', { items: {} } as TestDoc, { name: 'S', members: [alice.identity.getDid(), bob.identity.getDid()] })

    // Autorisierung besteht zum Request-Zeitpunkt; die Entfernung passiert an
    // der ersten await-Grenze DANACH (Key-Lookup) — genau das TOCTOU-Fenster.
    const km = (alice.adapter as unknown as { keyManagement: { getCurrentKey(spaceId: string): Promise<unknown> } }).keyManagement
    const baseGetKey = km.getCurrentKey.bind(km)
    let interleaved = false
    km.getCurrentKey = async (spaceId: string) => {
      if (!interleaved && spaceId === space.id) {
        interleaved = true
        await alice.adapter.removeMember(space.id, bob.identity.getDid())
      }
      return baseGetKey(spaceId)
    }

    const sends: Array<{ type?: string; toDid?: string }> = []
    const baseSend = alice.messaging.send.bind(alice.messaging)
    alice.messaging.send = async (message) => { sends.push(message as { type?: string; toDid?: string }); return baseSend(message) }

    await (bob.adapter as unknown as { sendSpaceSyncRequest(spaceId: string, recipient?: string): Promise<void> })
      .sendSpaceSyncRequest(space.id, alice.identity.getDid())
    await wait(100)

    // Kein content-Response an den inzwischen entfernten Requester.
    expect(sends.filter((m) => m.type === 'content' && m.toDid === bob.identity.getDid())).toHaveLength(0)
  })
})
