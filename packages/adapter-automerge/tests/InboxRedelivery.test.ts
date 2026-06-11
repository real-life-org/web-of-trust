/**
 * M1-Tests (Sync 003 Z.466 + Z.620-622), Mirror der Yjs-Referenz: Die
 * Message-ID-History wird erst bei konklusiver Verarbeitung befüllt. Ein
 * nicht-konklusiver Ausgang (unknown space → pending/not-buffered) lässt die
 * id frei: die Relay-Redelivery ist der Recovery-Pfad und wird normal
 * angewendet. Erst danach endet eine weitere Redelivery als Replay mit
 * duplicate-known-ack (Queue-Räumung).
 */
import { describe, it, expect } from 'vitest'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryKeyManagementAdapter,
  InMemoryMessageIdHistory,
  InMemoryMessagingAdapter,
} from '@web_of_trust/core/adapters'
import {
  ACK_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  SPACE_INVITE_MESSAGE_TYPE,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import { deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { WireMessage } from '@web_of_trust/core/ports'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'

const TARGET = 'did:key:z6MkTargetTargetTarget'
const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

async function setup() {
  InMemoryMessagingAdapter.resetAll()
  const alice = (await createTestIdentity('am-redelivery-alice')).identity
  const admin = (await createTestIdentity('am-redelivery-admin')).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(alice.getDid())

  // Alle Sends der Empfängerin mitschneiden, um ack/1.0-Emissionen zu zählen.
  const sent: WireMessage[] = []
  const originalSend = messaging.send.bind(messaging)
  messaging.send = (async (message: WireMessage) => {
    sent.push(message)
    return originalSend(message)
  }) as typeof messaging.send

  const history = new InMemoryMessageIdHistory()
  const adapter = new AutomergeReplicationAdapter({
    identity: alice,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement: new InMemoryKeyManagementAdapter(),
    messageIdHistory: history,
  })
  await adapter.start()
  const acks = () =>
    sent.filter((message) => isDidcommMessage(message) && message.type === ACK_MESSAGE_TYPE)
  return { adapter, alice, admin, history, acks }
}

describe('AutomergeReplicationAdapter — Message-ID-History erst bei konklusiver Verarbeitung (M1)', () => {
  it('PFLICHT: unknown space → kein ack, keine History; Redelivery wird angewendet; danach Replay-ack', async () => {
    const { adapter, alice, admin, history, acks } = await setup()
    const space = await adapter.createSpace('shared', { counter: 0 })
    const spaces = (adapter as any).spaces as Map<string, unknown>
    const state = spaces.get(space.id) as { info: { members: string[] }; documentId: string }
    // SPEC-APPROX admin = createdBy (VE-2): Seeding ueber den produktiven Pfad —
    // _createdBy + active@0-Event im Doc, die Projektion folgt via Handler.
    ;((adapter as any).repo.handles[state.documentId] as { change(fn: (d: any) => void): void }).change((d: any) => {
      d._createdBy = admin.getDid()
      if (!d._members) d._members = {}
      d._members[`${admin.getDid()}:0:active`] = { did: admin.getDid(), status: 'active', sinceGeneration: 0 }
    })

    const envelope = await deliverInboxMessage({
      type: MEMBER_UPDATE_MESSAGE_TYPE,
      body: { spaceId: space.id, action: 'added', memberDid: TARGET, effectiveKeyGeneration: 0 },
      from: admin.getDid(),
      to: alice.getDid(),
      recipientEncryptionPublicKey: alice.x25519PublicKey,
      sign: (input) => admin.signEd25519(input),
      crypto: protocolCrypto,
    })

    // 1) Space (noch) unbekannt: pending/not-buffered → KEIN ack, id NICHT in
    //    der History (Sync 003 Z.620-622 — volatil ist nicht "verarbeitet").
    spaces.delete(space.id)
    await (adapter as any).handleInboxEnvelope(envelope)
    expect(acks()).toHaveLength(0)
    expect(await history.has(envelope.id, new Date().toISOString())).toBe(false)

    // 2) Invite angekommen (Space wieder bekannt): die Relay-Redelivery wird
    //    normal angewendet — Recovery-Beweis. Jetzt konklusiv → recorded + ack.
    spaces.set(space.id, state)
    await (adapter as any).handleInboxEnvelope(envelope)
    expect(acks()).toHaveLength(1)
    expect((acks()[0] as { thid?: string }).thid).toBe(envelope.id)
    expect(await history.has(envelope.id, new Date().toISOString())).toBe(true)
    const seen = await (adapter as any).memberUpdateStore.listSeenForSpace(space.id)
    expect(seen).toHaveLength(1)

    // 3) Weitere Redelivery nach konklusiver Verarbeitung: Replay →
    //    duplicate-known-ack (Sync 003 Z.619, Queue-Räumung), keine Doppel-Anwendung.
    await (adapter as any).handleInboxEnvelope(envelope)
    expect(acks()).toHaveLength(2)
    expect(await (adapter as any).memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(1)

    await adapter.stop()
    InMemoryMessagingAdapter.resetAll()
  })

  it('malformed space-invite body → konklusiv invalid-rejected (record, Replay-ack statt Endlos-Redelivery)', async () => {
    // Konsistent zu member-update/key-rotation: ein deterministisch
    // ungültiger Body ist konklusiv (Sync 003 Z.466 + Z.620-622) — als
    // processing-incomplete würde er nie geackt und endlos redelivered.
    const { adapter, alice, admin, history, acks } = await setup()

    const envelope = await deliverInboxMessage({
      type: SPACE_INVITE_MESSAGE_TYPE,
      body: { spaceId: 'space-malformed' }, // verletzt das SpaceInviteBody-Schema
      from: admin.getDid(),
      to: alice.getDid(),
      recipientEncryptionPublicKey: alice.x25519PublicKey,
      sign: (input) => admin.signEd25519(input),
      crypto: protocolCrypto,
    })

    // Konklusiv ungültig: recorded, aber kein sofortiges ack
    // ('may-ack-invalid-and-drop' wird bewusst nicht genutzt).
    await (adapter as any).handleInboxEnvelope(envelope)
    expect(acks()).toHaveLength(0)
    expect(await history.has(envelope.id, new Date().toISOString())).toBe(true)

    // Redelivery endet als Replay mit duplicate-known-ack — Queue-Räumung.
    await (adapter as any).handleInboxEnvelope(envelope)
    expect(acks()).toHaveLength(1)
    expect((acks()[0] as { thid?: string }).thid).toBe(envelope.id)

    await adapter.stop()
    InMemoryMessagingAdapter.resetAll()
  })
})
