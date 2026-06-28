/**
 * VE-6 b/c/d (Slice 1.B.3-sync-recovery, Step 4): Generation-Gap-Recovery.
 *
 * Sync 005 Z.202: ohne lokale Space-Keys DARF der Client das Update nur als
 * unverifiziertes Pending-Signal speichern — das normative Muster fuer
 * "Nachricht fuer unbekannten Space": durabel puffern, nicht endlos
 * redelivern lassen.
 *
 * Sync 002 Z.231-235: future-rotation durabel puffern, nach Lueckenschluss
 * alle gepufferten Nachrichten in aufsteigender Generation erneut pruefen,
 * sync-request fuer das Space-Dokument ausloesen.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
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
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type { DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, buildSpaceInviteBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms))

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

/** Beobachtet abgehende ack/1.0-Envelopes eines Messaging-Adapters. */
function captureAcks(messaging: InMemoryMessagingAdapter): DidcommPlaintextMessage[] {
  const acks: DidcommPlaintextMessage[] = []
  const originalSend = messaging.send.bind(messaging)
  messaging.send = async (envelope: WireMessage) => {
    if (isDidcommMessage(envelope) && envelope.type === ACK_MESSAGE_TYPE) acks.push(envelope)
    return originalSend(envelope)
  }
  return acks
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

describe('Pflicht-Test 2 — unknown-space key-rotation: durabel puffern + ack (VE-6b)', () => {
  it('Rotation vor dem Invite: genau 1 ack/1.0 beim Puffern; nach space-invite-Apply angewendet; Redelivery endet als Replay-ack ohne Doppel-Anwendung', async () => {
    const alice = (await createTestIdentity('gap2-alice')).identity
    const bob = (await createTestIdentity('gap2-bob')).identity
    const aliceMsg = new InMemoryMessagingAdapter()
    const bobMsg = new InMemoryMessagingAdapter()
    await aliceMsg.connect(alice.getDid())
    await bobMsg.connect(bob.getDid())

    const aliceAdapter = new YjsReplicationAdapter({
      identity: alice, messaging: aliceMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
    await aliceAdapter.start()
    const bobKeys = new InMemoryKeyManagementAdapter()
    const bobCompact = new InMemoryCompactStore()
    const bobAdapter = new YjsReplicationAdapter({
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
      && (await bobCompact.list()).some((key) => key.includes('__wot_pending_space_message__')))

    // Durabel gepuffert (reason unknown-space) + genau EIN ack/1.0 (Sync 002
    // Z.172: ACK erst nach Anwendung ODER durablem Puffern).
    expect(await bobAdapter.getSpace(space.id)).toBeNull()
    expect((await bobCompact.list()).some((key) => key.includes('__wot_pending_space_message__'))).toBe(true)
    expect(bobAcks.filter((a) => a.thid === rotation.id)).toHaveLength(1)

    // space-invite kommt an → Replay-Hook nach dem Invite-Apply wendet die
    // gepufferte Rotation an (Authority-Check laeuft erst jetzt, mit Admin-Snapshot).
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await waitUntil(async () => (await bobKeys.getCurrentGeneration(space.id)) === 1
      && !(await bobCompact.list()).some((key) => key.includes('__wot_pending_space_message__')))
    expect(await bobAdapter.getSpace(space.id)).not.toBeNull()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect((await bobCompact.list()).some((key) => key.includes('__wot_pending_space_message__'))).toBe(false)
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
    const alice = (await createTestIdentity('gap3-alice')).identity
    const bob = (await createTestIdentity('gap3-bob')).identity
    const bobMsg = new InMemoryMessagingAdapter()
    await bobMsg.connect(bob.getDid())
    const bobKeys = new InMemoryKeyManagementAdapter()
    const memberUpdateStore = new InMemoryMemberUpdatePendingStore()
    const bobAdapter = new YjsReplicationAdapter({
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
    const inviteBody = await buildSpaceInviteBody({
      keyPort: senderPort, spaceId, recipientDid: bob.getDid(),
      brokerUrls: ['wss://broker.example.com'], adminDids: [alice.getDid()],
    })
    await (bobAdapter as any).handleSpaceInvite({
      type: SPACE_INVITE_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: inviteBody as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
    expect(await bobKeys.getCurrentGeneration(spaceId)).toBe(1)

    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 2
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() }) // gen 3

    // Gen-3-Rotation zuerst: > local+1 → durabler future-Buffer (Sync 002 Z.233).
    const rotation3 = await buildKeyRotationBody({ keyPort: senderPort, spaceId, newGeneration: 3, recipientDid: bob.getDid() })
    const outcome3 = await (bobAdapter as any).handleKeyRotation({
      type: KEY_ROTATION_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: rotation3 as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
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
    await (bobAdapter as any).handleKeyRotation({
      type: KEY_ROTATION_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: rotation2 as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
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
      // signer alice = Admin-Approximation (Invite ohne Snapshot: members[0]
      // = senderDid) → autorisiertes Pending.
      storedDisposition: 'store-pending-and-sync',
    })
    // Der Re-Lauf traegt die lokale UX-Wirkung wie der Live-Pfad (Z.183-184).
    expect(spaceState(bobAdapter, spaceId).pendingRemoval).toEqual({ effectiveKeyGeneration: 3 })
  })
})

describe('VE-6d — Catch-up-Trigger (Sync 002 Z.231 "sync-request ausloesen", SPEC-APPROX Old-World)', () => {
  it('sendSpaceSyncRequest feuert nach rotation-apply und nach kanonisch relevantem member-update', async () => {
    const alice = (await createTestIdentity('gap4-alice')).identity
    const bob = (await createTestIdentity('gap4-bob')).identity
    const bobMsg = new InMemoryMessagingAdapter()
    await bobMsg.connect(bob.getDid())
    const bobAdapter = new YjsReplicationAdapter({
      identity: bob, messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: new InMemorySpaceMetadataStorage(),
      compactStore: new InMemoryCompactStore(),
    })
    await bobAdapter.start()
    cleanups.push(async () => {
      await bobAdapter.stop()
      for (const id of [alice, bob]) { try { await id.deleteStoredIdentity() } catch {} }
    })

    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    const inviteBody = await buildSpaceInviteBody({
      keyPort: senderPort, spaceId, recipientDid: bob.getDid(),
      brokerUrls: ['wss://broker.example.com'], adminDids: [alice.getDid()],
    })
    await (bobAdapter as any).handleSpaceInvite({
      type: SPACE_INVITE_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: inviteBody as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })

    const syncRequestSpy = vi.spyOn(bobAdapter as any, 'sendSpaceSyncRequest').mockResolvedValue(undefined)

    // (1) rotation-apply → Catch-up.
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    const rotation1 = await buildKeyRotationBody({ keyPort: senderPort, spaceId, newGeneration: 1, recipientDid: bob.getDid() })
    await (bobAdapter as any).handleKeyRotation({
      type: KEY_ROTATION_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: rotation1 as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
    expect(syncRequestSpy).toHaveBeenCalledWith(spaceId)

    // (2) kanonisch relevantes member-update (store-pending) → Catch-up.
    syncRequestSpy.mockClear()
    await (bobAdapter as any).handleMemberUpdate({
      type: MEMBER_UPDATE_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: { spaceId, action: 'removed', memberDid: bob.getDid(), effectiveKeyGeneration: 1 },
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
    expect(syncRequestSpy).toHaveBeenCalledWith(spaceId)

    // Kontrast: ein Duplikat (ignore-duplicate) triggert KEINEN Catch-up.
    syncRequestSpy.mockClear()
    await (bobAdapter as any).handleMemberUpdate({
      type: MEMBER_UPDATE_MESSAGE_TYPE,
      senderDid: alice.getDid(),
      body: { spaceId, action: 'removed', memberDid: bob.getDid(), effectiveKeyGeneration: 1 },
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
    expect(syncRequestSpy).not.toHaveBeenCalled()
  })
})
