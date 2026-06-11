/**
 * VE-6 a/b/c (Slice 1.B.3-sync-recovery, Step 5 — Automerge-Mirror):
 * Generation-Gap-Recovery.
 *
 * Sync 002 Z.231-235: future-rotation durabel puffern, nach Lueckenschluss
 * alle gepufferten Nachrichten in aufsteigender Generation erneut pruefen.
 * Sync 005 Z.202: ohne lokale Space-Keys nur als Pending-Signal speichern —
 * das normative Muster fuer "Nachricht fuer unbekannten Space": durabel
 * puffern, nicht endlos redelivern lassen.
 *
 * VE-6d ist AM-seitig ein dokumentierter No-op (laufender automerge-repo-
 * Sync). Der fruehere CHECK-4-Befund-Pin (Stop-6) ist seit F-1 INVERTIERT:
 * content-Nachrichten mit unbekannter keyGeneration werden nicht mehr
 * gedroppt — die Selbstheilungs-These war experimentell widerlegt
 * (sentHashes-Suppression des Senders, endloser Heads-Ping-Pong ohne
 * Konvergenz) —, sondern als blocked-by-key gepuffert und nach Key-Ankunft
 * erneut durch den Live-Empfangspfad gefeedet (Sync 002 Z.173 MUSS,
 * Z.231-235). Die Ex-CHECK-4-Tests unten asserten die Konvergenz.
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
  InMemoryMemberUpdatePendingStore,
} from '@web_of_trust/core/adapters'
import {
  SPACE_INVITE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, ACK_MESSAGE_TYPE,
  isDidcommMessage, encryptOneShot,
} from '@web_of_trust/core/protocol'
import type { DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, buildSpaceInviteBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { encodeSpaceInviteSnapshotPayload } from '../src/space-invite-snapshot'

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms))

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
const PENDING_PREFIX = '__wot_pending_space_message__'

interface TestDoc { items: Record<string, { title: string }> }

function spaceState(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

function spaceDoc(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  const state = spaceState(adapter, spaceId)
  return (adapter as unknown as { repo: { handles: Record<string, { doc(): unknown }> } }).repo.handles[state.documentId]?.doc()
}

/** Beobachtet abgehende ack/1.0-Envelopes eines Messaging-Adapters. */
function captureAcks(messaging: InMemoryMessagingAdapter): DidcommPlaintextMessage[] {
  const acks: DidcommPlaintextMessage[] = []
  const originalSend = messaging.send.bind(messaging)
  messaging.send = (async (envelope: WireMessage) => {
    if (isDidcommMessage(envelope) && envelope.type === ACK_MESSAGE_TYPE) acks.push(envelope)
    return originalSend(envelope)
  }) as typeof messaging.send
  return acks
}

/**
 * Spec-konformer Invite als dekodiertes Inbox-Ergebnis: der Snapshot-Payload
 * (Pflicht fuer unbekannte Spaces, M2) traegt eine frische documentUrl und ein
 * leeres Doc-Binary — Inhalt kaeme via Live-Sync. createdBy bleibt damit
 * unbesetzt → spaceCreatorDid faellt auf members[0] = senderDid zurueck
 * (SPEC-APPROX-Fallback, Deliverable 3).
 */
async function craftedInviteDecoded(
  senderDid: string,
  recipientDid: string,
  spaceId: string,
  senderPort: InMemoryKeyManagementAdapter,
): Promise<Record<string, unknown>> {
  const body = await buildSpaceInviteBody({
    keyPort: senderPort, spaceId, recipientDid,
    brokerUrls: ['wss://broker.example.com'], adminDids: [senderDid],
  })
  const documentUrl = new Repo({ network: [] }).create({}).url
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

function rotationDecoded(senderDid: string, body: Record<string, unknown>) {
  return {
    type: KEY_ROTATION_MESSAGE_TYPE,
    senderDid,
    body,
    outerId: crypto.randomUUID(),
    extensionFields: {},
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

describe('Pflicht-Test 1 — AM future-rotation ueberlebt Neustart (VE-6a, Sync 002 Z.233/Z.171)', () => {
  it('future-rotation wird durabel gepuffert, ueberlebt den Adapter-Neustart und wird nach Lueckenschluss aufsteigend angewendet', async () => {
    const alice = (await createTestIdentity('am-gap1-alice')).identity
    const bob = (await createTestIdentity('am-gap1-bob')).identity
    const bobMsg = new InMemoryMessagingAdapter()
    await bobMsg.connect(bob.getDid())
    const bobMeta = new InMemorySpaceMetadataStorage()
    const bobCompact = new InMemoryCompactStore()

    const adapter1 = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: bobMeta,
      compactStore: bobCompact,
    })
    await adapter1.start()

    // Invite bei gen 0 (senderPort = Admin-Keymaterial von alice).
    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    await (adapter1 as any).handleSpaceInvite(await craftedInviteDecoded(alice.getDid(), bob.getDid(), spaceId, senderPort))
    expect(await adapter1.getKeyGeneration(spaceId)).toBe(0)
    // fire-and-forget _saveToCompactStore abwarten (Restore-Quelle)
    await waitUntil(async () => (await bobCompact.list()).includes(spaceId))

    // Gen-2-Rotation bei lokal gen 0: > local+1 → durabler future-Buffer + ack
    // (Sync 002 Z.233; Disposition pending/durable → send-ack, Z.172).
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 1
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 2
    const rotation2 = await buildKeyRotationBody({ keyPort: senderPort, spaceId, newGeneration: 2, recipientDid: bob.getDid() })
    const outcome = await (adapter1 as any).handleKeyRotation(
      rotationDecoded(alice.getDid(), rotation2 as unknown as Record<string, unknown>))
    expect(outcome).toMatchObject({ kind: 'pending', durability: 'durable' })
    expect(await adapter1.getKeyGeneration(spaceId)).toBe(0)
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(true)

    // Neustart: neue Adapter-Inkarnation, gleiche durable Stores, frisches
    // KeyManagement (Keys kommen aus der Metadata zurueck).
    await adapter1.stop()
    const adapter2 = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: bobMeta,
      compactStore: bobCompact,
    })
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })

    // Der Buffer hat den Neustart ueberlebt (Restore prueft erneut und
    // re-buffert die weiterhin zukuenftige Rotation — Sync 002 Z.237).
    expect(await adapter2.getKeyGeneration(spaceId)).toBe(0)
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(true)

    // Gen-1 schliesst die Luecke: apply 1 → Replay wendet die gepufferte 2 an
    // (aufsteigend, Sync 002 Z.235).
    const rotation1 = await buildKeyRotationBody({ keyPort: senderPort, spaceId, newGeneration: 1, recipientDid: bob.getDid() })
    await (adapter2 as any).handleKeyRotation(
      rotationDecoded(alice.getDid(), rotation1 as unknown as Record<string, unknown>))
    await waitUntil(async () => (await adapter2.getKeyGeneration(spaceId)) === 2
      && !(await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX)))

    expect(await adapter2.getKeyGeneration(spaceId)).toBe(2)
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(false)
  })
})

describe('Pflicht-Test 2 — unknown-space key-rotation: durabel puffern + ack (VE-6b)', () => {
  it('Rotation vor dem Invite: genau 1 ack/1.0 beim Puffern; nach space-invite-Apply angewendet; Redelivery endet als Replay-ack ohne Doppel-Anwendung', async () => {
    const alice = (await createTestIdentity('am-gap2-alice')).identity
    const bob = (await createTestIdentity('am-gap2-bob')).identity
    const aliceMsg = new InMemoryMessagingAdapter()
    const bobMsg = new InMemoryMessagingAdapter()
    await aliceMsg.connect(alice.getDid())
    await bobMsg.connect(bob.getDid())

    const aliceAdapter = new AutomergeReplicationAdapter({
      identity: alice, messaging: aliceMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
    await aliceAdapter.start()
    const bobKeys = new InMemoryKeyManagementAdapter()
    const bobCompact = new InMemoryCompactStore()
    const bobAdapter = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: bobKeys,
      metadataStorage: new InMemorySpaceMetadataStorage(),
      compactStore: bobCompact,
    })
    await bobAdapter.start()
    cleanups.push(async () => {
      await aliceAdapter.stop()
      await bobAdapter.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })
    const bobAcks = captureAcks(bobMsg)

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })

    // Selbstkonsistente gen-1-Rotation vom Admin (alice) — trifft bei bob ein,
    // BEVOR der space-invite ankommt (Out-of-Order-Zustellung).
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId: space.id, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId: space.id, ownerDid: alice.getDid() })
    const rotationBody = await buildKeyRotationBody({ keyPort: senderPort, spaceId: space.id, newGeneration: 1, recipientDid: bob.getDid() })
    const rotation = await deliverInboxMessage({
      type: KEY_ROTATION_MESSAGE_TYPE,
      body: rotationBody as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    })

    await aliceMsg.send(rotation)
    await waitUntil(async () => bobAcks.filter((a) => a.thid === rotation.id).length >= 1
      && (await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX)))

    // Durabel gepuffert (reason unknown-space) + genau EIN ack/1.0 (Sync 002
    // Z.172: ACK erst nach Anwendung ODER durablem Puffern).
    expect(await bobAdapter.getSpace(space.id)).toBeNull()
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(true)
    expect(bobAcks.filter((a) => a.thid === rotation.id)).toHaveLength(1)

    // space-invite kommt an → Replay-Hook nach dem Invite-Apply wendet die
    // gepufferte Rotation an (Authority-Check laeuft erst jetzt, mit
    // Admin-Snapshot createdBy = alice aus dem Snapshot-Doc).
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobKeys.getCurrentGeneration(space.id)) === 1
      && !(await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX)))
    expect(await bobAdapter.getSpace(space.id)).not.toBeNull()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(false)
    // Kein zweites ack fuer die Rotation durch den Replay (das ack vom
    // Puffern ist bereits gesendet).
    expect(bobAcks.filter((a) => a.thid === rotation.id)).toHaveLength(1)

    // Relay-Redelivery derselben Rotation: Message-ID-History → Replay-ack
    // (Sync 003 Z.619), keine Doppel-Anwendung.
    await aliceMsg.send(rotation)
    await waitUntil(() => bobAcks.filter((a) => a.thid === rotation.id).length >= 2)
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect(bobAcks.filter((a) => a.thid === rotation.id)).toHaveLength(2)
  })
})

describe('Pflicht-Test 3 — aufsteigende Re-Verarbeitung nach Lueckenschluss (VE-6c, Sync 002 Z.235)', () => {
  it('Gen-3-Rotation gepuffert, Gen-2 trifft ein → erst 2, dann 3; future-member-update (eff. 3) wird via resolveFuture actionable', async () => {
    const alice = (await createTestIdentity('am-gap3-alice')).identity
    const bob = (await createTestIdentity('am-gap3-bob')).identity
    const bobMsg = new InMemoryMessagingAdapter()
    await bobMsg.connect(bob.getDid())
    const bobKeys = new InMemoryKeyManagementAdapter()
    const memberUpdateStore = new InMemoryMemberUpdatePendingStore()
    const bobAdapter = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: bobKeys,
      metadataStorage: new InMemorySpaceMetadataStorage(),
      compactStore: new InMemoryCompactStore(),
      memberUpdateStore,
    })
    await bobAdapter.start()
    cleanups.push(async () => {
      await bobAdapter.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })

    // Sender-Port mit konsistenter Generationskette 0..3; der Invite reist bei
    // currentKeyGeneration 1 → bob startet auf lokaler Generation 1.
    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 1
    await (bobAdapter as any).handleSpaceInvite(await craftedInviteDecoded(alice.getDid(), bob.getDid(), spaceId, senderPort))
    expect(await bobKeys.getCurrentGeneration(spaceId)).toBe(1)

    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 2
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 3

    // Gen-3-Rotation zuerst: > local+1 → durabler future-Buffer (Sync 002 Z.233).
    const rotation3 = await buildKeyRotationBody({ keyPort: senderPort, spaceId, newGeneration: 3, recipientDid: bob.getDid() })
    const outcome3 = await (bobAdapter as any).handleKeyRotation(
      rotationDecoded(alice.getDid(), rotation3 as unknown as Record<string, unknown>))
    expect(outcome3).toMatchObject({ kind: 'pending', durability: 'durable' })
    expect(await bobKeys.getCurrentGeneration(spaceId)).toBe(1)

    // future-member-update (eff. 3): > local+1 → bufferFuture (Sync 005 Z.205).
    await (bobAdapter as any).handleMemberUpdate({
      type: MEMBER_UPDATE_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: { spaceId, action: 'removed', memberDid: bob.getDid(), effectiveKeyGeneration: 3 },
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
    expect(await memberUpdateStore.listFutureForSpace(spaceId)).toHaveLength(1)
    expect(await memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(0)
    expect(spaceState(bobAdapter, spaceId).pendingRemoval).toBeUndefined()

    // Gen-2 schliesst die Luecke: apply 2 → Replay wendet 3 an (aufsteigend) →
    // resolveFuture ueberfuehrt das member-update in den Seen-Zustand.
    const rotation2 = await buildKeyRotationBody({ keyPort: senderPort, spaceId, newGeneration: 2, recipientDid: bob.getDid() })
    await (bobAdapter as any).handleKeyRotation(
      rotationDecoded(alice.getDid(), rotation2 as unknown as Record<string, unknown>))
    await waitUntil(async () => (await bobKeys.getCurrentGeneration(spaceId)) === 3
      && (await memberUpdateStore.listFutureForSpace(spaceId)).length === 0)

    expect(await bobKeys.getCurrentGeneration(spaceId)).toBe(3)
    expect(await memberUpdateStore.listFutureForSpace(spaceId)).toHaveLength(0)
    const seen = await memberUpdateStore.listSeenForSpace(spaceId)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      action: 'removed',
      memberDid: bob.getDid(),
      effectiveKeyGeneration: 3,
      // signer alice = Admin-Approximation (Invite ohne createdBy im Doc:
      // SPEC-APPROX-Fallback members[0] = senderDid) → autorisiertes Pending.
      storedDisposition: 'store-pending-and-sync',
    })
    // Der Re-Lauf traegt die lokale UX-Wirkung wie der Live-Pfad (Z.183-184).
    expect(spaceState(bobAdapter, spaceId).pendingRemoval).toEqual({ effectiveKeyGeneration: 3 })
  })
})

/** F-1-Introspektion: blocked-by-key-Eintraege im In-Memory-Pending-Buffer. */
function pendingBlockedByKey(adapter: AutomergeReplicationAdapter, spaceId: string): any[] {
  const pending = (adapter as unknown as { pendingMessages: Map<string, any[]> }).pendingMessages.get(spaceId) ?? []
  return pending.filter((m) => m.reason === 'blocked-by-key')
}

describe('Ex-CHECK 4 (invertiert) — blocked-by-key-Content-Buffer (F-1, Sync 002 Z.173)', () => {
  /**
   * INVERTIERTER Befund-Pin: der fruehere CHECK-4-Pin dokumentierte den
   * endgueltigen Drop (Selbstheilungs-These widerlegt — sentHashes-
   * Suppression des Senders, endloser Heads-Ping-Pong, auch change 2 blieb
   * mangels Dependency unanwendbar). Seit F-1 puffert der Empfaenger die
   * Nachricht als blocked-by-key (Sync 002 Z.173 MUSS) und feedet sie nach
   * rotation-apply erneut durch DENSELBEN Decrypt-→repo-Pfad (Z.231/Z.235):
   * change 1 UND change 2 kommen nach Key-Ankunft an, der Heads-Ping-Pong
   * terminiert.
   */
  it('waehrend der Key-Luecke eingetroffene Change wird gepuffert und nach rotation-apply angewendet; die Folge-Aenderung wird anwendbar; der Sync terminiert', async () => {
    const alice = (await createTestIdentity('am-check4-alice')).identity
    const bob = (await createTestIdentity('am-check4-bob')).identity
    const aliceMsg = new InMemoryMessagingAdapter()
    const bobMsg = new InMemoryMessagingAdapter()
    await aliceMsg.connect(alice.getDid())
    await bobMsg.connect(bob.getDid())

    const aliceKeys = new InMemoryKeyManagementAdapter()
    const aliceAdapter = new AutomergeReplicationAdapter({
      identity: alice, messaging: aliceMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: aliceKeys,
    })
    await aliceAdapter.start()
    const bobKeys = new InMemoryKeyManagementAdapter()
    const bobAdapter = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: bobKeys,
    })
    await bobAdapter.start()
    cleanups.push(async () => {
      await aliceAdapter.stop()
      await bobAdapter.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null)
    expect(await bobAdapter.getSpace(space.id)).not.toBeNull()

    // Alice rotiert lokal auf gen 1, OHNE dass bob die key-rotation erhaelt
    // (simulierte Out-of-Order-/Verlust-Situation). Ihre naechste Aenderung
    // reist gen-1-verschluesselt → bob puffert sie als blocked-by-key
    // (Sync 002 Z.173 — kein Drop mehr; ohne CompactStore in-memory, der
    // content-Kanal hat keine ack-Semantik, Z.202).
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: aliceKeys, spaceId: space.id, ownerDid: alice.getDid() })
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
    aliceHandle.transact((d) => { d.items['dropped-while-keyless'] = { title: 'first' } })
    await waitUntil(() => pendingBlockedByKey(bobAdapter, space.id).length > 0)
    expect(spaceDoc(bobAdapter, space.id)?.items?.['dropped-while-keyless']).toBeUndefined()
    expect(pendingBlockedByKey(bobAdapter, space.id).length).toBeGreaterThan(0)

    // Jetzt erreicht bob die gen-1-Rotation (aus alices echtem Key-Material).
    const rotationBody = await buildKeyRotationBody({ keyPort: aliceKeys, spaceId: space.id, newGeneration: 1, recipientDid: bob.getDid() })
    const rotation = await deliverInboxMessage({
      type: KEY_ROTATION_MESSAGE_TYPE,
      body: rotationBody as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    })
    await aliceMsg.send(rotation)
    await waitUntil(async () => (await bobKeys.getCurrentGeneration(space.id)) === 1)
    // Die Rotation selbst kommt an (DIDComm-Inbox-Pfad ist gesund).
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)

    // F-1: der Replay-Hook nach rotation-apply feedet die gepufferte change 1
    // erneut durch den Live-Empfangspfad — sie kommt jetzt an.
    await waitUntil(() => spaceDoc(bobAdapter, space.id)?.items?.['dropped-while-keyless'] !== undefined)
    expect(spaceDoc(bobAdapter, space.id)?.items?.['dropped-while-keyless']).toMatchObject({ title: 'first' })

    // Die Folge-Aenderung (change 2, jetzt live entschluesselbar) ist nicht
    // mehr dependency-blockiert und kommt ebenfalls an.
    aliceHandle.transact((d) => { d.items['after-key-arrival'] = { title: 'second' } })
    await waitUntil(() => spaceDoc(bobAdapter, space.id)?.items?.['after-key-arrival'] !== undefined)

    const bobDoc = spaceDoc(bobAdapter, space.id)
    expect(bobDoc?.items?.['dropped-while-keyless']).toMatchObject({ title: 'first' })
    expect(bobDoc?.items?.['after-key-arrival']).toMatchObject({ title: 'second' })
    expect(pendingBlockedByKey(bobAdapter, space.id)).toHaveLength(0)

    // Heads-Ping-Pong-Aufloesung: nach der Konvergenz terminiert die Sync-
    // Konversation — es laufen keine weiteren content-Frames mehr ein (der
    // fruehere Pin zeigte hier endlose identische Mini-Frames).
    let bobContentFrames = 0
    bobMsg.onMessage((m) => { if ((m as { type?: string }).type === 'content') bobContentFrames++ })
    await wait(500)
    const settled = bobContentFrames
    await wait(600)
    expect(bobContentFrames).toBe(settled)
    aliceHandle.close()
  })

  /**
   * F-1 Sicherheits-Negativ (Abnahme 5): ein Empfaenger OHNE den neuen Key
   * (z.B. ein Entfernter, der nie eine gen-1-rotation erhaelt) bleibt
   * draussen — sein gepufferter Eintrag wendet NIE an, auch ein expliziter
   * Replay-Versuch re-buffert nur (korrekt + harmlos).
   */
  it('Sicherheits-Negativ: ohne Key-Import bleibt der blocked-by-key-Eintrag gepuffert und wendet nie an', async () => {
    const alice = (await createTestIdentity('am-check4neg-alice')).identity
    const bob = (await createTestIdentity('am-check4neg-bob')).identity
    const aliceMsg = new InMemoryMessagingAdapter()
    const bobMsg = new InMemoryMessagingAdapter()
    await aliceMsg.connect(alice.getDid())
    await bobMsg.connect(bob.getDid())

    const aliceKeys = new InMemoryKeyManagementAdapter()
    const aliceAdapter = new AutomergeReplicationAdapter({
      identity: alice, messaging: aliceMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: aliceKeys,
    })
    await aliceAdapter.start()
    const bobAdapter = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
    await bobAdapter.start()
    cleanups.push(async () => {
      await aliceAdapter.stop()
      await bobAdapter.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter.getSpace(space.id)) !== null)

    // Alice rotiert lokal; bob bekommt die rotation NIE (entspricht dem
    // Entfernten ohne neuen Key). Ihre gen-1-Changes werden bei bob gepuffert.
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: aliceKeys, spaceId: space.id, ownerDid: alice.getDid() })
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
    aliceHandle.transact((d) => { d.items['secret-after-rotation'] = { title: 'hidden' } })
    await waitUntil(() => pendingBlockedByKey(bobAdapter, space.id).length > 0)
    expect(spaceDoc(bobAdapter, space.id)?.items?.['secret-after-rotation']).toBeUndefined()

    // Expliziter Replay-Versuch ohne Key: re-buffert, wendet NICHT an.
    await (bobAdapter as any).processPendingForSpace(space.id)
    expect(spaceDoc(bobAdapter, space.id)?.items?.['secret-after-rotation']).toBeUndefined()
    expect(pendingBlockedByKey(bobAdapter, space.id).length).toBeGreaterThan(0)
    aliceHandle.close()
  })
})

describe('F-1 Neustart — blocked-by-key-Content ueberlebt den Adapter-Restart (Sync 002 Z.171/Z.173)', () => {
  it('durabel gepufferter Content wird nach Restart und Key-Import angewendet (Spiegel des Yjs-Tests)', async () => {
    const alice = (await createTestIdentity('am-f1restart-alice')).identity
    const bob = (await createTestIdentity('am-f1restart-bob')).identity
    const aliceMsg = new InMemoryMessagingAdapter()
    const bobMsg = new InMemoryMessagingAdapter()
    await aliceMsg.connect(alice.getDid())
    await bobMsg.connect(bob.getDid())

    const aliceKeys = new InMemoryKeyManagementAdapter()
    const aliceAdapter = new AutomergeReplicationAdapter({
      identity: alice, messaging: aliceMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: aliceKeys,
    })
    await aliceAdapter.start()

    const bobMeta = new InMemorySpaceMetadataStorage()
    const bobCompact = new InMemoryCompactStore()
    const bobAdapter1 = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: bobMeta,
      compactStore: bobCompact,
    })
    await bobAdapter1.start()
    let activeBobAdapter = bobAdapter1
    cleanups.push(async () => {
      await aliceAdapter.stop()
      await activeBobAdapter.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobAdapter1.getSpace(space.id)) !== null
      && (await bobCompact.list()).includes(space.id))

    // Gen-1-Change trifft VOR der rotation ein → durabel gepuffert.
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: aliceKeys, spaceId: space.id, ownerDid: alice.getDid() })
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
    aliceHandle.transact((d) => { d.items['blocked-across-restart'] = { title: 'survivor' } })
    await waitUntil(async () => (await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX)))
    expect(spaceDoc(bobAdapter1, space.id)?.items?.['blocked-across-restart']).toBeUndefined()

    // Neustart: neue Adapter-Inkarnation, gleiche durable Stores, frisches
    // KeyManagement (gen-0-Key kommt aus der Metadata zurueck, gen 1 fehlt).
    // Setzt den lineage-erhaltenden CompactStore-Snapshot voraus (Sync 002
    // Z.158): ein historienfrei re-erzeugtes Doc koennte die gepufferte
    // Change mangels Dependencies nie anwenden.
    await bobAdapter1.stop()
    const bobKeys2 = new InMemoryKeyManagementAdapter()
    const bobAdapter2 = new AutomergeReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: bobKeys2,
      metadataStorage: bobMeta,
      compactStore: bobCompact,
    })
    await bobAdapter2.start()
    activeBobAdapter = bobAdapter2

    // Buffer hat den Neustart ueberlebt; ohne gen-1-Key weiter blockiert.
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(true)
    expect(spaceDoc(bobAdapter2, space.id)?.items?.['blocked-across-restart']).toBeUndefined()

    // Key-Import: die gen-1-rotation trifft jetzt ein → Replay wendet den
    // gepufferten Content an.
    const rotationBody = await buildKeyRotationBody({ keyPort: aliceKeys, spaceId: space.id, newGeneration: 1, recipientDid: bob.getDid() })
    const rotation = await deliverInboxMessage({
      type: KEY_ROTATION_MESSAGE_TYPE,
      body: rotationBody as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    })
    await aliceMsg.send(rotation)
    await waitUntil(async () => spaceDoc(bobAdapter2, space.id)?.items?.['blocked-across-restart'] !== undefined
      && !(await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX)))

    expect(await bobKeys2.getCurrentGeneration(space.id)).toBe(1)
    expect(spaceDoc(bobAdapter2, space.id)?.items?.['blocked-across-restart']).toMatchObject({ title: 'survivor' })
    expect((await bobCompact.list()).some((key) => key.includes(PENDING_PREFIX))).toBe(false)
    aliceHandle.close()
  })
})
